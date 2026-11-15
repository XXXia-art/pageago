// Real Chromium extension smoke test; owns only its unique temporary profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output');
fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, '.extension-qa-' + randomUUID());
fs.mkdirSync(profile);
const browser = process.env.TRACE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const extension = path.join(root, 'extension');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(100); }
  throw Error('Timed out waiting for extension state');
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<title>PageAgo test ${req.url}</title><h1>Synthetic local test ${req.url}</h1>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}`;
const sockets = [];
const network = [], errors = [], checks = [], skipped = [];
let child, dashboard, diagnostics = '', port;
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); clearTimeout(item.timer); pending.delete(message.id);
      message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
    }
    if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { cmd, evaluate };
}
const listTargets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
try {
  const flags = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', 'about:blank'];
  if (process.env.TRACE_TEST_HEADED !== '1') flags.unshift('--headless=new');
  child = spawn(browser, flags, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let spawnError; child.on('error', error => { spawnError = error; });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  await until(() => { if (spawnError) throw spawnError; return fs.existsSync(path.join(profile, 'DevToolsActivePort')); });
  port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const worker = await until(async () => (await listTargets()).find(target => target.type === 'service_worker' && /^chrome-extension:\/\/[^/]+\/worker\.js$/.test(target.url)));
  const id = new URL(worker.url).host;
  const page = (await listTargets()).find(target => target.type === 'page');
  dashboard = await connect(page.webSocketDebuggerUrl);
  await dashboard.cmd('Runtime.enable'); await dashboard.cmd('Page.enable'); await dashboard.cmd('Network.enable');
  await dashboard.cmd('Page.navigate', { url: `chrome-extension://${id}/dashboard.html` });
  await until(() => dashboard.evaluate('typeof traceSnapshot === "function" && traceSnapshot().ready'));
  const send = message => dashboard.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  const openSettings = () => dashboard.evaluate('if(!document.querySelector("#settings-dialog").open){document.querySelector("#date-trigger").click();document.querySelector("#date-popover #settings-button").click();}');
  const initial = await send({ type: 'trace:get' });
  assert.equal(initial.recording, false); assert.equal(initial.status, 'paused'); assert.deepEqual(initial.sessions, []);
  assert.equal(await dashboard.evaluate('traceSnapshot().segments'), 0);
  assert.equal(await dashboard.evaluate('document.querySelector("#record-button") === null'), true);
  checks.push('unpacked extension loads; initial recording off and no synthetic live data');
  await openSettings();
  await dashboard.evaluate('document.querySelector("#record-button").click()');
  await until(async () => (await send({ type: 'trace:get' })).recording);
  checks.push('collapsed ribbon settings dialog Start button enables recorder');
  await dashboard.evaluate('document.querySelector("#close-dialog").click()');
  const idle = await dashboard.evaluate('chrome.idle.queryState(60)');
  const tabA = await dashboard.evaluate(`chrome.tabs.create({url:${JSON.stringify(fixture + '/a')}, active:true})`);
  await dashboard.evaluate(`chrome.windows.update(${tabA.windowId},{focused:true})`);
  await pause(1200);
  let result = await send({ type: 'trace:get' });
  if (idle === 'active') {
    assert.equal(result.status, 'recording', JSON.stringify(result));
    assert.ok(result.sessions.some(session => session.url === fixture + '/a'));
    checks.push('active local HTTP tab produces committed interval');
  } else {
    assert.equal(result.status, idle); assert.deepEqual(result.sessions, []);
    checks.push(`real OS ${idle} state correctly prevents recording eligible HTTP tabs`);
    skipped.push(`Active foreground interval creation: OS is ${idle}; no OS-input injection or idle mocks used`);
  }
  const tabB = await dashboard.evaluate(`chrome.tabs.create({url:${JSON.stringify(fixture + '/b')}, active:true})`);
  await pause(1100);
  result = await send({ type: 'trace:get' });
  if (idle === 'active') {
    assert.ok(result.sessions.some(session => session.url === fixture + '/b'));
    for (let i = 1; i < result.sessions.length; i++) assert.ok(Date.parse(result.sessions[i].start) >= Date.parse(result.sessions[i - 1].end));
    checks.push('switching tabs ends previous interval without overlap');
  } else skipped.push('Active tab-switch interval boundaries require active OS state');
  const dashboardTab = await dashboard.evaluate('chrome.tabs.getCurrent()');
  await dashboard.evaluate(`chrome.tabs.update(${dashboardTab.id},{active:true})`);
  await pause(250);
  result = await send({ type: 'trace:get' });
  assert.equal(result.status, idle === 'active' ? 'unsupported' : idle);
  const before = JSON.stringify(result.sessions);
  await pause(400);
  assert.equal(JSON.stringify((await send({ type: 'trace:get' })).sessions), before);
  if (idle === 'active') checks.push('extension dashboard is excluded from recording');
  else skipped.push('Dashboard exclusion status is superseded by real OS idle state');
  await until(() => dashboard.evaluate('!document.hidden && traceSnapshot().mode === "live"'));
  await openSettings();
  // Date buttons are dynamically created in settings; unchanged refreshes must
  // neither detach the focused node nor move keyboard focus back to the body.
  const focusKey = await dashboard.evaluate(`(() => {
    window.__traceTestFocused = document.querySelector('#prev-day');
    window.__traceTestFocused.focus();
    return document.activeElement.id;
  })()`);
  assert.ok(focusKey);
  for (let i = 0; i < 3; i++) {
    await send({ type: 'trace:get' });
    await dashboard.evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await pause(200);
    assert.deepEqual(await dashboard.evaluate(`({
      key: document.activeElement.id,
      sameNode: document.activeElement === window.__traceTestFocused,
      connected: window.__traceTestFocused.isConnected
    })`), { key: focusKey, sameNode: true, connected: true });
  }
  checks.push('repeated unchanged live reads and visibility refreshes preserve focused dynamic button');
  // Export files intentionally need no recorder controls. Importing one while
  // live collection is on must keep the settings control bound to the worker.
  const imported = {
    schema: 'trace.v1',
    sessions: [{ id: 'synthetic-import-regression', url: 'https://fixture.invalid/import',
      title: 'Synthetic import without recorder flags', host: 'fixture.invalid',
      start: new Date(Date.now() - 60000).toISOString(), end: new Date().toISOString() }],
  };
  assert.equal('recording' in imported, false); assert.equal('status' in imported, false);
  const importPath = path.join(profile, 'synthetic-import.json');
  fs.writeFileSync(importPath, JSON.stringify(imported));
  const { root: documentNode } = await dashboard.cmd('DOM.getDocument');
  const { nodeId: inputNode } = await dashboard.cmd('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#import-input' });
  await dashboard.cmd('DOM.setFileInputFiles', { nodeId: inputNode, files: [importPath] });
  await until(() => dashboard.evaluate('traceSnapshot().mode === "import"'));
  assert.equal(await dashboard.evaluate('document.querySelector("#settings-dialog").open'), false);
  await openSettings();
  assert.equal((await send({ type: 'trace:get' })).recording, true);
  assert.match(await dashboard.evaluate('document.querySelector("#record-button").getAttribute("aria-label")'), /暂停记录/);
  assert.equal(await dashboard.evaluate('traceSnapshot().allSessions'), 1);
  checks.push('import without recording/status retains live pause control while recorder is enabled');
  await dashboard.evaluate('document.querySelector("#record-button").click()');
  await until(async () => !(await send({ type: 'trace:get' })).recording);
  await until(() => dashboard.evaluate('traceSnapshot().mode === "live" && document.querySelector("#record-button").getAttribute("aria-label").includes("开始记录")'));
  checks.push('Pause from imported view pauses actual worker and returns to live records');
  await dashboard.evaluate('document.querySelector("#close-dialog").click()');
  const paused = await send({ type: 'trace:get' });
  await dashboard.evaluate(`chrome.tabs.update(${tabB.id},{active:true})`);
  await pause(500);
  result = await send({ type: 'trace:get' });
  assert.deepEqual(result.sessions, paused.sessions); assert.equal(result.status, 'paused');
  checks.push('actual dashboard Pause button stops accrual across subsequent activity');
  assert.equal(result.schema, 'trace.v1');
  assert.ok(result.sessions.every(session => session.id && session.title && session.host && Date.parse(session.end) > Date.parse(session.start)));
  checks.push(idle === 'active' ? 'export API returns completed trace.v1 intervals' : 'export API returns valid empty trace.v1 while OS is idle');
  await dashboard.evaluate(`chrome.tabs.update(${dashboardTab.id},{active:true})`);
  await openSettings();
  await dashboard.evaluate('[...document.querySelectorAll("#dialog-content button")].find(b=>b.textContent==="清空").click()');
  await dashboard.evaluate('[...document.querySelectorAll("#dialog-content button")].find(b=>b.textContent==="确认清空").click()');
  await until(async () => (await send({ type: 'trace:get' })).sessions.length === 0);
  assert.equal((await send({ type: 'trace:get' })).recording, false);
  checks.push('actual clear confirmation removes only isolated test data and pauses');
  assert.deepEqual(errors, []);
  assert.deepEqual(network.filter(url => /^https?:/i.test(url)), [], 'Dashboard must make no remote network requests');
  checks.push('dashboard has no runtime exceptions or HTTP(S) requests');
  fs.writeFileSync(path.join(output, 'extension-qa.json'), JSON.stringify({ passed: true, browser, osIdleState: idle, checks, skipped, errors, remoteRequests: [], sampleSessions: paused.sessions }, null, 2));
  console.log('PASS: ' + checks.join('; '));
  if (skipped.length) console.log('SKIPPED: ' + skipped.join('; '));
} catch (error) {
  fs.writeFileSync(path.join(output, 'extension-qa.json'), JSON.stringify({ passed: false, browser, checks, skipped, error: error.message, errors, network, diagnostics: diagnostics.slice(-2000) }, null, 2));
  console.error(error.stack); console.error(diagnostics.slice(-1600)); process.exitCode = 1;
} finally {
  if (dashboard) { try { await dashboard.cmd('Browser.close'); } catch { child?.kill(); } }
  else child?.kill();
  for (const socket of sockets) socket.close();
  await new Promise(resolve => server.close(resolve));
  await pause(500);
  const resolved = path.resolve(profile), expected = path.resolve(output) + path.sep;
  if (!resolved.startsWith(expected) || !path.basename(resolved).startsWith('.extension-qa-')) throw Error('Refusing profile cleanup outside owned QA directory');
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); }
  catch (error) { console.error('Owned temporary profile retained:', error.message); }
}
