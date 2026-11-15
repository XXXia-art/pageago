// Browser QA through Chromium's local debugging protocol; no npm packages.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const root=process.cwd();
const documentPath=path.resolve(root,process.env.TIMELINE_TEST_DOCUMENT||'output/edge_history_timeline.html');
const screenshotPrefix=process.env.TIMELINE_SCREENSHOT_PREFIX||'timeline';
const seed=JSON.parse(fs.readFileSync(documentPath,'utf8').match(/<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const exportOffset=seed.end_time.match(/Z|[+-]\d{2}:\d{2}$/i)[0];
const windowStart=Date.parse(seed.start_time.slice(0,10)+'T06:00:00'+exportOffset);
const windowEnd=Date.parse(seed.start_time.slice(0,10)+'T00:00:00'+exportOffset)+86400000;
const displayedSeed=seed.events.filter(e=>Date.parse(e.time)>=windowStart&&Date.parse(e.time)<windowEnd);
const browser=process.env.TIMELINE_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const qaRoot=path.resolve(root,'.timeline-browser-'+randomUUID());
fs.mkdirSync(qaRoot);
let child;
try { child=spawn(browser,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${qaRoot}`,
  '--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--disable-component-update','--disable-sync','--disable-extensions','about:blank'],
  {windowsHide:true,stdio:['ignore','ignore','pipe']}); }
catch(error){fs.rmdirSync(qaRoot);throw error;}
let diagnostic='';child.stderr.on('data',b=>{diagnostic+=b.toString();});
const errors=[],requests=[];
let socket;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await pause(100);}throw Error('Timed out waiting for browser state');}
try {
  await until(()=>fs.existsSync(path.join(qaRoot,'DevToolsActivePort')));
  const [port]=fs.readFileSync(path.join(qaRoot,'DevToolsActivePort'),'utf8').split('\n');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const pending=new Map();let sequence=0;
  socket.addEventListener('message',event=>{
    const value=JSON.parse(event.data);
    if(value.id&&pending.has(value.id)){const{resolve,reject,timer}=pending.get(value.id);clearTimeout(timer);pending.delete(value.id);value.error?reject(Error(JSON.stringify(value.error))):resolve(value.result);}
    if(value.method==='Runtime.exceptionThrown')errors.push(value.params.exceptionDetails.text+' '+(value.params.exceptionDetails.exception?.description||''));
    if(value.method==='Network.requestWillBeSent')requests.push(value.params.request.url);
  });
  const command=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{const value=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value;};
  const click=async selector=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing button');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});};
  const checkReadability=async()=>{
    for(const [selector,minimum] of [['.page-title',16],['.axis-tick span',18],['.header-search input',16],['.disclosure',14]]){
      const size=await evaluate(`parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontSize)`);
      assert.ok(size>=minimum,`${selector}: ${size}px must be at least ${minimum}px`);
    }
    const colors=await evaluate(`['.page-title','.axis-tick span'].map(selector=>{const node=document.querySelector(selector);let parent=node,bg;while(parent){bg=getComputedStyle(parent).backgroundColor;if(/^rgb\\(/.test(bg))break;parent=parent.parentElement;}return{selector,fg:getComputedStyle(node).color,bg};})`);
    const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{const s=n/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
    for(const {selector,fg,bg} of colors){const a=luminance(fg),b=luminance(bg);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${selector} needs clearer text contrast`);}
  };
  const checkPageListPriority=async()=>{
    const layout=await evaluate(`(()=>{const first=document.querySelector('.page-group > summary'),tabs=document.getElementById('detail-tabs');return{firstTop:first.getBoundingClientRect().top,tabsTop:tabs.getBoundingClientRect().top,summaryVisible:document.querySelector('.detail-grid').getClientRects().length>0,noteVisible:document.querySelector('.detail-note').getClientRects().length>0,font:parseFloat(getComputedStyle(document.querySelector('.page-group-title')).fontSize)};})()`);
    assert.equal(layout.summaryVisible,false,'A site page list must start before visit statistics');
    assert.equal(layout.noteVisible,false,'Visit explanations belong with visit evidence');
    assert.ok(layout.firstTop<=300,`The first page should be immediately available, not below ${layout.firstTop}px of header`);
    assert.ok(layout.font>=16,'Earlier page placement must preserve readable titles');
    return layout.tabsTop;
  };
  const open=async file=>{await command('Page.navigate',{url:pathToFileURL(file).href});await until(()=>evaluate('document.readyState==="complete" && typeof timelineSnapshot==="function" && timelineSnapshot().events !== undefined'));};
  const groupBy=async mode=>evaluate(`document.getElementById('group-by').value=${JSON.stringify(mode)};document.getElementById('group-by').dispatchEvent(new Event('change',{bubbles:true}));`);
  await command('Page.enable');await command('Runtime.enable');await command('Network.enable');
  await command('Emulation.setTimezoneOverride',{timezoneId:'UTC'});
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});
  const chartMetrics=async()=>evaluate(`(()=>{const r=document.getElementById('chart-scroll').getBoundingClientRect();return{top:r.top,width:r.width,height:r.height,fraction:r.height/innerHeight,viewport:{width:innerWidth,height:innerHeight}};})()`);
  const checkCoverage=async expected=>{
    const actual=await evaluate(`(()=>{const g=document.getElementById('gantt'),width=g.getBoundingClientRect().width,start=Number(g.dataset.start),end=Number(g.dataset.end),legend=document.getElementById('coverage-legend');return{gaps:[...g.querySelectorAll('.coverage-gap')].map(n=>({start:Number(n.dataset.start),end:Number(n.dataset.end),left:parseFloat(n.style.left),width:parseFloat(n.style.width),blocks:getComputedStyle(n).pointerEvents})),width,start,end,legend:!!legend&&!legend.hidden};})()`);
    assert.deepEqual(actual.gaps.map(g=>[g.start,g.end]),expected.map(pair=>pair.map(Date.parse)),'Uncovered time follows the export bounds, not its first/last visit');
    assert.equal(actual.legend,expected.length>0,'Only show the uncovered legend when there is a visible gap');
    for(const gap of actual.gaps){
      assert.ok(Math.abs(gap.left-(60+(gap.start-actual.start)/(actual.end-actual.start)*(actual.width-84)))<.01,'Uncovered regions use the same time coordinates as visits');
      assert.ok(Math.abs(gap.width-(gap.end-gap.start)/(actual.end-actual.start)*(actual.width-84))<.01);
      assert.equal(gap.blocks,'none','Coverage shading must not block visit selection');
    }
  };
  let baseline;
  if(process.env.TIMELINE_BASELINE){await open(path.resolve(root,process.env.TIMELINE_BASELINE));baseline=await chartMetrics();}
  await open(documentPath);
  const contentSnapshot=await evaluate('timelineSnapshot()');
  assert.equal(contentSnapshot.grouping,'page','Opening a report must show what was visited, without requiring expansion');
  assert.equal(contentSnapshot.rows,contentSnapshot.windowPages);
  assert.equal(await evaluate('document.getElementById("row-count-label").textContent'),'个网页');
  assert.equal(await evaluate('document.getElementById("group-by").closest(".toolbar")!==null'),true,'Content and site views must be reachable on the main toolbar');
  const expectedContent=new Map();for(const event of displayedSeed){const key=JSON.stringify([event.page_key,event.profile]);if(!expectedContent.has(key))expectedContent.set(key,[]);expectedContent.get(key).push(event);}
  const visibleContent=await evaluate('[...document.querySelectorAll(".gantt-row")].map(row=>({key:row.dataset.pageKey,title:row.querySelector(".page-title").textContent,height:row.getBoundingClientRect().height}))');
  for(const row of visibleContent){const events=expectedContent.get(row.key).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.visit_id-b.visit_id);assert.equal(row.title,events.at(-1).title.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,''),'Show the actual visible page title, not just its site');assert.ok(row.height<=76,'Content rows should use space efficiently');}
  await checkReadability();
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_content_desktop.png'),Buffer.from(r.data,'base64')));
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(180);
  await checkReadability();
  const contentPicker=await evaluate(`(()=>{const picker=document.getElementById('group-by'),r=picker.getBoundingClientRect();return{left:r.left,right:r.right,visible:r.width>0,overflow:document.querySelector('.toolbar').scrollWidth>document.querySelector('.toolbar').clientWidth};})()`);
  assert.ok(contentPicker.visible&&contentPicker.left>=0&&contentPicker.right<=390&&!contentPicker.overflow,'View selection must fit and stay visible on a phone');
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_content_mobile.png'),Buffer.from(r.data,'base64')));
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await pause(180);
  await groupBy('site');
  const snapshot=await evaluate('timelineSnapshot()');
  assert.equal(snapshot.events,seed.event_count);
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),displayedSeed.length);
  assert.equal(await evaluate('document.querySelectorAll(".gantt-row").length'),snapshot.rows);
  assert.equal(await evaluate('document.getElementById("data-date").textContent'),seed.start_time.slice(0,10).replaceAll('-','.'));
  assert.equal(await evaluate('document.getElementById("error").hidden'),true);
  assert.equal(snapshot.grouping,'site');
  const siteKeys=await evaluate('[...document.querySelectorAll(".gantt-row")].map(row=>row.dataset.site)');
  assert.equal(new Set(siteKeys).size,siteKeys.length,'A site must appear only once in the site overview');
  const expectedIds=displayedSeed.map(e=>`${e.profile}:${e.visit_id}`).sort();
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),expectedIds,'Grouping must preserve every source event');

  assert.equal(await evaluate('document.getElementById("snapshot-badge").textContent.includes("示例数据")'),seed.dataset_kind==='demo');
  const checkChartPriority=async()=>{
    const m=await chartMetrics(),mobile=m.viewport.width<760;
    assert.ok(m.fraction>=(mobile?.65:.70),`Canvas height must dominate the viewport: ${JSON.stringify(m)}`);
    assert.ok(m.top<=(mobile?245:160),`Canvas must appear near the top: ${m.top}`);
    assert.ok(m.width/m.viewport.width>=(mobile?.90:.94),'Canvas must occupy the full content width');
    assert.equal(await evaluate('document.documentElement.scrollHeight<=innerHeight+1'),true,'Only the canvas scrolls, not the page shell');
    assert.equal(await evaluate('(()=>{const f=document.querySelector(".chart-footer");return f.scrollWidth<=f.clientWidth;})()'),true,'The coverage legend and time help must fit the footer');
    assert.equal(await evaluate('document.querySelectorAll(".sidebar,#topic-list,[data-topic],.intro,#hour-overview,#site-filter").length'),0,'Search replaces topic and website filters');
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()'),'#f5f1e8');
    const header=await evaluate(`(()=>{const input=document.getElementById('search'),style=getComputedStyle(input),selectors=['.brand-name','.brand-date','#snapshot-badge','.header-search','.top-actions'];return{textWidth:input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),boxes:selectors.map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};})()`);
    assert.ok(header.textWidth>=160,`Search needs room for a readable query at ${m.viewport.width}px: ${JSON.stringify(header)}`);
    assert.ok(header.boxes.every(r=>r.left>=0&&r.right<=m.viewport.width),'Header controls must stay within the viewport');
    for(const [i,a] of header.boxes.entries())for(const b of header.boxes.slice(i+1))assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`Header controls must not overlap: ${a.selector} / ${b.selector}`);
    const controls=await evaluate(`['.record-count','.range-window','#group-by','.zoom','#display-options'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};}).filter(r=>r.width>0)`);
    assert.ok(controls.every(r=>r.left>=0&&r.right<=m.viewport.width),'Timeline controls must remain inside the screen');
    for(const [i,a] of controls.entries())for(const b of controls.slice(i+1))assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`Timeline controls must not overlap at ${m.viewport.width}px: ${a.selector} / ${b.selector}`);
    return m;
  };
  const desktop=await checkChartPriority();
  await checkReadability();
  await until(()=>evaluate('[...document.querySelectorAll(".site-avatar img")].every(img=>img.complete&&img.naturalWidth>0)'));
  assert.equal(await evaluate('document.querySelectorAll(".site-avatar").length'),snapshot.rows);
  assert.ok(await evaluate('[...document.querySelectorAll("img")].every(img=>img.closest(".site-avatar") && img.src.startsWith("data:image/"))'));
  const checkGanttGeometry=async()=>{
    const measured=await evaluate(`(()=>{const gantt=document.getElementById('gantt'),start=Number(gantt.dataset.start),end=Number(gantt.dataset.end),width=gantt.getBoundingClientRect().width;return{columns:document.querySelectorAll('.head-label').length,bars:[...document.querySelectorAll('.visit-span')].map(bar=>{const row=bar.closest('.gantt-row'),label=row.querySelector('.page-label'),markers=[...row.querySelectorAll('.event-marker')];return{left:parseFloat(bar.style.left),width:parseFloat(bar.style.width),expectedLeft:60+(Number(bar.dataset.first)-start)/(end-start)*(width-84),expectedWidth:(Number(bar.dataset.last)-Number(bar.dataset.first))/(end-start)*(width-84),above:label.getBoundingClientRect().bottom<=bar.getBoundingClientRect().top,markers:markers.map(m=>parseFloat(m.style.left))};})};})()`);
    assert.equal(measured.columns,0,'Timeline must not reserve a fixed website column');
    const rowLayout=await evaluate(`([...document.querySelectorAll('.gantt-row')].map(row=>{const icon=row.querySelector('.page-icon').getBoundingClientRect(),name=row.querySelector('.page-label').getBoundingClientRect(),first=row.querySelector('.event-marker').getBoundingClientRect();return{separate:icon.right<first.left,above:name.bottom<icon.top,center:Math.abs((icon.top+icon.bottom-first.top-first.bottom)/2),inside:parseFloat(row.querySelector('.page-icon').style.left)>=0,labels:row.querySelectorAll('.page-label .page-title').length,extra:row.querySelectorAll('.page-domain,.page-count,.endpoint-label').length};}))`);
    for(const row of rowLayout){
      assert.equal(row.separate,true,'Site icon must sit left of the visit markers');
      assert.equal(row.above,true,'Only the page name belongs above the icon');
      assert.ok(row.center<=1,'Icon and visit bar must share the same vertical center');
      assert.equal(row.inside,true,'Icons near the first time tick must remain inside the canvas');
      assert.equal(row.labels,1);assert.equal(row.extra,0,'No extra domain, count or endpoint text in each row');
    }

    for(const bar of measured.bars){
      assert.ok(Math.abs(bar.left-bar.expectedLeft)<.01,'Bar start must match the first real visit');
      assert.ok(Math.abs(bar.width-bar.expectedWidth)<.01,'Bar width must match the visit span');
      assert.equal(bar.above,true,'Page labels must remain above the bar');
      assert.ok(bar.markers.every(x=>x>=bar.left-.01&&x<=bar.left+bar.width+.01));
    }
  };
  const checkFullDayOverview=async()=>{
    const layout=await evaluate(`(()=>{const chart=document.getElementById('chart-scroll'),g=document.getElementById('gantt'),rect=chart.getBoundingClientRect();const ticks=[...document.querySelectorAll('.axis-tick span')].filter(n=>getComputedStyle(n).visibility!=='hidden').map(n=>{const r=n.getBoundingClientRect();return{text:n.textContent,left:r.left,right:r.right};});return{width:g.getBoundingClientRect().width,available:chart.clientWidth,scroll:chart.scrollLeft,ticks,inside:ticks.every(t=>t.left>=rect.left&&t.right<=rect.left+chart.clientWidth),ids:[...document.querySelectorAll('.event-marker')].map(n=>n.dataset.eventId).sort()};})()`);
    assert.ok(Math.abs(layout.width-layout.available)<=1,'At 1×, the whole day must fit the screen');
    assert.equal(layout.scroll,0);
    assert.equal(layout.inside,true,'Visible time labels must fit inside the viewport');
    assert.equal(layout.ticks[0].text,'06:00');assert.equal(layout.ticks.at(-1).text,'24:00');
    if(layout.available>=330&&layout.available<460)assert.deepEqual(layout.ticks.map(t=>t.text),['06:00','12:00','18:00','24:00'],'The last-visit badge must not displace the main mobile time labels');
    assert.ok(layout.ticks.slice(1).every((tick,i)=>tick.left>=layout.ticks[i].right+9),'Time labels must not overlap on small screens');
    assert.deepEqual(layout.ids,expectedIds,'Fitting the day must not remove visits');
  };
  await checkGanttGeometry();
  await checkFullDayOverview();
  const names=await evaluate(`([...document.querySelectorAll('.page-title')].map(e=>e.textContent))`);
  const expectedNames=new Set(['arXiv','GitHub','Gitee','ChatGPT','Bing','飞书','哔哩哔哩','Kyutai']);
  if(seed.dataset_kind==='demo')assert.ok(names.every(name=>expectedNames.has(name)),'Chart labels must contain only the site name');
  await groupBy('page');assert.equal(await evaluate('timelineSnapshot().rows'),snapshot.windowPages);
  assert.equal(await evaluate('document.getElementById("row-count-label").textContent'),'个网页');
  await groupBy('site');assert.equal(await evaluate('timelineSnapshot().rows'),snapshot.rows);
  assert.equal(await evaluate('document.getElementById("row-count-label").textContent'),'个网站');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),expectedIds);
  const checkRulerReading=async()=>{
    await evaluate('document.activeElement?.blur()');
    const point=await evaluate(`(()=>{const c=document.getElementById('chart-scroll'),head=document.querySelector('.gantt-head').getBoundingClientRect(),g=document.getElementById('gantt'),r=c.getBoundingClientRect();const x=Math.round(r.left+c.clientWidth*.57),plotX=c.scrollLeft+x-r.left,start=Number(g.dataset.start),end=Number(g.dataset.end);return{x,y:head.top+35,plotX,ms:start+(plotX-60)/(g.getBoundingClientRect().width-84)*(end-start)};})()`);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
    await until(()=>evaluate('!document.getElementById("inspection-time").hidden'));
    const offsetMinutes=exportOffset==='Z'?0:(exportOffset[0]==='-'?-1:1)*(Number(exportOffset.slice(1,3))*60+Number(exportOffset.slice(4,6)));
    assert.equal(await evaluate('document.getElementById("inspection-time").textContent'),new Date(point.ms+offsetMinutes*60000).toISOString().slice(11,16),'Ruler reading uses the export timezone and pointer time');
    assert.ok(Math.abs(await evaluate('parseFloat(document.getElementById("inspection-line").style.left)')-point.plotX)<1,'Ruler guide must follow the actual time position');
    assert.equal(await evaluate('document.getElementById("event-preview").hidden'),true,'Reading empty time must not invent a visit popup');
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:10});
    assert.equal(await evaluate('document.getElementById("inspection-line").hidden'),true);
  };
  await checkRulerReading();
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  const spanSeed=await evaluate(`(()=>{const bar=document.querySelector('.visit-span');if(!bar)return null;bar.focus();return{first:Number(bar.dataset.first),last:Number(bar.dataset.last),site:bar.closest('.gantt-row').dataset.site};})()`);
  if(spanSeed){
    await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
    assert.equal(await evaluate('document.activeElement.tagName'),'BUTTON','A span must support keyboard and touch activation');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-describedby")'),'event-preview');
    assert.ok(await evaluate('document.querySelector(".span-preview-note").textContent.includes("非持续停留")'));
    assert.equal(await evaluate('document.querySelectorAll(".span-preview-range time").length'),2);
    assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector(".span-preview-range")).fontSize)>=18'));
    assert.equal(await evaluate('document.getElementById("inspection-line").hidden'),true,'A span summary must not imply an extra visit');
    await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_span_preview.png'),Buffer.from(r.data,'base64')));
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
    assert.equal(await evaluate('document.getElementById("drawer").hidden'),false);
    assert.equal(await evaluate('document.getElementById("detail-pages").hidden'),false,'A site span opens its page outline');
    await click('#drawer-close');
    assert.equal(await evaluate('document.activeElement.classList.contains("visit-span")'),true,'Closing span details returns keyboard focus');
    await evaluate('document.activeElement.blur()');
    const hoverSpan=await evaluate(`(()=>{const bar=document.querySelector('.visit-span'),r=bar.getBoundingClientRect(),markers=[...bar.closest('.gantt-row').querySelectorAll('.event-marker')].map(n=>n.getBoundingClientRect());for(let i=1;i<10;i++){const x=r.left+r.width*i/10;if(markers.every(m=>x<m.left-1||x>m.right+1))return{x,y:r.top+r.height/2};}return null;})()`);
    if(hoverSpan){
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverSpan});
      await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
      assert.equal(await evaluate('document.querySelector(".visit-span.inspected")!==null'),true,'Hovering the actual bar opens its contextual preview');
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:10});
      assert.equal(await evaluate('document.getElementById("event-preview").hidden'),true);
    }
  }
  // Expand one site in place without duplicating visits or changing time positions.
  const branch=await evaluate(`(()=>{const t=document.querySelector('.site-toggle');if(!t)return null;const row=t.closest('.gantt-row');return{key:row.dataset.pageKey,id:t.getAttribute('aria-controls'),count:row.querySelectorAll('.event-marker').length,points:Object.fromEntries([...document.querySelectorAll('.event-marker')].map(n=>[n.dataset.eventId,parseFloat(n.style.left)]))};})()`);
  if(branch){
    await click('.site-toggle');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'),'true');
    assert.equal(await evaluate(`document.getElementById(${JSON.stringify(branch.id)}).hidden`),false);
    const expanded=await evaluate(`(()=>{const children=document.getElementById(${JSON.stringify(branch.id)});return{pages:children.querySelectorAll('.gantt-child').length,events:children.querySelectorAll('.event-marker').length,parentEvents:children.previousElementSibling.querySelectorAll('.event-marker').length,points:Object.fromEntries([...document.querySelectorAll('.event-marker')].map(n=>[n.dataset.eventId,parseFloat(n.style.left)]))};})()`);
    assert.ok(expanded.pages>1);assert.equal(expanded.events,branch.count);assert.equal(expanded.parentEvents,0,'The expanded summary must not duplicate child visits');
    await checkFullDayOverview();
    assert.deepEqual(expanded.points,branch.points,'Expansion must retain every exact visit coordinate');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),expectedIds);
    assert.equal(await evaluate('timelineSnapshot().rows'),snapshot.rows,'The toolbar still counts sites');
    assert.ok(await evaluate('[...document.querySelectorAll(".gantt-child .track")].every(n=>n.style.getPropertyValue("--color")===n.closest(".site-children").previousElementSibling.querySelector(".track").style.getPropertyValue("--color"))'),'Child pages inherit the site color');
    assert.ok(await evaluate('[...document.querySelectorAll(".gantt-child .page-title")].every(n=>parseFloat(getComputedStyle(n).fontSize)>=16)'));
    await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_expanded.png'),Buffer.from(r.data,'base64')));
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(180);
    assert.equal(await evaluate('document.activeElement.classList.contains("site-toggle")'),true,'The expansion control retains focus on resize');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'),'true');
    assert.ok(await evaluate(`(()=>{const c=document.getElementById('chart-scroll').getBoundingClientRect();return [...document.querySelectorAll('.row-identity')].every(n=>{const r=n.getBoundingClientRect();return r.left>=c.left&&r.right<=c.right;});})()`),'Expanded names remain within the phone canvas');
    await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_expanded_mobile.png'),Buffer.from(r.data,'base64')));
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft'});
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-expanded")'),'false');
    assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),0);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
    assert.ok(await evaluate('document.querySelectorAll(".gantt-child").length>1'));
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft'});
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await pause(180);
    await evaluate('document.getElementById("chart-scroll").scrollTop=0');
  }
  const search=async query=>evaluate(`document.getElementById('search').value=${JSON.stringify(query)};document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}));`);
  const site=displayedSeed[0].domain;
  await search(site.toUpperCase());
  const groups=new Map();for(const event of displayedSeed){const key=JSON.stringify([event.page_key,event.profile]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(event);}
  const searchMatches=[...groups.values()].filter(events=>events.some(e=>(e.title+' '+e.url+' '+e.domain).toLowerCase().includes(site.toLowerCase())));
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),searchMatches.reduce((n,events)=>n+events.length,0));
  assert.equal(await evaluate('timelineSnapshot().shown'),searchMatches.length);
  await search('');
  await evaluate('document.activeElement?.blur()');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'/',code:'Slash'});
  assert.equal(await evaluate('document.activeElement.id'),'search');
  await search('no-such-page-1938');
  assert.equal(await evaluate('timelineSnapshot().shown'),0);
  assert.ok(await evaluate('document.querySelector(".empty-state").textContent.includes("没有符合")'));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  assert.equal(await evaluate('timelineSnapshot().shown'),snapshot.windowPages);
  assert.equal(await evaluate('document.getElementById("search").value'),'');
  await evaluate('document.activeElement?.blur()');
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_desktop.png'),Buffer.from(r.data,'base64')));
  await click('.page-label');
  assert.equal(await evaluate('document.getElementById("drawer").hidden'),false);
  assert.equal(await evaluate('document.getElementById("detail-pages").hidden'),false);
  assert.equal(await evaluate('document.getElementById("detail-visits").hidden'),true);
  const pageTabsTop=await checkPageListPriority();
  await click('#detail-visits-tab');
  assert.equal(await evaluate('document.querySelector(".detail-grid").getClientRects().length>0'),true,'Visit statistics remain available in the visit tab');
  assert.equal(await evaluate('document.querySelector(".detail-note").getClientRects().length>0'),true,'Preserve the visit-time limitation alongside the evidence');
  assert.ok(Math.abs(await evaluate('document.getElementById("detail-tabs").getBoundingClientRect().top')-pageTabsTop)<=1,'Switching views must not move their tabs');
  await click('#detail-pages-tab');
  await checkPageListPriority();
  await evaluate('document.getElementById("drawer-close").focus()');
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_pages.png'),Buffer.from(r.data,'base64')));
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate('getComputedStyle(document.getElementById("drawer")).animationName'),'none');
  await command('Emulation.setEmulatedMedia',{features:[]});
  assert.ok(await evaluate(`(${JSON.stringify([...new Set(seed.events.map(e=>e.profile))])}).some(profile=>document.getElementById('event-list').textContent.includes(profile+':'))`));
  const drawerOpener=await evaluate('document.querySelector(".page-label").closest(".gantt-row").dataset.pageKey');
  await command('Emulation.setDeviceMetricsOverride',{width:1024,height:1040,deviceScaleFactor:1,mobile:false});await pause(180);
  assert.equal(await evaluate('document.activeElement.id'),'drawer-close','Resizing must retain focus inside an open drawer');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  assert.equal(await evaluate('document.getElementById("drawer").hidden'),true);
  assert.equal(await evaluate('document.activeElement.closest(".gantt-row")?.dataset.pageKey'),drawerOpener,'Closing a resized drawer must return focus to its original site');
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await pause(180);
  assert.equal(await evaluate('document.activeElement.closest(".gantt-row")?.dataset.pageKey'),drawerOpener,'A focused site label must survive the return to desktop width');
  await click('.page-icon');assert.equal(await evaluate('document.getElementById("drawer").hidden'),false);await click('#drawer-close');
  assert.equal(await evaluate('timelineSnapshot().range'),'06-24');
  assert.equal(snapshot.start,windowStart);assert.equal(snapshot.end,windowEnd);
  assert.equal(snapshot.windowEvents,displayedSeed.length);
  assert.equal(await evaluate('document.getElementById("range-label").textContent'),'06:00 — 24:00');
  assert.deepEqual(await evaluate('(()=>{const ticks=[...document.querySelectorAll(".axis-tick span")];return[ticks[0].textContent,ticks.at(-1).textContent];})()'),['06:00','24:00']);
  const originalWidth=await evaluate('document.querySelector(".time-axis").getBoundingClientRect().width');
  await click('#zoom-in');assert.equal(await evaluate('timelineSnapshot().zoom'),2);
  assert.equal(await evaluate('document.querySelector(".time-axis").getBoundingClientRect().width'),originalWidth*2);
  await checkGanttGeometry();
  await click('#zoom-out');
  // Use the chart as a reader: inspect visits without opening a drawer, keep
  // the same time under the pointer when zooming, and pan without losing names.
  const timeUnder=async anchor=>evaluate(`(()=>{const c=document.getElementById('chart-scroll'),g=document.getElementById('gantt');return(c.scrollLeft+${anchor}-60)/(g.getBoundingClientRect().width-84);})()`);
  const center=await evaluate('document.getElementById("chart-scroll").clientWidth/2');
  const beforeZoom=await timeUnder(center);
  await click('#zoom-in');
  const centerError=Math.abs(await timeUnder(center)-beforeZoom)*(await evaluate('document.getElementById("gantt").getBoundingClientRect().width')-84);
  assert.ok(centerError<=1,`Button zoom must preserve the center time within one pixel, got ${centerError}px`);
  await evaluate('document.getElementById("chart-scroll").scrollLeft=400');await pause(60);
  const pointerAnchor=160,beforeWheel=await timeUnder(pointerAnchor);
  await evaluate(`(()=>{const c=document.getElementById('chart-scroll'),r=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-80,clientX:r.left+${pointerAnchor},bubbles:true,cancelable:true}));})()`);
  assert.equal(await evaluate('timelineSnapshot().zoom'),4);
  const pointerError=Math.abs(await timeUnder(pointerAnchor)-beforeWheel)*(await evaluate('document.getElementById("gantt").getBoundingClientRect().width')-84);
  assert.ok(pointerError<=1,`Wheel zoom must preserve the pointer time within one pixel, got ${pointerError}px`);
  await evaluate(`(()=>{const c=document.getElementById('chart-scroll'),r=c.getBoundingClientRect();document.querySelector('.gantt-head').dispatchEvent(new MouseEvent('dblclick',{clientX:r.left+${pointerAnchor},bubbles:true}));})()`);
  assert.equal(await evaluate('timelineSnapshot().zoom'),8);
  await checkRulerReading();
  await evaluate('document.getElementById("chart-scroll").scrollLeft=900');await pause(80);
  const pinnedLabels=await evaluate(`(()=>{const c=document.getElementById('chart-scroll').getBoundingClientRect();return[...document.querySelectorAll('.page-label')].map(n=>{const r=n.getBoundingClientRect(),t=n.querySelector('.page-title');return{inside:r.left>=c.left&&r.right<=c.right,clipped:t.scrollWidth>t.clientWidth+1};});})()`);
  assert.ok(pinnedLabels.every(label=>label.inside),'Panning must retain the short site names inside the viewport');
  assert.ok(pinnedLabels.every(label=>!label.clipped),'Short site names must not become clipped after repeated layout');
  const resizeFocus=await evaluate(`(()=>{const c=document.getElementById('chart-scroll').getBoundingClientRect(),marker=[...document.querySelectorAll('.event-marker')].find(n=>{const r=n.getBoundingClientRect();return r.left>=c.left&&r.right<=c.right&&r.top>c.top+64&&r.bottom<c.bottom;});if(!marker)throw Error('No visible visit for resize reading');marker.focus({preventScroll:true});return marker.dataset.eventId;})()`);await pause(40);
  const resizeReading=async width=>{
    const before=await evaluate(`(()=>{const c=document.getElementById('chart-scroll'),g=document.getElementById('gantt');return{time:(c.scrollLeft+c.clientWidth/2-60)/(g.getBoundingClientRect().width-84),zoom:timelineSnapshot().zoom};})()`);
    await command('Emulation.setDeviceMetricsOverride',{width,height:1040,deviceScaleFactor:1,mobile:width<760});await pause(180);
    const after=await evaluate(`(()=>{const c=document.getElementById('chart-scroll'),g=document.getElementById('gantt'),left=c.scrollLeft;c.scrollLeft=1e6;const maxLeft=c.scrollLeft;c.scrollLeft=left;return{left,maxLeft,width:g.getBoundingClientRect().width,viewport:c.clientWidth,zoom:timelineSnapshot().zoom};})()`);
    const desired=60+before.time*(after.width-84)-after.viewport/2,expected=Math.max(0,Math.min(after.maxLeft,desired));
    assert.ok(Math.abs(after.left-expected)<=1,`Resize to ${width}px must retain the reading time within scroll bounds: ${JSON.stringify({before,after,expected})}`);
    assert.equal(after.zoom,before.zoom,'Resizing must keep the selected zoom');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),expectedIds);
  };
  await resizeReading(1024);
  assert.equal(await evaluate('document.activeElement.dataset.eventId'),resizeFocus,'The focused visit must survive resizing');
  await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
  await resizeReading(390);
  assert.equal(await evaluate('document.activeElement.dataset.eventId'),resizeFocus,'Keep the same visit when moving to mobile width');
  // Widening from the right edge lets the browser clamp the old scroll offset
  // before the debounced render. Restore the time from the last stable layout.
  await evaluate('document.activeElement.blur();document.getElementById("chart-scroll").scrollLeft=1e6');await pause(60);
  await resizeReading(1440);
  await click('#zoom-label');assert.equal(await evaluate('timelineSnapshot().zoom'),1);
  await evaluate('document.getElementById("chart-scroll").scrollTo(0,0)');await pause(60);
  await evaluate('document.querySelector(".event-marker").focus()');
  await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
  assert.equal(await evaluate('document.getElementById("event-preview").hidden'),false);
  assert.equal(await evaluate('document.getElementById("drawer").hidden'),true);
  const inspectedId=await evaluate('document.activeElement.dataset.eventId');
  const inspectedSeed=seed.events.find(e=>`${e.profile}:${e.visit_id}`===inspectedId);
  assert.ok(await evaluate(`document.getElementById('event-preview').textContent.includes(${JSON.stringify(inspectedSeed.title)})`));
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-describedby")'),'event-preview');
  assert.equal(await evaluate('document.getElementById("inspection-time").textContent'),inspectedSeed.time.slice(11,16));
  const previewBounds=await evaluate('(()=>{const r=document.getElementById("event-preview").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()');
  assert.equal(previewBounds,true,'Visit preview must stay inside the viewport');
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_inspection.png'),Buffer.from(r.data,'base64')));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  assert.equal(await evaluate('document.getElementById("event-preview").hidden'),true);
  assert.equal(await evaluate('document.getElementById("inspection-line").hidden'),true);
  await evaluate('document.activeElement.blur()');
  const hoverPoint=await evaluate('(()=>{const r=document.querySelector(".event-marker").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverPoint});await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
  assert.equal(await evaluate('document.getElementById("drawer").hidden'),true);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:10});
  assert.equal(await evaluate('document.getElementById("event-preview").hidden'),true,'Moving away must remove the transient preview');
  await search('no-such-page-1938');assert.equal(await evaluate('document.getElementById("clear-search").hidden'),false);
  await click('#clear-search');assert.equal(await evaluate('timelineSnapshot().shownEvents'),displayedSeed.length);
  await click('#display-options > summary');
  await click('#show-spans');assert.equal(await evaluate('document.querySelectorAll(".visit-span").length'),0);
  await click('#show-spans');
  await click('#display-options > summary');
  await evaluate('document.getElementById("sort").value="count";document.getElementById("sort").dispatchEvent(new Event("change",{bubbles:true}));');
  const counts=await evaluate('[...document.querySelectorAll(".gantt-row")].map(row=>row.querySelectorAll(".event-marker").length)');
  assert.equal(counts[0],Math.max(...counts));

  const fixture={status:'complete',start_time:'2026-11-01T00:00:00+08:00',end_time:'2026-11-01T12:00:00+08:00',event_count:5,profiles:[],errors:[],visits:[
    {profile:'Default',visit_id:1,visit_time:'2026-11-01T09:00:00+08:00',title:'</script><img src="https://unwanted.example/x">',url:'https://user:password@github.com.evil.example/watch?v=one&token=secret',icon:'https://unwanted.example/favicon.png'},
    {profile:'Profile 1',visit_id:1,visit_time:'2026-11-01T10:00:00+08:00',title:'Different page',url:'https://github.com/'},
    {profile:'Default',visit_id:2,visit_time:'2026-11-01T11:00:00+08:00',title:'Project detail',url:'https://github.com/project'},
    {profile:'Profile 1',visit_id:2,visit_time:'2026-11-01T10:30:00+08:00',title:'GitHub docs · 中文文档 (C++)',url:'https://docs.github.com/en'},
    {profile:'Default',visit_id:3,visit_time:'2026-11-01T11:30:00+08:00',title:'Project readme',url:'https://github.com/project?view=readme'}]};
  const fixturePath=path.join(qaRoot,'fixture.json');fs.writeFileSync(fixturePath,JSON.stringify(fixture));
  const importFile=async file=>{const doc=await command('DOM.getDocument');const input=await command('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#import-file'});await command('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[file]});await until(()=>evaluate('document.getElementById("import-file").value===""'));if(await evaluate('document.getElementById("import-state").textContent')==='已导入 '+path.basename(file))assert.equal(await evaluate('timelineSnapshot().grouping'),'page','Imported data also starts with visible page titles');await groupBy('site');};
  await importFile(fixturePath);await until(()=>evaluate('timelineSnapshot().events===5'));
  await checkCoverage([['2026-11-01T12:00:00+08:00','2026-11-02T00:00:00+08:00']]);
  const boundedPath=path.join(qaRoot,'bounded.json');fs.writeFileSync(boundedPath,JSON.stringify({...fixture,start_time:'2026-11-01T08:00:00+08:00'}));
  await importFile(boundedPath);await until(()=>evaluate('document.getElementById("coverage-note").textContent.includes("08:00:00")'));
  await checkCoverage([['2026-11-01T06:00:00+08:00','2026-11-01T08:00:00+08:00'],['2026-11-01T12:00:00+08:00','2026-11-02T00:00:00+08:00']]);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),['Default:1','Default:2','Default:3','Profile 1:1','Profile 1:2']);
  const emptyPath=path.join(qaRoot,'empty.json');fs.writeFileSync(emptyPath,JSON.stringify({...fixture,event_count:0,visits:[]}));
  await importFile(emptyPath);await until(()=>evaluate('timelineSnapshot().events===0'));
  await checkCoverage([['2026-11-01T12:00:00+08:00','2026-11-02T00:00:00+08:00']]);
  await importFile(fixturePath);await until(()=>evaluate('timelineSnapshot().events===5'));
  assert.equal(await evaluate('document.querySelectorAll(".gantt-row").length'),2);
  assert.equal(await evaluate('document.getElementById("profile-field").hidden'),false);
  const importedNames=await evaluate('[...document.querySelectorAll(".page-title")].map(e=>e.textContent)');
  assert.deepEqual(importedNames.sort(),['GitHub','github.com.evil.example'].sort(),'Unknown and spoof domains must not acquire a trusted site name');
  await click('.gantt-row[data-site="github.com"] .site-toggle');
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),4,'Keep query variants and profiles separate when expanded');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),['Default:1','Default:2','Default:3','Profile 1:1','Profile 1:2']);
  await search('github /project');
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),2,'Search must filter child pages before displaying the branch');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),['Default:2','Default:3']);
  await evaluate('document.getElementById("profile-filter").value="Profile 1";document.getElementById("profile-filter").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),0);
  await search('');
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),2,'An open branch follows the active profile');
  await evaluate('document.getElementById("profile-filter").value="all";document.getElementById("profile-filter").dispatchEvent(new Event("change"))');
  await search('Different page');
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),0,'A single matching page needs no redundant child row');
  await search('');
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),4,'Clearing search restores the original expansion');
  await click('.gantt-row[data-site="github.com"] .site-toggle');
  await search('Different page');assert.equal(await evaluate('timelineSnapshot().shown'),1);await search('');
  await search('watch');assert.equal(await evaluate('timelineSnapshot().shown'),1);await search('');
  // A remembered site and topic need not sit next to each other in the title.
  // Match all terms within a source page before folding it into a site row.
  for(const [query,ids] of [
    ['中文 github',['Profile 1:2']],
    ['GITHUB　中文',['Profile 1:2']],
    ['  readme   github  ',['Default:3']],
    ['github /project',['Default:2','Default:3']],
    ['docs readme',[]],
    ['github 中文 missing-word',[]]
  ]){
    await search(query);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),ids,`All search terms must match the same source page: ${query}`);
  }
  await search('github /project');assert.equal(await evaluate('timelineSnapshot().rows'),1);assert.equal(await evaluate('timelineSnapshot().shown'),2);
  await groupBy('page');assert.equal(await evaluate('timelineSnapshot().rows'),2);
  await groupBy('site');assert.equal(await evaluate('timelineSnapshot().rows'),1);
  await search('');assert.equal(await evaluate('timelineSnapshot().shownEvents'),5);
  // Highlight evidence in the detail/preview without adding text to chart rows.
  await search('中文 github');await click('.page-label');
  assert.equal(await evaluate('document.querySelector(".page-group-meta time")?.textContent'),'10:30','Show the first local visit to distinguish similar page titles');
  assert.equal(await evaluate('document.querySelector(".page-group-meta time").dateTime'),fixture.visits[3].visit_time);
  assert.equal(await evaluate('document.querySelector(".page-group-meta").textContent.includes("Profile 1")'),false,'A single visible profile is already identified in the drawer header');
  assert.ok(await evaluate('document.querySelector(".page-group-meta").textContent.includes("首次")'));
  assert.equal(await evaluate('document.querySelector(".page-group-title").textContent'),fixture.visits[3].title);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-title mark")].map(n=>n.textContent)'),['GitHub','中文'],'Show the matching words inside long page titles');
  assert.ok(await evaluate('[...document.querySelectorAll(".page-group-title mark")].every(n=>parseFloat(getComputedStyle(n).fontSize)>=16)'));
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_search_detail.png'),Buffer.from(r.data,'base64')));
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(180);
  assert.equal(await evaluate('document.getElementById("drawer").scrollWidth<=document.getElementById("drawer").clientWidth'),true);
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_search_detail_mobile.png'),Buffer.from(r.data,'base64')));
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await pause(180);
  await click('#detail-visits-tab');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-page-title mark")].map(n=>n.textContent)'),['GitHub','中文']);
  await click('#drawer-close');await evaluate('document.querySelector(".event-marker").focus()');
  await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".preview-title mark")].map(n=>n.textContent)'),['GitHub','中文']);
  await evaluate('document.activeElement.blur()');
  await search('C++');await click('.page-label');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-title mark")].map(n=>n.textContent)'),['C++'],'Search metacharacters remain literal text');
  await click('#drawer-close');await search('<img');await click('.page-label');
  assert.equal(await evaluate('document.querySelector(".page-group-title").textContent'),fixture.visits[0].title);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-title mark")].map(n=>n.textContent)'),['<img']);
  assert.equal(await evaluate('document.querySelectorAll(".page-group-title img, .page-group-title script").length'),0,'Highlighting must never interpret source text as HTML');
  await click('#drawer-close');await search('');await click('.page-label');
  assert.equal(await evaluate('document.querySelectorAll("#drawer mark").length'),0,'Opening details after clearing search removes query highlights');
  await click('#drawer-close');
  // Pinyin/IME candidates are unfinished text. Keep the current reading state
  // until composition commits, and let Escape cancel the candidate list.
  await search('Different page');
  await evaluate(`(()=>{const input=document.getElementById('search');input.focus();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='zhong';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'zhong'}));})()`);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId)'),['Profile 1:1'],'Uncommitted IME input must not blank or move the current result');
  await evaluate(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,isComposing:true}));`);
  assert.equal(await evaluate('document.getElementById("search").value'),'zhong','Escape during composition belongs to the input method');
  await evaluate(`(()=>{const input=document.getElementById('search');input.value='中文';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));})()`);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId)'),['Profile 1:2'],'Committed Chinese text must filter the original page titles');
  assert.equal(await evaluate('document.activeElement.id'),'search');
  const duplicateCommit=await evaluate(`(()=>{const input=document.getElementById('search'),marker=document.querySelector('.event-marker');input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText',data:'中文'}));return marker===document.querySelector('.event-marker');})()`);
  assert.equal(duplicateCommit,true,'The final input event must not redraw an already applied composition');
  await search('Different page');
  const cancelledComposition=await evaluate(`(()=>{const input=document.getElementById('search'),marker=document.querySelector('.event-marker');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='wen';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));input.value='Different page';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));return marker===document.querySelector('.event-marker');})()`);
  assert.equal(cancelledComposition,true,'Cancelling composition must preserve the existing result');
  await search('watch');assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId)'),['Default:1'],'Ordinary typing must resume after cancellation');
  await search('');assert.equal(await evaluate('timelineSnapshot().shownEvents'),5);
  assert.equal(await evaluate('document.querySelectorAll("img").length'),1);
  assert.ok(await evaluate('document.querySelector(".site-avatar img").src.startsWith("data:image/")'));
  assert.equal(await evaluate('timelineSnapshot().pages'),5,'Query variants remain distinct source pages');
  await groupBy('page');assert.equal(await evaluate('timelineSnapshot().rows'),5);
  await click('.page-label');
  assert.equal(await evaluate('document.getElementById("detail-tabs").hidden'),true);
  assert.equal(await evaluate('document.querySelector(".detail-grid").getClientRects().length>0'),true,'Single-page details still expose their visit summary');
  assert.equal(await evaluate('document.getElementById("detail-url").getClientRects().length>0'),true,'Single-page details still show the redacted URL');
  await click('#drawer-close');
  await groupBy('site');assert.equal(await evaluate('timelineSnapshot().rows'),2);
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),5);
  await click('.gantt-row[data-site="github.com"] .page-label');
  assert.equal(await evaluate('document.getElementById("detail-title").textContent'),'GitHub');
  assert.equal(await evaluate('document.getElementById("detail-pages-tab").textContent'),'网页 4');
  assert.equal(await evaluate('document.querySelectorAll(".page-group").length'),4,'Group by source page/profile, not displayed title or redacted URL');
  assert.equal(await evaluate('new Set([...document.querySelectorAll(".page-group")].map(group=>group.dataset.pageKey)).size'),4);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-events li")].map(e=>e.dataset.eventId).sort()'),['Default:2','Default:3','Profile 1:1','Profile 1:2']);
  const pageMeta=await evaluate('[...document.querySelectorAll(".page-group")].map(g=>({id:g.querySelector(".page-group-events li").dataset.eventId,text:g.querySelector(".page-group-meta").textContent,time:g.querySelector(".page-group-meta time").textContent,datetime:g.querySelector(".page-group-meta time").dateTime}))');
  for(const meta of pageMeta){const event=fixture.visits.find(e=>`${e.profile}:${e.visit_id}`===meta.id);assert.equal(meta.time,event.visit_time.slice(11,16));assert.equal(meta.datetime,event.visit_time);assert.ok(meta.text.endsWith(event.profile),'Keep profile labels when a site includes multiple profiles');}
  assert.ok(await evaluate('[...document.querySelectorAll(".page-group")].every(group=>!group.open)'),'Repeated visits are collapsed by default');
  await click('.page-group > summary');
  assert.equal(await evaluate('document.querySelector(".page-group").open'),true);
  assert.equal(await evaluate('document.querySelector(".page-group-link").getAttribute("rel")'),'noreferrer noopener');
  await click('#detail-visits-tab');
  assert.equal(await evaluate('document.getElementById("detail-visits").hidden'),false);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft'});
  assert.equal(await evaluate('document.getElementById("detail-pages").hidden'),false);
  assert.equal(await evaluate('document.activeElement.id'),'detail-pages-tab');
  await evaluate('document.getElementById("drawer-close").focus()');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:8});
  assert.equal(await evaluate('document.activeElement.matches(".page-group > summary")'),true,'Focus trap must skip hidden visit links and collapsed group links: '+await evaluate('document.activeElement.outerHTML.slice(0,250)'));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'});
  assert.equal(await evaluate('document.activeElement.id'),'drawer-close');
  assert.equal(await evaluate('document.querySelectorAll("#event-list li").length'),4);
  assert.equal(await evaluate('document.querySelectorAll("#event-list a.event-page-title").length'),4);
  assert.ok(await evaluate('document.getElementById("event-list").textContent.includes("GitHub docs")'));
  assert.ok(await evaluate('document.getElementById("event-list").textContent.includes("Project readme")'));
  await click('#drawer-close');
  await search('GitHub docs');await click('.page-label');
  assert.equal(await evaluate('document.querySelectorAll(".page-group").length'),1,'Page outline must follow the active search');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-events li")].map(e=>e.dataset.eventId)'),['Profile 1:2']);
  await click('#drawer-close');await search('');
  // Search from a zoomed evening viewport must reveal a morning match without
  // changing the scale. Dismissing search restores the original reading place.
  await click('#zoom-in');await click('#zoom-in');await click('#zoom-in');
  for(const clear of ['button','escape','input']){
    const readingLeft=await evaluate('(()=>{const c=document.getElementById("chart-scroll");c.scrollLeft=c.scrollWidth-c.clientWidth;document.getElementById("search").focus();return c.scrollLeft;})()');
    await search('Different page');
    const visibleMatch=await evaluate('(()=>{const r=document.querySelector(".event-marker").getBoundingClientRect(),c=document.getElementById("chart-scroll").getBoundingClientRect();return r.left>=c.left&&r.right<=c.right;})()');
    assert.equal(visibleMatch,true,'Search must reveal its real visit instead of leaving the match outside the viewport');
    assert.equal(await evaluate('timelineSnapshot().zoom'),8,'Searching must preserve the chosen scale');
    assert.equal(await evaluate('document.activeElement.id'),'search','Search must not steal typing focus');
    if(clear==='button')await click('#clear-search');
    else if(clear==='escape')await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
    else await search('');
    assert.ok(Math.abs(await evaluate('document.getElementById("chart-scroll").scrollLeft')-readingLeft)<=1,'Dismissing search must restore the original time position');
    assert.equal(await evaluate('timelineSnapshot().shownEvents'),5);
  }
  await evaluate('(()=>{const c=document.getElementById("chart-scroll");c.scrollLeft=c.scrollWidth/2;})()');
  const originalReadingTime=await timeUnder(center);
  await search('Different page');await click('#zoom-out');await click('#clear-search');
  assert.equal(await evaluate('timelineSnapshot().zoom'),4,'Clearing search must keep a scale adjusted during the search');
  const restoredError=Math.abs(await timeUnder(center)-originalReadingTime)*(await evaluate('document.getElementById("gantt").getBoundingClientRect().width')-84);
  assert.ok(restoredError<=1,'Search must restore the original time rather than old pixel offsets when the scale changes');
  await click('#zoom-label');
  await evaluate('document.getElementById("profile-filter").value="Profile 1";document.getElementById("profile-filter").dispatchEvent(new Event("change",{bubbles:true}));');
  assert.equal(await evaluate('timelineSnapshot().shown'),2);
  assert.equal(await evaluate('timelineSnapshot().rows'),1);
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),2);
  await command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:qaRoot});
  await click('#export-button');
  const saved=await until(()=>fs.readdirSync(qaRoot).find(name=>name.endsWith('.html')));
  const exported=fs.readFileSync(path.join(qaRoot,saved),'utf8');
  const savedData=JSON.parse(exported.match(/<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.ok(!JSON.stringify(savedData).includes('password'));assert.ok(!JSON.stringify(savedData).includes('token=secret'));
  await open(path.join(qaRoot,saved));assert.equal(await evaluate('timelineSnapshot().events'),5);
  assert.equal(await evaluate('timelineSnapshot().grouping'),'page','Saved reports reopen with content visible');
  await groupBy('site');
  assert.equal(await evaluate('document.querySelectorAll("img").length'),1);
  const bad={...fixture,event_count:99};const badPath=path.join(qaRoot,'bad.json');fs.writeFileSync(badPath,JSON.stringify(bad));
  await importFile(badPath);await until(()=>evaluate('!document.getElementById("error").hidden'));
  assert.equal(await evaluate('timelineSnapshot().events'),5);
  // A dense cluster keeps every visit and supports precise keyboard selection.
  const dense={...fixture,start_time:'2026-11-01T00:00:00+08:00',end_time:'2026-11-01T23:59:59+08:00',event_count:12,visits:Array.from({length:12},(_,i)=>({profile:'Default',visit_id:100+i,visit_time:`2026-11-01T10:00:${String(i).padStart(2,'0')}+08:00`,title:i===1?'Untrusted <img src="https://unwanted.example/preview">':`Dense visit ${i}`,url:`https://github.com/project/${i}`}))};
  const densePath=path.join(qaRoot,'dense.json');fs.writeFileSync(densePath,JSON.stringify(dense));
  await importFile(densePath);await until(()=>evaluate('timelineSnapshot().events===12'));
  await click('.site-toggle');
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),12);
  assert.equal(await evaluate('document.querySelectorAll(".gantt-child .page-title img,.gantt-child .page-title script").length'),0,'Expanded titles remain inert text');
  assert.ok(await evaluate('[...document.querySelectorAll(".gantt-child .page-title")].some(n=>n.textContent.includes("<img"))'));
  const childId=await evaluate('document.querySelector(".gantt-child .event-marker").dataset.eventId');
  await click('.gantt-child .event-marker');
  assert.equal(await evaluate('document.querySelectorAll("#event-list li").length'),1,'A child marker opens its original page evidence');
  assert.equal(await evaluate('document.querySelector("#event-list .focused").textContent.includes('+JSON.stringify(childId)+')'),true);
  await click('#drawer-close');await click('.site-toggle');
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  await evaluate('document.querySelector(".event-marker").blur();document.querySelector(".event-marker").focus()');await until(()=>evaluate('!document.getElementById("event-preview").hidden'));
  assert.ok(await evaluate('document.querySelector(".preview-count").textContent.includes("12")'));
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),12);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});await pause(60);
  assert.equal(await evaluate('document.activeElement.dataset.eventId'),'Default:101');
  assert.ok(await evaluate('document.querySelector(".preview-title").textContent.includes("<img")'));
  assert.equal(await evaluate('document.querySelectorAll("#event-preview img").length'),1,'Only the bundled site icon can render as an image');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await pause(60);
  assert.equal(await evaluate('document.getElementById("drawer").hidden'),false);
  assert.equal(await evaluate('document.getElementById("detail-pages").hidden'),true,'Selecting an exact visit must open the chronological evidence directly');
  assert.equal(await evaluate('document.getElementById("detail-visits").hidden'),false);
  assert.ok(await evaluate('document.querySelector("#event-list .focused").textContent.includes("<img")'));
  assert.equal(await evaluate('document.querySelectorAll("#event-list li").length'),12);
  assert.equal(await evaluate('document.getElementById("event-preview").hidden'),true);
  await click('#drawer-close');
  await evaluate('document.querySelector(".event-marker").focus()');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});await pause(60);
  assert.equal(await evaluate('document.activeElement.dataset.eventId'),'Default:111');
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'});await pause(60);
  assert.equal(await evaluate('document.activeElement.dataset.eventId'),'Default:100');
  // ISO values without fractional seconds must not leak a sliced "+08:" into
  // displayed clocks, and per-event offsets must normalize to the export zone.
  dense.visits[0].visit_time='2026-11-01T02:00:00Z';fs.writeFileSync(densePath,JSON.stringify(dense));
  await importFile(densePath);await until(()=>evaluate('document.querySelector(".event-marker").getAttribute("aria-label").includes("10:00:00")'));
  await click('.page-label');
  assert.equal(await evaluate('document.getElementById("detail-first").textContent'),'10:00:00');
  assert.equal(await evaluate('document.getElementById("detail-last").textContent'),'10:00:11');
  assert.equal(await evaluate('document.querySelector(".page-group-events time").textContent'),'10:00:00');
  await click('#drawer-close');
  // Optional scale check: thousands of visits should remain usable without
  // weakening source identities or the compact, site-grouped default.
  if(process.env.TIMELINE_TEST_STRESS==='1'){
    const totalPages=1200,totalEvents=totalPages*4,dayStart=Date.parse('2026-11-01T06:00:00+08:00');
    const stressData={status:'complete',dataset_kind:'demo',start_time:'2026-11-01T00:00:00+08:00',end_time:'2026-11-01T23:59:59+08:00',event_count:totalEvents,profiles:[],errors:[],visits:[]};
    for(let page=0;page<totalPages;page++)for(let repeat=0;repeat<4;repeat++){
      const instant=dayStart+((page*17+repeat*79)%(18*60))*60000;
      stressData.visits.push({profile:Math.floor(page/12)%2?'Profile 1':'Default',visit_id:page*4+repeat+1,url:`https://site${page%12}.example.test/page-${page}`,title:`Synthetic page ${String(page).padStart(4,'0')}`,visit_time:new Date(instant+8*3600000).toISOString().slice(0,-1)+'+08:00'});
    }
    const stressPath=path.join(qaRoot,'stress.json');fs.writeFileSync(stressPath,JSON.stringify(stressData));
    const expectedStressIds=stressData.visits.map(e=>`${e.profile}:${e.visit_id}`).sort();
    await evaluate('performance.mark("stress-import-start")');await importFile(stressPath);await until(()=>evaluate(`timelineSnapshot().events===${totalEvents}`));
    const importMs=await evaluate('performance.now()-performance.getEntriesByName("stress-import-start").at(-1).startTime');
    assert.equal(await evaluate('timelineSnapshot().rows'),12);assert.equal(await evaluate('timelineSnapshot().pages'),totalPages);
    await click('.site-toggle');
    assert.equal(await evaluate('document.querySelectorAll(".gantt-child").length'),100,'Expand just one site within the 1,200-page dataset');
    assert.equal(await evaluate('document.querySelectorAll(".gantt-row").length'),112);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(n=>n.dataset.eventId).sort()'),expectedStressIds);
    await click('.site-toggle');
    const measure=async action=>evaluate(`(()=>{const start=performance.now();${action};document.getElementById('gantt').getBoundingClientRect();return performance.now()-start;})()`);
    const pageViewMs=await measure('document.getElementById("group-by").value="page";document.getElementById("group-by").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('document.querySelectorAll(".gantt-row").length'),totalPages);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(n=>n.dataset.eventId).sort()'),expectedStressIds);
    const searchMs=await measure('document.getElementById("search").value="Synthetic page 0600";document.getElementById("search").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate('timelineSnapshot().rows'),1);assert.equal(await evaluate('timelineSnapshot().shownEvents'),4);
    const clearMs=await measure('document.getElementById("clear-search").click()');
    assert.equal(await evaluate('timelineSnapshot().rows'),totalPages);
    const siteViewMs=await measure('document.getElementById("group-by").value="site";document.getElementById("group-by").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('timelineSnapshot().rows'),12);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(n=>n.dataset.eventId).sort()'),expectedStressIds);
    await click('.page-label');assert.equal(await evaluate('document.querySelectorAll(".page-group").length'),100);
    await checkPageListPriority();
    assert.equal(await evaluate('document.querySelectorAll(".page-group-events li").length'),400);
    await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(180);
    await checkPageListPriority();
    const visiblePages=await evaluate('[...document.querySelectorAll(".page-group > summary")].filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}).length');
    assert.ok(visiblePages>=6,`A 100-page site should offer at least six readable pages on a phone, got ${visiblePages}`);
    await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_many_pages_mobile.png'),Buffer.from(r.data,'base64')));
    await click('#drawer-close');
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await pause(180);
    fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_stress.json'),JSON.stringify({pages:totalPages,events:totalEvents,siteRows:12,importMs,pageViewMs,searchMs,clearMs,siteViewMs},null,2));
  }
  // The display window filters counts and spans but never discards source data.
  const boundary={status:'complete',start_time:'2026-11-01T00:00:00+08:00',end_time:'2026-11-02T00:00:00+08:00',event_count:6,profiles:[],errors:[],visits:[
    {profile:'Default',visit_id:41,visit_time:'2026-11-01T05:59:59.999+08:00',title:'Before six',url:'https://github.com/project/one'},
    {profile:'Default',visit_id:42,visit_time:'2026-11-01T06:00:00+08:00',title:'At six',url:'https://github.com/project/one'},
    {profile:'Default',visit_id:43,visit_time:'2026-11-01T06:10:00+08:00',title:'Morning page',url:'https://github.com/project/one'},
    {profile:'Default',visit_id:44,visit_time:'2026-11-01T23:59:59.999+08:00',title:'Before midnight',url:'https://github.com/project/two'},
    {profile:'Default',visit_id:45,visit_time:'2026-11-02T00:00:00+08:00',title:'Next midnight',url:'https://github.com/project/two'},
    {profile:'Default',visit_id:46,visit_time:'2026-11-01T00:00:00+08:00',title:'Midnight first',url:'https://bing.com/'}]};
  const boundaryPath=path.join(qaRoot,'boundary.json');fs.writeFileSync(boundaryPath,JSON.stringify(boundary));
  await importFile(boundaryPath);await until(()=>evaluate('timelineSnapshot().events===6'));
  await checkCoverage([]);
  assert.equal(await evaluate('timelineSnapshot().windowEvents'),3);
  assert.equal(await evaluate('timelineSnapshot().shown'),2);assert.equal(await evaluate('timelineSnapshot().rows'),1);
  assert.equal(await evaluate('document.getElementById("event-count").textContent'),'3');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".event-marker")].map(e=>e.dataset.eventId).sort()'),['Default:42','Default:43','Default:44']);
  assert.equal(await evaluate('Number(document.querySelector(".visit-span").dataset.first)'),Date.parse('2026-11-01T06:00:00+08:00'));
  assert.equal(await evaluate('Number(document.querySelector(".visit-span").dataset.last)'),Date.parse('2026-11-01T23:59:59.999+08:00'));
  assert.equal(await evaluate('getComputedStyle([...document.querySelectorAll(".axis-tick span")].at(-1)).visibility'),'visible','24:00 must remain readable even when a visit is close to midnight');
  await click('.page-label');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-meta time")].map(n=>n.textContent)'),['06:00','23:59'],'Page clocks use the filtered window, not pre-06:00 visits');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".page-group-meta time")].map(n=>n.dateTime)'),[boundary.visits[1].visit_time,boundary.visits[3].visit_time]);
  assert.equal(await evaluate('document.querySelectorAll("#event-list li").length'),3);
  assert.ok(await evaluate('!document.getElementById("event-list").textContent.includes("Before six")&&!document.getElementById("event-list").textContent.includes("Next midnight")'));
  await click('#drawer-close');await groupBy('page');assert.equal(await evaluate('timelineSnapshot().rows'),2);await groupBy('site');
  await search('Before six');assert.equal(await evaluate('timelineSnapshot().rows'),0);
  await search('Next midnight');assert.equal(await evaluate('timelineSnapshot().rows'),0);await search('');
  const boundaryExports=path.join(qaRoot,'window-exports');fs.mkdirSync(boundaryExports);
  await command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:boundaryExports});await click('#export-button');
  const boundarySaved=await until(()=>fs.readdirSync(boundaryExports).find(name=>name.endsWith('.html')));
  const boundaryHtml=fs.readFileSync(path.join(boundaryExports,boundarySaved),'utf8');
  const boundaryData=JSON.parse(boundaryHtml.match(/<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(boundaryData.event_count,6);assert.deepEqual(boundaryData.events.map(e=>e.visit_id).sort((a,b)=>a-b),[41,42,43,44,45,46]);
  await open(path.join(boundaryExports,boundarySaved));assert.equal(await evaluate('timelineSnapshot().windowEvents'),3);
  const nightOnly={...boundary,event_count:1,visits:[boundary.visits[0]]};const nightPath=path.join(qaRoot,'night.json');fs.writeFileSync(nightPath,JSON.stringify(nightOnly));
  await importFile(nightPath);await until(()=>evaluate('timelineSnapshot().events===1'));
  assert.equal(await evaluate('timelineSnapshot().windowEvents'),0);assert.equal(await evaluate('timelineSnapshot().rows'),0);
  assert.ok(await evaluate('document.querySelector(".empty-state").textContent.includes("06:00")'));
  await open(documentPath);
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
  await checkReadability();
  const mobile=await checkChartPriority();
  await checkFullDayOverview();
  await click('#zoom-in');assert.equal(await evaluate('timelineSnapshot().zoom'),2);
  assert.equal(await evaluate('document.getElementById("gantt").getBoundingClientRect().width>document.getElementById("chart-scroll").clientWidth'),true,'Zooming a mobile overview must reveal a scrollable detailed timeline');
  await click('#zoom-label');await evaluate('document.getElementById("chart-scroll").scrollLeft=0');await pause(60);
  await checkFullDayOverview();
  await evaluate('window.scrollTo(0,0)');await pause(120);
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_mobile.png'),Buffer.from(r.data,'base64')));
  await click('.page-label');
  assert.equal(await evaluate('document.getElementById("detail-visits").hidden'),false,'A title in the content view opens that page evidence');
  assert.ok(await evaluate('document.querySelectorAll("#event-list li").length>0'));
  await click('#drawer-close');
  await groupBy('site');
  await click('.page-label');assert.equal(await evaluate('document.getElementById("drawer").hidden'),false);
  assert.equal(await evaluate('document.getElementById("detail-pages").hidden'),false);
  assert.equal(await evaluate('document.getElementById("drawer").scrollWidth<=document.getElementById("drawer").clientWidth'),true,'Page outline must fit the mobile drawer');
  await checkPageListPriority();
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_pages_mobile.png'),Buffer.from(r.data,'base64')));
  await click('#drawer-close');
  for(const width of [320,375,421,480,600,761,768,900,901,1024,1440]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:1040,deviceScaleFactor:1,mobile:width<760});await pause(130);
    if(width===768)await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_tablet.png'),Buffer.from(r.data,'base64')));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,`horizontal overflow at ${width}px`);
    await checkReadability();
    await checkGanttGeometry();
    await checkChartPriority();
    await checkFullDayOverview();
    if(width===320)await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_320.png'),Buffer.from(r.data,'base64')));
  }

  // Regression: opening the source template directly must render, not parse an
  // unresolved placeholder. Importing and saving from this entry also works.
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});
  const previewPath=path.resolve(root,process.env.TIMELINE_TEST_TEMPLATE||'skills/edge-learning-review/assets/edge_history_timeline.template.html');
  await open(previewPath);
  assert.equal(await evaluate('timelineSnapshot().events'),0);
  assert.equal(await evaluate('document.getElementById("error").hidden'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".workspace")).display'),'grid');
  assert.equal(await evaluate('document.getElementById("snapshot-badge").textContent'),'等待导入');
  await checkCoverage([]);
  await command('Emulation.setDeviceMetricsOverride',{width:1024,height:1040,deviceScaleFactor:1,mobile:false});await pause(160);
  await checkCoverage([]);
  assert.ok(await evaluate('document.querySelector(".empty-state").textContent.includes("导入")'),'Resizing the empty importer must not imply data was collected');
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await pause(160);
  assert.ok(await evaluate('document.querySelector(".empty-state").textContent.includes("导入")'));
  assert.equal(await evaluate('document.getElementById("export-button").disabled'),true);
  await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(r=>fs.writeFileSync(path.join(root,'output',screenshotPrefix+'_template.png'),Buffer.from(r.data,'base64')));
  await importFile(fixturePath);await until(()=>evaluate('timelineSnapshot().events===5'));
  assert.equal(await evaluate('document.querySelectorAll(".event-marker").length'),5);
  assert.equal(await evaluate('document.getElementById("export-button").disabled'),false);
  const previewExports=path.join(qaRoot,'preview-exports');fs.mkdirSync(previewExports);
  await command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:previewExports});
  await click('#export-button');
  const previewSaved=await until(()=>fs.readdirSync(previewExports).find(name=>name.endsWith('.html')));
  await open(path.join(previewExports,previewSaved));
  assert.equal(await evaluate('timelineSnapshot().events'),5);
  assert.equal(await evaluate('document.getElementById("error").hidden'),true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".workspace")).display'),'grid');
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests.filter(url=>/^https?:/i.test(url)),[]);
  console.log(JSON.stringify({status:'passed',events:snapshot.events,windowEvents:snapshot.windowEvents,windowPages:snapshot.windowPages,pages:snapshot.pages,sites:snapshot.rows,baseline,desktop,mobile,checks:['06:00–24:00 local window and labels','06:00 inclusive and 24:00 exclusive','counts, spans, search and details follow the window','off-window source events survive save/reload','night-only data has an honest empty state','real visit count','page titles visible by default','one row per site in overview','site/page grouping preserves all event IDs','site details retain page titles and links','subdomain merge and cross-profile evidence','official icons load from embedded data','icons left of bars with only the site name above','full page titles remain searchable','title and URL search','domain spoof and remote icon rejection','readable fonts and text contrast','search shortcut and Escape','canvas viewport priority','warm homepage palette','no topic sidebar or filler','detail and Escape','time range','zoom','span toggle','search empty state','sort','JSON import','profile filter','saved HTML reload','malicious text escaping','invalid data rejection','375/768/1024/1440 layouts','source template renders without data','source template import and saved HTML reload','zero browser exceptions','no external network requests']},null,2));
  try{await command('Browser.close');}catch{}
} catch(error) {
  console.error(error);console.error(diagnostic.slice(-1800));process.exitCode=1;
} finally {
  if(socket)socket.close();
  if(child.exitCode===null){child.kill();await pause(500);}
  // Only the exact, unique temporary directory created above may be removed.
  if(path.dirname(qaRoot)!==root||!path.basename(qaRoot).startsWith('.timeline-browser-'))throw Error('Unexpected cleanup path');
  try{fs.rmSync(qaRoot,{recursive:true,force:true,maxRetries:8,retryDelay:200});}catch(error){console.error('Cleanup failed:',error.message);process.exitCode=1;}
}
