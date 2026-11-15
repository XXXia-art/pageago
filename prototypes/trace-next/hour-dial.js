/* An all-day ruler. The selected time follows the input; only the wake lags. */
(() => {
  'use strict';

  const MINUTES = 24 * 60;
  const TICK_COUNT = 30;
  const MINUTES_PER_TICK = MINUTES / TICK_COUNT;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clock = minute => [Math.floor(minute / 60), minute % 60]
    .map(part => String(part).padStart(2, '0')).join(':');

  function create({root, onPreview, onCommit, onCancel, onWheelZoom}) {
    const track = root.querySelector('.hour-dial-track');
    const output = root.querySelector('.hour-dial-time');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const bars = Array.from({length: TICK_COUNT}, () => {
      const bar = document.createElement('span');
      bar.className = 'hour-dial-bar';
      bar.setAttribute('aria-hidden', 'true');
      return bar;
    });
    track.replaceChildren(...bars);
    let minute = 720, head = 0.5, velocity = 0, wakeSpeed = 0;
    let frame = 0, previousTime = 0;
    let drag = null;
    let wheel = null;

    function paint() {
      const intensity = clamp(Math.abs(wakeSpeed) / 3.2, 0, 1);
      const amplitude = wheel ? wheel.lift : intensity * intensity * (3 - 2 * intensity);
      const center = wheel ? wheel.position : head;
      const reach = 1.5 + 3.5 * amplitude;
      const current = Math.min(TICK_COUNT - 1, Math.floor(minute / MINUTES_PER_TICK));
      bars.forEach((bar, index) => {
        const distance = index + 0.5 - center * TICK_COUNT;
        const radius = wheel ? reach : reach * (distance * wakeSpeed < 0 ? 1.6 : 0.7);
        const lift = Math.abs(distance) < radius
          ? amplitude * Math.cos(Math.PI * distance / (2 * radius)) ** 2
          : 0;
        bar.style.setProperty('--lift', lift.toFixed(3));
        bar.toggleAttribute('data-lit', index + 0.5 <= head * TICK_COUNT);
        bar.toggleAttribute('data-current', index === current);
      });
    }

    function alignHead() {
      head = minute / MINUTES;
      velocity = 0;
      wakeSpeed = 0;
    }

    function settle() {
      cancelAnimationFrame(frame);
      frame = 0;
      wheel = null;
      alignHead();
      paint();
    }

    function advance(now) {
      const dt = clamp((now - previousTime) / 1000, 0, 0.064);
      previousTime = now;
      const goal = minute / MINUTES, delta = head - goal;
      // Exact critically damped step so event frequency doesn't set the wave height.
      const omega = 31, slope = velocity + omega * delta, decay = Math.exp(-omega * dt);
      head = goal + (delta + slope * dt) * decay;
      velocity = (velocity - omega * slope * dt) * decay;
      wakeSpeed += (velocity - wakeSpeed) * (1 - Math.exp(-dt / 0.055));
      if (wheel) {
        // Closely spaced wheel impulses accumulate; an isolated notch quickly subsides.
        wheel.lift += (wheel.energy - wheel.lift) * (1 - Math.exp(-dt / 0.035));
        wheel.energy *= Math.exp(-dt / 0.10);
        if (wheel.lift < 0.003 && wheel.energy < 0.003) wheel = null;
      }
      if (!wheel && Math.abs(head - goal) < 0.00005 && Math.abs(velocity) < 0.002 && Math.abs(wakeSpeed) < 0.008) {
        settle();
        return;
      }
      paint();
      frame = requestAnimationFrame(advance);
    }

    function startFrames() {
      if (frame) return;
      previousTime = performance.now();
      frame = requestAnimationFrame(advance);
    }

    function display(value, animate) {
      minute = clamp(Math.round(value), 0, MINUTES);
      const label = clock(minute);
      track.setAttribute('aria-valuenow', String(minute));
      track.setAttribute('aria-valuetext', label);
      output.textContent = label;
      root.style.setProperty('--position', (minute / MINUTES * 100) + '%');
      if (reduced.matches || document.hidden) {
        settle();
      } else if (!animate) {
        alignHead();
        paint();
      } else if (head !== minute / MINUTES) {
        startFrames();
      }
    }

    function point(x, force = false) {
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const fraction = clamp((x - rect.left) / rect.width, 0, 1);
      const wasMoving = drag.moved;
      if (Math.abs(x - drag.startX) > 3) drag.moved = true;
      let next;
      if (drag.moved) {
        next = Math.round(fraction * MINUTES);
      } else if (drag.startX >= rect.right - 1) {
        next = MINUTES;
      } else {
        // A tap selects the start of the pressed cell, even if the finger jitters.
        const cell = Math.floor((drag.startX - rect.left) / rect.width * TICK_COUNT);
        next = clamp(cell, 0, TICK_COUNT - 1) * MINUTES_PER_TICK;
      }
      if (!force && next === minute && drag.moved === wasMoving) return;
      display(next, true);
      onPreview(minute, drag.moved);
    }

    function releaseDrag() {
      const id = drag.id;
      drag = null;
      root.removeAttribute('data-dragging');
      if (track.hasPointerCapture(id)) track.releasePointerCapture(id);
    }

    function cancelDrag() {
      if (!drag) return;
      const original = drag.original;
      releaseDrag();
      display(original, false);
      onCancel();
    }

    track.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag || !event.isPrimary) return;
      wheel = null;
      track.setPointerCapture(event.pointerId);
      drag = {id: event.pointerId, original: minute, startX: event.clientX, moved: false};
      root.setAttribute('data-dragging', '');
      track.focus({preventScroll: true});
      point(event.clientX, true);
    });
    track.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) point(event.clientX);
    });
    track.addEventListener('pointerup', event => {
      if (drag?.id !== event.pointerId) return;
      point(event.clientX);
      releaseDrag();
      onCommit(minute);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      track.addEventListener(type, event => {
        if (drag?.id === event.pointerId) cancelDrag();
      });
    }
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelDrag(); settle(); }
    });
    reduced.addEventListener('change', () => { if (reduced.matches) settle(); });

    track.addEventListener('wheel', event => {
      if (!event.deltaY || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      event.preventDefault();
      if (drag) return;
      const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      onWheelZoom(Math.round(fraction * MINUTES), event);
      if (reduced.matches || document.hidden) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const pixels = Math.abs(event.deltaY) * unit;
      wheel ??= {position: fraction, energy: 0, lift: 0};
      wheel.position = fraction;
      wheel.energy = Math.min(1, wheel.energy + pixels / 320);
      startFrames();
    }, {passive: false});

    track.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) {
        event.stopPropagation();
        event.preventDefault();
        cancelDrag();
        return;
      }
      if (drag || event.ctrlKey || event.altKey || event.metaKey) return;
      const step = event.shiftKey ? 60 : 1;
      let value;
      switch (event.key) {
        case 'ArrowRight': case 'ArrowUp': value = minute + step; break;
        case 'ArrowLeft': case 'ArrowDown': value = minute - step; break;
        case 'PageUp': value = minute + 60; break;
        case 'PageDown': value = minute - 60; break;
        case 'Home': value = 0; break;
        case 'End': value = MINUTES; break;
        default: return;
      }
      event.preventDefault();
      event.stopPropagation();
      wheel = null;
      display(value, false);
      onCommit(minute);
    });

    function setMinute(value) {
      if (!drag && Number.isFinite(value) && Math.round(value) !== minute) display(value, false);
    }

    function reset(value = 720) {
      if (drag) cancelDrag();
      wheel = null;
      display(value, false);
    }

    reset();
    return {setMinute, reset};
  }

  window.TraceHourDial = {create};
})();
