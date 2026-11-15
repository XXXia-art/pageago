/* Date navigation moves one visual plane; selected records update synchronously. */
(() => {
  'use strict';
  const STYLE = ['display','position','left','right','top','bottom','width','height','min-width','max-width',
    'box-sizing','padding','margin','border','border-radius','background','box-shadow','color','font-family',
    'font-size','font-weight','font-style','line-height','letter-spacing','text-align','white-space','overflow',
    'text-overflow','vertical-align','align-items','justify-content','flex-direction','flex-shrink','flex-basis',
    'gap','object-fit','transform','transform-origin','clip-path','z-index','opacity','fill','stroke',
    'stroke-width','stroke-opacity','stroke-linejoin','stroke-linecap'];

  function create({scene, parts, reduced}) {
    const document = scene.ownerDocument, view = document.defaultView;
    let frame = 0, lastTime = 0, started = 0, heldAt = 0, active = false, applying = false, departure = null;
    let direction = 0, distance = 0, offset = 0, velocity = 0, opacity = 1, alphaVelocity = 0;
    let outgoingOffset = 0, outgoingVelocity = 0, outgoingOpacity = 0, outgoingAlphaVelocity = 0;
    let fromDate = '', toDate = '';

    // Presentation-only copies have no data identity, controls, IDs, or live CSS classes.
    // Copy visible nodes only, so records hidden by the camera are never duplicated.
    function copyVisual(source) {
      if (source.nodeType === 3) return source.cloneNode();
      if (source.nodeType !== 1 || source.hidden) return null;
      const style = view.getComputedStyle(source);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      const node = ['BUTTON','A'].includes(source.tagName) ? document.createElement('span') : source.cloneNode(false);
      for (const attr of [...node.attributes]) {
        if (attr.name === 'id' || attr.name.startsWith('data-') || attr.name.startsWith('aria-') ||
            ['tabindex','title','name','role','autofocus','contenteditable','form'].includes(attr.name) || attr.name.startsWith('on')) node.removeAttribute(attr.name);
      }
      node.removeAttribute('style');
      node.setAttribute('class', [...source.classList].map(name => 'date-copy-' + name).join(' '));
      for (const property of STYLE) node.style.setProperty(property, style.getPropertyValue(property));
      node.style.pointerEvents = 'none';
      for (const child of source.childNodes) {const copy = copyVisual(child);if (copy) node.append(copy);}
      return node;
    }
    function capture() {
      const layer = document.createElement('div');layer.className = 'date-motion-departure';
      layer.inert = true;layer.setAttribute('aria-hidden','true');
      for (const part of parts) {
        const rect = part.getBoundingClientRect(), copy = copyVisual(part);
        if (!copy) continue;
        Object.assign(copy.style, {position:'absolute',left:rect.left+'px',right:'auto',top:rect.top+'px',
          bottom:'auto',width:rect.width+'px',height:rect.height+'px',transform:'none',opacity:'1'});
        layer.append(copy);
      }
      return layer;
    }
    function paint() {
      for (const part of parts) {part.style.transform = `translate3d(${offset}px,0,0)`;part.style.opacity = String(opacity);}
      if (departure) {departure.style.transform = `translate3d(${outgoingOffset}px,0,0)`;departure.style.opacity = String(outgoingOpacity);}
    }
    function finish() {
      if (applying) return;
      cancelAnimationFrame(frame);frame = 0;lastTime = 0;heldAt = 0;active = false;
      departure?.remove();departure = null;
      offset = velocity = outgoingOffset = outgoingVelocity = alphaVelocity = outgoingAlphaVelocity = 0;
      opacity = 1;outgoingOpacity = 0;
      delete scene.dataset.dateMotion;
      for (const part of parts) {part.style.removeProperty('transform');part.style.removeProperty('opacity');part.style.removeProperty('will-change');}
    }
    function step(value, speed, target, dt) {
      const omega = 23, delta = value - target, c = speed + omega * delta, decay = Math.exp(-omega * dt);
      return [target + (delta + c * dt) * decay, (speed - omega * c * dt) * decay];
    }
    function tick(now) {
      frame = 0;
      if (!active) return;
      const dt = Math.min(.04, Math.max(0,(now-lastTime)/1000));lastTime = now;
      [offset,velocity] = step(offset,velocity,0,dt);
      [opacity,alphaVelocity] = step(opacity,alphaVelocity,1,dt);
      [outgoingOffset,outgoingVelocity] = step(outgoingOffset,outgoingVelocity,direction*distance,dt);
      [outgoingOpacity,outgoingAlphaVelocity] = step(outgoingOpacity,outgoingAlphaVelocity,0,dt);
      opacity = Math.min(1,Math.max(0,opacity));outgoingOpacity = Math.min(1,Math.max(0,outgoingOpacity));
      paint();
      if (now-started >= 420) finish();else frame = requestAnimationFrame(tick);
    }
    function change(dates, apply) {
      const animate = dates.fromDate && dates.fromDate !== dates.toDate && !reduced.matches && !document.hidden;
      if (!animate) {finish();apply();return;}
      // On interruption the live plane's presented offset is baked into its copy.
      // Its velocity passes to the outgoing plane; there is never a transition queue.
      const copy = capture(), carryVelocity = active ? velocity : 0, carryOpacity = active ? opacity : 1;
      finish();fromDate = dates.fromDate;toDate = dates.toDate;direction = toDate < fromDate ? 1 : -1;
      distance = Math.min(240,Math.max(128,scene.clientWidth*.15));
      applying = true;
      try {apply();} finally {applying = false;}
      departure = copy;document.body.append(departure);
      offset = -direction*distance;velocity = carryVelocity;opacity = 0;alphaVelocity = 0;
      outgoingOffset = 0;outgoingVelocity = carryVelocity;outgoingOpacity = carryOpacity;outgoingAlphaVelocity = 0;
      active = true;scene.dataset.dateMotion = direction > 0 ? 'previous' : 'next';
      for (const part of parts) part.style.willChange = 'transform, opacity';
      paint();started = lastTime = performance.now();frame = requestAnimationFrame(tick);
    }
    function visibility() {if (document.hidden) finish();}
    function preference() {if (reduced.matches) finish();}
    function keyboard(event) {if (event.key === 'Tab') finish();}
    // Interacting with the new day immediately hands control back to the live axis.
    function interact(event) {
      if (!scene.contains(event.target)) return;
      if (active && event.type === 'pointerdown' && event.target.closest('.event-tag,#more-pages')) {
        // Keep the hit target under a held pointer; its click opens the new day's details.
        cancelAnimationFrame(frame);frame = 0;heldAt = performance.now();return;
      }
      finish();
    }
    function release() {
      if (!active || !heldAt) return;
      const now = performance.now();started += now-heldAt;lastTime = now;heldAt = 0;
      frame = requestAnimationFrame(tick);
    }
    document.addEventListener('visibilitychange',visibility);
    document.addEventListener('keydown',keyboard,true);
    document.addEventListener('pointerdown',interact,true);
    document.addEventListener('pointerup',release,true);document.addEventListener('pointercancel',release,true);
    document.addEventListener('wheel',interact,{capture:true,passive:true});
    view.addEventListener('resize',finish);view.addEventListener('blur',finish);view.addEventListener('scroll',finish,{passive:true});
    reduced.addEventListener('change',preference);
    return {change,finish,snapshot:()=>({active,direction,offset,outgoingOffset,opacity,outgoingOpacity,
      departingLayers:departure ? 1 : 0,fromDate,toDate}),
      dispose() {finish();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('keydown',keyboard,true);
        document.removeEventListener('pointerdown',interact,true);document.removeEventListener('pointerup',release,true);document.removeEventListener('pointercancel',release,true);document.removeEventListener('wheel',interact,true);
        view.removeEventListener('resize',finish);view.removeEventListener('blur',finish);view.removeEventListener('scroll',finish);reduced.removeEventListener('change',preference);}
    };
  }
  window.TraceDateTimelineMotion = Object.freeze({create});
})();
