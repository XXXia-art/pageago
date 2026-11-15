// Pure timing logic. Every stored interval has a confirmed, bounded end.
export const MAX_SEGMENT_MS = 30_000;
export const MAX_GAP_MS = 45_000;
export const IDLE_SECONDS = 60;

export function emptyState() {
  return { version: 1, recording: false, status: 'paused', sessions: [], cursor: null };
}

export function restoreState(saved, epoch) {
  const loaded = saved?.version === 1 && Array.isArray(saved.sessions) ? saved : emptyState();
  return { ...loaded, cursor: loaded.epoch === epoch ? loaded.cursor : null, epoch };
}

export function candidateFrom(window, tab, idleState = 'active') {
  if (idleState !== 'active') return { candidate: null, status: idleState === 'locked' ? 'locked' : 'idle' };
  if (!window || !window.focused || window.type !== 'normal' || window.incognito) {
    return { candidate: null, status: 'unfocused' };
  }
  if (!tab || !tab.active || tab.incognito || tab.windowId !== window.id || tab.discarded) {
    return { candidate: null, status: 'unsupported' };
  }
  let parsed;
  try { parsed = new URL(tab.url); } catch { return { candidate: null, status: 'unsupported' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { candidate: null, status: 'unsupported' };
  // URLs can contain credentials; never persist those.
  parsed.username = '';
  parsed.password = '';
  const url = parsed.href;
  return {
    candidate: { key: `${window.id}:${tab.id}:${url}`, url, title: String(tab.title || parsed.hostname).slice(0, 1024), host: parsed.hostname },
    status: 'recording',
  };
}

export function transition(state, observation, now, options = {}) {
  const recording = options.recording ?? state.recording;
  const sessions = state.sessions.slice();
  const previous = state.cursor;
  const lastEnd = sessions.length ? Date.parse(sessions.at(-1).end) : 0;
  // A backwards system clock must never create overlapping or negative intervals.
  const time = Math.max(now, lastEnd || 0, previous?.at || 0);
  let contiguous = false;
  if (state.recording && previous && !options.reset) {
    const elapsed = time - previous.at;
    // After sleep or a long scheduling gap we cannot establish activity. Drop it.
    if (elapsed > 0 && elapsed <= MAX_GAP_MS) {
      const end = Math.min(time, previous.at + MAX_SEGMENT_MS);
      const start = Math.max(previous.at, lastEnd || 0);
      if (end > start) {
        const last = sessions.at(-1);
        const endISO = new Date(end).toISOString();
        if (last?.id === previous.id && Date.parse(last.end) === start) {
          sessions[sessions.length - 1] = { ...last, end: endISO, title: previous.candidate.title };
        } else {
          sessions.push({ id: previous.id, url: previous.candidate.url, title: previous.candidate.title,
            host: previous.candidate.host, start: new Date(start).toISOString(), end: endISO });
        }
      }
      contiguous = end === time;
    } else if (elapsed === 0) {
      contiguous = true;
    }
  }
  const candidate = recording ? observation.candidate : null;
  const sameVisit = !options.reset && contiguous && previous?.candidate.key === candidate?.key;
  const cursor = candidate ? { candidate, at: time, id: sameVisit ? previous.id : (options.makeId || (() => crypto.randomUUID()))() } : null;
  return { version: 1, recording, status: recording ? observation.status : 'paused', sessions, cursor };
}

export function publicState(state) {
  return { schema: 'trace.v1', sessions: state.sessions, recording: state.recording, status: state.status };
}
