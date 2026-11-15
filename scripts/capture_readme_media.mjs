// Capture PageAgo's actual offline UI using only the bundled synthetic demo.
// Prerequisites: Node 22+, Microsoft Edge, and a completed trace-next/build.py.
// Optional GIF encoding: python scripts/encode_readme_gif.py <capture-folder>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output');
const work = path.join(output, 'readme-media-' + randomUUID());
const profile = path.join(work, 'isolated-edge-profile');
const frames = path.join(work, 'frames');
const media = path.join(root, 'docs', 'media');
for (const folder of [profile, frames, media]) fs.mkdirSync(folder, {recursive: true});
const browser = process.env.PAGEAGO_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const child = spawn(browser, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-extensions',
  'about:blank',
], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
let browserLog = '', socket, command, evaluate;
child.stderr.on('data', data => browserLog += data);
child.on('error', error => browserLog += error.message);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await pause(30);
  }
  throw new Error('Timed out: ' + label);
}
const errors = [], requests = [], captures = [];

try {
  await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'isolated browser');
  const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id);
      clearTimeout(task.timer); pending.delete(message.id);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/i.test(message.params.request.url)) requests.push(message.params.request.url);
  });
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error('CDP: ' + method));}, 20000);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params}));
  });
  evaluate = async expression => {
    const result = await command('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async file => {
    const image = await command('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
  };
  const frame = async (duration = 90) => {
    const file = `${String(captures.length).padStart(4, '0')}.png`;
    await screenshot(path.join(frames, file));
    captures.push({file, duration});
  };
  const animateFrames = async (count, duration = 90) => {
    for (let i = 0; i < count; i++) {await frame(duration); await pause(18);}
  };

  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Network.setBlockedURLs', {urls: ['http://*', 'https://*']});
  await command('Emulation.setTimezoneOverride', {timezoneId: 'Asia/Shanghai'});
  await command('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false});
  await command('Page.navigate', {url: pathToFileURL(path.join(root, 'prototypes', 'trace-next', 'dist', 'index.html')).href});
  await until(() => evaluate('typeof traceSnapshot === "function" && traceSnapshot().ready'), 'synthetic demo ready');
  assert.equal(await evaluate('TRACE_DEMO.source'), 'synthetic-demo', 'README may only show the bundled synthetic fixture');
  assert.equal((await evaluate('traceSnapshot()')).mode, 'demo', 'never capture an imported or live record');
  await pause(1200);
  await evaluate('document.activeElement?.blur()');
  await screenshot(path.join(media, 'pageago-overview.png'));

  // Record normal controls; do not inject replacement layout, typography, or pages.
  await frame(1100);
  await click('#zoom-in'); await animateFrames(5);
  await click('#zoom-in'); await animateFrames(6);
  const nav = await evaluate('(()=>{const r=document.querySelector("#timeline-nav").getBoundingClientRect();return {x:r.x+r.width*.64,y:r.y+r.height*.4};})()');
  await command('Input.dispatchMouseEvent', {type:'mouseMoved', ...nav});
  await command('Input.dispatchMouseEvent', {type:'mousePressed', ...nav, button:'left', clickCount:1});
  for (let i = 1; i <= 10; i++) {
    await command('Input.dispatchMouseEvent', {type:'mouseMoved', x:nav.x-i*22, y:nav.y, button:'left', buttons:1});
    await frame(70);
  }
  await command('Input.dispatchMouseEvent', {type:'mouseReleased', x:nav.x-220, y:nav.y, button:'left', clickCount:1});
  await animateFrames(4);
  await command('Input.dispatchMouseEvent', {type:'mouseMoved', x:35, y:40});
  await click('#hour-dial-reset'); await animateFrames(6);
  await click('#day-search-open'); await animateFrames(6);
  await command('Input.insertText', {text:'arxiv'});
  await animateFrames(5); await frame(1300);
  await command('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
  await animateFrames(5);
  await click('#date-previous'); await animateFrames(7); await frame(1100);
  await click('#date-next'); await animateFrames(7); await frame(900);
  assert.deepEqual(errors, [], 'no browser exceptions during capture');
  assert.deepEqual(requests, [], 'README capture must remain offline');
  const manifest = {source:'synthetic-demo', screenshot:'docs/media/pageago-overview.png', width:1600, height:1000, frames:captures};
  fs.writeFileSync(path.join(work, 'capture.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({work, screenshot:path.join(media, 'pageago-overview.png'), frames:captures.length, source:manifest.source}));
} catch (error) {
  console.error(error.stack || error.message);
  if (browserLog) fs.writeFileSync(path.join(work, 'browser.log'), browserLog);
  process.exitCode = 1;
} finally {
  if (command) try {await command('Browser.close');} catch {}
  socket?.close(); child.kill();
}
