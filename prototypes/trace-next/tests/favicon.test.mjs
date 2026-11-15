// Synthetic local favicon cache QA. Owns only a unique, temporary Edge profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspace=path.resolve(project,'../..'),output=path.join(workspace,'output');
fs.mkdirSync(output,{recursive:true});
const profile=path.join(output,'.favicon-qa-'+randomUUID());fs.mkdirSync(profile);
const extension=path.join(project,'extension');
const browser='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(50);}throw Error('Timed out: '+label);}
const checks=[],errors=[],dashboardRequests=[],serverRequests=[];
let diagnostics='',child,socket,cmd,ev,port;
function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,checksum]);}
function faviconPNG(){
  const size=32,header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc(size*(size*4+1));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const offset=y*(size*4+1)+1+x*4;rows.set(x<16?[18,177,91,255]:[219,72,50,255],offset);}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const png=faviconPNG();
const server=http.createServer((request,response)=>{
  serverRequests.push(request.url);
  if(request.url==='/fixture.png'){response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public,max-age=86400'});response.end(png);return;}
  if(request.url==='/known'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><title>Local favicon fixture</title><link rel="icon" href="/fixture.png" sizes="32x32" type="image/png"><p>Synthetic favicon cache fixture</p>');return;}
  response.writeHead(404,{'Content-Type':'text/plain'});response.end('No fixture');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const fixture='http://127.0.0.1:'+server.address().port;
try{
  const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
  assert.ok(manifest.permissions.includes('favicon'),'favicon permission is declared');
  assert.ok(!manifest.host_permissions?.length,'favicon rendering does not add remote host permissions');
  child=spawn(browser,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let spawnError;child.on('error',error=>spawnError=error);child.stderr.on('data',data=>diagnostics+=data);
  await until(()=>{if(spawnError)throw spawnError;return fs.existsSync(path.join(profile,'DevToolsActivePort'));},'Edge debug port');
  port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const targets=async()=>await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const worker=await until(async()=>(await targets()).find(t=>t.type==='service_worker'&&t.url.endsWith('/worker.js')),'extension worker');
  const id=new URL(worker.url).host,page=(await targets()).find(t=>t.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0,collectDashboard=false;const pending=new Map();
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id&&pending.has(message.id)){const item=pending.get(message.id);clearTimeout(item.timer);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    if(message.method==='Network.requestWillBeSent'&&collectDashboard)dashboardRequests.push(message.params.request.url);
  });
  cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  ev=async expression=>{const result=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Network.enable');
  await cmd('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'});
  await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:fixture+'/known'});
  await until(()=>ev('document.readyState==="complete"'),'fixture page');
  await until(()=>serverRequests.includes('/fixture.png'),'browser favicon fetch');
  await pause(800);
  const warmedRequests=serverRequests.length;collectDashboard=true;
  await cmd('Page.navigate',{url:`chrome-extension://${id}/dashboard.html`});
  await until(()=>ev('typeof traceSnapshot==="function"&&traceSnapshot().ready'),'dashboard');
  const before=await ev('chrome.runtime.sendMessage({type:"trace:get"})');
  assert.equal(before.recording,false);assert.deepEqual(before.sessions,[]);
  const selected=await ev('traceSnapshot().date');
  const payload={schema:'trace.v1',source:'synthetic-demo',sessions:[
    {id:'cache-known',url:fixture+'/known',title:'Local favicon fixture',host:'127.0.0.1',start:selected+'T09:00:00+08:00',end:selected+'T09:15:00+08:00'},
    {id:'cache-missing',url:'https://favicon-absent.invalid/not-visited',title:'Missing cache fixture',host:'favicon-absent.invalid',start:selected+'T11:00:00+08:00',end:selected+'T11:10:00+08:00'},
    {id:'static-subdomain',url:'https://www.youtube.com/watch?v=synthetic-fixture',title:'Bundled subdomain fixture',host:'www.youtube.com',start:selected+'T13:00:00+08:00',end:selected+'T13:30:00+08:00'}]};
  const file=path.join(profile,'fixture.json');fs.writeFileSync(file,JSON.stringify(payload));
  const importData=async()=>{const {root}=await cmd('DOM.getDocument');const {nodeId}=await cmd('DOM.querySelector',{nodeId:root.nodeId,selector:'#import-input'});await cmd('DOM.setFileInputFiles',{nodeId,files:[file]});await until(()=>ev('traceSnapshot().mode==="import"&&traceSnapshot().segments===3'),'fixture import');};
  await importData();
  // DOM contract: icon image lives in its corresponding real URL tag.
  const iconExpression=url=>`(()=>{const tag=[...document.querySelectorAll('.event-tag')].find(n=>n.dataset.url===${JSON.stringify(url)});const icon=tag?.querySelector('.site-icon'),img=tag?.querySelector('img');return {tag:!!tag,src:img?.src||'',loaded:!!img?.complete&&img.naturalWidth>0,naturalWidth:img?.naturalWidth||0,text:icon?.textContent||'',hasIcon:!!icon,iconSource:icon?.dataset.iconSource};})()`;
  await until(()=>ev(`(()=>{const icon=${iconExpression(fixture+'/known')};return icon.loaded&&icon.iconSource==='browser-cache';})()`),'cached website icon');
  const cached=await ev(iconExpression(fixture+'/known'));
  assert.match(cached.src,/^data:image\/png/);
  const nativeRequest=dashboardRequests.find(url=>url.startsWith(`chrome-extension://${id}/_favicon/`)&&new URL(url).searchParams.get('pageUrl')===fixture+'/known');
  assert.ok(nativeRequest,'native favicon API is queried with the complete local page URL');
  const pixels=await ev(`(()=>{const tag=[...document.querySelectorAll('.event-tag')].find(n=>n.dataset.url===${JSON.stringify(fixture+'/known')}),img=tag.querySelector('img'),canvas=document.createElement('canvas');canvas.width=canvas.height=32;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,32,32);return [Array.from(ctx.getImageData(7,16,1,1).data),Array.from(ctx.getImageData(24,16,1,1).data)];})()`);
  assert.deepEqual(pixels,[[18,177,91,255],[219,72,50,255]],'actual browser cache returns the website’s own known pixel icon');
  checks.push('native extension favicon URL returns exact pixels from the browser cache');
  await pause(300);
  const missing=await ev(iconExpression('https://favicon-absent.invalid/not-visited'));
  assert.ok(missing.hasIcon,'missing cache retains an icon slot');
  assert.ok(missing.loaded||missing.text.trim(),'missing cache never leaves a broken blank image');
  assert.equal(missing.iconSource,'placeholder','browser generic default icon does not replace the placeholder');
  assert.equal(serverRequests.length,warmedRequests,'dashboard does not refetch favicon from the website');
  assert.deepEqual(dashboardRequests.filter(url=>/^https?:/i.test(url)),[],'dashboard has no external favicon traffic');
  const after=await ev('chrome.runtime.sendMessage({type:"trace:get"})');assert.deepEqual(after.sessions,before.sessions);assert.equal(after.recording,before.recording);
  checks.push('missing-cache fallback works without HTTP requests or recorder mutations');
  await cmd('Page.navigate',{url:pathToFileURL(path.join(output,'pageago.html')).href});
  await until(()=>ev('typeof traceSnapshot==="function"&&traceSnapshot().ready'),'standalone');await importData();
  await until(()=>ev(`(${iconExpression('https://www.youtube.com/watch?v=synthetic-fixture')}).loaded`),'offline subdomain icon');
  const offline=await ev(iconExpression('https://www.youtube.com/watch?v=synthetic-fixture'));
  assert.equal(offline.src,await ev('TRACE_ICONS["youtube.com"].data_url'),'subdomain uses the bundled official site icon offline');
  assert.match(offline.src,/^data:image\//);assert.deepEqual(dashboardRequests.filter(url=>/^https?:/i.test(url)),[]);assert.deepEqual(errors,[]);
  checks.push('standalone uses bundled subdomain icons with no script errors or remote requests');
  fs.writeFileSync(path.join(output,'trace-favicon-qa.json'),JSON.stringify({passed:true,checks,errors,remoteRequests:[]},null,2));
  console.log('PASS: '+checks.join('; '));
}catch(error){
  console.error(error.stack);console.error(diagnostics.slice(-1000));process.exitCode=1;
  fs.writeFileSync(path.join(output,'trace-favicon-qa.json'),JSON.stringify({passed:false,checks,error:error.message,errors},null,2));
}finally{
  if(cmd){try{await cmd('Browser.close');}catch{child?.kill();}}else child?.kill();socket?.close();
  await new Promise(resolve=>server.close(resolve));await pause(400);
  const resolved=path.resolve(profile);if(!resolved.startsWith(output+path.sep)||!path.basename(resolved).startsWith('.favicon-qa-'))throw Error('Unsafe cleanup target');
  try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){console.error('Owned QA profile retained: '+error.message);}
}
