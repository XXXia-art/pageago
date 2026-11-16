// Isolated Edge navigation QA. Synthetic data and a disposable profile only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

const output=path.resolve('output');
const profile=path.join(output,'.trace-navigation-'+randomUUID());
fs.mkdirSync(profile,{recursive:true});
const browser=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
  '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,
  '--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--disable-component-update','--disable-sync','--disable-extensions','about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let diagnostics='',socket,cmd,ev;
browser.stderr.on('data',value=>diagnostics+=value);
browser.on('error',error=>diagnostics+=error.message);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await fn())return;await pause(25);}
  throw Error('Timed out waiting for '+label);
}
const checks=[],errors=[],network=[];

// Observe actual native Web Audio calls without substituting an audio mock.
const audioProbe=`(()=>{
  const log=window.__qaAudio={contexts:0,resumes:0,starts:[],mediaPlays:0};
  const Native=window.AudioContext||window.webkitAudioContext;
  if(Native){
    const resume=Native.prototype.resume;
    Native.prototype.resume=function(...args){log.resumes++;return resume.apply(this,args);};
    for(const method of ['createOscillator','createBufferSource']){
      const create=Native.prototype[method];
      Native.prototype[method]=function(...args){
        const context=this,node=create.apply(this,args),start=node.start;
        node.start=function(...values){const result=start.apply(this,values);log.starts.push({method,state:context.state,time:performance.now(),audioTime:context.currentTime});return result;};
        return node;
      };
    }
    class ObservedContext extends Native{constructor(...args){super(...args);log.contexts++;}}
    window.AudioContext=ObservedContext;
    if(window.webkitAudioContext)window.webkitAudioContext=ObservedContext;
  }
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(...args){log.mediaPlays++;return play.apply(this,args);};
})()`;

