/* Passive Shanghai study, lit for the local time shown on the timeline. */
(() => {
  'use strict';

  // Coordinates belong to the registered artwork, independent of pixel density.
  const W = 1710, H = 919;
  const catPlacement = {morning: [355, 800], bed: [1115, 842], height: 138};
  const required = ['dawn', 'day', 'golden', 'blue', 'night', 'curtains', 'cat'];
  const lightStops = [
    [0, 'night'], [285, 'night'], [380, 'dawn'], [435, 'dawn'],
    [585, 'day'], [925, 'day'], [1040, 'golden'], [1060, 'golden'],
    [1135, 'blue'], [1170, 'blue'], [1255, 'night'], [1440, 'night']
  ];

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function ease(a, b, value) {
    const t = clamp((value - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function makeCanvas(doc, width, height) {
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  function lighting(minute) {
    let i = 1;
    while (i < lightStops.length - 1 && lightStops[i][0] < minute) i++;
    const [start, from] = lightStops[i - 1], [end, to] = lightStops[i];
    return {from, to, mix: ease(start, end, minute)};
  }
  function closure(minute) {
    return 1 - ease(320, 440, minute) + ease(1245, 1355, minute);
  }

  // Isolate the actual illuminated texels in the night photograph. Independent
  // floor banks come on before blue hour; the river glints stay on their reflections.
  function luminousLayers(doc, night) {
    const w = night.naturalWidth, h = night.naturalHeight;
    const width = Math.ceil(850 * w / W), height = Math.ceil(516 * h / H);
    const capture = makeCanvas(doc, width, height);
    const source = capture.getContext('2d', {willReadFrequently:true});
    source.drawImage(night, 0, 0);
    const pixels = source.getImageData(0, 0, width, height).data;
    const banks = Array.from({length: 9}, () => {
      const bitmap = makeCanvas(doc, width, height), ctx = bitmap.getContext('2d');
      return {bitmap, ctx, image: ctx.createImageData(width, height)};
    });
    const facades = [
      [99,379,132,433], [148,359,198,432], [203,335,244,431],
      [350,338,376,426], [490,268,526,418], [551,215,590,415],
      [644,151,670,401], [700,353,731,424], [746,334,769,417]
    ];
    for (let y = Math.floor(145*h/H); y < height; y++) {
      for (let x = Math.floor(90*w/W); x < width; x++) {
        const ax = x*W/w, ay = y*H/h, i = (y*width+x)*4;
        const onWater = ax>285 && ax<737 && ay>455 && ay<508;
        const building = onWater ? -1 :
          facades.findIndex(([l,t,r,b]) => ax>=l && ax<=r && ay>=t && ay<=b);
        if (building < 0 && !onWater) continue;
        const r=pixels[i], g=pixels[i+1], b=pixels[i+2];
        const luma=.3*r+.54*g+.16*b;
        const lamp = ease(onWater ? 51 : 54, onWater ? 125 : 133, luma);
        if (lamp <= .04 || (onWater && r<g*.93)) continue;
        const group = onWater ? 6+(Math.floor(ay/5)+Math.floor(ax/20))%3 :
          (building*5+Math.floor(ay/13)+Math.floor(ax/21))%6;
        const dst = banks[group].image.data;
        dst[i]=r; dst[i+1]=g; dst[i+2]=b; dst[i+3]=Math.round(lamp*255);
      }
    }
    for (const layer of banks) layer.ctx.putImageData(layer.image,0,0);
    return {banks:banks.map(layer=>layer.bitmap), w:width*W/w, h:height*H/h};
  }

  function cityLights(ctx, lamps, minute) {
    if (minute>380 && minute<1010) return;
    for (let i=0; i<6; i++) {
      const on = 1010+i*17;
      ctx.globalAlpha = .94*Math.max(1-ease(280,380,minute), ease(on,on+18,minute));
      ctx.drawImage(lamps.banks[i],0,0,lamps.w,lamps.h);
    }
    ctx.globalAlpha = 1;
  }

  function riverGlints(ctx, lamps, minute, beat) {
    const amount = closure(minute);
    if (amount>.96 || minute<1040) return;
    // Clip behind the advancing curtains, as well as to existing river highlights.
    const left = 108+(431-108)*amount, right = 746-(746-431)*amount;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left,452,right-left,58);
    ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    for (let i=0; i<3; i++) {
      ctx.globalAlpha = ease(1040,1140,minute)*(.24+.20*Math.sin(beat*.37+i*2.1+minute*.031));
      ctx.drawImage(lamps.banks[6+i],0,0,lamps.w,lamps.h);
    }
    ctx.restore();
  }

  // Produce a clean textile plate and an occluder matte once at asset resolution.
  // The plant and books on the sill stay in front as the two panels travel.
  function curtainAssets(doc, images) {
    const day = images.day;
    const w = day.naturalWidth, h = day.naturalHeight;
    const cloth = makeCanvas(doc, w, h);
    const fabric = cloth.getContext('2d');
    fabric.drawImage(images.curtains, 0, 0, w, h);
    const sx = w / W, sy = h / H;
    // The photographed plant and book edges must not slide inside the folds.
    for (const [x, sw, fromY, fromHeight, replaceY] of [
      [76, 230, 370, 72, 443], [619, 141, 470, 60, 531]
    ]) {
      fabric.drawImage(images.curtains, x*sx, fromY*sy, sw*sx, fromHeight*sy,
        x*sx, replaceY*sy, sw*sx, (557-replaceY)*sy);
    }
    const matte = makeCanvas(doc, w, h), mc = matte.getContext('2d', {willReadFrequently:true});
    mc.drawImage(day, 0, 0, w, h);
    const mask = mc.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = 4 * (y * w + x), ax = x / sx, ay = y / sy;
        const [red, green, blue] = [mask.data[i], mask.data[i+1], mask.data[i+2]];
        const leaf = ax > 74 && ax < 309 && ay > 444 && ay < 560 &&
          green > blue * 1.16 && green >= red * .82 && red > blue * 1.04;
        const pot = ay > 514 && ay < 560 && ax > 149+(ay-514)*.12 && ax < 210-(ay-514)*.12;
        const books = ay > 536 && ay < 559 && ax > 636 && ax < 735;
        mask.data[i+3] = leaf || pot || books ? 255 : 0;
      }
    }
    mc.putImageData(mask, 0, 0);
    return {cloth, matte};
  }

  function curtainPanels(ctx, assets, amount) {
    if (amount <= 0) return;
    const x = 17, top = 24, end = 843, bottom = 555, seam = 431;
    const sx = assets.cloth.width / W, sy = assets.cloth.height / H;
    // Each horizontal strip extends out of its gathered, tied-back width.
    // Both the sloping silhouette and the spacing of the folds change continuously.
    const strip = 10;
    ctx.globalAlpha = ease(0, .12, amount);
    for (let y = top; y < bottom; y += strip) {
      const h = Math.min(strip, bottom-y), v = (y-top)/(bottom-top);
      const gather = v < .66 ? 1-v/.66 : (v-.66)/.34*.44;
      const leftRest = 54 + 76*gather, rightRest = 48 + 87*gather;
      const left = leftRest + (seam-x-leftRest)*amount;
      const right = rightRest + (end-seam-rightRest)*amount;
      ctx.drawImage(assets.cloth, x*sx, y*sy, (seam-x)*sx, h*sy, x, y, left, h+.25);
      ctx.drawImage(assets.cloth, seam*sx, y*sy, (end-seam)*sx, h*sy, end-right, y, right, h+.25);
    }
    ctx.globalAlpha = 1;
  }

  function drawLitPlate(ctx, images, state) {
    ctx.drawImage(images[state.from], 0, 0, W, H);
    if (state.from !== state.to && state.mix > 0) {
      ctx.globalAlpha = state.mix;
      ctx.drawImage(images[state.to], 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
  function createSurface(doc, width, height) {
    const base = makeCanvas(doc, width, height);
    const occluders = makeCanvas(doc, width, height);
    const matrix = [width / W, 0, 0, height / H, 0, 0];
    return {
      base, matrix, occluders,
      plate: base.getContext('2d', {willReadFrequently:true}),
      front: occluders.getContext('2d'),
      minute: -1, presses: []
    };
  }

  // Displace only an oval around the leading knuckles. The elbows, chair and
  // the rest of the photograph stay registered between the animation cels.
  function pressedHand(surface, ax, ay, aw, ah) {
    const [sx, , , sy] = surface.matrix;
    const x = Math.floor((ax-aw/2)*sx), y = Math.floor((ay-ah/2)*sy);
    const w = Math.max(3, Math.ceil(aw*sx)), h = Math.max(3, Math.ceil(ah*sy));
    const base = surface.plate.getImageData(x, y, w, h);
    const pressed = surface.plate.createImageData(w, h);
    const displacement = Math.max(1, Math.round(sy*6));
    for (let j=0; j<h; j++) {
      for(let i=0; i<w; i++) {
        const u = 2*(i+.5)/w-1, v = 2*(j+.5)/h-1;
        const d = Math.round(displacement * Math.max(0, 1-u*u-v*v));
        const src = (Math.max(0, j-d)*w+i)*4;
        pressed.data.set(base.data.subarray(src, src+4), (j*w+i)*4);
      }
    }
    return {x,y,image:pressed};
  }

  function paintBase(surface, images, fabric, minute) {
    const ctx = surface.plate, light = lighting(minute);
    ctx.setTransform(...surface.matrix);
    ctx.imageSmoothingEnabled = false;
    drawLitPlate(ctx, images, light);
    cityLights(ctx, fabric.lamps, minute);
    const amount = closure(minute);
    if (amount > 0) {
      curtainPanels(ctx, fabric, amount);
      const front = surface.front;
      front.setTransform(...surface.matrix);
      front.globalCompositeOperation = 'source-over';
      drawLitPlate(front, images, light);
      front.globalCompositeOperation = 'destination-in';
      front.drawImage(fabric.matte, 0, 0, W, H);
      ctx.resetTransform();
      ctx.drawImage(surface.occluders, 0, 0);
    }
    ctx.resetTransform();
    surface.presses = [pressedHand(surface, 1261, 497, 45, 26),
      pressedHand(surface, 1292, 507, 48, 25)];
    surface.minute = minute;
  }

  function animateRoom(ctx, surface, cat, lamps, minute, beat) {
    ctx.resetTransform();
    ctx.drawImage(surface.base, 0, 0);
    const key = beat % 11;
    const hand = key === 2 || key === 6 ? surface.presses[0]
      : key === 3 || key === 8 ? surface.presses[1] : null;
    if (hand) ctx.putImageData(hand.image, hand.x, hand.y);
    ctx.setTransform(...surface.matrix);
    riverGlints(ctx, lamps, minute, beat);
    // Extend a line in the real code editor, just above the bottom status bar.
    const characters = 3 + Math.floor(beat / 2) % 5;
    ctx.fillStyle = '#95c8c2';
    ctx.fillRect(1350, 457, characters * 3, 3);
    if (beat % 4 < 2) {
      ctx.fillStyle = '#ebd6a1';
      ctx.fillRect(1354 + characters * 3, 455, 3, 7);
    }
    window.TraceDaylightCat.draw(ctx, cat, minute, beat, catPlacement);
    ctx.resetTransform();
  }

  function create({canvas}) {
    const doc = canvas.ownerDocument, view = doc.defaultView;
    const ctx = canvas.getContext('2d'), files = window.TRACE_DAYLIGHT_IMAGES;
    const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
    let images = null, fabric = null, surface = null;
    let frame = 0, timer = 0, beat = 0, minute = 540;
    let visible = false, disposed = false;

    function schedule() {
      if (!disposed && !frame) frame = view.requestAnimationFrame(paint);
    }

    function animationState() {
      view.clearTimeout(timer);
      timer = 0;
      if (!visible || doc.hidden || reduced.matches || disposed) {
        if (beat) { beat = 0; schedule(); }
      } else if (images) {
        timer = view.setTimeout(() => {
          beat = beat % 264 + 1;
          schedule();
          animationState();
        }, 240);
      }
    }

    function paint() {
      frame = 0;
      if (!visible || !ctx || !images || disposed || doc.hidden) return;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const dpr = Math.min(2, view.devicePixelRatio || 1);
      const width = Math.max(1,Math.round(bounds.width*dpr));
      const height = Math.max(1,Math.round(bounds.height*dpr));
      if (!surface || width !== canvas.width || height !== canvas.height) {
        canvas.width = width;
        canvas.height = height;
        surface = createSurface(doc,width,height);
      }
      if (surface.minute !== minute) paintBase(surface, images, fabric, minute);
      ctx.clearRect(0, 0, width, height);
      animateRoom(ctx, surface, images.cat, fabric.lamps, minute, beat);
      canvas.dataset.minute = String(minute);
      canvas.dataset.daylightReady = 'true';
    }

    const resize = new ResizeObserver(schedule), intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      animationState();
      if (visible) schedule();
    });
    function handleVisibility() {
      animationState();
      if (!doc.hidden) schedule();
    }
    function handleMotionPreference() {
      animationState();
      schedule();
    }
    resize.observe(canvas);
    intersection.observe(canvas);
    doc.addEventListener('visibilitychange', handleVisibility);
    reduced.addEventListener('change', handleMotionPreference);
    canvas.dataset.daylightReady = 'false';

    Promise.all(required.map(async name => {
      const image = new Image();
      image.src = files[name];
      await image.decode();
      return [name,image];
    })).then(entries => {
      if (disposed) return;
      images = Object.fromEntries(entries);
      fabric = curtainAssets(doc, images);
      fabric.lamps = luminousLayers(doc, images.night);
      animationState();
      schedule();
    }).catch(() => { if (!disposed) canvas.dataset.daylightReady = 'error'; });

    return {
      setMinute(localMinute) {
        if (!Number.isFinite(localMinute) || disposed) return;
        const next = clamp(Math.floor(localMinute), 0, 1440);
        if (minute === next) return;
        minute = next;
        if (visible && !doc.hidden) schedule();
      },
      dispose() {
        disposed = true;
        resize.disconnect();
        intersection.disconnect();
        reduced.removeEventListener('change', handleMotionPreference);
        doc.removeEventListener('visibilitychange', handleVisibility);
        view.clearTimeout(timer);
        view.cancelAnimationFrame(frame);
        surface = fabric = images = null;
      }
    };
  }

  window.TraceDaylightRoom = Object.freeze({create});
})();
