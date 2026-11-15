import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateFrom, emptyState, publicState, restoreState, transition } from '../extension/recorder-core.mjs';

const T = Date.parse('2026-11-08T00:00:00Z');
let counter = 0;
const options = { makeId: () => `visit-${++counter}` };
const window = { id: 1, focused: true, type: 'normal', incognito: false };
const tab = { id: 2, windowId: 1, active: true, url: 'https://example.com/article', title: 'Article' };
const active = candidateFrom(window, tab);
const other = candidateFrom(window, { ...tab, id: 3, url: 'https://other.test/' });
const disabled = { candidate: null, status: 'unfocused' };
const move = (state, observation, seconds, extra = {}) => transition(state, observation, T + seconds * 1000, { ...options, ...extra });
const start = () => move(emptyState(), active, 0, { recording: true });
const seconds = state => state.sessions.reduce((sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)) / 1000, 0);

test('default is off; observing tabs does not begin recording', () => {
  const state = move(emptyState(), active, 30);
  assert.equal(state.recording, false);
  assert.equal(state.cursor, null);
  assert.deepEqual(state.sessions, []);
});

test('only active HTTP(S) tab in focused normal non-incognito window is eligible', () => {
  assert.equal(active.status, 'recording');
  for (const change of [{ focused: false }, { type: 'popup' }, { incognito: true }]) {
    assert.equal(candidateFrom({ ...window, ...change }, tab).candidate, null);
  }
  for (const change of [{ active: false }, { incognito: true }, { discarded: true }, { windowId: 5 },
    { url: 'chrome://newtab/' }, { url: 'edge://settings/' }, { url: 'file:///notes.html' },
    { url: 'chrome-extension://abc/dashboard.html' }, { url: 'bad url' }]) {
    assert.equal(candidateFrom(window, { ...tab, ...change }).candidate, null);
  }
  assert.equal(candidateFrom(window, tab, 'idle').candidate, null);
  assert.equal(candidateFrom(window, tab, 'locked').status, 'locked');
});

test('credentials are stripped; host and title retained without page access', () => {
  const result = candidateFrom(window, { ...tab, url: 'https://user:password@example.com/a?q=b#c' });
  assert.equal(result.candidate.url, 'https://example.com/a?q=b#c');
  assert.equal(result.candidate.host, 'example.com');
});

test('contiguous checkpoints coalesce and duplicate timestamps do not add time', () => {
  let state = move(start(), active, 30);
  state = move(state, active, 30);
  state = move(state, active, 60);
  assert.equal(seconds(state), 60);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].start, '2026-11-08T00:00:00.000Z');
});

test('tab switching closes the previous visit and records only one tab at a time', () => {
  let state = move(start(), other, 10);
  state = move(state, active, 25);
  state = move(state, active, 35);
  assert.equal(seconds(state), 35);
  assert.deepEqual(state.sessions.map(s => s.host), ['example.com', 'other.test', 'example.com']);
  for (let i = 1; i < state.sessions.length; i++) assert.equal(state.sessions[i - 1].end, state.sessions[i].start);
});

test('pause closes at pause time, and resume never adds paused duration', () => {
  let state = move(start(), disabled, 12, { recording: false });
  assert.equal(state.cursor, null);
  state = move(state, active, 100, { recording: true });
  state = move(state, active, 110);
  assert.equal(seconds(state), 22);
  assert.equal(state.sessions.length, 2);
});

test('idle, locked, and focus loss stop accrual until a new observation', () => {
  for (const status of ['idle', 'locked', 'unfocused', 'unsupported']) {
    let state = move(start(), { candidate: null, status }, 15);
    state = move(state, { candidate: null, status }, 120);
    assert.equal(seconds(state), 15);
    assert.equal(state.status, status);
    state = move(state, active, 180);
    state = move(state, active, 190);
    assert.equal(seconds(state), 25);
  }
});

test('late heartbeat is capped and missing time is represented as a gap', () => {
  let state = move(start(), active, 40);
  state = move(state, active, 50);
  assert.equal(seconds(state), 40);
  assert.equal(state.sessions[0].end, new Date(T + 30_000).toISOString());
  assert.equal(state.sessions[1].start, new Date(T + 40_000).toISOString());
  assert.notEqual(state.sessions[0].id, state.sessions[1].id);
});

test('long scheduling gaps and machine sleep are not counted', () => {
  let state = move(start(), active, 30);
  state = move(state, active, 3600);
  assert.equal(seconds(state), 30);
  state = move(state, active, 3630);
  assert.equal(seconds(state), 60);
  assert.equal(state.sessions.length, 2);
});

test('worker suspension keeps epoch; browser crash/restart invalidates cursor', () => {
  const persisted = { ...move(start(), active, 20), epoch: 'old-browser' };
  let resumed = restoreState(JSON.parse(JSON.stringify(persisted)), 'old-browser');
  resumed = move(resumed, active, 30);
  assert.equal(seconds(resumed), 30);
  let restarted = restoreState(JSON.parse(JSON.stringify(persisted)), 'new-browser');
  assert.equal(restarted.cursor, null);
  restarted = move(restarted, active, 35);
  assert.equal(seconds(restarted), 20);
  restarted = move(restarted, active, 45);
  assert.equal(seconds(restarted), 30);
});

test('backwards system clock never overlaps or makes negative duration', () => {
  let state = move(start(), active, 20);
  state = move(state, other, 5);
  state = move(state, other, 25);
  assert.equal(seconds(state), 25);
  assert.ok(state.sessions.every(s => Date.parse(s.end) > Date.parse(s.start)));
  assert.ok(Date.parse(state.sessions[1].start) >= Date.parse(state.sessions[0].end));
});

test('export contains finite completed intervals and no internal cursor or epoch', () => {
  const state = move(start(), active, 3);
  const result = publicState(state);
  assert.deepEqual(Object.keys(result).sort(), ['recording', 'schema', 'sessions', 'status']);
  assert.equal(result.schema, 'trace.v1');
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), ['end', 'host', 'id', 'start', 'title', 'url']);
});
