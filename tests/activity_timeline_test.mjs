// Isolated desktop browser QA. Only synthetic fixtures are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const root=process.cwd(),output=path.join(root,'output');
fs.mkdirSync(output,{recursive:true});
const qa=path.join(output,'.activity-browser-'+randomUUID());fs.mkdirSync(qa);
const browser=process.env.TIMELINE_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let child;
try {child=spawn(browser,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${qa}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});}
catch(error){fs.rmdirSync(qa);throw error;}
let socket,diagnostics='';child.stderr.on('data',b=>diagnostics+=b.toString());
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await pause(80);}throw Error('Timed out waiting for page state');}
const errors=[],network=[];let cmd,ev;
try {
  await until(()=>fs.existsSync(path.join(qa,'DevToolsActivePort')));
  const port=fs.readFileSync(path.join(qa,'DevToolsActivePort'),'utf8').split('\n')[0];
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const pending=new Map();let sequence=0;
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const p=pending.get(message.id);clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(Error(JSON.stringify(message.error))):p.resolve(message.result);}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);if(message.method==='Network.requestWillBeSent')network.push(message.params.request.url);});
  cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value;};
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const snapshot=()=>ev('activitySnapshot()');
  const axisLabelsFit=()=>ev(`(()=>{const boxes=[...document.querySelectorAll('.tick span')].filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect()).sort((a,b)=>a.left-b.left);return boxes.every((b,i)=>i===0 || b.left-boxes[i-1].right>=4);})()`);
  const open=async file=>{await cmd('Page.navigate',{url:pathToFileURL(file).href});await until(()=>ev('document.readyState==="complete" && typeof activitySnapshot==="function"'));await pause(100);};
  const screen=async(name)=>{await ev('document.activeElement?.blur()');const r=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));};
  const importData=async(data,name)=>{const file=path.join(qa,name+'.json');fs.writeFileSync(file,JSON.stringify(data));const {root:doc}=await cmd('DOM.getDocument');const {nodeId}=await cmd('DOM.querySelector',{nodeId:doc.nodeId,selector:'#file-input'});await cmd('DOM.setFileInputFiles',{nodeId,files:[file]});await pause(180);};
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');
  await cmd('Emulation.setTimezoneOverride',{timezoneId:'UTC'});
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await open(process.env.TIMELINE_TEST_FILE || path.join(root,'activity.html'));
  assert.equal(await ev('document.querySelector("#search, #source-button, #import-button, .chart-footer")'),null);
  const initial=await snapshot();
  assert.equal(initial.source,'synthetic');assert.equal(initial.pages,27);assert.equal(initial.sessions,40);assert.equal(initial.sites,9);assert.equal(initial.view,'site');
  assert.equal(new Date(initial.start).toISOString(),'2026-11-02T22:00:00.000Z');assert.equal(new Date(initial.end).toISOString(),'2026-11-03T16:00:00.000Z');
  assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.ok(await ev('document.querySelector("#chart-scroll").clientHeight/innerHeight>.65'));
  assert.ok(await ev('parseFloat(getComputedStyle(document.querySelector(".page-title")).fontSize)>=16'));
  assert.ok(await ev('parseFloat(getComputedStyle(document.querySelector(".tick span")).fontSize)>=18'));
  assert.equal(await axisLabelsFit(),true,'Time labels must remain separated');
  assert.deepEqual(await ev('[...document.querySelectorAll(".tick:not(.minor) span")].filter(n=>getComputedStyle(n).display!=="none").map(n=>n.textContent).filter((_,i,a)=>i===0||i===a.length-1)'),['06:00','24:00']);
  assert.equal(await ev('[...document.querySelectorAll(".avatar img")].every(i=>i.complete&&i.naturalWidth>0)'),true);
  // Frost stays on a small set of control surfaces; never blur every data row.
  assert.equal(await ev('getComputedStyle(document.querySelector(".options-panel")).backdropFilter.includes("blur")'),true);
  assert.equal(await ev('getComputedStyle(document.querySelector(".row-track")).backdropFilter'),'none');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  assert.equal(await ev('matchMedia("(prefers-reduced-transparency: reduce)").matches'),true);
  assert.equal(await ev('getComputedStyle(document.querySelector(".options-panel")).backdropFilter'),'none');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-contrast',value:'more'}]});
  assert.equal(await ev('getComputedStyle(document.querySelector(".options-panel")).backdropFilter'),'none');
  assert.equal(await ev('getComputedStyle(document.querySelector(".row-duration")).color'),'rgb(51, 71, 88)');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  // Report the actual local faces used for Latin, CJK and numeric text.
  await cmd('DOM.enable');await cmd('CSS.enable');
  const {root:fontDocument}=await cmd('DOM.getDocument');
  const renderedFonts={};
  for(const [role,selector] of Object.entries({brand:'.brand',chinese:'.toolbar h1',clock:'.tick span',page:'.page-title'})){
    const {nodeId}=await cmd('DOM.querySelector',{nodeId:fontDocument.nodeId,selector});
    const {fonts}=await cmd('CSS.getPlatformFontsForNode',{nodeId});
    renderedFonts[role]=fonts.map(f=>f.familyName);
  }
  console.log('Rendered local fonts:',JSON.stringify(renderedFonts));
  assert.equal(await ev('document.querySelector("#options-menu").open'),false);
  await click('#options-trigger');
  assert.equal(await ev('document.querySelector("#options-menu").open'),true);
  assert.equal(await ev('document.querySelector("#save-button").getClientRects().length>0'),true);
  assert.equal(await ev('document.querySelector(".options-panel").getBoundingClientRect().right<=innerWidth'),true);
  await ev('document.querySelector("#sort").value="name";document.querySelector("#sort").dispatchEvent(new Event("change"))');
  assert.equal((await snapshot()).sessions,40);
  await ev('document.querySelector("#sort").value="duration";document.querySelector("#sort").dispatchEvent(new Event("change"));document.querySelector("#sort").focus()');
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await ev('document.querySelector("#options-menu").open'),false);
  assert.equal(await ev('document.activeElement.id'),'options-trigger');
  await click('#options-trigger');
  await ev('document.querySelector("#chart-scroll").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
  assert.equal(await ev('document.querySelector("#options-menu").open'),false);
  await screen('activity-prototype-desktop');

  await click('#fold-all');assert.equal((await snapshot()).rows,36);assert.equal((await snapshot()).sessions,40);
  await click('#fold-all');assert.equal((await snapshot()).rows,9);
  await click('[data-group="arxiv.org"]');assert.equal(await ev('document.activeElement.dataset.group'),'arxiv.org');
  await click('#view-page');assert.equal((await snapshot()).rows,27);
  const geometry=await ev(`(()=>{const snap=activitySnapshot();return [...document.querySelectorAll('.page-row .interval-hit')].map(b=>{const track=b.closest('.row-track').getBoundingClientRect(),bar=b.querySelector('.interval-bar').getBoundingClientRect();return{left:bar.left-track.left,width:bar.width,expectedLeft:(Number(b.dataset.start)-snap.start)/(snap.end-snap.start)*track.width,expectedWidth:(Number(b.dataset.end)-Number(b.dataset.start))/(snap.end-snap.start)*track.width};});})()`);
  assert.equal(geometry.length,40);for(const g of geometry){assert.ok(Math.abs(g.left-g.expectedLeft)<1,'Exact interval start');assert.ok(Math.abs(g.width-g.expectedWidth)<1.1,'Exact duration geometry');}
  await screen('activity-prototype-pages');
  await click('.page-row .interval-hit');assert.equal(await ev('document.querySelector("#drawer").hidden'),false);assert.ok(await ev('document.querySelectorAll(".session-entry").length>=1'));
  await pause(500);
  await screen('activity-prototype-detail');
  assert.equal(await ev('document.querySelector("#drawer-backdrop").hidden'),true);
  assert.equal(await ev('document.querySelector("#chart-scroll").getBoundingClientRect().right<document.querySelector("#drawer").getBoundingClientRect().left'),true,'Inspector must not cover the timeline');
  const firstDetail=await ev('document.querySelector("#drawer-title").textContent');
  await ev('document.querySelectorAll(".page-row")[1].querySelector(".interval-hit").click()');
  assert.notEqual(await ev('document.querySelector("#drawer-title").textContent'),firstDetail,'Select another page without dismissing the inspector');
  await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await pause(120);
  assert.equal(await axisLabelsFit(),true);assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await pause(120);
  await ev('document.querySelector("#chart-scroll").focus()');
  assert.equal(await ev('document.activeElement.id'),'chart-scroll','Timeline controls remain available');
  // Reverse mid-flight and retain the actual DOM/focusable bars throughout.
  await ev('window.motionBar=document.querySelector(".page-row .interval-hit")');
  await click('#drawer-close');await pause(70);
  const midClose=await ev('parseFloat(getComputedStyle(document.querySelector("#drawer")).opacity)');
  assert.ok(midClose>0 && midClose<1,'Closing has intermediate frames: '+midClose);
  await click('.page-row .interval-hit');
  const resumed=await ev('parseFloat(getComputedStyle(document.querySelector("#drawer")).opacity)');
  assert.ok(Math.abs(resumed-midClose)<.2,'Reopening continues from current presentation');
  await pause(500);
  assert.equal(await ev('window.motionBar===document.querySelector(".page-row .interval-hit")'),true,'Animation preserves interactive nodes');
  assert.equal(await ev('document.querySelector("#drawer").inert'),false);
  await click('#drawer-close');await pause(500);
  assert.equal(await ev('document.querySelector("#drawer").hidden'),true);
  assert.equal(await ev('parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--inspector-space"))'),0);
  await click('.page-row .interval-hit');await pause(80);
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await pause(60);
  assert.equal(await ev('parseFloat(getComputedStyle(document.querySelector("#drawer")).opacity)'),1);
  await click('#drawer-close');assert.equal(await ev('document.querySelector("#drawer").hidden'),true);
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await click('#zoom-in');assert.equal((await snapshot()).zoom,1.5);assert.ok(await ev('document.querySelector("#chart-scroll").scrollWidth>document.querySelector("#chart-scroll").clientWidth'));
  await click('#zoom-reset');assert.equal((await snapshot()).zoom,1);await click('#view-site');
  for(const [width,height] of [[1280,800],[1920,1080]]){await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await pause(120);assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);assert.ok(await ev('document.querySelector("#chart-scroll").clientHeight/innerHeight>.62'));assert.equal(await axisLabelsFit(),true,'Time labels must remain separated');}
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await pause(100);

  const aw={buckets:{'aw-watcher-web-chrome_test':{id:'aw-watcher-web-chrome_test',type:'web.tab.current',events:[
    {id:1,timestamp:'2026-11-03T07:00:00Z',duration:600,data:{title:'Paper A',url:'https://arxiv.org/abs/test-a'}},
    {id:2,timestamp:'2026-11-03T07:10:00Z',duration:300,data:{title:'Repository B',url:'https://github.com/example/b'}},
    {id:3,timestamp:'2026-11-03T07:15:00Z',duration:600,data:{title:'Paper A',url:'https://arxiv.org/abs/test-a'}},
    {id:4,timestamp:'2026-11-03T08:00:00Z',duration:0,data:{title:'Zero',url:'https://example.com/zero'}},
    {id:5,timestamp:'2026-11-03T08:00:00Z',duration:30,data:{title:'Settings',url:'chrome://settings/'}},
  ]}}};
  await importData(aw,'synthetic-aw-export');assert.equal((await snapshot()).sessions,3);assert.equal((await snapshot()).pages,2);assert.equal((await snapshot()).basis,'raw_browser_events');assert.equal((await snapshot()).duration,25*60000);
  await click('#view-page');
  assert.equal(await ev('[...document.querySelectorAll(".page-row")].find(r=>r.textContent.includes("Paper A")).querySelectorAll(".interval-hit").length'),2);
  await importData({events:[{time:'2026-11-03T07:00:00Z',url:'https://example.com'}]},'visit-points-only');assert.equal((await snapshot()).sessions,3);assert.equal(await ev('document.querySelector("#toast").classList.contains("error")'),true);

  const interval=(id,url,start,end,title='Synthetic page')=>({id,url,title,start,end,profile:'test'});
  const boundaries={schema:'daytrace.activity.v1',date:'2026-11-03',utc_offset:'+08:00',source:'import',sessions:[
    interval('a1','https://example.com/a','2026-11-03T05:50:00+08:00','2026-11-03T06:10:00+08:00'),
    interval('b1','https://example.com/b','2026-11-03T06:10:00+08:00','2026-11-03T06:20:00+08:00'),
    interval('a2','https://example.com/a','2026-11-03T06:20:00+08:00','2026-11-03T06:40:00+08:00'),
    interval('b2','https://example.com/b','2026-11-03T23:50:00+08:00','2026-11-04T00:10:00+08:00'),
    interval('early','https://example.com/a','2026-11-03T05:10:00+08:00','2026-11-03T05:20:00+08:00'),
    interval('next','https://example.com/c','2026-11-04T06:20:00+08:00','2026-11-04T06:30:00+08:00'),
  ]};
  await importData(boundaries,'interval-boundaries');assert.equal((await snapshot()).sessions,4);assert.equal((await snapshot()).duration,50*60000);assert.equal((await snapshot()).pages,2);
  await click('#next-day');assert.equal((await snapshot()).date,'2026-11-04');assert.equal((await snapshot()).sessions,1);await click('#previous-day');assert.equal((await snapshot()).sessions,4);
  const downloadDir=path.join(qa,'downloads');fs.mkdirSync(downloadDir);
  await cmd('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
  await click('.interval-hit');await click('#save-button');
  await until(()=>fs.existsSync(path.join(downloadDir,'pageago-activity-2026-11-03.html')));
  const saved=path.join(downloadDir,'pageago-activity-2026-11-03.html');const html=fs.readFileSync(saved,'utf8');
  assert.ok(!/<html[^>]*class="[^"]*inspector-open/.test(html),'Saved page opens with the full-width timeline');
  assert.equal(JSON.parse(html.match(/<script id="activity-data" type="application\/json">([\s\S]*?)<\/script>/)[1]).sessions.length,6,'Save preserves intervals outside visible hours and date');
  await open(saved);assert.equal((await snapshot()).sessions,4);
  await importData({schema:'daytrace.activity.v1',date:'2026-11-03',utc_offset:'+08:00',source:'import',sessions:[interval('xss','https://example.com/unsafe','2026-11-03T08:00:00+08:00','2026-11-03T08:10:00+08:00','</script><img src=x onerror="window.wasInjected=1">')]},'escaped-title');
  await click('#view-page');assert.equal(await ev('window.wasInjected'),undefined);assert.equal(await ev('document.querySelector(".page-title").textContent'),'</script><img src=x onerror="window.wasInjected=1">');
  const large={schema:'daytrace.activity.v1',date:'2026-11-03',utc_offset:'+08:00',source:'import',sessions:[]};
  for(let i=0;i<1000;i++)for(let j=0;j<3;j++){
    const start=Date.parse('2026-11-03T06:00:00+08:00')+(120+j*240+(i%100))*60000;
    large.sessions.push(interval(`large-${i}-${j}`,`https://site${i%10}.example.com/page/${i}`,new Date(start).toISOString(),new Date(start+45000).toISOString(),`Synthetic page #${String(i).padStart(4,'0')} END`));
  }
  await importData(large,'large-synthetic-intervals');await click('#view-site');assert.equal((await snapshot()).pages,1000);assert.equal((await snapshot()).sessions,3000);assert.equal((await snapshot()).rows,10);
  assert.deepEqual(errors,[]);assert.deepEqual(network.filter(url=>/^https?:/i.test(url)),[],'Offline page makes no remote requests');
  fs.writeFileSync(path.join(output,'activity-prototype-qa.json'),JSON.stringify({passed:true,initial,geometryChecks:geometry.length,desktopViewports:['1280x800','1440x1000','1920x1080'],largeFixture:{pages:1000,sessions:3000,collapsedRows:10},checks:['grouping','separate-return-intervals','minimal-controls','interruptible-inspector','reduced-motion','zoom','detail','timezone','06-24-clipping','ActivityWatch-import','visit-only-rejection','offline-save-reload','escaped-titles','large-grouping','glass-control-layer','reduced-transparency','increased-contrast','no-network']},null,2));
  console.log('PASS: activity timeline browser QA; screenshots and report saved in output/');
} catch(error) {
  console.error(error.stack);console.error(diagnostics.slice(-1300));process.exitCode=1;
} finally {
  if(cmd){try{await cmd('Browser.close');}catch{child.kill();}}
  else child.kill();
  socket?.close();
  await pause(350);
  const resolved=path.resolve(qa),expected=path.resolve(root,'output')+path.sep;
  if(!resolved.startsWith(expected) || !path.basename(resolved).startsWith('.activity-browser-'))throw Error('Refusing cleanup outside owned QA directory');
  try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:150});}catch(error){console.error('Owned QA directory retained:',error.message);}
}
