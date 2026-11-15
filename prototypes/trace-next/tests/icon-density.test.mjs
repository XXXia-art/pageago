// Icon-first labels, exercised in a disposable Edge profile with synthetic records only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output=path.resolve('output'),profile=path.join(output,'.trace-icon-density-'+randomUUID());
fs.mkdirSync(profile,{recursive:true});
const browser=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
  '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check',
  '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let diagnostics='',socket,cmd,ev;const errors=[],network=[],checks=[];
browser.stderr.on('data',b=>diagnostics+=b);browser.on('error',e=>diagnostics+=e.message);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(25);}throw Error('Timed out: '+label);}
try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Edge ready');
  const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const pending=new Map();let sequence=0;
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(pending.has(m.id)){const r=pending.get(m.id);clearTimeout(r.timer);pending.delete(m.id);m.error?r.reject(Error(JSON.stringify(m.error))):r.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Network.requestWillBeSent')network.push(m.params.request.url);});
  cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const snap=()=>ev('traceSnapshot()');
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const importData=async(sessions,name)=>{const file=path.join(profile,name+'.json');fs.writeFileSync(file,JSON.stringify({schema:'trace.v1',source:'synthetic-demo',sessions}));const {root}=await cmd('DOM.getDocument');const {nodeId}=await cmd('DOM.querySelector',{nodeId:root.nodeId,selector:'#import-input'});await cmd('DOM.setFileInputFiles',{nodeId,files:[file]});await until(()=>ev('document.querySelector("#import-input").value===""'),'import');await pause(80);};
  const stable=async()=>{let before=null,count=0;await until(async()=>{const after=(await snap()).viewport;if(before&&after.every((n,i)=>Math.abs(n-before[i])<.01))count++;else count=0;before=after;return count>=4;},'navigation settled',6000);};
  const shot=async name=>{await ev('document.activeElement?.blur()');const r=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
  const tags=()=>ev(`(()=>{const plot=document.querySelector('#lanes').getBoundingClientRect();return [...document.querySelectorAll('.event-tag')].filter(n=>!n.hidden&&n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect(),name=n.querySelector('.event-name'),nr=name.getBoundingClientRect(),style=getComputedStyle(name),icon=n.querySelector('.site-icon'),ir=icon.getBoundingClientRect(),a=[...document.querySelectorAll('.event-anchor')].find(a=>a.dataset.url===n.dataset.url),link=[...document.querySelectorAll('.event-link')].find(a=>a.dataset.url===n.dataset.url),ar=a.getBoundingClientRect();return {url:n.dataset.url,title:n.title,aria:n.getAttribute('aria-label'),text:name.textContent,x:r.x,y:r.y,width:r.width,height:r.height,textWidth:style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0?0:nr.width,textX:nr.x,textHeight:nr.height,textClientWidth:name.clientWidth,textScrollWidth:name.scrollWidth,textClientHeight:name.clientHeight,textScrollHeight:name.scrollHeight,textOverflow:style.textOverflow,whiteSpace:style.whiteSpace,lineClamp:style.webkitLineClamp,icon:!!icon,iconRight:ir.right,anchor:ar.x+ar.width/2,link:link.getAttribute('d'),plotX:plot.x,plotWidth:plot.width};});})()`);
  const verify=async(label,sessions)=>{
    const state=await snap(),shown=await tags(),viewport=await ev('innerWidth');
    const candidates=new Set(sessions.filter(s=>Date.parse(s.end)>state.viewport[0]&&Date.parse(s.start)<state.viewport[1]).map(s=>s.url));
    const count=await ev('document.querySelector("#more-pages").hidden?0:Number(document.querySelector("#more-pages").textContent.match(/\\d+/)?.[0]||0)');
    assert.equal(shown.length+count,candidates.size,label+': visible plus overflow accounts for every eligible page');
    for(const tag of shown){
      assert.ok(candidates.has(tag.url)&&tag.icon,label+': every shown label is a real eligible page with an icon');
      assert.ok(tag.width>=31.9&&tag.height>=31.9,label+': icon target remains usable');
      assert.ok(Math.abs(tag.height-32)<.2,label+': tags keep their compact 32px height at every zoom level');
      assert.ok(tag.x>=0&&tag.x+tag.width<=viewport+.1,label+': tag stays within viewport');
      if(tag.textWidth>0){assert.ok(tag.iconRight<=tag.textX+.5,label+': icon is always to the left of title text');assert.ok(Math.abs(tag.textHeight-22)<.2,label+': title stays on one 22px line');assert.equal(tag.whiteSpace,'nowrap',label+': title never expands into multiple lines');assert.equal(tag.textOverflow,'ellipsis',label+': overflow uses a single-line ellipsis');}
      const source=sessions.find(s=>s.url===tag.url);assert.equal(tag.title,source.title);assert.equal(tag.text,source.title);assert.ok(tag.aria.includes(source.title),label+': full title retained for accessibility');
      const first=sessions.filter(s=>s.url===tag.url&&Date.parse(s.end)>state.viewport[0]&&Date.parse(s.start)<state.viewport[1]).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))[0];
      const expected=tag.plotX+(Math.max(Date.parse(first.start),state.viewport[0])-state.viewport[0])/(state.viewport[1]-state.viewport[0])*tag.plotWidth;
      assert.ok(Math.abs(tag.anchor-expected)<.2,label+': anchor follows exact time');
      const coords=tag.link.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);
      assert.equal(coords.length,4,label+': single straight connector');assert.ok(Math.abs(coords[0]-coords[2])<.001,label+': connector is vertical');
    }
    for(let i=0;i<shown.length;i++)for(let j=i+1;j<shown.length;j++){const a=shown[i],b=shown[j];assert.ok(Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)<.4||Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)<.4,label+': tags do not collide');}
    return shown;
  };
  const exactBlocks=async(sessions,label)=>{
    const state=await snap(),plotWidth=await ev('document.querySelector("#lanes").clientWidth'),blocks=await ev(`(()=>{const r=document.querySelector('#lanes').getBoundingClientRect();return [...document.querySelectorAll('.block')].map(n=>({id:n.dataset.session,left:parseFloat(n.style.left),width:parseFloat(n.style.width),hidden:n.hidden}));})()`);
    assert.equal(blocks.length,sessions.length,label+': every activity interval remains present');
    for(const b of blocks){const s=sessions.find(s=>s.id===b.id);assert.ok(s);const span=state.viewport[1]-state.viewport[0],a=Math.max(Date.parse(s.start),state.bounds[0]),z=Math.min(Date.parse(s.end),state.bounds[1]),visible=z>a&&z>state.viewport[0]&&a<state.viewport[1];assert.equal(b.hidden,!visible,label+': viewport intersection visibility '+b.id);if(!visible)continue;assert.ok(Math.abs(b.left-(a-state.viewport[0])/span*100)/100*plotWidth<.15,label+': correct position '+b.id+' ('+b.left+')');assert.ok(Math.abs(b.width-(z-a)/span*100)/100*plotWidth<.15,label+': correct duration width '+b.id);}
    if(await ev('!!window.__densityNodes'))assert.ok(await ev('window.__densityNodes.length===document.querySelectorAll(".block").length&&window.__densityNodes.every((n,i)=>n===document.querySelectorAll(".block")[i])'),label+': interval node identities persist');
  };
  const pageColors=async(sessions,label)=>{
    const values=await ev(`({tags:[...document.querySelectorAll('.event-tag')].map(n=>({url:n.dataset.url,tone:n.style.getPropertyValue('--tone'),backgroundImage:getComputedStyle(n).backgroundImage})),blocks:[...document.querySelectorAll('.block')].map(n=>({id:n.dataset.session,tone:n.style.getPropertyValue('--tone'),backgroundImage:getComputedStyle(n).backgroundImage}))})`),tones=Object.fromEntries(values.tags.map(t=>[t.url,t.tone]));
    for(const tag of values.tags){assert.ok(tag.tone,label+': every page has a color');assert.equal(tag.backgroundImage,'none',label+': page tags use solid colors without gradients');}
    for(const block of values.blocks){const source=sessions.find(s=>s.id===block.id);assert.ok(source,label+': colored interval still maps to an original record');assert.equal(block.tone,tones[source.url],label+': each interval shares its page icon color');assert.equal(block.backgroundImage,'none',label+': interval colors have no gradient');}
    return tones;
  };
  const wheel=async delta=>{const p=await ev('(()=>{const r=document.querySelector("#lanes").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+16};})()');await cmd('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:delta});await pause(80);await stable();};
  const maximumZoom=async()=>{for(let i=0;i<12&&!await ev('document.querySelector("#zoom-in").disabled');i++){await click('#zoom-in');await stable();}assert.ok(await ev('document.querySelector("#zoom-in").disabled'),'maximum zoom reached through the actual control');const state=await snap();assert.ok(Math.abs(state.viewport[1]-state.viewport[0]-1800000)<2,'maximum zoom shows 30 actual minutes');};
  const compactLongTitle=(tag,label)=>{assert.ok(tag.textWidth>0,label+': title preview is visible');assert.ok(tag.textScrollWidth>tag.textClientWidth+1,label+': long title is intentionally shortened inside its tag');assert.ok(Math.abs(tag.height-32)<.2&&Math.abs(tag.textHeight-22)<.2,label+': a long title cannot grow the tag or row');assert.equal(tag.textOverflow,'ellipsis',label+': maximum zoom still uses ellipsis');assert.equal(tag.whiteSpace,'nowrap',label+': maximum zoom remains single-line');};
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');await cmd('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:pathToFileURL(path.join(output,'pageago.html')).href});await until(()=>ev('typeof traceSnapshot==="function"&&traceSnapshot().ready'),'page');
  const start=Date.parse('2026-11-08T06:00:00+08:00');
  const longSessions=Array.from({length:144},(_,i)=>({id:'density-'+i,url:`https://www.bilibili.com/video/synthetic-${i}`,title:`网页 ${i+1} — 一篇用于检验长标题密集排列的合成网页记录 / complete descriptive title`,start:new Date(start+i*7.45*60000).toISOString(),end:new Date(start+i*7.45*60000+18000).toISOString()}));
  longSessions.push({...longSessions[60],id:'repeat-density',start:new Date(start+1079*60000).toISOString(),end:new Date(start+1079.5*60000).toISOString()});
  await importData(longSessions,'long-titles');const initial=await snap();assert.equal(initial.pages,144);assert.equal(initial.segments,145);assert.equal(initial.overflowOpen,false);
  const folded=await verify('long-title overview',longSessions);await exactBlocks(longSessions,'long-title overview');
  const initialColors=await pageColors(longSessions,'long-title overview');assert.equal(new Set(Object.values(initialColors)).size,1,'all pages from one website share one consistent color');
  const oldCount=await ev(`(()=>{const state=traceSnapshot(),width=document.querySelector('#lanes').clientWidth,levels=Math.min(5,Math.max(3,Math.floor((innerHeight*.5-125)/42))),bands=Array.from({length:levels},()=>[]);let count=0;for(let i=0;i<144;i++){const x=(${start}+i*7.45*60000-state.viewport[0])/(state.viewport[1]-state.viewport[0])*width,left=Math.max(0,Math.min(width-190,x-95));const band=bands.find(a=>a.every(([start,end])=>left+202<=start||left>=end+12));if(band){band.push([left,left+190]);count++;}}return count;})()`);
  assert.ok(folded.length>=oldCount*2,'long titles allow at least twice as many icons as the former fixed-width labels');
  assert.ok(folded.some(t=>t.textWidth<10),'dense overview hides title text before dropping page icons');
  await shot('trace-icon-density-compact');
  await ev('window.__densityNodes=[...document.querySelectorAll(".block")]');
  const shortSessions=longSessions.map(s=>({...s,title:'页'}));await importData(shortSessions,'short-titles');const short=await verify('short-title overview',shortSessions);
  assert.deepEqual(short.map(t=>t.url).sort(),folded.map(t=>t.url).sort(),'title lengths do not decide which page icons survive');
  assert.deepEqual(await pageColors(shortSessions,'changed titles'),initialColors,'page colors stay stable when only titles change');
  await importData(longSessions,'long-titles-again');await exactBlocks(longSessions,'title changes');
  checks.push(`144-page overview shows ${folded.length} icons versus ${oldCount} former fixed-width labels; titles cannot evict icons`);
  const widths=[];for(let i=0;i<4;i++){await wheel(-180);const visible=await verify('zoom '+i,longSessions);widths.push(visible);await exactBlocks(longSessions,'zoom '+i);assert.equal((await snap()).overflowOpen,false);}
  const latest=widths.at(-1),initialByUrl=new Map(folded.map(t=>[t.url,t]));
  assert.deepEqual(await pageColors(longSessions,'after zoom'),initialColors,'zoom and viewport navigation never recolor a page');
  assert.ok(latest.filter(t=>initialByUrl.has(t.url)&&t.textWidth>initialByUrl.get(t.url).textWidth+12).length>=Math.min(3,latest.length),'zoom reveals more of the same page titles without clicking them');
  await shot('trace-icon-density-zoom');checks.push('wheel zoom progressively reveals text without collisions or changing interval geometry');
  checks.push('same-website pages share one solid color, stable across title changes, repeat intervals and zoom');
  await click('#zoom-reset');await stable();const restored=await verify('restored overview',longSessions);assert.ok(restored.length>=folded.length,'reset keeps at least the original icon density while stable row preference may retain different peers');
  const target=restored.find(t=>t.textWidth<10)||restored[0];
  await ev(`(()=>{const n=[...document.querySelectorAll('.event-tag')].find(n=>n.dataset.url===${JSON.stringify(target.url)});n.focus();})()`);
  assert.equal(await ev('document.querySelector("#tooltip strong").textContent'),target.title,'icon-only focus reveals full title');
  await ev('document.activeElement.click()');await until(()=>ev('Math.abs(traceSnapshot().drawer-1)<.0001'),'detail');assert.equal(await ev('document.querySelector(".detail-url").href'),target.url);assert.equal(await ev('document.querySelector(".detail-title").textContent'),target.title,'inspector preserves the full title');
  await click('#close-inspector');await until(()=>ev('traceSnapshot().drawer<.0001'),'detail close');assert.equal(await ev('document.activeElement.dataset.url'),target.url,'detail returns focus to its icon');
  checks.push('icon-only labels preserve full titles, detail access and keyboard focus');
  const crowded=Array.from({length:80},(_,i)=>({id:'cluster-'+i,url:`https://example.com/cluster-${i}`,title:`同刻网页 ${i} — 长标题不会优先占掉图标空间`,start:new Date(start+1000).toISOString(),end:new Date(start+6000).toISOString()}));
  await ev('window.__densityNodes=null');await importData(crowded,'same-time-cluster');const clustered=await verify('same-time cluster',crowded);assert.equal(clustered.length,8,'same-time pages use all eight compact rows');assert.ok(clustered.every(t=>t.icon));
  await exactBlocks(crowded,'same-time cluster');const clusterViewport=(await snap()).viewport;await click('#more-pages');assert.equal((await snap()).overflowOpen,true,'+N opens the hidden-page list');
  const overflowRows=await ev('[...document.querySelectorAll("#overflow-list .overflow-item")].map(n=>({url:n.dataset.url,icon:!!n.querySelector(".site-icon")}))'),shownUrls=new Set(clustered.map(t=>t.url)),hiddenUrls=crowded.filter(s=>!shownUrls.has(s.url)).map(s=>s.url);
  assert.deepEqual(overflowRows.map(n=>n.url).sort(),hiddenUrls.sort(),'every hidden page appears once in the list');assert.ok(overflowRows.every(n=>n.icon),'hidden pages retain site icons');assert.equal((await snap()).overflowPages,72,'eight visible icons leave exactly 72 overflow webpages');assert.deepEqual((await snap()).viewport,clusterViewport,'opening the hidden-page list does not change the time range');await exactBlocks(crowded,'same-time overflow list');
  const hiddenTarget=overflowRows.at(-1).url;await ev(`(()=>{const n=[...document.querySelectorAll('#overflow-list .overflow-item')].find(n=>n.dataset.url===${JSON.stringify(hiddenTarget)});n.focus();n.click();})()`);await until(()=>ev('Math.abs(traceSnapshot().drawer-1)<.0001'),'hidden page detail');assert.equal(await ev('document.querySelector(".detail-url").href'),hiddenTarget);assert.equal((await snap()).overflowOpen,false,'details replace the list');await click('#close-inspector');await until(()=>ev('traceSnapshot().drawer<.0001'),'hidden page detail close');assert.equal(await ev('document.activeElement.id'),'more-pages','hidden-page details return focus to +N');await verify('cluster after list detail',crowded);checks.push('unavoidable same-time overflow lists every remaining page with its icon and detail access without expanding the timeline');
  // Button zoom keeps the full day's noon center; test both edges of 11:45–12:15.
  const edgeTimes=[['crossing-left','11:44:30','11:46:00'],['near-left','11:46:00','11:47:00'],['center','11:59:00','12:00:00'],['near-right','12:14:00','12:14:50']];
  const descriptiveTitle='最大缩放仍保留单行标题：网页活动记录与浏览轨迹的详细说明，包含论文、代码和文档的上下文信息 / a long webpage title stays compact at maximum zoom';
  const edgeSessions=edgeTimes.map(([id,a,b])=>({id:'max-'+id,url:`https://www.bilibili.com/video/max-${id}`,title:`${id} — ${descriptiveTitle}`,start:`2026-11-08T${a}+08:00`,end:`2026-11-08T${b}+08:00`}));
  for(const [width,height] of [[1440,1100],[1280,900]]){
    await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await click('#zoom-reset');await stable();await importData(edgeSessions,'max-title-edges-'+width);
    await ev('window.__densityNodes=[...document.querySelectorAll(".block")]');await maximumZoom();const edgeTags=await verify(width+' maximum zoom edges',edgeSessions);assert.equal(edgeTags.length,edgeSessions.length,'sparse edge fixture retains every icon');
    for(const tag of edgeTags)compactLongTitle(tag,width+' '+tag.url);
    await exactBlocks(edgeSessions,width+' maximum zoom edges');assert.equal(await ev('document.querySelectorAll(".lane-label").length'),0,'maximum zoom keeps a single main axis without expanded webpage rows');
    if(width===1440)await shot('trace-icon-density-max-zoom');
  }
  checks.push('maximum zoom keeps 32px single-line labels with ellipsis at center and both viewport edges; icons remain on the left');
  const extremeSessions=[{id:'extreme-title',url:'https://example.com/extremely-long-title',title:'完整保留的超长网页标题 / '.repeat(25),start:'2026-11-08T11:59:00+08:00',end:'2026-11-08T12:00:00+08:00'}];
  await ev('window.__densityNodes=null');await importData(extremeSessions,'extreme-title');await maximumZoom();const extremeTags=await verify('extreme title at maximum zoom',extremeSessions);assert.equal(extremeTags.length,1);compactLongTitle(extremeTags[0],'extreme title');
  await ev('document.querySelector(".event-tag:not([hidden])").focus()');const tooltip=await ev('(()=>{const n=document.querySelector("#tooltip strong");return {text:n.textContent,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight};})()');assert.equal(tooltip.text,extremeSessions[0].title);assert.ok(tooltip.scrollWidth<=tooltip.clientWidth+1&&tooltip.scrollHeight<=tooltip.clientHeight+1,'tooltip does not clip a very long title');await ev('document.activeElement.blur()');
  const maximumCrowded=crowded.map(s=>({...s,start:'2026-11-08T11:59:00+08:00',end:'2026-11-08T12:00:00+08:00'}));await importData(maximumCrowded,'maximum-same-time-cluster');await maximumZoom();const denseMax=await verify('same-time cluster at maximum zoom',maximumCrowded);assert.ok(denseMax.length>0&&denseMax.length<maximumCrowded.length);await exactBlocks(maximumCrowded,'same-time cluster at maximum zoom');
  await importData(maximumCrowded.map(s=>({...s,title:'页'})),'maximum-same-time-short-titles');const denseShort=await verify('short same-time cluster at maximum zoom',maximumCrowded.map(s=>({...s,title:'页'})));assert.deepEqual(denseShort.map(t=>t.url).sort(),denseMax.map(t=>t.url).sort(),'maximum zoom title length never evicts icon candidates');
  checks.push('extreme titles stay single-line while focus tooltips expose their complete text; maximum-zoom crowded icons retain exact overflow counts regardless of title length');
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  const narrowStart=Date.parse('2026-11-08T11:46:00+08:00'),narrowSessions=Array.from({length:80},(_,i)=>{const time=narrowStart+Math.floor(i/5)*105000;return {id:'narrow-'+i,url:`https://example.com/narrow-cell-${i}`,title:`窄列标题 ${i} — 缩放到最后一级也不能突然消失`,start:new Date(time).toISOString(),end:new Date(time+12000).toISOString()};});
  await importData(narrowSessions,'maximum-narrow-cells');await maximumZoom();await wheel(1);const nearMaximum=await snap();assert.ok(nearMaximum.viewport[1]-nearMaximum.viewport[0]>1800001,'test starts just outside maximum zoom');
  const beforeNarrow=await verify('narrow cells just before maximum zoom',narrowSessions),narrowTitles=beforeNarrow.filter(t=>t.textWidth>=28&&t.textWidth<59);assert.ok(narrowTitles.length>=10,'fixture exercises many real 28–59px title cells');
  await maximumZoom();const afterNarrow=await verify('narrow cells at maximum zoom',narrowSessions),afterNarrowByUrl=new Map(afterNarrow.map(t=>[t.url,t]));
  assert.deepEqual(afterNarrow.map(t=>t.url).sort(),beforeNarrow.map(t=>t.url).sort(),'crossing the maximum zoom threshold keeps the same page icons');
  for(const previous of narrowTitles){const current=afterNarrowByUrl.get(previous.url);assert.ok(current&&current.textWidth>=28,'a readable narrow title does not disappear at the maximum zoom threshold: '+JSON.stringify({url:previous.url,before:previous.textWidth,after:current?.textWidth}));assert.ok(current.textHeight<=22.5,'narrow title cells remain one readable line rather than vertical columns');}
  await exactBlocks(narrowSessions,'narrow cells at maximum zoom');checks.push('28–59px short titles stay visible when crossing into maximum zoom without evicting icons or forming vertical text columns');
  await click('#zoom-reset');await stable();
  for(const [width,height] of [[1280,900],[1920,1080]]){await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await importData(longSessions,'viewport-'+width);await verify(width+' overview',longSessions);await wheel(-200);await verify(width+' zoom',longSessions);await click('#zoom-reset');await stable();}
  const siteFixtures=[
    ['bilibili.com','https://bilibili.com/video/root'],['bilibili.com','https://www.bilibili.com/video/www'],['bilibili.com','https://live.bilibili.com/live-room'],['bilibili.com','https://www.bilibili.com./video/trailing-dot'],
    ['101weiqi.com','https://101weiqi.com/q/100'],['101weiqi.com','https://www.101weiqi.com/q/101'],['101weiqi.com','https://www.101weiqi.com./q/102'],
    ['zhihu.com','https://zhihu.com/question/100'],['zhihu.com','https://www.zhihu.com/question/101'],
    ['example.co.uk','https://example.co.uk/root'],['example.co.uk','https://www.example.co.uk/www'],['example.co.uk','https://a.b.example.co.uk/deep'],['other.co.uk','https://other.co.uk/separate-website'],
    ['alpha.github.io','https://alpha.github.io/root'],['alpha.github.io','https://docs.alpha.github.io/deep'],['beta.github.io','https://beta.github.io/root'],['beta.github.io','https://docs.beta.github.io/deep'],
    ['xn--bcher-kva.de','https://bücher.de/unicode'],['xn--bcher-kva.de','https://xn--bcher-kva.de/punycode'],['xn--bcher-kva.de','https://www.xn--bcher-kva.de/www'],
    ['127.0.0.1','http://127.0.0.1:8000/one'],['127.0.0.1','http://127.0.0.1:9000/two'],
    ['[::1]','http://[::1]:8000/one'],['[::1]','http://[::1]:9000/two'],
    ['localhost','http://localhost:8000/one'],['localhost','http://localhost:9000/two']
  ],rawSiteSessions=siteFixtures.map(([site,url],i)=>({id:'site-color-'+i,url,title:`合成 ${site} 网页 ${i}`,start:new Date(start+(i+1)*1200000).toISOString(),end:new Date(start+(i+1)*1200000+60000).toISOString()}));
  // Import the Unicode URL as written; compare renderer keys with standard URL serialization.
  const siteSessions=rawSiteSessions.map(s=>({...s,url:new URL(s.url).href}));
  const siteDomains=()=>ev(`Object.fromEntries([...document.querySelectorAll('.event-tag')].map(n=>[n.dataset.url,n.dataset.site]))`);
  await importData(rawSiteSessions,'website-color-groups');await verify('website color groups',siteSessions);const siteColors=await pageColors(siteSessions,'website color groups'),domains=await siteDomains(),brandColors={};
  for(const [brand,rawUrl] of siteFixtures){const url=new URL(rawUrl).href;assert.equal(domains[url],brand,'website grouping uses the correct registrable domain or local host: '+rawUrl);if(brandColors[brand])assert.equal(siteColors[url],brandColors[brand],brand+': related root, subdomain, Unicode and trailing-dot URLs share one color');else brandColors[brand]=siteColors[url];}
  assert.equal(new Set(['bilibili.com','101weiqi.com','zhihu.com'].map(site=>brandColors[site])).size,3,'Bilibili, 101weiqi and Zhihu retain distinguishable website colors');
  const reorderedRawSites=rawSiteSessions.toReversed().map(s=>({...s,title:'修改标题 — '+s.title})),reorderedSites=reorderedRawSites.map(s=>({...s,url:new URL(s.url).href}));await importData(reorderedRawSites,'reordered-website-color-groups');await verify('reordered website color groups',reorderedSites);assert.deepEqual(await pageColors(reorderedSites,'reordered website color groups'),siteColors,'website colors remain stable after importing reordered records with changed titles');assert.deepEqual(await siteDomains(),domains,'website identity remains stable after reordered imports and title changes');
  checks.push('automatic site identity handles unknown co.uk roots and subdomains, separates github.io tenants, normalizes IDNs and local IP/localhost addresses, and keeps colors stable across reordered imports');
  const paletteDomains=Array.from({length:60},(_,i)=>i===0?'alpha.github.io':i===1?'beta.github.io':`trace-palette-${i}.com`);
  const paletteSessions=count=>{
    const sessions=paletteDomains.slice(0,count).map((domain,i)=>({id:'palette-'+i,url:`https://${domain}/page`,title:`合成网站 ${i+1} — ${domain}`,start:new Date(start+(i+1)*600000).toISOString(),end:new Date(start+(i+1)*600000+45000).toISOString()}));
    sessions.push(...paletteDomains.slice(0,2).map((domain,i)=>({id:'palette-subdomain-'+i,url:`https://docs.${domain}/reference`,title:`同网站的文档页面 ${i}`,start:new Date(start+(i+1)*600000+120000).toISOString(),end:new Date(start+(i+1)*600000+150000).toISOString()})));
    sessions.push({...sessions[0],id:'palette-repeat',start:new Date(start+1030*60000).toISOString(),end:new Date(start+1030*60000+30000).toISOString()});return sessions;
  };
  const verifyPalette=async(sessions,count,label)=>{
    await verify(label,sessions);await exactBlocks(sessions,label);const colors=await pageColors(sessions,label),identities=await siteDomains(),baseColors=paletteDomains.slice(0,count).map(domain=>colors[`https://${domain}/page`]);
    assert.ok(baseColors.every(color=>/^#[\da-f]{6}$/i.test(color)),label+': website colors are concrete six-digit hex values');assert.equal(new Set(baseColors).size,count,label+': every distinct website receives its own color, beyond the former twelve-color limit');
    for(const domain of paletteDomains.slice(0,count))assert.equal(identities[`https://${domain}/page`],domain,label+': arbitrary website identity is preserved');
    for(const domain of paletteDomains.slice(0,2)){assert.equal(identities[`https://docs.${domain}/reference`],domain);assert.equal(colors[`https://docs.${domain}/reference`],colors[`https://${domain}/page`],label+': related subdomain pages share the website color');}
    assert.notEqual(colors['https://alpha.github.io/page'],colors['https://beta.github.io/page'],label+': old hash-collision sites are now distinguishable');return colors;
  };
  const firstPalette=paletteSessions(24);await importData(firstPalette,'twenty-four-website-colors');const colors24=await verifyPalette(firstPalette,24,'24 websites');
  const fullPalette=paletteSessions(60);await importData(fullPalette,'sixty-website-colors');const colors60=await verifyPalette(fullPalette,60,'60 websites');
  for(const [url,color] of Object.entries(colors24))assert.equal(colors60[url],color,'adding websites cannot recolor an existing page');
  await shot('trace-site-colors-sixty');
  await ev('window.__densityBeforeReload=true');const pageReloaded=new Promise((resolve,reject)=>{const listener=event=>{if(JSON.parse(event.data).method==='Page.loadEventFired'){clearTimeout(timer);socket.removeEventListener('message',listener);resolve();}},timer=setTimeout(()=>{socket.removeEventListener('message',listener);reject(Error('Timed out waiting for page reload'));},15000);socket.addEventListener('message',listener);});await cmd('Page.reload');await pageReloaded;await until(()=>ev('!window.__densityBeforeReload&&typeof traceSnapshot==="function"&&traceSnapshot().ready'),'reload with persisted website colors');
  await importData(fullPalette,'sixty-website-colors-reloaded');assert.deepEqual(await verifyPalette(fullPalette,60,'60 websites after reload'),colors60,'website color assignments survive a full reload and reimport');
  checks.push('24 then 60 websites receive unique colors beyond twelve; adding sites preserves existing assignments, related subdomains and repeated intervals match, and reload restores every color');
  assert.deepEqual(errors,[]);assert.deepEqual(network.filter(u=>/^https?:/i.test(u)),[]);checks.push('1280/1440/1920 layouts remain bounded; no browser exceptions or external requests');
  fs.writeFileSync(path.join(output,'trace-icon-density-qa.json'),JSON.stringify({passed:true,checks,errors,remoteRequests:[]},null,2));console.log('PASS',checks.join('; '));
}catch(error){console.error(error.stack);if(ev){try{console.error('Snapshot:',await ev('typeof traceSnapshot==="function"?traceSnapshot():null'));}catch{}}console.error(diagnostics.slice(-1000));process.exitCode=1;}
finally{if(cmd){try{await cmd('Browser.close');}catch{browser.kill();}}else browser.kill();socket?.close();await pause(400);const resolved=path.resolve(profile);if(!resolved.startsWith(output+path.sep)||!path.basename(resolved).startsWith('.trace-icon-density-'))throw Error('Unsafe QA cleanup');try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(e){console.error('Owned profile retained: '+e.message);}}
