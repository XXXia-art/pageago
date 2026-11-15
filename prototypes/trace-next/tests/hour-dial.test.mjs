// Point NODE_PATH at an installed Playwright if it is outside the working tree.
// Run after build.py. Only synthetic sessions and a disposable browser context are used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const {chromium} = createRequire(import.meta.url)('playwright');
const preview = pathToFileURL(path.resolve('output/pageago.html')).href;
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-background-networking', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({
    timezoneId: 'America/New_York', viewport: {width: 1440, height: 900}, reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(8000);
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:/, route => {
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(preview);
  const slider = page.locator('#hour-dial [role=slider]');
  const resetDial = page.locator('#hour-dial-reset');
  const bars = page.locator('#hour-dial .hour-dial-bar');
  const snapshot = () => page.evaluate(() => traceSnapshot());
  const readMinute = async () => Number(await slider.getAttribute('aria-valuenow'));

  async function loadDay(date) {
    const record = {
      id: 'fixture', title: 'Test page', url: 'https://example.org/test',
      start: date + 'T14:00:00Z', end: date + 'T14:01:00Z',
    };
    await page.locator('#import-input').setInputFiles({
      name: 'synthetic.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({schema: 'trace.v1', source: 'synthetic-demo', sessions: [record]})),
    });
    await page.waitForFunction(date => traceSnapshot().date === date && traceSnapshot().segments === 1, date);
  }

  async function assertLayout() {
    const geometry = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const dial = box('#hour-dial'), room = box('#daylight-room');
      const tickRects = [...document.querySelectorAll('#axis-ticks span')]
        .map(el => el.getBoundingClientRect()).filter(r => r.height > 0);
      return {
        lastTick: Math.max(...tickRects.map(rect => rect.bottom)),
        dialTop: dial.top, dialBottom: dial.bottom, roomTop: room.top,
        interactiveInRoom: !!document.querySelector('#daylight-room [role=slider]'),
      };
    });
    assert.ok(geometry.lastTick <= geometry.dialTop + 1, JSON.stringify(geometry));
    assert.ok(Number.isFinite(geometry.lastTick), 'time ticks are present');
    assert.ok(geometry.dialBottom <= geometry.roomTop + 1, JSON.stringify(geometry));
    assert.equal(geometry.interactiveInRoom, false);
    assert.equal(await bars.count(), 30);
  }

  async function moveTo(fraction) {
    await slider.scrollIntoViewIfNeeded();
    const rect = await slider.boundingBox();
    await page.mouse.move(rect.x + fraction * rect.width, rect.y + rect.height / 2);
  }

  async function rollDial(fraction, deltaY) {
    await moveTo(fraction);
    const {zoom} = await snapshot();
    const scroll = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, deltaY);
    await page.waitForFunction(({zoom, deltaY}) =>
      deltaY < 0 ? traceSnapshot().zoom > zoom : traceSnapshot().zoom < zoom, {zoom, deltaY});
    assert.equal(await page.evaluate(() => window.scrollY), scroll, 'scroll over the dial belongs to the timeline');
    return snapshot();
  }

  // Send equal wheel distances at one tick and measure the rendered crest across frames.
  async function measureWheelCrest(interval) {
    return slider.evaluate(async (track, interval) => {
      const ticks = [...track.children];
      const tickIndex = 21;
      const rect = ticks[tickIndex].getBoundingClientRect();
      const before = traceSnapshot().zoom;
      let peak = 0, peakIndex = -1, sent = 0, last = -Infinity;
      while (sent < 5 || performance.now() - last < 220) {
        const now = await new Promise(requestAnimationFrame);
        if (sent < 5 && now - last >= interval) {
          track.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: -32,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          }));
          sent++;
          last = now;
        }
        ticks.forEach((tick, i) => {
          const lift = Number(getComputedStyle(tick).getPropertyValue('--lift'));
          if (lift > peak) { peak = lift; peakIndex = i; }
        });
      }
      return {peak, peakIndex, tickIndex, zoomed: traceSnapshot().zoom > before};
    }, interval);
  }

  const expectFlatTicks = () => page.waitForFunction(() =>
    [...document.querySelectorAll('.hour-dial-bar')].every(
      bar => Number(getComputedStyle(bar).getPropertyValue('--lift')) === 0));

  async function expectWindowAt(minute) {
    await page.waitForFunction(minute => {
      const {date, viewport: [a, b], bounds: [dayStart, dayEnd]} = traceSnapshot();
      const target = new Date(date + 'T00:00:00');
      target.setMinutes(minute);
      const width = b - a;
      const start = Math.max(dayStart, Math.min(dayEnd - width, Number(target) - width / 2));
      return width <= 3600001 && Math.abs(start - a) < 10;
    }, minute, {timeout: 5000});
  }

  async function expectNoonOverview() {
    await page.waitForFunction(() => {
      const {viewport, bounds, zoom} = traceSnapshot();
      return zoom === 1 && viewport.every((value, i) => value === bounds[i])
        && document.querySelector('#hour-dial-reset').hasAttribute('data-at-noon');
    });
    assert.equal(await readMinute(), 720);
    assert.equal(await slider.getAttribute('aria-valuetext'), '12:00');
    assert.equal(await page.locator('.hour-dial-time').textContent(), '12:00');
    assert.equal(await bars.nth(15).getAttribute('data-current'), '');
    assert.equal(await page.locator('#hour-marker').isHidden(), true);
    assert.equal(await page.locator('#hour-dial').getAttribute('data-locked'), null);
  }

  await loadDay('2026-11-02');
  for (const [width,height] of [[1440,900], [1280,720]]) {
    await page.setViewportSize({width,height});
    await assertLayout();
  }
  await page.setViewportSize({width:1440,height:900});
  const initial = await snapshot();
  await expectNoonOverview();
  assert.equal(await page.locator('#hour-dial').getByText(/^(00|24)$/).count(), 0);
  const ticks = page.locator('#axis-ticks .tick');
  assert.equal(await ticks.first().textContent(), '00:00');
  assert.equal(await ticks.last().textContent(), '24:00');
  assert.ok(await page.locator('.hour-dial-time').evaluate(label => label.inert));
  await resetDial.focus();
  await page.keyboard.press('Shift+Tab');
  assert.ok(await slider.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'none'));
  assert.equal(await page.locator('.hour-dial-time').evaluate(el => getComputedStyle(el).textDecorationLine), 'underline');
  // Start at midnight, then roll on an evening tick without first pressing it.
  await slider.press('Home');
  await expectWindowAt(0);
  const evening = await rollDial(.804, -120);
  const eveningMinute = await readMinute();
  assert.ok(Math.abs(eveningMinute - .804 * 1440) < 6, 'pointing at the dial selects a minute of the full day');
  const center = (evening.viewport[0] + evening.viewport[1]) / 2;
  assert.ok(Math.abs(center - (initial.bounds[0] + eveningMinute * 60000)) < 10,
    'the viewport centers on the selected minute, even when it was previously off screen');
  await rollDial(.804, -120);
  const midnight = await rollDial(.005, 120);
  assert.equal(midnight.viewport[0], initial.bounds[0], 'zooming near midnight stays within the same day');
  for (let i = 0; i < 12 && (await snapshot()).zoom > 1; i++) {
    await rollDial(.25, 600);
  }
  await expectNoonOverview();
  await resetDial.focus();
  assert.ok(await resetDial.evaluate(el => el === document.activeElement));
  const noonCell = 15.5 / 30;
  await moveTo(noonCell);
  await page.mouse.down();
  assert.equal(await readMinute(),720);
  assert.equal(await slider.getAttribute('aria-valuetext'),'12:00');
  assert.equal(await page.locator('#hour-marker').evaluate(el => el.hidden),false);
  assert.deepEqual((await snapshot()).viewport, initial.viewport, 'pressing a tick only previews its time');
  const track = await slider.boundingBox();
  await page.mouse.move(track.x + noonCell * track.width + 1, track.y + track.height / 2);
  assert.deepEqual((await snapshot()).viewport, initial.viewport, 'one pixel of jitter still counts as a tap');
  await page.mouse.up();
  await expectWindowAt(720);
  assert.ok(await page.locator('#hour-dial').evaluate(el => el.hasAttribute('data-locked')));
  const noon = await snapshot();
  assert.ok(noon.zoom > initial.zoom);
  assert.equal(noon.viewport[1]-noon.viewport[0], 3600000, 'an overview jump opens the surrounding hour');

  // Scrubbing moves the viewport while the pointer is held, including after a reversal.
  await moveTo(.25); await page.mouse.down();
  assert.deepEqual((await snapshot()).viewport, noon.viewport);
  await moveTo(.5); await moveTo(.625); await expectWindowAt(900);
  await moveTo(.375); await expectWindowAt(540);
  await moveTo(.75); await expectWindowAt(1080);
  assert.equal(await readMinute(),1080);
  assert.ok(await bars.evaluateAll(els => els.every(el => Number(getComputedStyle(el).getPropertyValue('--lift')) === 0)));
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await readMinute(),720);
  assert.deepEqual((await snapshot()).viewport, noon.viewport);

  await moveTo(.3);
  await slider.evaluate(el => {
    el.addEventListener('pointerdown', event => { el.dataset.qaPointer = String(event.pointerId); }, {once:true});
  });
  await page.mouse.down(); await moveTo(.75); await expectWindowAt(1080);
  const id = Number(await slider.getAttribute('data-qa-pointer'));
  assert.ok(await slider.evaluate((el,id) => el.hasPointerCapture(id), id));
  await slider.dispatchEvent('pointercancel',{pointerId:id, pointerType:'mouse'});
  await page.mouse.up();
  assert.equal(await readMinute(),720);
  assert.deepEqual((await snapshot()).viewport, noon.viewport);

  await moveTo(.4); await page.mouse.down(); await moveTo(.75); await expectWindowAt(1080);
  const dragWindow = (await snapshot()).viewport;
  await page.mouse.up();
  assert.deepEqual((await snapshot()).viewport, dragWindow, 'release keeps the last preview window');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual((await snapshot()).viewport, dragWindow, 'release does not queue another camera adjustment');
  await page.locator('#zoom-in').click();
  const [fineStart,fineEnd] = (await snapshot()).viewport;
  assert.ok(fineEnd-fineStart < 3600000);
  await slider.press('ArrowRight'); assert.equal(await readMinute(),1081); await expectWindowAt(1081);
  const [fineLeft,fineRight] = (await snapshot()).viewport;
  assert.equal(fineRight-fineLeft, fineEnd-fineStart, 'a jump keeps an existing finer zoom');
  await slider.press('PageDown'); assert.equal(await readMinute(),1021); await expectWindowAt(1021);
  await slider.press('Home'); assert.equal(await readMinute(),0); await expectWindowAt(0);
  await slider.press('End'); assert.equal(await slider.getAttribute('aria-valuetext'),'24:00'); await expectWindowAt(1440);
  assert.equal((await snapshot()).date, initial.date);
  assert.equal((await snapshot()).activeMs, initial.activeMs);
  for (let cell = 0; cell < 30; cell++) {
    await moveTo((cell + .5) / 30);
    await page.mouse.down(); await page.mouse.up();
    assert.equal(await readMinute(), cell * 48, 'tap selects the start of cell ' + cell);
    assert.equal(await bars.nth(cell).getAttribute('data-current'), '');
    await expectWindowAt(cell * 48);
  }
  await resetDial.click();
  await expectNoonOverview();
  await page.locator('#zoom-in').click();
  assert.ok((await snapshot()).zoom > 1);
  await resetDial.focus();
  await resetDial.press('Enter');
  await expectNoonOverview();
  await slider.press('End');
  await page.locator('#zoom-reset').click();
  await page.waitForFunction(() => traceSnapshot().zoom===1 && document.querySelector('#hour-marker').hidden);
  await moveTo(.25); await page.mouse.down(); await moveTo(.5); await expectWindowAt(720);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual((await snapshot()).viewport, initial.viewport, 'cancel restores the overview zoom and its bounds');
  assert.equal(await page.locator('#hour-marker').evaluate(el => el.hidden),true);

  for (const [date,hours,localNoon] of [
    ['2026-03-08', 23, '2026-03-08T16:00:00Z'],
    ['2026-11-01', 25, '2026-11-01T17:00:00Z'],
  ]) {
    await loadDay(date);
    const [start,end] = (await snapshot()).bounds;
    assert.equal(end-start, hours*3600000);
    await moveTo(noonCell); await page.mouse.down(); await page.mouse.up(); await expectWindowAt(720);
    const [left,right] = (await snapshot()).viewport;
    assert.ok(Math.abs((left+right)/2-Date.parse(localNoon))<10, 'noon is a local wall-clock time on '+date);
    // The cell starting at 02:24 falls in the spring gap; 01:36 repeats in autumn.
    const transitionCell = hours === 23 ? 3 : 2;
    await moveTo((transitionCell + .5) / 30); await page.mouse.down(); await page.mouse.up();
    await expectWindowAt(transitionCell * 48);
    await slider.press('End'); await expectWindowAt(1440);
    await resetDial.click();
    await expectNoonOverview();
  }
  // Capture a live intermediate state, then confirm the wave returns to rest.
  const reducedCrest = await measureWheelCrest(16);
  assert.ok(reducedCrest.zoomed, 'reduced motion preserves wheel zoom');
  assert.equal(reducedCrest.peak, 0, 'reduced motion keeps the ticks flat throughout the gesture');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await rollDial(860 / 1440, -120);
  assert.ok(Math.abs(await readMinute() - 860) <= 5);
  assert.equal(await page.locator('#hour-marker').isVisible(), true);
  await resetDial.evaluate(button => {
    button.addEventListener('click', () => {
      window.noonDuringReset = new Promise(resolve => {
        let frames = 0;
        function check() {
          const minute = document.querySelector('.hour-dial-track').getAttribute('aria-valuenow');
          const label = document.querySelector('.hour-dial-time').textContent;
          const markerHidden = document.querySelector('#hour-marker').hidden;
          if (minute !== '720' || label !== '12:00' || !markerHidden) {
            resolve({minute, label, markerHidden, frames});
          } else if (++frames === 10) resolve(null);
          else requestAnimationFrame(check);
        }
        check();
      });
    }, {once: true});
  });
  await resetDial.click();
  assert.equal(await page.evaluate(() => window.noonDuringReset), null,
    'reset clears the afternoon selection on click and keeps noon throughout the animated return');
  await expectNoonOverview();
  const slow = await measureWheelCrest(150);
  assert.ok(slow.peak > 0 && slow.zoomed, 'slow wheel movement raises the ticks while zooming');
  await expectFlatTicks();
  const fast = await measureWheelCrest(16);
  assert.ok(fast.zoomed && fast.peak > slow.peak + .02,
    'scrolling faster at the same position produces a taller crest: ' + JSON.stringify({slow, fast}));
  assert.ok(Math.abs(fast.peakIndex - fast.tickIndex) <= 1, 'the crest peaks at the pointed tick');
  await expectFlatTicks();

  await moveTo(.5); await page.mouse.down(); await moveTo(.25);
  await page.waitForFunction(() => {
    const lift = [...document.querySelectorAll('.hour-dial-bar')]
      .map(el => Number(getComputedStyle(el).getPropertyValue('--lift')));
    return Math.max(...lift) > .1 && Math.min(...lift) === 0;
  });
  await page.mouse.up();
  await expectFlatTicks();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('PASS 30 ticks at 48-minute intervals, desktop layout, speed-responsive wheel crest and zoom, live scrubbing, cancel and release, noon overview reset, keyboard, reduced motion and DST.');
} finally {
  await browser.close();
}
