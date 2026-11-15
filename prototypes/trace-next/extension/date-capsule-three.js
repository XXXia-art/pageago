/* Offline Three.js keycaps. Native date controls remain usable without WebGL. */
(() => {
  'use strict';
  const QUARTER = Math.PI / 2;
  const wrap = n => ((n % 4) + 4) % 4;

  function create({host}) {
    const T = window.TraceThree;
    let backend = 'fallback', renderer = null, scene = null, camera = null;
    let frame = 0, lastTime = 0, renders = 0, disposed = false, lost = false;
    let values = {month: '', day: ''}, reduced = false, pressed = false;
    let pressAmount = 0, pressVelocity = 0;
    const rollers = [], geometries = new Set(), materials = new Set(), textures = new Set(), shadowLights = [];
    const revision = T?.REVISION ? String(T.REVISION) : null;
    const document = host.ownerDocument;
    const labelStyle = getComputedStyle(host.querySelector('.date-day') || host);
    const labelFont = `${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`;
    let resizeObserver = null;
    host.dataset.renderer = 'fallback';host.dataset.rolling = 'false';

    function stop() { if (frame) cancelAnimationFrame(frame);frame = 0;lastTime = 0; }
    function disposeResources() {
      resizeObserver?.disconnect();resizeObserver = null;
      for (const resource of textures) resource.dispose();textures.clear();
      for (const resource of materials) resource.dispose();materials.clear();
      for (const resource of geometries) resource.dispose();geometries.clear();
      for (const light of shadowLights.splice(0)) light.dispose();
      renderer?.dispose();renderer?.domElement.remove();
      scene?.clear();
    }
    function fallback() {
      stop();lost = true;backend = 'fallback';pressed = false;
      for (const state of rollers) {state.active = false;state.group.rotation.x = 0;state.velocity = 0;}
      host.dataset.renderer = 'fallback';host.dataset.rolling = 'false';
      disposeResources();
    }
    function render() {
      if (backend !== 'three' || lost || disposed) return;
      try {renderer.render(scene, camera);renders++;} catch {fallback();}
    }
    function geometry(value) {geometries.add(value);return value;}
    function material(value) {materials.add(value);return value;}

    function drawLabel(face, value, kind) {
      if (face.value === value) return;
      face.value = value;
      const {context: ctx, canvas} = face;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();ctx.scale(4, 4);
      const width = canvas.width / 4, height = canvas.height / 4;
      ctx.fillStyle = '#625e56';ctx.strokeStyle = '#726c63';
      if (kind === 'calendar') {
        const x = width / 2 - 7, y = height / 2 - 6;
        ctx.lineWidth = 1.25;ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();ctx.roundRect(x, y, 14, 13, 2);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x, y + 4);ctx.lineTo(x + 14, y + 4);
        ctx.moveTo(x + 4, y - 2);ctx.lineTo(x + 4, y + 2);
        ctx.moveTo(x + 10, y - 2);ctx.lineTo(x + 10, y + 2);ctx.stroke();
      } else {
        // Month and day use the same typography as the native fallback labels.
        ctx.font = labelFont;
        ctx.textAlign = 'center';ctx.textBaseline = 'middle';
        ctx.fillText(value, width / 2, height / 2 + .5);
      }
      ctx.restore();face.texture.needsUpdate = true;
    }

    function createKey(kind, width, x) {
      const group = new T.Group();group.position.set(x, 0, -18);
      group.name = 'date-' + kind;scene.add(group);
      const body = new T.Mesh(
        geometry(new T.RoundedBoxGeometry(width, 36, 36, 4, 1.6)),
        material(new T.MeshStandardMaterial({color: 0xf2ede4, roughness: 1, metalness: 0}))
      );
      body.castShadow = true;body.receiveShadow = true;group.add(body);
      const faces = [];
      for (let i = 0; i < 4; i++) {
        const canvas = document.createElement('canvas');canvas.width = width * 4;canvas.height = 36 * 4;
        const context = canvas.getContext('2d');if (!context) throw Error('Canvas labels unavailable');
        const texture = new T.CanvasTexture(canvas);texture.colorSpace = T.SRGBColorSpace;
        texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());textures.add(texture);
        const face = {canvas, context, texture, value: null};
        const ink = new T.Mesh(
          geometry(new T.PlaneGeometry(width, 36)),
          material(new T.MeshBasicMaterial({map: texture, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1}))
        );
        const mount = new T.Group();mount.rotation.x = i * QUARTER;
        ink.position.z = 18.035;mount.add(ink);group.add(mount);
        faces.push(face);drawLabel(face, kind === 'calendar' ? 'calendar' : '', kind);
      }
      const state = {kind, group, faces, value: '', target: 0, step: 0, velocity: 0, active: false};
      rollers.push(state);return state;
    }

    function settle(state) {
      state.group.rotation.x = 0;state.target = state.step = state.velocity = 0;state.active = false;
      for (const face of state.faces) drawLabel(face, state.value, state.kind);
    }
    function paintPress() {
      for (const state of rollers) {
        state.group.position.y = -pressAmount * .65;
        state.group.position.z = -18 - pressAmount * .85;
      }
    }
    function pending() {
      return rollers.some(state => state.active) || Math.abs(pressAmount - Number(pressed)) > .0001 || Math.abs(pressVelocity) > .001;
    }
    function tick(now) {
      frame = 0;
      if (backend !== 'three' || lost || disposed) return;
      const dt = lastTime ? Math.min(.04, (now - lastTime) / 1000) : 1 / 60;lastTime = now;
      const omega = 20, decay = Math.exp(-omega * dt);
      for (const state of rollers) if (state.active) {
        const delta = state.group.rotation.x - state.target, c = state.velocity + omega * delta;
        state.group.rotation.x = state.target + (delta + c * dt) * decay;
        state.velocity = (state.velocity - omega * c * dt) * decay;
        if (Math.abs(state.group.rotation.x - state.target) < .0018 && Math.abs(state.velocity) < .018) settle(state);
      }
      const pressOmega = 28, delta = pressAmount - Number(pressed), c = pressVelocity + pressOmega * delta, e = Math.exp(-pressOmega * dt);
      pressAmount = Number(pressed) + (delta + c * dt) * e;
      pressVelocity = (pressVelocity - pressOmega * c * dt) * e;
      if (Math.abs(pressAmount - Number(pressed)) < .0001 && Math.abs(pressVelocity) < .001) {pressAmount = Number(pressed);pressVelocity = 0;}
      paintPress();host.dataset.rolling = String(rollers.some(state => state.active));render();
      if (pending() && backend === 'three') frame = requestAnimationFrame(tick);else lastTime = 0;
    }
    function run() {if (!frame && backend === 'three' && !lost && !disposed) frame = requestAnimationFrame(tick);}
    function finish() {
      stop();
      for (const state of rollers) settle(state);
      pressAmount = Number(pressed);pressVelocity = 0;paintPress();
      host.dataset.rolling = 'false';render();
    }

    function update(next, options = {}) {
      values = {month: String(next.month), day: String(next.day)};reduced = !!options.reduced;
      if (backend !== 'three' || lost || disposed) return;
      for (const state of rollers) state.value = state.kind === 'calendar' ? 'calendar' : values[state.kind];
      if (options.initial || reduced) {finish();return;}
      const direction = options.direction < 0 ? -1 : 1;
      for (const state of rollers) {
        if (!options.monthChanged && state.kind !== 'day') {
          // A new same-month intent cancels any previous month-wide roll immediately.
          if (state.active || state.faces[0].value !== state.value) settle(state);
          continue;
        }
        const angle = state.group.rotation.x / QUARTER;
        state.step = Math.max(Math.ceil(angle - 2), Math.min(Math.floor(angle + 2), state.step - direction));
        state.target = state.step * QUARTER;
        drawLabel(state.faces[wrap(-state.step)], state.value, state.kind);
        state.active = true;
      }
      host.dataset.rolling = String(rollers.some(state => state.active));render();run();
    }
    function setPressed(value) {
      pressed = !!value;
      if (backend !== 'three' || lost || disposed) return;
      if (reduced) {pressAmount = Number(pressed);pressVelocity = 0;paintPress();render();} else run();
    }
    function snapshot() {
      return {backend, revision, angles: backend === 'three' ? rollers.map(state => state.group.rotation.x) : [0, 0, 0],
        rolling: backend === 'three' ? rollers.map(state => state.active) : [false, false, false], values: {...values}, renders, pressed};
    }
    function contextLost(event) {event.preventDefault();fallback();}
    function dispose() {
      if (disposed) return;disposed = true;stop();
      renderer?.domElement.removeEventListener('webglcontextlost', contextLost);
      disposeResources();backend = 'fallback';host.dataset.renderer = 'fallback';host.dataset.rolling = 'false';
    }
    const api = {update, setPressed, finish, snapshot, dispose};
    if (!T?.WebGLRenderer || !T.RoundedBoxGeometry) return api;

    try {
      renderer = new T.WebGLRenderer({alpha: true, antialias: true, powerPreference: 'low-power'});
      renderer.setPixelRatio(Math.min(2.5, window.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.toneMapping = T.NeutralToneMapping;renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = true;renderer.shadowMap.type = T.PCFSoftShadowMap;
      const canvas = renderer.domElement;canvas.className = 'date-three-canvas';canvas.setAttribute('aria-hidden', 'true');
      canvas.style.pointerEvents = 'none';canvas.addEventListener('webglcontextlost', contextLost);
      // Extra vertical space lets the full key corner pass during a quarter turn.
      scene = new T.Scene();camera = new T.OrthographicCamera(-82, 82, 30, -30, .1, 500);
      camera.position.set(0, 0, 180);camera.lookAt(0, 0, 0);
      scene.add(new T.HemisphereLight(0xffffff, 0xd6d0c6, 2.3));
      const light = new T.DirectionalLight(0xffffff, 1.05);light.position.set(-40, 65, 170);light.castShadow = true;
      shadowLights.push(light);
      light.shadow.mapSize.set(1024, 1024);Object.assign(light.shadow.camera, {left: -105, right: 105, top: 70, bottom: -70, near: 1, far: 400});
      light.shadow.bias = -.0003;light.shadow.normalBias = .12;scene.add(light);
      createKey('month', 64, -44);createKey('day', 46, 14);createKey('calendar', 36, 58);
      host.append(canvas);backend = 'three';host.dataset.renderer = 'three';
      function resize() {
        if (backend !== 'three' || disposed || lost) return;
        const width = host.clientWidth || 164, height = (host.clientHeight || 48) + 12;
        renderer.setSize(width, height, false);render();
      }
      resize();
      if (typeof ResizeObserver === 'function') {resizeObserver = new ResizeObserver(resize);resizeObserver.observe(host);}
    } catch {fallback();}
    return api;
  }

  window.TraceDateCapsuleThree = Object.freeze({create});
})();