try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Edge');
  const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',reject,{once:true});
  });
  const pending=new Map();let sequence=0;
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data),request=pending.get(message.id);
    if(request){clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(Error(JSON.stringify(message.error))):request.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    if(message.method==='Network.requestWillBeSent')network.push(message.params.request.url);
  });
  cmd=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP '+method));},15000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  ev=async expression=>{
    const result=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  };
  const snapshot=()=>ev('traceSnapshot()');
  const point=async(selector,fraction=.5)=>ev(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.x+r.width*${fraction},y:r.y+r.height/2};})()`);
  const mouse=async(type,p,extra={})=>cmd('Input.dispatchMouseEvent',{type,...p,...extra});
  const click=async selector=>{
    const p=await point(selector);
    await mouse('mouseMoved',p);
    await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1});
    await mouse('mouseReleased',p,{button:'left',buttons:0,clickCount:1});
  };
  const drag=async(selector,dx,dy=0,holdBeforeRelease=0)=>{
    const p=await point(selector);
    await mouse('mouseMoved',p);await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1});
    for(const fraction of [.2,.4,.6,.8,1]){
      await pause(25);
      await mouse('mouseMoved',{x:p.x+dx*fraction,y:p.y+dy*fraction},{button:'left',buttons:1});
    }
    if(holdBeforeRelease)await pause(holdBeforeRelease);
    await mouse('mouseReleased',{x:p.x+dx,y:p.y+dy},{button:'left',buttons:0,clickCount:1});
    await pause(80);
  };
  const wheel=async(p,deltaX,deltaY,modifiers=0)=>{
    await ev(`document.addEventListener('wheel',event=>{const r=document.querySelector('#lanes').getBoundingClientRect();window.__navWheel={clientX:event.clientX,pointerX:window.__navPointer?.x,fraction:(event.clientX-r.x)/r.width,viewport:traceSnapshot().viewport};},{capture:true,once:true})`);
    await mouse('mouseMoved',p);
    await mouse('mouseWheel',p,{deltaX,deltaY,modifiers});
    await pause(100);
    return ev('window.__navWheel');
  };
  const key=async(key,code,virtualKey,extra={})=>{
    const text=key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{};
    await cmd('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey,...text,...extra});
    await cmd('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey,...extra});
    await pause(50);
  };
  const importData=async(value,name)=>{
    const file=path.join(profile,name+'.json');fs.writeFileSync(file,JSON.stringify(value));
    const {root}=await cmd('DOM.getDocument');
    const {nodeId}=await cmd('DOM.querySelector',{nodeId:root.nodeId,selector:'#import-input'});
    await cmd('DOM.setFileInputFiles',{nodeId,files:[file]});
    await until(()=>ev('document.querySelector("#import-input").value===""'),'fixture import');
  };
  const audio=()=>ev('structuredClone(window.__qaAudio)');
  const span=state=>state.viewport[1]-state.viewport[0];
  const center=state=>(state.viewport[0]+state.viewport[1])/2;
  const stableViewport=async()=>{
    let previous=null,consecutive=0;
    await until(async()=>{const next=(await snapshot()).viewport;if(previous&&next.every((n,i)=>Math.abs(n-previous[i])<.01))consecutive++;else consecutive=0;previous=next;return consecutive>=4;},'stable viewport',6000);
    return snapshot();
  };
  const motionFrames=async action=>{
    await ev(`(()=>{window.__navFrames=[];window.__navSampling=true;function sample(){if(!window.__navSampling)return;window.__navFrames.push({at:performance.now(),viewport:traceSnapshot().viewport});requestAnimationFrame(sample);}requestAnimationFrame(sample);})()`);
    try{await action();await stableViewport();}
    finally{await ev('window.__navSampling=false');}
    return ev('window.__navFrames');
  };
  const wheelBurst=async(deltas,fraction=.5)=>ev(`(async()=>{const n=document.querySelector('#timeline-nav'),r=document.querySelector('#lanes').getBoundingClientRect();for(const deltaY of ${JSON.stringify(deltas)}){n.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+r.width*${fraction},clientY:r.y+16,deltaY,deltaMode:0}));await new Promise(resolve=>requestAnimationFrame(resolve));}})()`);
  const plotPoint=async(fraction=.5)=>ev(`(()=>{const r=document.querySelector('#lanes').getBoundingClientRect();return {x:r.x+r.width*${fraction},y:r.y+16};})()`);
  const ruler=async label=>{
    const state=await ev(`(()=>{const plot=document.querySelector('#lanes').getBoundingClientRect(),ticks=[...document.querySelectorAll('#axis-graduations .ruler-tick')].map(n=>{const r=n.getBoundingClientRect();return {major:n.classList.contains('is-major'),x:r.x,right:r.right,height:r.height};}),labels=[...document.querySelectorAll('#axis-ticks .tick')].map(n=>{const r=n.getBoundingClientRect();return {text:n.textContent,left:r.left,right:r.right,fontSize:parseFloat(getComputedStyle(n).fontSize)};});return {left:plot.left,right:plot.right,ticks,labels};})()`);
    assert.ok(state.ticks.some(n=>n.major)&&state.ticks.some(n=>!n.major),label+': the ruler has major and minor graduations');
    for(const tick of state.ticks)assert.ok(tick.x>=state.left-1&&tick.right<=state.right+1,label+': graduations stay on the actual time plot');
    for(const tick of state.labels){assert.match(tick.text,/^\d{2}:\d{2}$/,label+': major tick remains a plain local time');assert.ok(tick.fontSize>=18,label+': time labels are at least 18px');}
    const ordered=state.labels.toSorted((a,b)=>a.left-b.left);for(let i=1;i<ordered.length;i++)assert.ok(ordered[i].left>=ordered[i-1].right-1,label+': time labels do not overlap');
  };
  const probeAt=async(clientX,label)=>{
    const actual=await ev(`(()=>{const n=document.querySelector('#time-probe'),badge=document.querySelector('#probe-badge'),b=badge.getBoundingClientRect(),axis=document.querySelector('#axis').getBoundingClientRect(),plot=document.querySelector('#lanes').getBoundingClientRect(),state=traceSnapshot(),fraction=Math.max(0,Math.min(1,(${clientX}-plot.x)/plot.width)),instant=state.viewport[0]+fraction*(state.viewport[1]-state.viewport[0]),probeInstant=Number(n.dataset.instant),d=new Date(probeInstant),end=new Date(state.date+'T00:00:00');end.setDate(end.getDate()+1);const expectedText=Math.abs(probeInstant-+end)<1?'24:00:00':[d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':');return {hidden:n.hidden,instant:probeInstant,expectedInstant:instant,text:badge.querySelector('#probe-time').textContent,expectedText,lineX:axis.x+parseFloat(n.style.left),badgeLeft:b.left,badgeRight:b.right,viewport:innerWidth,pointerEvents:getComputedStyle(n).pointerEvents,aria:n.getAttribute('aria-hidden'),tabIndex:n.tabIndex};})()`);
    assert.equal(actual.hidden,false,label+': pointer time probe is visible');assert.ok(Math.abs(actual.instant-actual.expectedInstant)<2,label+': probe follows the actual viewport epoch '+JSON.stringify({instant:actual.instant,expected:actual.expectedInstant,clientX,lineX:actual.lineX}));assert.equal(actual.text,actual.expectedText,label+': probe shows local time to the second');assert.ok(Math.abs(actual.lineX-clientX)<.6,label+': the probe line stays on the pointer time');
    assert.ok(actual.badgeLeft>=0&&actual.badgeRight<=actual.viewport+.5,label+': edge labels stay inside the viewport');assert.equal(actual.pointerEvents,'none',label+': probe cannot intercept timeline gestures');assert.equal(actual.aria,'true');assert.equal(actual.tabIndex,-1);return actual;
  };
  const hoverProbe=async(fraction,label)=>{const p=await plotPoint(fraction);await mouse('mouseMoved',p);await pause(30);return probeAt(await ev('window.__navPointer.x'),label);};
  const focus=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`);
  const unchangedData=async(reference,label)=>{
    const current=await snapshot();
    for(const name of ['date','segments','allSessions','activeMs'])assert.equal(current[name],reference[name],label+': '+name+' is unchanged');
    assert.deepEqual(current.range,reference.range,label+': selected base range is unchanged');
    assert.ok(await ev('window.__navBlocks.length===document.querySelectorAll("#scene .block").length&&window.__navBlocks.every((n,i)=>n===document.querySelectorAll("#scene .block")[i])'),label+': navigation preserves interval nodes');
  };
  const exactIntervals=async(sessions,label)=>{
    const geometry=await ev(`(()=>{const r=document.querySelector('#lanes').getBoundingClientRect();return {width:r.width,state:traceSnapshot(),blocks:[...document.querySelectorAll('#scene .block')].map(n=>{const b=n.getBoundingClientRect();return {id:n.dataset.session,x:b.x-r.x,width:b.width,leftPercent:parseFloat(n.style.left),widthPercent:parseFloat(n.style.width),hidden:n.hidden,tabIndex:n.tabIndex};})};})()`);
    const byId=new Map(sessions.map(session=>[session.id,session]));
    assert.equal(geometry.blocks.length,sessions.length,label+': all base intervals remain rendered');
    for(const block of geometry.blocks){
      const session=byId.get(block.id);assert.ok(session,label+': real source interval');
      const a=Math.max(Date.parse(session.start),geometry.state.bounds[0]),b=Math.min(Date.parse(session.end),geometry.state.bounds[1]);
      const x=(a-geometry.state.viewport[0])/span(geometry.state)*geometry.width,width=(b-a)/span(geometry.state)*geometry.width;
      assert.ok(Math.abs(block.leftPercent*geometry.width/100-x)<.15,label+': stored position preserves the real instant for '+block.id);
      assert.ok(Math.abs(block.widthPercent*geometry.width/100-width)<.15,label+': stored width preserves the real duration for '+block.id);
      const outside=b<=a||b<=geometry.state.viewport[0]||a>=geometry.state.viewport[1];
      assert.equal(block.hidden,outside,label+': only intervals intersecting the viewport are visible');
      assert.equal(block.tabIndex,-1,label+': ribbon intervals are not separate keyboard stops');
      if(!block.hidden){
        assert.ok(Math.abs(block.x-x)<.15,label+': correct displayed instant for '+block.id+' ('+(block.x-x)+')');
        assert.ok(Math.abs(block.width-width)<.15,label+': correct displayed duration for '+block.id+' ('+(block.width-width)+')');
      }
    }
    const overflow=await ev('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll("#scene .block:not([hidden]),#scene .event-tag:not([hidden]),#axis .tick")].map(n=>{const r=n.getBoundingClientRect();return {kind:n.className,id:n.dataset.session||n.dataset.url||n.textContent,left:r.left,right:r.right};}).filter(r=>r.right>innerWidth+.1||r.left<-.1).slice(0,8)})');
    assert.ok(overflow.scrollWidth<=overflow.width,label+': offscreen intervals do not widen the document '+JSON.stringify(overflow));
  };
  const settings=async()=>{
    if(await ev('document.querySelector("#settings-dialog").open'))return;
    await click('#date-trigger');
    assert.ok(await ev('document.querySelector("#date-popover #settings-button").getClientRects().length'), 'settings is visible in the date picker');
    await click('#settings-button');
  };
  const closeSettings=async()=>{if(await ev('document.querySelector("#settings-dialog").open'))await click('#close-dialog');};
  const reset=async()=>{await focus('#timeline-nav');await key('Home','Home',36);return stableViewport();};
  const wheelLimit=async direction=>{for(let i=0;i<12;i++)await wheel(await plotPoint(),0,direction*100000);return stableViewport();};
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:audioProbe});
  await cmd('Page.addScriptToEvaluateOnNewDocument',{source:'document.addEventListener("pointermove",event=>window.__navPointer={x:event.clientX,y:event.clientY},{capture:true})'});
  await cmd('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await cmd('Page.navigate',{url:pathToFileURL(path.join(output,'pageago.html')).href});
  await until(()=>ev('typeof traceSnapshot==="function"&&traceSnapshot().ready'),'dashboard');

  const initial=await snapshot();
  assert.equal(initial.mode,'demo');
  await until(()=>ev("document.querySelector('#daylight-canvas')?.dataset.daylightReady === 'true'"),'room artwork rendered');
  const room=await ev(`(()=>{
    const shell=document.querySelector('#daylight-room'),canvas=shell.querySelector('#daylight-canvas');
    const box=canvas.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
    const context=canvas.getContext('2d');
    const cornerRadii=['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'];
    const shellStyle=getComputedStyle(shell),canvasStyle=getComputedStyle(canvas);
    const softCorners=cornerRadii.every(radius=>shellStyle[radius]==='8px')
      &&shellStyle.overflowX==='hidden'&&shellStyle.overflowY==='hidden';
    const squareCanvas=cornerRadii.every(radius=>canvasStyle[radius]==='0px');
    const corners=[[0,0],[canvas.width-1,0],[0,canvas.height-1],[canvas.width-1,canvas.height-1]];
    return {
      visible:box.width>0&&box.height>0&&context.getImageData(canvas.width>>1,canvas.height>>1,1,1).data[3]>0,
      softCorners,squareCanvas,paintedCorners:corners.every(([px,py])=>context.getImageData(px,py,1,1).data[3]===255),
      interactive:shell.tabIndex>=0||canvas.tabIndex>=0||!!shell.querySelector('input,button,a[href],[role="slider"],[tabindex]:not([tabindex="-1"])'),
      intercepted:shell.contains(document.elementFromPoint(x,y)),
      slider:!!document.querySelector('#daylight-range')||!!shell.querySelector('input[type="range"],[role="slider"]')
    };
  })()`);
  assert.deepEqual(room,{visible:true,softCorners:true,squareCanvas:true,paintedCorners:true,interactive:false,intercepted:false,slider:false},'the passive study has four softly rounded corners around the complete artwork');
  const roomMinute=()=>ev("Number(document.querySelector('#daylight-canvas').dataset.minute)");
  assert.equal(await roomMinute(),540,'the daily overview opens with the morning room');
  assert.deepEqual(await ev(`(()=>{const n=document.querySelector('#timeline-nav');return {tag:n.tagName,role:n.getAttribute('role'),tabIndex:n.tabIndex,expanded:n.hasAttribute('aria-expanded')};})()`),{tag:'DIV',role:'group',tabIndex:0,expanded:false},'the main ruler is a focusable navigation group, not an expansion button');
  assert.deepEqual(initial.viewport,initial.bounds);assert.equal(initial.zoom,1);
  const baseStart=Date.parse(initial.date+'T00:00:00+08:00'),baseEnd=baseStart+86400000;
  assert.deepEqual(initial.range,[0,1440]);assert.deepEqual(initial.bounds,[baseStart,baseEnd],'viewport exposes the complete selected local day');
  const fullDayLabels=async label=>assert.deepEqual(await ev('(()=>{const n=[...document.querySelectorAll("#axis-ticks .tick")];return [n[0].textContent,n.at(-1).textContent];})()'),['00:00','24:00'],label+': overview endpoints stay midnight and end of day');await fullDayLabels('initial demo');
  const sessions=await ev('(()=>{window.__navBlocks=[...document.querySelectorAll("#scene .block")];const ids=new Set(window.__navBlocks.map(n=>n.dataset.session));return window.TRACE_DEMO.sessions.filter(s=>ids.has(s.id));})()');
  await ruler('full-day ruler');const focusedBeforeHover=await ev('document.activeElement.id');
  for(const fraction of [0,.25,.5,.75,1])await hoverProbe(fraction,'full-day probe '+fraction);
  assert.equal(await roomMinute(),540,'ordinary ruler hover leaves the lighting alone');
  assert.equal(await ev('document.activeElement.id'),focusedBeforeHover,'hovering the ruler never steals focus');await unchangedData(initial,'ruler hover');
  const pageTag=await point('.event-tag:not([hidden])');await mouse('mouseMoved',pageTag);await pause(30);assert.equal(await ev('document.querySelector("#time-probe").hidden'),true,'page-title hover hides the ruler probe');assert.equal(await ev('document.querySelector("#tooltip").hidden'),false,'page-title tooltip remains available');
  await hoverProbe(.75,'probe screenshot');const rulerImage=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,'trace-ruler-probe.png'),Buffer.from(rulerImage.data,'base64'));
  await mouse('mouseMoved',{x:8,y:8});await pause(30);assert.equal(await ev('document.querySelector("#time-probe").hidden'),true,'probe disappears when the pointer leaves the ruler');
  await pause(200);
  assert.deepEqual(await audio(),{contexts:0,resumes:0,starts:[],mediaPlays:0},'loading and idle rendering never initialize or play audio');
  checks.push('18px non-overlapping major labels and fine graduations; hover probe tracks real local time, clamps edge badges, yields to page tooltips and stays silent');
  assert.equal(await ev('TraceDialAudio.debug.enabled'),true);
  await drag('#timeline-nav',150);
  assert.deepEqual((await snapshot()).viewport,initial.bounds,'horizontal drag at 1× stays inside the base range');
  assert.equal((await snapshot()).overflowOpen,false,'horizontal drag does not open the hidden-page list');
  assert.equal((await audio()).starts.length,0,'an unchanged boundary does not tick');
  checks.push('real instant viewport, silent initial render and silent bounded drag at 1×');

  await click('#zoom-in');let current=await stableViewport();
  await ruler('zoomed ruler');
  assert.ok(span(current)<span(initial),'zoom-in reduces the visible time span');
  assert.ok(Math.abs(center(current)-center(initial))<2,'button zoom retains the center instant');
  assert.ok(Math.abs(current.zoom-span(initial)/span(current))<.00001,'zoom factor reflects the actual visible span');
  await unchangedData(initial,'button zoom');await exactIntervals(sessions,'button zoom');
  const enlarged=current;await click('#zoom-out');current=await stableViewport();
  assert.ok(span(current)>span(enlarged),'zoom-out widens the visible time span');
  await click('#zoom-in');await stableViewport();
  for(const [fraction,modifiers,label] of [[.72,0,'mouse wheel'],[.31,2,'Ctrl+wheel pinch']]){
    const before=await snapshot(),p=await plotPoint(fraction),scroll=await ev('scrollY');
    const event=await wheel(p,0,-150,modifiers),anchor=before.viewport[0]+span(before)*event.fraction,after=await stableViewport();
    assert.ok(span(after)<span(before),label+' zooms in');
    assert.ok(Math.abs(after.viewport[0]+span(after)*event.fraction-anchor)<2,label+' keeps the actual event instant anchored (delta '+(after.viewport[0]+span(after)*event.fraction-anchor)+'ms)');
    assert.equal(after.overflowOpen,false,label+' does not open another surface');
    assert.equal(await ev('scrollY'),scroll,label+' does not scroll the page');
    assert.equal(await ev('devicePixelRatio'),1,label+' does not zoom the browser UI');
    await probeAt(event.pointerX,label+' updates the time probe under the stationary pointer');
  }
  await exactIntervals(sessions,'anchored wheel zoom');await unchangedData(initial,'wheel zoom');
  await ev('document.activeElement?.blur()');const zoomedImage=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,'trace-ribbon-zoomed.png'),Buffer.from(zoomedImage.data,'base64'));
  checks.push('button, wheel and trackpad-pinch zoom preserve center/pointer anchors and real interval geometry');

  for(const [deltaX,deltaY,modifiers,label] of [[80,0,0,'horizontal wheel'],[0,80,8,'Shift+wheel'],[80,0,8,'Shift+horizontal wheel']]){
    const before=await snapshot(),p=await plotPoint();const event=await wheel(p,deltaX,deltaY,modifiers);const after=await stableViewport();
    assert.ok(after.viewport[0]>before.viewport[0],label+' pans forward in time');
    assert.ok(Math.abs(span(after)-span(before))<2,label+' does not change the scale');
    assert.equal(after.overflowOpen,false,label+' does not open another surface');
    await probeAt(event.pointerX,label+' updates probe time without another pointer move');
  }
  const beforeDrag=await snapshot(),plotWidth=await ev('document.querySelector("#lanes").getBoundingClientRect().width');
  await drag('#timeline-nav',120,0,140);current=await stableViewport();
  assert.ok(Math.abs(current.viewport[0]-(beforeDrag.viewport[0]-120/plotWidth*span(beforeDrag)))/span(beforeDrag)*plotWidth<.1,'drag keeps time attached to the pointer within a tenth of a pixel');
  assert.equal(current.overflowOpen,false,'horizontal drag does not open the hidden-page list');
  await unchangedData(initial,'pan');await exactIntervals(sessions,'pan');
  await wheel(await plotPoint(),-1000000,0);current=await stableViewport();
  assert.ok(Math.abs(current.viewport[0]-initial.bounds[0])<2,'pan clamps at the start boundary');
  await wheel(await plotPoint(),1000000,0);current=await stableViewport();
  assert.ok(Math.abs(current.viewport[1]-initial.bounds[1])<2,'pan clamps at the end boundary');
  const boundaryAudio=(await audio()).starts.length;
  await wheel(await plotPoint(),1000000,0);await stableViewport();
  assert.equal((await audio()).starts.length,boundaryAudio,'repeating an already-clamped pan remains silent');
  current=await wheelLimit(-1);
  assert.ok(Math.abs(span(current)-1800000)<2,'minimum visible span is 30 actual minutes');
  await ruler('maximum-zoom ruler');await hoverProbe(.5,'maximum-zoom probe');
  await exactIntervals(sessions,'minimum span');
  current=await wheelLimit(1);
  assert.deepEqual(current.viewport,initial.bounds,'maximum visible span is the selected full base range');
  assert.equal(current.zoom,1);await unchangedData(initial,'bounded zoom');
  checks.push('horizontal drag/wheel pan, 30-minute minimum, full-range maximum and silent hard boundaries');

  // Sample the live camera between wheel notches, rather than only checking its destination.
  const smoothBefore=await snapshot(),smoothPoint=await plotPoint(.61);let smoothEvent;
  const smoothFrames=await motionFrames(async()=>{smoothEvent=await wheel(smoothPoint,0,-150);});
  const smoothAfter=await snapshot(),smoothTarget=span(smoothBefore)*Math.exp(-150*.002);
  assert.ok(Math.abs(span(smoothAfter)-smoothTarget)<2,'one wheel notch retains its original scale increment');
  const intermediate=smoothFrames.filter(f=>{const width=f.viewport[1]-f.viewport[0];return width<span(smoothBefore)-2&&width>smoothTarget+2;});
  assert.ok(new Set(intermediate.map(f=>Math.round(f.viewport[1]-f.viewport[0]))).size>=3,'a single mouse-wheel notch paints multiple intermediate scales instead of one jump');
  const anchoredInstant=smoothBefore.viewport[0]+span(smoothBefore)*smoothEvent.fraction;
  for(const frame of intermediate)assert.ok(Math.abs(frame.viewport[0]+(frame.viewport[1]-frame.viewport[0])*smoothEvent.fraction-anchoredInstant)<2,'the pointer instant remains anchored throughout the spring, not only after settling');
  const burstBefore=await snapshot();
  await motionFrames(()=>wheelBurst([-90,-90,-90]));
  assert.ok(Math.abs(span(await snapshot())-span(burstBefore)*Math.exp(-270*.002))<2,'rapid wheel events accumulate every delta while the display is still following its target');
  const reverseBefore=await snapshot(),reversePoint=await plotPoint(.5);
  const reverseFrames=await motionFrames(async()=>{await wheel(reversePoint,0,-200);await wheel(reversePoint,0,200);});
  assert.ok(Math.abs(span(await snapshot())-span(reverseBefore))<2,'reversing before the spring settles returns to the net wheel target without losing the earlier input');
  assert.ok(reverseFrames.some(f=>f.viewport[1]-f.viewport[0]<span(reverseBefore)-1000),'reverse test observes a real in-flight change before returning');
  await exactIntervals(sessions,'smooth wheel');await unchangedData(initial,'smooth wheel');
  checks.push('wheel zoom paints intermediate anchored scales; rapid notches accumulate and an in-flight reversal settles at the exact net target');

  const grabPoint=await plotPoint(.5);
  await mouse('mouseMoved',grabPoint);await mouse('mouseWheel',grabPoint,{deltaX:0,deltaY:-450});await pause(25);
  await mouse('mousePressed',grabPoint,{button:'left',buttons:1,clickCount:1});const grabbed=await snapshot();
  await pause(140);assert.deepEqual((await snapshot()).viewport,grabbed.viewport,'pointer-down interrupts wheel zoom at the actual visible viewport');
  const grabWidth=await ev('document.querySelector("#lanes").getBoundingClientRect().width');
  await mouse('mouseMoved',{x:grabPoint.x+80,y:grabPoint.y},{button:'left',buttons:1});await pause(150);
  await mouse('mouseReleased',{x:grabPoint.x+80,y:grabPoint.y},{button:'left',buttons:0,clickCount:1});
  const draggedAfterWheel=await stableViewport();
  assert.ok(Math.abs(span(draggedAfterWheel)-span(grabbed))<2,'dragging a grabbed zoom keeps the presented scale');
  assert.ok(Math.abs(draggedAfterWheel.viewport[0]-(grabbed.viewport[0]-80/grabWidth*span(grabbed)))/span(grabbed)*grabWidth<.1,'drag continues from the grabbed time window within a tenth of a pixel rather than the abandoned zoom target');
  const beforeReset=await plotPoint(.5);await mouse('mouseMoved',beforeReset);await mouse('mouseWheel',beforeReset,{deltaX:0,deltaY:-350});await pause(25);
  await click('#hour-dial-reset');await stableViewport();await pause(180);
  assert.deepEqual((await snapshot()).viewport,initial.bounds,'noon reset replaces an in-flight wheel target and stays at the full-day overview');
  assert.equal(await ev('document.querySelector(".hour-dial-time").textContent'),'12:00','reset keeps the selected time at noon throughout the completed return');
  assert.equal(await ev('document.querySelector("#hour-marker").hidden'),true,'reset clears the previous selected-time marker');
  checks.push('pointer-down and drag interrupt a live wheel spring without a jump or residual zoom; noon reset replaces the old target');

  await ev(`document.querySelector('.hour-dial-track').addEventListener('wheel',event=>{const r=event.currentTarget.getBoundingClientRect();window.__navDialMinute=Math.round(Math.max(0,Math.min(1,(event.clientX-r.left)/r.width))*1440);},{capture:true,once:true})`);
  const dialFrames=await motionFrames(async()=>wheel(await point('.hour-dial-track',.625),0,-150));
  const dialAfter=await snapshot(),dialMinute=await ev('window.__navDialMinute');
  assert.ok(Math.abs(span(dialAfter)-span(initial)*Math.exp(-150*.002))<2,'the lower dial uses the same accumulated zoom scale');
  assert.ok(new Set(dialFrames.map(f=>Math.round(f.viewport[1]-f.viewport[0]))).size>=4,'lower dial wheel zoom also paints intermediate scales');
  assert.ok(Math.abs(center(dialAfter)-(baseStart+dialMinute*60000))<2,'lower dial wheel zoom centers its requested local time');
  assert.equal(await ev('document.querySelector("#hour-dial").hasAttribute("data-locked")'),true,'lower dial keeps its selected time locked while its camera animates');
  assert.equal(await ev('document.querySelector(".hour-dial-track").getAttribute("aria-valuenow")'),String(dialMinute),'lower dial selection is not overwritten by the moving camera center');
  assert.ok(await ev('!document.querySelector("#hour-marker").hidden&&Math.abs(parseFloat(document.querySelector("#hour-marker").style.left)-50)<.001'),'selected-time marker reaches the middle of the completed dial zoom');
  await click('#hour-dial-reset');await stableViewport();
  assert.deepEqual((await snapshot()).viewport,initial.bounds);
  checks.push('lower-dial wheel shares smooth camera motion and retains its requested time, marker and lock until reset');

  await focus('#timeline-nav');
  for(const shortcut of [{key:'+',code:'Equal',ctrlKey:true},{key:'-',code:'Minus',metaKey:true},{key:'ArrowLeft',code:'ArrowLeft',altKey:true}]){
    const before=await snapshot();
    const prevented=await ev(`(()=>{const event=new KeyboardEvent('keydown',{...${JSON.stringify(shortcut)},bubbles:true,cancelable:true});document.querySelector('#timeline-nav').dispatchEvent(event);return event.defaultPrevented;})()`);
    assert.equal(prevented,false,'browser shortcut '+JSON.stringify(shortcut)+' remains available');
    assert.deepEqual((await stableViewport()).viewport,before.viewport,'browser shortcuts do not move the timeline');
  }
  await key('+','Equal',187,{text:'+',unmodifiedText:'+',modifiers:8});current=await stableViewport();
  assert.ok(span(current)<span(initial),'keyboard + zooms in');
  const keyboardStart=current.viewport[0],roomBeforePan=await roomMinute();
  await key('ArrowRight','ArrowRight',39);current=await stableViewport();
  assert.ok(current.viewport[0]>keyboardStart,'focused Right Arrow pans rather than changing date');assert.equal(current.date,initial.date);
  const roomAfterPan=await roomMinute();
  assert.notEqual(roomAfterPan,roomBeforePan,'panning the main ruler updates the study lighting time');
  const centerMinute=await ev(`(()=>{const d=new Date(${center(current)});return d.getHours()*60+d.getMinutes();})()`);
  assert.ok(Math.abs(roomAfterPan-centerMinute)<=1,'the room follows the local time at the viewport center');
  checks.push('visible noninteractive study follows main timeline navigation; no water drop, duplicate range, or extra focus stop');
  await key('ArrowLeft','ArrowLeft',37);current=await stableViewport();
  assert.ok(Math.abs(current.viewport[0]-keyboardStart)<2,'opposite arrow returns to the previous viewport');
  const keyboardSpan=span(current);await key('-','Minus',189,{text:'-',unmodifiedText:'-'});current=await stableViewport();
  assert.ok(span(current)>keyboardSpan,'keyboard - zooms out');
  await key('+','Equal',187,{text:'+',unmodifiedText:'+',modifiers:8});await stableViewport();
  const focusTargets=new Set();
  for(let i=0;i<35&&focusTargets.size<3;i++){await key('Tab','Tab',9);const id=await ev('document.activeElement.id');if(['zoom-in','zoom-out','zoom-reset'].includes(id))focusTargets.add(id);}
  assert.deepEqual([...focusTargets].sort(),['zoom-in','zoom-out','zoom-reset'],'all zoom controls are reachable through Tab');
  for(const id of focusTargets)assert.ok(await ev(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-label')`),id+' has an accessible name');
  await click('#zoom-reset');current=await stableViewport();assert.deepEqual(current.viewport,initial.bounds,'reset button restores the complete local day at 1×');await fullDayLabels('zoom reset');
  await click('#zoom-in');await stableViewport();await reset();assert.deepEqual((await snapshot()).viewport,initial.bounds,'Home restores 1×');
  await click('#zoom-in');const beforeIdleGestures=await stableViewport();
  await drag('#timeline-nav',0,150);current=await stableViewport();
  assert.deepEqual(current.viewport,beforeIdleGestures.viewport,'vertical dragging does not change the time range');
  assert.equal(current.overflowOpen,false,'vertical dragging does not open the hidden-page list');
  await click('#timeline-nav');current=await stableViewport();
  assert.deepEqual(current.viewport,beforeIdleGestures.viewport,'clicking the ruler does not select or zoom a time period');
  assert.equal(current.overflowOpen,false,'clicking the ruler does not open the hidden-page list');
  assert.equal(current.drawer,0,'clicking the ruler does not open webpage details');
  await focus('#timeline-nav');await key('Enter','Enter',13,{text:'\r',unmodifiedText:'\r'});
  assert.deepEqual((await stableViewport()).viewport,beforeIdleGestures.viewport,'Enter on the ruler does not navigate');
  await unchangedData(initial,'non-navigation ruler gestures');await exactIntervals(sessions,'after non-navigation ruler gestures');
  assert.equal(await ev('document.querySelectorAll("#period-controls,#period-menu,#period-empty,.lane-label").length'),0,'removed period and row-label controls are absent');
  checks.push('keyboard pan/zoom/reset, Tab-accessible navigation group, and inert ruler click/vertical-drag without removed expansion surfaces');

  const played=await audio();assert.ok(played.starts.length>0,'crossing scale marks emits native audio after a trusted gesture');
  assert.ok(played.starts.every(start=>start.state==='running'),'ticks are started only in a running context');
  assert.ok(await ev('TraceDialAudio.debug.played>0'),'audio module confirms played ticks');
  await settings();assert.equal(await ev('document.querySelector("#sound-button").getAttribute("aria-pressed")'),'true');
  await click('#sound-button');assert.equal(await ev('document.querySelector("#sound-button").getAttribute("aria-pressed")'),'false');await closeSettings();
  const mutedCount=(await audio()).starts.length,mutedPlayed=await ev('TraceDialAudio.debug.played');
  await wheel(await plotPoint(),0,-500);await stableViewport();await wheel(await plotPoint(),600,0);await stableViewport();
  assert.equal((await audio()).starts.length,mutedCount,'muted zoom and pan schedule no new audio');
  assert.equal(await ev('TraceDialAudio.debug.played'),mutedPlayed,'muted crossings do not increment played ticks');
  await cmd('Page.reload');await until(()=>ev('typeof traceSnapshot==="function"&&traceSnapshot().ready'),'muted reload');
  assert.equal(await ev('TraceDialAudio.debug.enabled'),false,'mute preference survives reload');
  await click('#zoom-in');await stableViewport();
  assert.equal((await audio()).contexts,0,'muted gestures do not create an audio context');assert.equal((await audio()).starts.length,0);
  await settings();await click('#sound-button');await closeSettings();
  await wheel(await plotPoint(),0,-500);await stableViewport();
  assert.ok((await audio()).starts.length>0,'explicitly re-enabling sound restores tick playback');
  checks.push('gesture-only native ticks, mute suppresses new playback, mute persists, explicit re-enable works');

  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await reset();await click('#zoom-in');const reduced=await snapshot();await pause(150);
  assert.deepEqual((await snapshot()).viewport,reduced.viewport,'reduced-motion button zoom has no residual spring');
  assert.ok(reduced.zoom>1);await drag('#timeline-nav',80);assert.equal((await snapshot()).overflowOpen,false);
  await focus('#timeline-nav');await key('Home','Home',36);assert.equal((await snapshot()).zoom,1,'reduced-motion Home resets immediately');
  checks.push('reduced-motion zoom/reset is immediate and horizontal drag remains available');

  await cmd('Emulation.setTimezoneOverride',{timezoneId:'America/New_York'});
  const dstSessions=[{id:'navigation-dst',url:'https://example.com/dst',title:'Synthetic clock rollback',start:'2026-11-01T05:50:00Z',end:'2026-11-01T06:10:00Z'}];
  await importData({schema:'trace.v1',source:'synthetic-demo',sessions:dstSessions},'navigation-dst');current=await snapshot();
  assert.deepEqual(current.bounds,[Date.parse('2026-11-01T04:00:00Z'),Date.parse('2026-11-02T05:00:00Z')]);
  assert.equal(span(current),90000000,'a complete rollback day contains 25 actual hours');
  await ruler('DST rollback ruler');const firstOne=await hoverProbe(1.5/25,'first 01:30 during rollback'),secondOne=await hoverProbe(2.5/25,'repeated 01:30 during rollback');assert.equal(firstOne.text.slice(0,2),'01');assert.equal(secondOne.text.slice(0,2),'01');assert.ok(Math.abs(secondOne.instant-firstOne.instant-3600000)<120000,'same local clock hour represents distinct actual instants during rollback');
  current=await wheelLimit(-1);
  assert.ok(Math.abs(span(current)-1800000)<2,'minimum zoom is still 30 actual minutes on a rollback day');
  assert.equal(current.activeMs,1200000);await exactIntervals(dstSessions,'DST zoom');
  await reset();assert.equal(span(await snapshot()),90000000,'reset recovers the complete 25-hour base range');await fullDayLabels('25-hour reset');
  const springSessions=[{id:'navigation-spring',url:'https://example.com/spring',title:'Synthetic clock advance',start:'2026-03-08T06:50:00Z',end:'2026-03-08T07:10:00Z'}];await importData({schema:'trace.v1',source:'synthetic-demo',sessions:springSessions},'navigation-spring');current=await snapshot();assert.deepEqual(current.range,[0,1440]);assert.deepEqual(current.bounds,[Date.parse('2026-03-08T05:00:00Z'),Date.parse('2026-03-09T04:00:00Z')]);assert.equal(span(current),82800000,'a complete spring-forward day contains 23 actual hours');assert.equal(current.activeMs,1200000);await fullDayLabels('23-hour overview');await ruler('DST spring-forward ruler');await exactIntervals(springSessions,'spring-forward interval');await click('#zoom-in');await stableViewport();await reset();assert.equal(span(await snapshot()),82800000,'reset recovers the complete 23-hour day');await fullDayLabels('23-hour reset');
  checks.push('full-day DST navigation preserves both 25-hour rollback and 23-hour spring-forward days, local midnight endpoints, and real interval durations');
  await cmd('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
  const repeat='https://github.com/example/repeat';
  const visit=(id,url,title,from,to)=>({
    id,url,title,start:'2026-11-10T'+from+':00+08:00',end:'2026-11-10T'+to+':00+08:00'
  });
  const first=visit('first',repeat,'First reading','00:00','00:06');
  const before=visit('before','https://arxiv.org/abs/123','Earlier paper','18:50','19:00');
  const returning=visit('return',repeat,'Evening revisit','19:00','19:20');
  const overlap=visit('overlap','https://www.youtube.com/watch?v=example','Overlapping video '+ 'with a long title '.repeat(12).trim(),'19:05','19:15');
  const last=visit('last','https://example.org/end','Final reading','23:45','23:59');
  const visits=[last,returning,first,overlap,before]; // Export order can differ from browsing order.
  await importData({schema:'trace.v1',source:'synthetic-demo',sessions:visits},'ruler-visits');
  await until(async()=>(await snapshot()).segments===visits.length,'visits loaded');

  const pageTip=()=>ev(`(()=>{
    const page=document.querySelector('#probe-page'),icon=page.querySelector('.site-icon');
    return {visible:!!page.getClientRects().length,title:document.querySelector('#probe-title').textContent,
      icon:!!icon?.getClientRects().length,loadedImage:!!icon?.querySelector('img')?.naturalWidth};
  })()`);
  const blockSelector=id=>'.block[data-session="'+id+'"]';
  const hoverPaint=async(position,label)=>{
    await mouse('mouseMoved',position);
    await probeAt(await ev('window.__navPointer.x'),label);
    assert.equal(await ev(`document.elementFromPoint(${position.x},${position.y})?.closest('#timeline-nav')?.id`),'timeline-nav',label+': hovering a block preserves the gesture surface');
  };
  const assertPageTip=async session=>{
    await until(async()=>(await pageTip()).loadedImage,'local site icon for '+session.id);
    assert.deepEqual(await pageTip(),{visible:true,title:session.title,icon:true,loadedImage:true});
  };
  const assertTimeOnly=async label=>{
    const tip=await pageTip();
    assert.equal(tip.visible,false,label+': no page title displayed');
    assert.equal(tip.icon,false,label+': no site icon displayed');
  };
  const topVisit=await point(blockSelector(returning.id)),secondVisit=await point(blockSelector(overlap.id));
  await hoverPaint({x:secondVisit.x,y:topVisit.y},'repeated URL on first row');
  await assertPageTip(returning);
  await hoverPaint(secondVisit,'same instant on second row');
  await assertPageTip(overlap);
  assert.equal(await ev(`(()=>{const title=document.querySelector('#probe-title');return getComputedStyle(title).textOverflow==='ellipsis'&&title.scrollWidth>title.clientWidth})()`),true,'long hover titles fit on one compact line');
  const belowTrack=await point('#axis-ticks');
  await mouse('mouseMoved',{x:secondVisit.x,y:belowTrack.y});
  await probeAt(await ev('window.__navPointer.x'),'clock ticks below a painted interval');
  await assertTimeOnly('clock ticks below a painted interval');
  const joinedEdge=await point(blockSelector(returning.id),0);
  await hoverPaint({x:joinedEdge.x-2,y:joinedEdge.y},'just before adjacent visit');
  await assertPageTip(before);
  await hoverPaint({x:joinedEdge.x+2,y:joinedEdge.y},'just after adjacent visit');
  await assertPageTip(returning);
  await hoverProbe(.5,'long gap between visits');await assertTimeOnly('empty space on populated day');
  assert.equal(await ev('document.querySelector("#scene").hasAttribute("data-highlight-site")'),false,'hover never selects a website');
  checks.push('main ruler hover matches the painted row and the visit title even at overlapping rows, boundaries and repeated URLs; gaps show only time');

  const openPage=async url=>{
    await click('.event-tag[data-url="'+url+'"]');
    await until(async()=>(await snapshot()).drawer===1,'detail for '+url);
  };
  const visitButton=id=>'button.detail-session[data-session="'+id+'"]';
  const locate=async(session,expected,withKeyboard=false)=>{
    if(withKeyboard){
      await focus(visitButton(session.id));
      await key('Enter','Enter',13);
    }else await click(visitButton(session.id));
    await until(()=>ev('document.querySelector(".block.visit-selected")?.dataset.session==='+JSON.stringify(session.id)),'located '+session.id);
    const view=await stableViewport(),start=Date.parse(session.start),end=Date.parse(session.end);
    assert.ok(view.viewport[0]<=start&&view.viewport[1]>=end,'the chosen visit fits the visible ruler');
    assert.ok(span(view)<3600000,'short visit zooms to its surrounding half-hour');
    assert.equal(await ev('document.querySelector(".detail-session[aria-pressed=true]")?.dataset.session'),session.id);
    assert.equal(await ev('document.querySelector(".detail-url").href'),session.url);
    assert.equal(await ev('document.querySelector("#scene").dataset.highlightSite'),new URL(session.url).hostname,'site highlight follows the chosen page through visit navigation');
    const context=await ev(`[...document.querySelectorAll('.visit-context .visit-neighbor')].map(n=>({
      direction:n.dataset.direction,id:n.dataset.session,title:n.querySelector('.visit-neighbor-title').textContent,
      visible:!!n.getClientRects().length
    }))`);
    assert.deepEqual(context,expected.map(([direction,neighbor])=>({direction,id:neighbor.id,title:neighbor.title,visible:true})),session.id+': chronological neighbors are identifiable');
  };
  await openPage(repeat);
  await locate(first,[['next',before]]);
  await locate(returning,[['previous',before],['next',overlap]],true);
  for(const s of [before,returning,overlap])assert.equal(await ev('document.querySelector('+JSON.stringify(blockSelector(s.id))+').hidden'),false,'nearby interval is visible on the ruler: '+s.id);
  assert.equal(await ev('document.querySelector('+JSON.stringify(blockSelector(first.id))+').hidden'),true,'the other visit to the same URL remains outside this evening view');
  await click('#close-inspector');await reset();await openPage(last.url);
  await locate(last,[['previous',overlap]]);
  await click('#close-inspector');
  assert.equal(await ev('document.querySelector(".block.visit-selected")===null'),true,'closing details clears the located visit');
  await reset();
  await importData({schema:'trace.v1',source:'synthetic-demo',sessions:[first]},'ruler-single-visit');
  await until(async()=>(await snapshot()).segments===1,'single visit loaded');
  await openPage(repeat);await locate(first,[]);
  assert.equal(await ev('document.querySelector(".visit-context")===null'),true,'a lone visit has no empty neighbor section');
  await click('#close-inspector');
  checks.push('detail buttons and Enter locate the exact repeated visit, include nearby intervals on the ruler, and show existing neighbors at both ends of the day');

  // A shorter, nested interval must not shorten the end of the surrounding browsing group.
  const reading=visit('reading',repeat,'Main reading','11:59','12:05');
  const nested=visit('nested',repeat,'Reading briefly revisited','12:00','12:01');
  const tail=visit('tail',repeat,'Reading continued','12:09','12:10');
  const afterBreak=visit('five-minutes',repeat,'Reading after exactly five minutes','12:15','12:16');
  const anotherPath=visit('other-path','https://github.com/example/other','Another page on GitHub','12:16','12:17');
  const elsewhere=visit('other-site','https://arxiv.org/abs/456','Paper','12:17','12:18');
  const backAtPage=visit('back-again',repeat,'Back after another site','12:18','12:19');
  const evening=visit('evening',repeat,'Evening reading','19:00','19:05');
  const thread=[reading,nested,tail,afterBreak,anotherPath,elsewhere,backAtPage,evening];
  await reset();
  await importData({schema:'trace.v1',source:'synthetic-demo',sessions:thread},'visit-navigation');
  await until(async()=>(await snapshot()).segments===thread.length,'browsing thread loaded');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await click('#zoom-in');await stableViewport();
  await focus('#timeline-nav');await key('ArrowRight','ArrowRight',39);
  const origin=await stableViewport();
  assert.ok(origin.zoom>1&&span(origin)>3600000,'the starting point is a custom zoomed and panned view');
  const restored=(actual,expected)=>assert.ok(actual.every((t,i)=>Math.abs(t-expected[i])<1),'both limits of the viewport are restored');
  const hasReturn=()=>ev('!!document.querySelector("#return-original-view")?.getClientRects().length');
  const stepButton=direction=>'button.visit-neighbor[data-direction="'+direction+'"]';
  const step=async(direction,target,withKeyboard=false)=>{
    const selector=stepButton(direction);
    assert.equal(await ev('document.querySelector('+JSON.stringify(selector)+')?.dataset.session'),target.id,'available '+direction+' visit');
    if(withKeyboard){
      await focus(selector);await key('Enter','Enter',13);
    }else{
      await ev('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"nearest"})');
      await click(selector);
    }
    await until(()=>ev('document.querySelector(".block.visit-selected")?.dataset.session==='+JSON.stringify(target.id)),'step to '+target.id);
    const state=await stableViewport();
    assert.equal(state.drawer,1,'following a neighbor keeps its details open');
    assert.ok(state.viewport[0]<=Date.parse(target.start)&&state.viewport[1]>=Date.parse(target.end),'the new activity is on the ruler');
    assert.equal(await ev('document.querySelector(".detail-title").textContent'),target.title);
    assert.equal(await ev('document.querySelector(".detail-url").href'),target.url);
    assert.equal(await ev('document.querySelector("#scene").dataset.highlightSite'),new URL(target.url).hostname);
    assert.equal(await ev('document.querySelector(".detail-session[aria-pressed=true]").dataset.session'),target.id);
    assert.ok(await hasReturn(),'the first jump remains available after changing pages');
    if(withKeyboard&&await ev('!!document.querySelector('+JSON.stringify(selector)+')')){
      assert.equal(await ev('document.activeElement.dataset.direction'),direction,'Enter can continue in the same direction');
    }
  };
  await openPage(repeat);
  assert.equal(await hasReturn(),false,'return appears only after the first jump');
  assert.equal(await ev('document.querySelectorAll("button.detail-session").length'),thread.filter(s=>s.url===repeat).length,'short repeats retain individual time buttons');
  await locate(nested,[['next',afterBreak]],true);
  await step('next',afterBreak,true);
  await step('previous',tail);
  assert.equal(await ev('document.querySelector('+JSON.stringify(stepButton('previous'))+')'),null,'a backward step stops at the nearest segment of the first group');
  await step('next',afterBreak);
  await step('next',anotherPath);
  await step('next',elsewhere,true);
  await step('next',backAtPage,true);
  await step('next',evening,true);
  assert.equal(await ev('document.querySelector('+JSON.stringify(stepButton('next'))+')'),null,'evening is the last meaningful stop');
  assert.equal(await ev('document.activeElement.dataset.session'),evening.id,'at the boundary the selected time remains focusable');
  await focus('#return-original-view');await key('Enter','Enter',13);
  await until(async()=>(await snapshot()).drawer===0,'original view closes details');
  restored((await stableViewport()).viewport,origin.viewport);
  assert.equal(await ev('document.activeElement.dataset.url'),repeat,'return restores focus to the original visible tag');
  await openPage(repeat);
  assert.equal(await hasReturn(),false,'old origin is cleared after return');
  await locate(evening,[['previous',backAtPage]],true);
  const eveningView=(await stableViewport()).viewport;
  await key('Escape','Escape',27);
  await until(async()=>(await snapshot()).drawer===0,'Escape closes details');
  restored((await stableViewport()).viewport,eveningView);
  checks.push('page navigation skips short same-URL runs and stops for exact five-minute gaps, later returns and intervening URLs; keyboard and click follow real intervals, explicit return restores the original custom viewport, and ordinary close stays put');

  // Result activation (by mouse or keyboard) goes to our own loopback server.
  const destination=createServer((_req,res)=>res.end('Synthetic visited page'));
  await new Promise((resolve,reject)=>destination.once('error',reject).listen(0,'127.0.0.1',resolve));
  try{
    const popupUrl='http://127.0.0.1:'+destination.address().port+'/visited';
    const video='https://www.bilibili.com/video/fixture';
    const earlierDay=visit('search-prior',video,'仅前一天可见','07:00','07:10');
    earlierDay.start=earlierDay.start.replace('11-10','11-09');
    earlierDay.end=earlierDay.end.replace('11-10','11-09');
    const rows=[
      earlierDay,visit('first-cut',video,'围棋 Café 初稿','09:30','09:32'),
      visit('second-cut',video,'围棋 Café 定稿','11:10','11:15'),
      visit('changed-title',video,'进阶视频','15:10','15:20'),
      visit('another-site','https://github.com/synthetic/go','围棋 笔记','14:00','14:05'),
      visit('link-test',popupUrl,'本地预览链接','16:21','16:25'),
      visit('link-draft',popupUrl+'/draft','本地预览草案','17:05','17:09')
    ];
    await importData({schema:'trace.v1',source:'synthetic-demo',sessions:rows},'day-search');
    await until(async()=>(await snapshot()).segments===6,'current day search records');
    const query='#day-search-query', resultTimes='#day-search-results .search-time';
    const inputText=async value=>{
      await ev("document.querySelector('#day-search-query').select()");
      if(value)await cmd('Input.insertText',{text:value});
      else await key('Backspace','Backspace',8);
    };
    const resultIds=()=>ev(`[...document.querySelectorAll(${JSON.stringify(resultTimes)})].map(button=>button.dataset.session)`);
    const expectResults=async ids=>until(async()=>JSON.stringify(await resultIds())===JSON.stringify(ids),'search results '+ids.join(','));
    const activeResult=()=>ev(`(()=>{
      const field=document.getElementById('day-search-query');
      const selected=document.getElementById(field.getAttribute('aria-activedescendant'));
      if(!selected)return null;
      if(field!==document.activeElement||selected.getAttribute('aria-selected')!=='true')return 'invalid focus';
      return selected.querySelector('.search-time')?.dataset.session;
    })()`);
    const closeVisitedTab=async()=>{
      let popup;
      await until(async()=>{
        const {targetInfos}=await cmd('Target.getTargets');
        popup=targetInfos.find(target=>target.type==='page'&&target.url===popupUrl);
        return !!popup;
      },'the intended original URL opens in a separate browser tab');
      await cmd('Target.closeTarget',{targetId:popup.targetId});
    };
    const escape=()=>key('Escape','Escape',27);
    const searchClosed=()=>ev('!document.querySelector("#day-search-dialog").open');
    const searchMotion=()=>ev(`(()=>{
      const panel=document.querySelector('#day-search-dialog');
      const style=getComputedStyle(panel);
      return {entry:panel.dataset.entry,animation:style.animationName,seconds:parseFloat(style.animationDuration)};
    })()`);
    await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await click('#day-search-open');
    const pointerMotion=await searchMotion();
    assert.equal(pointerMotion.entry,'pointer');
    assert.ok(pointerMotion.animation!=='none'&&pointerMotion.seconds>0,'the search trigger animates the panel into view');
    assert.equal(await ev('document.activeElement.id'),'day-search-query','typing can start during the entrance');
    assert.doesNotMatch(await ev('document.querySelector("#day-search-dialog").innerText'),/\besc\b/i,'the search field has no visible Escape hint');
    await escape();await until(searchClosed,'Escape interrupts the opening animation');
    await key('/','Slash',191,{text:'/',unmodifiedText:'/'});
    const shortcutMotion=await searchMotion();
    assert.equal(shortcutMotion.entry,'keyboard');
    assert.ok(shortcutMotion.animation!=='none'&&shortcutMotion.animation!==pointerMotion.animation&&shortcutMotion.seconds<pointerMotion.seconds,'the shortcut uses a shorter distinct entrance');
    assert.equal(await ev('document.activeElement.id'),'day-search-query','rapid reopen puts focus in the new search');
    await escape();await until(searchClosed,'close the reopened search');
    await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});

    await click('#day-search-open');
    assert.equal((await searchMotion()).animation,'none','reduced motion suppresses the pointer entrance');
    await until(()=>ev('document.activeElement.id==="day-search-query"'),'search focuses text entry');
    await expectResults([]);
    assert.ok(await ev(`['#day-search-sites','#day-search-empty'].every(s=>!document.querySelector(s).getClientRects().length)`),'opening search presents a single compact field');
    assert.equal(await activeResult(),null,'collapsed search has no active result');
    await click('#day-search-browse');
    await until(()=>ev(`!!document.querySelector('#day-search-sites [data-domain="bilibili.com"]')?.getClientRects().length`),'site browser reveals a selectable icon');
    const panelGap = () => ev(`document.querySelector('.day-search-site-sheet').getBoundingClientRect().top
      - document.querySelector('.day-search-field').getBoundingClientRect().bottom`);
    const siteGap = await panelGap();
    assert.ok(siteGap > 0, 'site picker sits below the search field');
    await click('#day-search-sites [data-domain="bilibili.com"]');
    await expectResults(['changed-title']);
    assert.equal(await panelGap(), siteGap, 'results keep the site picker gap');
    assert.equal(await activeResult(),'changed-title','choosing an icon scopes the current day');
    await escape();await until(searchClosed,'Escape closes search');
    assert.equal(await ev('document.activeElement.id'),'day-search-open','Escape restores the search opener');
    await focus('#timeline-nav');await key('/','Slash',191,{text:'/',unmodifiedText:'/'});
    assert.equal((await searchMotion()).animation,'none','reduced motion suppresses the keyboard entrance');
    assert.equal(await ev('document.activeElement.id'),'day-search-query','slash opens search from the timeline');
    assert.equal(await ev('document.querySelector("#day-search-query").value'),'','opening slash is not entered in the query');
    await key('ArrowDown','ArrowDown',40);
    await expectResults(['link-draft','link-test','changed-title','another-site']);
    await inputText('仅前一天可见');await expectResults([]);
    assert.equal(await activeResult(),null,'no hidden or obsolete result is selected on an unmatched query');
    assert.ok(await ev('!!document.querySelector("#day-search-empty").getClientRects().length'));
    await inputText('BILIBILI.COM cafe');await expectResults(['second-cut']);
    assert.equal(await ev('document.querySelector(".search-title-text").textContent'),'围棋 Café 定稿');
    await inputText('初稿 进阶');await expectResults([]); // Words from different visits cannot form a match.
    await inputText('bili');await expectResults(['changed-title']);
    await click('#day-search-sites [data-domain="bilibili.com"]');
    assert.equal(await ev('document.querySelector("#day-search-query").value'),'','selected domain becomes the search scope');
    await focus(query);await inputText('围棋');await expectResults(['second-cut']);
    await click('#day-search-scope');await expectResults(['another-site','second-cut']);
    await inputText('bili cafe');await expectResults(['second-cut']);
    await click(resultTimes);
    await until(searchClosed,'time action closes search');
    await until(()=>ev('document.querySelector(".block.visit-selected")?.dataset.session==="second-cut"'),'time action locates the matching visit');
    assert.equal(await ev('document.querySelector(".detail-url").href'),video);
    const located=await stableViewport();
    const match=rows.find(row=>row.id==='second-cut');
    assert.ok(located.viewport[0]<=Date.parse(match.start)&&located.viewport[1]>=Date.parse(match.end));
    await click('#close-inspector');
    await click('#day-search-open');await inputText('本地预览');await expectResults(['link-draft','link-test']);
    assert.equal(await activeResult(),'link-draft','top result is active while the query still has focus');
    await key('ArrowDown','ArrowDown',40);
    assert.equal(await activeResult(),'link-test','ArrowDown selects the second result without moving the caret out of search');
    await key('ArrowUp','ArrowUp',38);
    assert.equal(await activeResult(),'link-draft','ArrowUp returns to the first result');
    const composing=await ev(`(()=>{
      const field=document.getElementById('day-search-query'), keys=['ArrowDown','Enter','Escape'];
      const dialog=document.getElementById('day-search-dialog');
      let clicks=0;
      const catchActivation=event=>{clicks++;event.preventDefault();};
      dialog.addEventListener('click',catchActivation,true);
      try{
        for(const key of keys)field.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,isComposing:true}));
        return {clicks,open:dialog.open};
      }finally{dialog.removeEventListener('click',catchActivation,true);}
    })()`);
    assert.deepEqual(composing,{clicks:0,open:true},'composition does not open a result or dismiss the palette');
    assert.equal(await activeResult(),'link-draft','composition navigation belongs to the IME');
    await key('ArrowDown','ArrowDown',40);await key('Enter','Enter',13);await closeVisitedTab();
    if(!await searchClosed())await escape();
    await click('#day-search-open');await inputText('初稿');await expectResults(['first-cut']);
    await focus('#day-search-results .search-title');await key('Tab','Tab',9);
    assert.ok(await ev('document.activeElement.matches(".search-time")'),'the access time is a separate native Tab stop');
    await key('Enter','Enter',13);
    await until(()=>ev('document.querySelector(".block.visit-selected")?.dataset.session==="first-cut"'),'keyboard time action locates the chosen visit');
    await click('#close-inspector');
    await click('#day-search-open');await inputText('本地预览链接');await expectResults(['link-test']);
    await click('#day-search-results .search-title');await closeVisitedTab();
    if(!await searchClosed())await escape();
    checks.push('Spotlight search opens by icon and slash, preserves focus and Chinese composition during keyboard selection, opens the active result in a real tab, groups same-day URLs, filters by site, and locates visits with keyboard and mouse');
    await importData({schema:'trace.v1',source:'synthetic-demo',sessions:[
      visit('settings-a','https://github.com/alpha/settings','仓库设置','09:00','09:01'),
      visit('settings-b','https://github.com/beta/settings','仓库设置','10:00','10:01'),
      visit('help','https://docs.github.com/start','入门文档','11:00','11:01'),
      visit('home','https://github.com/','首页','12:00','12:01')
    ]},'search-labels');
    await click('#day-search-open');await click('#day-search-browse');
    await click('#day-search-sites [data-domain="github.com"]');
    await expectResults(['home','help','settings-b','settings-a']);
    assert.deepEqual(await ev(`Array.from(document.querySelectorAll('.search-result'),
      row => row.querySelector('.search-domain')?.textContent ?? '')`),
      ['', 'docs.github.com', '/beta/settings', '/alpha/settings']);
    await escape();
  }finally{
    destination.closeAllConnections();await new Promise(resolve=>destination.close(resolve));
  }
  await importData({schema:'trace.v1',source:'synthetic-demo',sessions:[]},'navigation-empty');
  assert.deepEqual((await snapshot()).range,[0,1440]);await fullDayLabels('empty import');
  assert.equal(await ev('document.querySelector("#time-probe").hidden'),true,'empty import clears the old probe until the next move');
  for(const fraction of [0,.45,1]){
    await hoverProbe(fraction,'empty day clock '+fraction);
    await assertTimeOnly('empty day');
  }
  await mouse('mouseMoved',{x:8,y:8});
  await until(()=>ev('document.querySelector("#time-probe").hidden'),'probe hides after leaving empty ruler');
  checks.push('empty days show the local clock only while hovering, including midnight endpoints; DST, pan and zoom retain time accuracy');
  assert.deepEqual(errors,[]);assert.deepEqual(network.filter(url=>/^https?:/i.test(url)),[]);
  checks.push('no browser script errors or remote requests');
  fs.writeFileSync(path.join(output,'trace-navigation-qa.json'),JSON.stringify({passed:true,checks,errors,remoteRequests:[]},null,2));
  console.log('PASS',checks.join('; '));
}catch(error){
  console.error(error.stack);
  if(ev){try{console.error('Dashboard snapshot:',await ev('typeof traceSnapshot==="function"?traceSnapshot():null'));}catch{}}
  console.error(diagnostics.slice(-1300));process.exitCode=1;
}finally{
  if(cmd){try{await cmd('Browser.close');}catch{browser.kill();}}else browser.kill();
  socket?.close();await pause(400);
  const resolved=path.resolve(profile);
  if(!resolved.startsWith(output+path.sep)||!path.basename(resolved).startsWith('.trace-navigation-'))throw Error('Unsafe QA cleanup path');
  try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){console.error('Owned QA directory retained: '+error.message);}
}
