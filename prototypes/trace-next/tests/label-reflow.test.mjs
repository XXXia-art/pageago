// Spatial label reflow: synthetic records in a disposable Edge profile only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const output=path.resolve('output'),profile=path.join(output,'.trace-label-reflow-'+randomUUID());
fs.mkdirSync(profile,{recursive:true});
const browser=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',[
  '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check',
  '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket,cmd,ev,diagnostics='';const errors=[],network=[],checks=[];
browser.stderr.on('data',b=>diagnostics+=b);browser.on('error',e=>diagnostics+=e.message);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(25);}throw Error('Timed out: '+label);}
try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Edge');
  const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;const pending=new Map();
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Network.requestWillBeSent')network.push(m.params.request.url);});
  cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const click=selector=>ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settled=async()=>{let previous=null,count=0;await until(async()=>{const s=await ev('({viewport:traceSnapshot().viewport,moving:!!document.querySelector(".event-tag[data-reflow]")})');count=!s.moving&&previous&&s.viewport.every((v,i)=>Math.abs(v-previous[i])<.01)?count+1:0;previous=s.viewport;return count>=4;},'camera and labels settled',7000);};
  const importData=async(sessions,name)=>{const file=path.join(profile,name+'.json');fs.writeFileSync(file,JSON.stringify({schema:'trace.v1',source:'synthetic-demo',sessions}));const {root}=await cmd('DOM.getDocument');const {nodeId}=await cmd('DOM.querySelector',{nodeId:root.nodeId,selector:'#import-input'});await cmd('DOM.setFileInputFiles',{nodeId,files:[file]});await until(()=>ev('document.querySelector("#import-input").value===""'),'import');await settled();};
  const geometry=`(()=>{const baseline=document.querySelector('#constellation').getBoundingClientRect(),plot=document.querySelector('#lanes').getBoundingClientRect(),svg=document.querySelector('#event-links').getBoundingClientRect();return [...document.querySelectorAll('.event-tag:not([hidden])')].map(n=>{const r=n.getBoundingClientRect(),icon=n.querySelector('.site-icon').getBoundingClientRect(),name=n.querySelector('.event-name').getBoundingClientRect(),a=[...document.querySelectorAll('.event-anchor')].find(a=>a.dataset.url===n.dataset.url),ar=a.getBoundingClientRect(),link=[...document.querySelectorAll('.event-link')].find(a=>a.dataset.url===n.dataset.url),block=[...document.querySelectorAll('.block')].find(b=>!b.hidden&&b.segment?.url===n.dataset.url),br=block?.getBoundingClientRect(),coords=(link.getAttribute('d')||'').match(/-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?/gi)?.map(Number)||[],ls=getComputedStyle(link);return {url:n.dataset.url,x:r.x-baseline.x,y:r.y-baseline.y,targetX:parseFloat(n.style.left),plotWidth:plot.width,width:r.width,height:r.height,moving:n.hasAttribute('data-reflow'),iconOffset:icon.x-r.x,iconCenter:icon.y+icon.height/2-r.y,nameCenter:name.y+name.height/2-r.y,nameLeft:name.left,iconRight:icon.right,nameWidth:name.width,anchor:ar.x+ar.width/2,expectedAnchor:br?Math.max(plot.left,br.left):null,linkVisible:ls.display!=='none'&&ls.visibility!=='hidden',coords,lineStartY:coords.length?svg.y+coords[1]:null,bottom:r.bottom};});})()`;
  const begin=()=>ev(`(()=>{window.__reflowFrames=[];window.__reflowSampling=true;const sample=()=>{if(!window.__reflowSampling)return;window.__reflowFrames.push({at:performance.now(),tags:${geometry}});requestAnimationFrame(sample);};requestAnimationFrame(sample);})()`);
  const end=async()=>{await ev('window.__reflowSampling=false');return ev('window.__reflowFrames');};
  const capture=async action=>{await begin();try{await action();await settled();}finally{await ev('window.__reflowSampling=false');}return end();};
  const verifyMotion=frames=>{
    const moving=frames.flatMap(f=>f.tags.filter(t=>t.moving));assert.ok(moving.length>0,'fixture exercises actual reflow');
    assert.ok(moving.some(t=>Math.abs((t.y+62)/42-Math.round((t.y+62)/42))>.07),'at least one label occupies a real intermediate vertical position between rows');
    for(const tag of moving){
      assert.ok(Math.abs(tag.height-32)<.2,'moving tags retain their single-line size');
      assert.ok(Math.abs(tag.iconCenter-tag.nameCenter)<.2,'icon and title move together with the same vertical center');
      assert.ok(Math.abs(tag.iconOffset-4)<.2,'the icon remains inside its moving label rather than following separately');
      if(tag.nameWidth>1)assert.ok(tag.nameLeft>=tag.iconRight-.2,'the icon remains before its title');
      assert.ok(Math.abs(tag.anchor-tag.expectedAnchor)<.6,'the anchor remains attached to the actual painted visit time');
      if(tag.linkVisible){assert.equal(tag.coords.length,4,'connector remains one straight line');assert.ok(Math.abs(tag.coords[0]-tag.coords[2])<.001,'connector remains vertical');assert.ok(Math.abs(tag.lineStartY-tag.bottom)<.7,'connector starts at the presented label bottom rather than its destination row');}
    }
    const intermediateByUrl=new Map();for(const t of moving){const set=intermediateByUrl.get(t.url)||new Set();set.add(Math.round(t.y*10));intermediateByUrl.set(t.url,set);}
    assert.ok([...intermediateByUrl.values()].some(values=>values.size>=3),'one label paints multiple intermediate positions during a row change');
  };
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');
  await cmd('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await cmd('Page.navigate',{url:pathToFileURL(path.join(output,'pageago.html')).href});await until(()=>ev('typeof traceSnapshot==="function"&&traceSnapshot().ready'),'page');
  // Freeze animation only for this allocator regression: every sampled target is
  // produced by the real browser layout after a precise, monotonic zoom step.
  // New icons becoming visible must not repeatedly steal an incumbent's row.
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await ev(`document.documentElement.style.setProperty('--gutter',((document.querySelector('#scene').clientWidth-1280)/2)+'px');window.dispatchEvent(new Event('resize'))`);
  assert.ok(Math.abs(await ev('document.querySelector("#lanes").clientWidth')-1280)<.1,'stability fixture uses exactly 1280px of plot width');
  const midnight=Date.parse('2026-11-15T00:00:00+08:00');let rng=1;
  const stabilitySessions=Array.from({length:32},(_,id)=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;const at=midnight+(600+rng/2**32*240)*60000;return {id:'stable-'+id,url:`https://example.com/stable-${id}`,title:`连续缩放稳定性网页 ${id}`,start:new Date(at).toISOString(),end:new Date(at+5000).toISOString()};});
  await importData(stabilitySessions,'stable-incumbent-rows');
  const monotonic=await ev(`(async()=>{const nav=document.querySelector('#timeline-nav'),r=document.querySelector('#lanes').getBoundingClientRect(),rows=[];const sample=()=>rows.push({zoom:traceSnapshot().zoom,targets:[...document.querySelectorAll('.event-tag')].map(n=>({url:n.dataset.url,hidden:n.hidden,top:parseFloat(n.style.top)}))});sample();for(let frame=1;frame<=70;frame++){nav.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+16,deltaY:-Math.log(48)/499/.002}));await new Promise(resolve=>requestAnimationFrame(resolve));sample();}return rows;})()`);
  assert.ok(monotonic.every((f,i)=>!i||f.zoom>monotonic[i-1].zoom),'the row-stability fixture zooms strictly in one direction');
  const watched=monotonic.map(f=>f.targets.find(t=>t.url.endsWith('/stable-13')));
  assert.ok(watched.every(t=>t&&!t.hidden),'the known incumbent remains visible through the complete stability test');
  const rowSequence=watched.map(t=>Math.round((-t.top-62)/42)).filter((level,i,all)=>!i||level!==all[i-1]);
  assert.ok(!rowSequence.some((level,i)=>i>=2&&level===rowSequence[i-2]),'one-way zoom must not make the same visible title switch to another row and back: '+rowSequence.join(' → '));
  // Return through the same zoom steps, then force several identical layouts.
  // A settled viewport must be a fixed point, rather than feeding on old rows.
  await ev(`(async()=>{const nav=document.querySelector('#timeline-nav'),r=document.querySelector('#lanes').getBoundingClientRect();for(let frame=1;frame<=70;frame++){nav.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+16,deltaY:Math.log(48)/499/.002}));await new Promise(resolve=>requestAnimationFrame(resolve));}})()`);
  await settled();
  const settledTargets=()=>ev(`[...document.querySelectorAll('.event-tag')].map(n=>({url:n.dataset.url,hidden:n.hidden,top:n.style.top,left:n.style.left}))`);
  const fixedTargets=await settledTargets();
  for(let repeat=0;repeat<3;repeat++){await ev(`window.dispatchEvent(new Event('resize'));new Promise(resolve=>requestAnimationFrame(resolve))`);assert.deepEqual(await settledTargets(),fixedTargets,'repeating the same settled viewport cannot reshuffle its labels');}
  checks.push('monotonic zoom keeps incumbent row targets from oscillating; round-trip zoom leaves a settled layout unchanged by repeated paints');
  await ev(`document.documentElement.style.removeProperty('--gutter');window.dispatchEvent(new Event('resize'))`);
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const start=Date.parse('2026-11-15T11:00:00+08:00');
  const sessions=Array.from({length:80},(_,i)=>({id:'reflow-'+i,url:`https://example.com/reflow-${i}`,title:`空间连续性测试网页 ${i+1} — 图标和标题作为同一个整体移动`,start:new Date(start+i*30000).toISOString(),end:new Date(start+i*30000+5000).toISOString()}));
  await importData(sessions,'dense-reflow');
  assert.equal(await ev('document.querySelectorAll(".event-tag[data-reflow]").length'),0,'initial import does not animate from another dataset');
  await ev('window.__reflowNodes=[...document.querySelectorAll(".event-tag")];window.__reflowBlocks=[...document.querySelectorAll(".block")]');
  const frames=[];for(let i=0;i<5;i++)frames.push(...await capture(()=>click('#zoom-in')));
  for(let i=0;i<3;i++)frames.push(...await capture(()=>click('#zoom-out')));
  verifyMotion(frames);
  assert.ok(await ev('window.__reflowNodes.every((n,i)=>n===document.querySelectorAll(".event-tag")[i])&&window.__reflowBlocks.every((n,i)=>n===document.querySelectorAll(".block")[i])'),'zoom reuses the original interactive labels and activity nodes');
  checks.push('dense labels change rows through intermediate positions; icon and title move together, exact time anchors and presented connector endpoints stay aligned');

  const reverse=await capture(async()=>{await click('#zoom-in');await pause(80);await click('#zoom-out');});
  assert.ok(reverse.some(f=>f.tags.some(t=>t.moving)),'reversal interrupts a live layout reflow');
  assert.equal(await ev('document.querySelectorAll(".event-tag[data-reflow]").length'),0,'reversed reflow fully settles without a queued animation');
  checks.push('mid-flight reverse retargets the current labels and clears animation state when settled');

  // Use native mouse hit testing while the label is moving, not an artificial .click().
  await click('#zoom-in');
  await until(()=>ev('!!document.querySelector(".event-tag[data-reflow]:not([hidden])")'),'moving click target',3000);
  const hit=await ev(`(()=>{const n=[...document.querySelectorAll('.event-tag[data-reflow]:not([hidden])')].find(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.event-tag')===n;});if(!n)return null;const r=n.getBoundingClientRect();window.__reflowClicked=n;return {x:r.x+r.width/2,y:r.y+r.height/2,url:n.dataset.url};})()`);
  assert.ok(hit,'a moving label retains a real pointer target');
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:hit.x,y:hit.y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:hit.x,y:hit.y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:hit.x,y:hit.y,button:'left',buttons:0,clickCount:1});
  await until(()=>ev('traceSnapshot().drawer>.999'),'moving label detail');
  assert.equal(await ev('document.querySelector(".detail-url").href'),hit.url,'native click on a moving tag opens that actual page');
  await click('#close-inspector');await settled();checks.push('native pointer hit testing on a moving label opens its correct page');

  const repeated=[['early','11:30:00'],['later','12:10:00']].map(([id,time])=>({id:'reflow-'+id,url:'https://example.com/repeated-reflow',title:'同一网页跨访问锚点的空间连续性',start:`2026-11-15T${time}+08:00`,end:`2026-11-15T${time.replace(/00$/,'05')}+08:00`}));
  await importData(repeated,'repeated-visit-reflow');
  const horizontal=await capture(()=>ev(`(()=>{const n=document.querySelector('#timeline-nav'),r=document.querySelector('#lanes').getBoundingClientRect();for(let i=0;i<8;i++)n.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+16,deltaY:-320}));})()`));
  const positions=horizontal.map(f=>f.tags[0]).filter(Boolean),horizontalMoving=positions.filter(t=>t.moving&&Math.abs(t.x-t.targetX)>2);
  assert.ok(new Set(horizontalMoving.map(t=>Math.round(t.x))).size>=3,'a repeated page animates through multiple horizontal positions when its visible visit changes');
  const anchorSwitch=positions.findIndex((t,i)=>i>0&&Math.abs(t.anchor-positions[i-1].anchor)>t.plotWidth*.5);
  assert.ok(anchorSwitch>0,'the repeated-page fixture actually changes its visible visit anchor');
  assert.ok(Math.abs(positions[anchorSwitch].x-positions[anchorSwitch-1].x)<positions[anchorSwitch].plotWidth*.2,'the label remains near its current screen position when the new visit anchor jumps across the ruler');
  assert.ok(horizontalMoving.some(t=>!t.linkVisible),'a connector that cannot meet the travelling label is temporarily hidden');
  checks.push('a later visit of the same page rebases from its presented horizontal position and temporarily hides an unattached connector');

  await importData(sessions,'dense-reflow-restored');

  await click('#zoom-out');await pause(30);
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await pause(50);assert.equal(await ev('document.querySelectorAll(".event-tag[data-reflow]").length'),0,'reduced-motion change clears in-flight label springs');
  await click('#zoom-in');await pause(50);assert.equal(await ev('document.querySelectorAll(".event-tag[data-reflow]").length'),0,'reduced motion snaps positions instead of sliding');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await click('#zoom-out');await pause(30);await click('#date-previous');
  await until(()=>ev('traceSnapshot().date==="2026-11-14"'),'previous date');
  assert.equal(await ev('document.querySelectorAll(".event-tag[data-reflow]").length'),0,'switching dates removes pending label reflow');
  await pause(550);assert.equal(await ev('document.querySelectorAll(".event-tag[data-reflow]").length'),0,'old-day label motion cannot restart after the date transition');
  checks.push('reduced motion and date changes clear all pending label movement');

  await ev('window.__reflowBeforeReload=true');await cmd('Page.reload');await until(()=>ev('!window.__reflowBeforeReload&&typeof traceSnapshot==="function"&&traceSnapshot().ready'),'new reloaded page');await importData(sessions,'blur-reflow');
  const blurred=await capture(async()=>{await click('#zoom-in');await pause(35);await ev('window.dispatchEvent(new Event("blur"))');for(let i=0;i<3;i++){await click('#zoom-in');await pause(35);}});
  const afterBlur=blurred.filter(f=>f.at>blurred[0].at+100);
  assert.ok(afterBlur.length>0);assert.ok(afterBlur.every(f=>f.tags.every(t=>!t.moving)),'an unfocused window cannot restart label springs while its camera keeps moving');
  await ev('window.dispatchEvent(new Event("focus"))');
  const refocused=await capture(()=>click('#zoom-in'));
  assert.ok(refocused.some(f=>f.tags.some(t=>t.moving)),'focus restores normal interruptible label motion');
  checks.push('blur clears and suspends reflow through later camera frames; focus restores motion');
  assert.deepEqual(errors,[]);assert.deepEqual(network.filter(u=>/^https?:/i.test(u)),[]);checks.push('no browser exceptions or external requests');
  fs.writeFileSync(path.join(output,'trace-label-reflow-qa.json'),JSON.stringify({passed:true,checks,errors,remoteRequests:[]},null,2));console.log('PASS',checks.join('; '));
}catch(error){console.error(error.stack);console.error(diagnostics.slice(-800));process.exitCode=1;}
finally{if(cmd){try{await cmd('Browser.close');}catch{browser.kill();}}else browser.kill();socket?.close();await pause(400);const resolved=path.resolve(profile);if(!resolved.startsWith(output+path.sep)||!path.basename(resolved).startsWith('.trace-label-reflow-'))throw Error('Unsafe QA cleanup');try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(e){console.error('Owned profile retained: '+e.message);}}
