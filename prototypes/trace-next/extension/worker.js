import { candidateFrom, emptyState, IDLE_SECONDS, publicState, restoreState, transition } from './recorder-core.mjs';

const KEY = 'trace.recorder.v1';
const EPOCH_KEY = 'trace.browser.epoch';
const ALARM = 'trace.checkpoint';
const STORAGE_BUDGET = 8 * 1024 * 1024;
let state;
let queue = Promise.resolve();
let lastError = '';

// All reads/transitions/writes share one queue, including dashboard commands.
function enqueue(task) {
  const result = queue.then(async () => { await initialize(); return task(); });
  queue = result.catch(() => {});
  return result;
}

async function initialize() {
  if (state) return;
  const [stored, session] = await Promise.all([
    chrome.storage.local.get(KEY), chrome.storage.session.get(EPOCH_KEY),
  ]);
  // session survives service-worker suspension, but is cleared on browser restart.
  // A different epoch invalidates the old cursor without extending its duration.
  const epoch = session[EPOCH_KEY] || crypto.randomUUID();
  await chrome.storage.session.set({ [EPOCH_KEY]: epoch });
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  chrome.idle.setDetectionInterval(IDLE_SECONDS);
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  state = restoreState(stored[KEY], epoch);
}

async function observe() {
  const idle = await chrome.idle.queryState(IDLE_SECONDS);
  if (idle !== 'active') return candidateFrom(null, null, idle);
  // getLastFocused can return an unfocused browser while another application is active.
  const window = await chrome.windows.getLastFocused({ populate: false });
  if (!window.focused || window.type !== 'normal' || window.incognito) return candidateFrom(window, null, idle);
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
  return candidateFrom(window, tab, idle);
}

async function commit(next) {
  next.epoch = state.epoch;
  if (new TextEncoder().encode(JSON.stringify(next)).length > STORAGE_BUDGET) {
    // Never silently delete history to make room. Pause and expose the reason.
    next = { ...state, cursor: null, recording: false, status: 'storage-full' };
  }
  try {
    await chrome.storage.local.set({ [KEY]: next });
    state = next;
    lastError = '';
  } catch (error) {
    // Retain the last committed records. Never retry an uncommitted interval later.
    state = { ...state, cursor: null, recording: false, status: 'error' };
    lastError = '本地保存失败，记录已暂停。请导出已有数据并检查浏览器存储。';
    throw error;
  }
  await chrome.action.setBadgeText({ text: state.recording ? 'ON' : '' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#276750' }).catch(() => {});
  return publicState(state);
}

async function reconcile(options = {}) {
  if (!state.recording && options.recording === undefined) return publicState(state);
  const at = options.at ?? Date.now();
  let observation;
  try {
    observation = (options.recording ?? state.recording)
      ? (options.observation || await observe()) : { candidate: null, status: 'paused' };
  } catch {
    // A failed browser query breaks continuity instead of keeping a stale tab alive.
    observation = { candidate: null, status: 'error' };
  }
  return commit(transition(state, observation, at, options));
}

function schedule(observation) {
  const at = Date.now();
  const boundary = observation?.candidate === null ? observation : undefined;
  enqueue(() => reconcile({ at, observation: boundary })).catch(() => { lastError ||= '无法读取浏览器状态，等待重试。'; });
}

// Register synchronously so a dormant worker can receive each event.
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) schedule(); });
chrome.tabs.onActivated.addListener(schedule);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('url' in change || 'title' in change || 'discarded' in change || change.status === 'complete') schedule();
});
chrome.tabs.onRemoved.addListener(schedule);
chrome.tabs.onReplaced.addListener(schedule);
chrome.tabs.onAttached.addListener(schedule);
chrome.tabs.onDetached.addListener(schedule);
chrome.windows.onFocusChanged.addListener(id => schedule(
  id === chrome.windows.WINDOW_ID_NONE ? { candidate: null, status: 'unfocused' } : undefined,
));
chrome.windows.onRemoved.addListener(schedule);
chrome.idle.onStateChanged.addListener(status => schedule(
  status !== 'active' ? { candidate: null, status } : undefined,
));
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(() => {
  enqueue(() => reconcile({ reset: true })).catch(() => {});
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the bundled local dashboard may read data or control recording.
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('dashboard.html')) return false;
  if (!['trace:get', 'trace:set-recording', 'trace:clear-data'].includes(message?.type)) return false;
  enqueue(async () => {
    if (message.type === 'trace:clear-data') {
      return commit({ ...emptyState(), epoch: state.epoch });
    }
    if (message.type === 'trace:set-recording') {
      if (typeof message.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
      return reconcile({ recording: message.enabled });
    }
    if (lastError) return { ...publicState(state), status: 'error', error: lastError };
    return reconcile();
  }).then(sendResponse).catch(() => {
    sendResponse({ ...publicState(state || emptyState()), status: 'error', error: lastError || '本地操作失败，请重试。' });
  });
  return true;
});
