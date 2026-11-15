/* A quiet, local dial tick. No recordings, downloads, or background playback. */
(() => {
  'use strict';

  const PREFERENCE_KEY = 'trace.dialSound';
  const MIN_INTERVAL = 0.042;
  let enabled = true;
  let context = null;
  let unlocking = null;
  let noise = null;
  let lastTick = -Infinity;
  let played = 0;
  const voices = new Set();

  try { enabled = localStorage.getItem(PREFERENCE_KEY) !== 'off'; } catch {}

  function removeVoice(voice) {
    voices.delete(voice);
    for (const node of [voice.source, voice.filter, voice.gain]) {
      try { node.disconnect(); } catch {}
    }
  }

  function silence() {
    for (const voice of [...voices]) {
      try { voice.source.stop(); } catch {}
      removeVoice(voice);
    }
    lastTick = -Infinity;
  }

  function makeNoise(audio) {
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * 0.024), audio.sampleRate);
    const samples = buffer.getChannelData(0);
    // A fixed noise grain gives the dial a consistent mechanical character.
    let seed = 0x51f15e;
    for (let i = 0; i < samples.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      samples[i] = (seed >>> 0) / 0x80000000 - 1;
    }
    return buffer;
  }

  // Call from pointer/key input. Never called by tick(), a timer, or page load.
  function unlock() {
    if (!enabled || document.hidden) return Promise.resolve(false);
    if (unlocking) return unlocking;
    try {
      if (!context) {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) return Promise.resolve(false);
        context = new Audio({ latencyHint: 'interactive' });
      }
      if (context.state === 'closed') return Promise.resolve(false);
      if (!noise) noise = makeNoise(context);
      if (context.state === 'running') return Promise.resolve(true);
      unlocking = Promise.resolve(context.resume())
        .then(() => enabled && !document.hidden && context.state === 'running')
        .catch(() => false)
        .finally(() => { unlocking = null; });
      return unlocking;
    } catch {
      return Promise.resolve(false);
    }
  }

  function tick({ major = false } = {}) {
    if (!enabled || document.hidden || !context || !noise || context.state !== 'running') return false;
    const now = context.currentTime;
    if (now - lastTick < MIN_INTERVAL) return false;

    let voice;
    try {
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      voice = { source, filter, gain };
      source.buffer = noise;
      source.loop = false;
      // Wide-band noise, not an oscillator: a soft click without a pitched note.
      filter.type = 'bandpass';
      filter.frequency.value = major ? 1250 : 1550;
      filter.Q.value = 0.65;
      const length = major ? 0.020 : 0.016;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(major ? 0.13 : 0.10, now + 0.0008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + length - 0.002);
      gain.gain.linearRampToValueAtTime(0, now + length);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.onended = () => removeVoice(voice);
      voices.add(voice);
      source.start(now);
      source.stop(now + length);
      lastTick = now;
      played++;
      return true;
    } catch {
      if (voice) {
        try { voice.source.stop(); } catch {}
        removeVoice(voice);
      }
      return false;
    }
  }

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) silence();
    try { localStorage.setItem(PREFERENCE_KEY, enabled ? 'on' : 'off'); } catch {}
    return enabled;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) silence();
  });
  window.addEventListener('pagehide', silence);

  window.TraceDialAudio = Object.freeze({
    unlock,
    tick,
    setEnabled,
    get enabled() { return enabled; },
    get debug() {
      return { enabled, contextState: context?.state || 'uninitialized', played, activeSources: voices.size };
    },
  });
})();
