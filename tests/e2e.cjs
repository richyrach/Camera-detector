// End-to-end check in a real (headless) browser with a simulated phone camera.
//
// The fake camera draws a lit room with a lamp that is always on and a small
// dark object hiding a lens. The lens only glints while the app has the
// "flashlight" switched on, the same way a real retroreflecting lens behaves.
// The frame also jitters a little, like a hand-held phone.
//
//   npm run test:e2e            (screenshots go to $SCREENSHOT_DIR if set)
const { chromium } = require('playwright');
const assert = require('assert/strict');
const path = require('path');
const { createServer } = require('./serve.cjs');

const LENS = { x: 0.64, y: 0.56 };
const LAMP = { x: 0.26, y: 0.11 };

function fakeCamera({ torch, lens, lamp }) {
  const W = 720;
  const H = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  window.__fake = { torch: false, torchCalls: 0 };
  let frame = 0;

  function scene() {
    const wall = ctx.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#4a4f57');
    wall.addColorStop(0.3, '#8d9299');
    wall.addColorStop(1, '#6b6f76');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d8d1c4'; // picture frame
    ctx.fillRect(W * 0.1, H * 0.22, W * 0.42, H * 0.17);
    ctx.fillStyle = '#5b6f63';
    ctx.fillRect(W * 0.14, H * 0.245, W * 0.34, H * 0.12);
    ctx.fillStyle = '#3b2c22'; // shelf
    ctx.fillRect(0, H * 0.62, W, H * 0.035);
    ctx.fillStyle = '#c8ccd1'; // a desk clock / smoke-detector-ish object
    ctx.beginPath();
    ctx.arc(lens.x * W, lens.y * H, W * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#121418'; // its dark lens housing
    ctx.beginPath();
    ctx.arc(lens.x * W, lens.y * H, W * 0.012, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff'; // ceiling lamp: small, bright, always on
    ctx.beginPath();
    ctx.arc(lamp.x * W, lamp.y * H, W * 0.008, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw() {
    frame++;
    const on = window.__fake.torch;
    ctx.save();
    // hand shake: up to ±1.5px
    ctx.translate(Math.sin(frame * 1.7) * 1.5, Math.cos(frame * 2.3) * 1.5);
    ctx.filter = on ? 'brightness(1.22)' : 'none'; // the flash lifts everything a bit
    scene();
    ctx.filter = 'none';
    if (on) {
      ctx.fillStyle = '#ffffff'; // the lens bounces the flash straight back
      ctx.beginPath();
      ctx.arc(lens.x * W, lens.y * H, W * 0.005, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    setTimeout(draw, 33);
  }
  draw();

  navigator.mediaDevices.enumerateDevices = async () => [];
  navigator.mediaDevices.getUserMedia = async () => {
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    track.getCapabilities = () => (torch ? { torch: true } : {});
    track.getSettings = () => ({ width: W, height: H, facingMode: 'environment', deviceId: 'fake' });
    track.applyConstraints = async (c) => {
      const value = c?.advanced?.[0]?.torch;
      if (typeof value === 'boolean') {
        if (!torch) throw new DOMException('torch unsupported', 'NotSupportedError');
        window.__fake.torchCalls++;
        await new Promise((r) => setTimeout(r, 20));
        window.__fake.torch = value;
      }
    };
    return stream;
  };
}

const near = (t, p, tol = 0.04) => Math.abs(t.x - p.x) < tol && Math.abs(t.y - p.y) < tol;

async function run(browser, base, { torch, screenshot }) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: screenshot ? 2 : 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(fakeCamera, { torch, lens: LENS, lamp: LAMP });
  await page.goto(base);

  if (screenshot) await page.screenshot({ path: path.join(screenshot, 'intro.png') });
  await page.click('#intro-start');

  const snap = () => page.evaluate(() => window.__cameraDetector.snapshot());
  await page.waitForFunction(() => window.__cameraDetector.snapshot().running, null, { timeout: 8000 });
  const mode = (await snap()).mode;
  assert.equal(mode, torch ? 'flash' : 'spot', 'scan mode');

  const target = torch ? LENS : LAMP;
  await page.waitForFunction(
    ({ x, y }) =>
      window.__cameraDetector
        .snapshot()
        .tracks.some((t) => t.confirmed && Math.abs(t.x - x) < 0.04 && Math.abs(t.y - y) < 0.04),
    target,
    { timeout: 12000 },
  );
  // Let it keep scanning a while, then check it isn't flagging anything else.
  await page.waitForTimeout(4000);
  const s = await snap();
  const confirmed = s.tracks.filter((t) => t.confirmed);
  assert.ok(confirmed.some((t) => near(t, target)), `target still tracked: ${JSON.stringify(s.tracks)}`);
  if (torch) {
    assert.ok(!confirmed.some((t) => near(t, LAMP)), `lamp flagged in flash mode: ${JSON.stringify(confirmed)}`);
    assert.equal(confirmed.length, 1, `false positives: ${JSON.stringify(confirmed)}`);
    const calls = await page.evaluate(() => window.__fake.torchCalls);
    assert.ok(calls >= 10, `flashlight toggled ${calls} times`);
  }
  const countText = await page.textContent('#count');
  assert.match(countText, torch ? /1 possible lens/ : /bright spot/);

  if (screenshot) {
    await page.screenshot({ path: path.join(screenshot, torch ? 'flash-scan.png' : 'spot-scan.png') });
    if (torch) {
      await page.click('[data-view="heat"]');
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(screenshot, 'glow-map.png') });
      await page.click('#help-open');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(screenshot, 'help.png') });
      await page.click('#help-close');
    }
  }

  await page.click('#start'); // stop
  await page.waitForTimeout(600);
  const after = await snap();
  assert.equal(after.running, false);
  assert.equal(after.torch, false, 'flashlight left on after stopping');
  if (torch) assert.equal(await page.evaluate(() => window.__fake.torch), false);

  assert.deepEqual(errors, [], 'console errors');
  await context.close();
  return { mode, confirmed: confirmed.length };
}

(async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const screenshot = process.env.SCREENSHOT_DIR || null;
  let failed = false;
  for (const torch of [true, false]) {
    const label = torch ? 'flash scan (flashlight available)' : 'spot scan (no flashlight control)';
    try {
      const r = await run(browser, base, { torch, screenshot });
      console.log(`ok - ${label}: ${r.confirmed} confirmed`);
    } catch (err) {
      failed = true;
      console.log(`not ok - ${label}\n  ${err.message}`);
    }
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
