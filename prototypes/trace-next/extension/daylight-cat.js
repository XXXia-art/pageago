/* Six side-view pixel cels of the same tabby share one foot line. */
(() => {
  'use strict';

  const cellWidth = 96;
  const cellHeight = 80;
  const feet = 78;
  const seatedHeight = 65;
  const cel = {stretch: 0, sit: 1, walkA: 2, walkB: 3, crouch: 4, sleep: 5};
  const layers = new WeakMap();

  // Position along the floor runs from the window (0) to the woven mat (1).
  // The first and last poses match across midnight. Scrubbing in either
  // direction always reconstructs the same activity and position at that time.
  const cues = [
    {end: 319, pose: 'sleep', from: 1, to: 1, facing: -1},
    {end: 338, pose: 'crouch', from: 1, to: 1, facing: -1},
    {end: 360, pose: 'stretch', from: 1, to: 1, facing: -1},
    {end: 435, pose: 'walk', from: 1, to: 0, facing: -1},
    {end: 610, pose: 'sit', from: 0, to: 0, facing: -1},
    {end: 635, pose: 'stretch', from: 0, to: 0, facing: 1},
    {end: 674, pose: 'walk', from: 0, to: .22, facing: 1},
    {end: 845, pose: 'crouch', from: .22, to: .22, facing: 1},
    {end: 1025, pose: 'sit', from: .22, to: .22, facing: 1},
    {end: 1140, pose: 'walk', from: .22, to: 1, facing: 1},
    {end: 1235, pose: 'sit', from: 1, to: 1, facing: -1},
    {end: 1275, pose: 'crouch', from: 1, to: 1, facing: -1},
    {end: 1440, pose: 'sleep', from: 1, to: 1, facing: -1}
  ];
  function smooth(start, end, x) {
    const t = Math.max(0, Math.min(1, (x - start) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function prepareCel(ctx, atlas, index, minute, twitchEar) {
    let canvas = layers.get(atlas);
    if (!canvas) {
      canvas = ctx.canvas.ownerDocument.createElement('canvas');
      canvas.width = cellWidth;
      canvas.height = cellHeight;
      layers.set(atlas, canvas);
    }
    const layer = canvas.getContext('2d');
    layer.clearRect(0, 0, cellWidth, cellHeight);
    const sx = index % 3 * cellWidth, sy = Math.floor(index / 3) * cellHeight;
    layer.drawImage(atlas, sx, sy, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
    if (twitchEar) {
      // Clip only the tips of the seated ears. The paws stay planted.
      layer.clearRect(52, 12, 12, 6);
      layer.drawImage(atlas, sx + 52, sy + 12, 12, 6, 51, 13, 12, 6);
    }
    const night = 1 - smooth(315, 425, minute) + smooth(1065, 1270, minute);
    const amber = smooth(912, 1030, minute) * (1 - smooth(1080, 1185, minute));
    layer.globalCompositeOperation = 'source-atop';
    if (amber) {
      layer.fillStyle = `rgba(224, 140, 83, ${amber * .21})`;
      layer.fillRect(0, 0, cellWidth, cellHeight);
    }
    if (night) {
      // A little warm fur remains legible in the desk lamp's reflected light.
      layer.fillStyle = `rgba(44, 47, 76, ${night * .46})`;
      layer.fillRect(0, 0, cellWidth, cellHeight);
    }
    layer.globalCompositeOperation = 'source-over';
    return canvas;
  }

  function draw(ctx, atlas, minute, beat, placement) {
    if (!atlas?.naturalWidth || !placement?.height) return;
    minute = Math.max(0, Math.min(1440, minute));
    const i = cues.findIndex(cue => minute <= cue.end);
    const cue = cues[i];
    const start = i ? cues[i - 1].end : 0;
    const part = smooth(start, cue.end, minute);
    const along = cue.from + (cue.to - cue.from) * part;
    const [wx, wy] = placement.morning;
    const [bx, by] = placement.bed;
    const scale = placement.height / seatedHeight;
    // Curve slightly toward the front of the room when passing the desk.
    const x = wx + (bx - wx) * along;
    const y = wy + (by - wy) * along + Math.sin(Math.PI * along) * placement.height * .25;
    let index = cel[cue.pose];
    if (cue.pose === 'walk') {
      const distance = Math.abs(along - cue.from) * Math.hypot(bx - wx, by - wy);
      const step = Math.floor(distance / (placement.height * .24) + beat);
      index = step % 2 ? cel.walkB : cel.walkA;
    }
    const twitchEar = cue.pose === 'sit' && beat > 0 && beat % 23 === 9;
    const frame = prepareCel(ctx, atlas, index, minute, twitchEar);
    // Measured in atlas pixels before scaling; breathing expands the ribcage
    // by about one pixel while the curled body stays in contact with the mat.
    const breath = cue.pose === 'sleep' && beat ? 1 + .034 * Math.sin(beat * .44) : 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(24, 24, 34, .19)';
    ctx.beginPath();
    ctx.ellipse(0, -scale, (cue.pose === 'walk' ? 28 : 18) * scale,
      2.2 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.scale(cue.facing * scale, scale * breath);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, -cellWidth / 2, -feet);
    ctx.restore();
  }

  window.TraceDaylightCat = Object.freeze({draw});
})();
