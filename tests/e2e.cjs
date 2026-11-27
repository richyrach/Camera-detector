// End-to-end check in a real (headless) browser with a simulated phone camera.
//
// The fake camera draws a lit room: a lamp and an LED strip that are always
// on, a laptop keyboard (white letters on dark keys, glossy keycaps that throw
// back small flash highlights), and a small dark object hiding a lens. The
// lens only glints while the app has the "flashlight" on, the way a real
// retroreflecting lens behaves. The picture shakes and tilts like a hand-held
// phone, and unless the app locks exposure, the camera re-adjusts brightness
// and contrast whenever the flash fires, as most phones do.
//
//   npm run test:e2e            (screenshots go to $SCREENSHOT_DIR if set)
const { chromium } = require('playwright');
const assert = require('assert/strict');
const path = require('path');
const { createServer } = require('./serve.cjs');

const LENS = { x: 0.64, y: 0.56 };
const LAMP = { x: 0.26, y: 0.11 };

function fakeCamera({ torch, exposureLock, lens, lamp }) {
  const W = 720;
  const H = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  window.__fake = { torch: false, torchCalls: 0, locked: false, everLocked: false };
  let frame = 0;

  // Keyboard layout (fixed pseudo-random letters and glossy keys).
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const keys = [];
  const size = W * 0.075;
  const gap = W * 0.012;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 10; c++) {
      const x = W * 0.05 + c * (size + gap);
      const y = H * 0.7 + r * (size + gap);
      keys.push({
        x,
        y,
        lx: x + size * (0.25 + 0.4 * rand()),
        ly: y + size * (0.25 + 0.4 * rand()),
        shine: rand() < 0.45 ? { x: x + size * (0.2 + 0.6 * rand()), y: y + size * 0.2 } : null,
      });
    }
  }

  function scene() {
    const wall = ctx.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#4a4f57');
    wall.addColorStop(0.3, '#8d9299');
    wall.addColorStop(1, '#6b6f76');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f4f7ff'; // LED strip, always on
    ctx.fillRect(W * 0.1, H * 0.04, W * 0.8, 3);
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
    ctx.fillStyle = '#d9dce1'; // laptop body
    ctx.fillRect(W * 0.02, H * 0.68, W * 0.96, H * 0.22);
    for (const k of keys) {
      ctx.fillStyle = '#1b1d21';
      ctx.fillRect(k.x, k.y, size, size);
      ctx.fillStyle = '#eef0f3'; // key letter
      ctx.fillRect(k.lx, k.ly, 5, 7);
    }
  }

  function draw() {
    frame++;
    const on = window.__fake.torch;
    ctx.save();
    // hand shake: up to ±2.5px and a slight tilt
    ctx.translate(W / 2, H / 2);
    ctx.rotate(Math.sin(frame * 0.9) * 0.004);
    ctx.translate(-W / 2 + Math.sin(frame * 1.7) * 2.5, -H / 2 + Math.cos(frame * 2.3) * 2.5);
    if (on) {
      // Locked exposure: the flash just lifts everything. Unlocked: the camera
      // compensates and changes contrast, like phone auto-exposure does.
      ctx.filter = window.__fake.locked ? 'brightness(1.22)' : 'brightness(1.02) contrast(1.2)';
    }
    scene();
    ctx.filter = 'none';
    if (on) {
      ctx.fillStyle = '#ffffff';
      for (const k of keys) {
        if (!k.shine) continue; // glossy keycaps throw back the flash
        ctx.beginPath();
        ctx.arc(k.shine.x, k.shine.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath(); // the lens bounces the flash straight back
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
    track.getCapabilities = () => ({
      ...(torch ? { torch: true } : {}),
      ...(exposureLock
        ? {
            exposureMode: ['continuous', 'manual'],
            exposureTime: { min: 1, max: 10000, step: 1 },
            whiteBalanceMode: ['continuous', 'manual'],
            colorTemperature: { min: 2500, max: 7500, step: 50 },
          }
        : {}),
    });
    track.getSettings = () => ({
      width: W,
      height: H,
      facingMode: 'environment',
      deviceId: 'fake',
      ...(torch ? { torch: window.__fake.torch } : {}),
      ...(exposureLock ? { exposureMode: window.__fake.locked ? 'manual' : 'continuous', exposureTime: 166, colorTemperature: 4800 } : {}),
    });
    track.applyConstraints = async (c) => {
      const set = c?.advanced?.[0] ?? {};
      if (typeof set.torch === 'boolean') {
        if (!torch) throw new DOMException('torch unsupported', 'NotSupportedError');
        window.__fake.torchCalls++;
        await new Promise((r) => setTimeout(r, 20));
        window.__fake.torch = set.torch;
      }
      if (exposureLock && set.exposureMode) {
        window.__fake.locked = set.exposureMode === 'manual';
        window.__fake.everLocked ||= window.__fake.locked;
      }
    };
    return stream;
  };
}

const near = (t, p, tol = 0.04) => Math.abs(t.x - p.x) < tol && Math.abs(t.y - p.y) < tol;

async function run(browser, base, { torch, exposureLock = false, screenshot }) {
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
  await page.addInitScript(fakeCamera, { torch, exposureLock, lens: LENS, lamp: LAMP });
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
    { timeout: 15000 },
  );
  // Keep scanning a while and watch for anything else being flagged.
  const falseAlarms = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const now = await snap();
    if (torch) falseAlarms.push(...now.tracks.filter((t) => t.confirmed && !near(t, LENS)));
  }
  const s = await snap();
  const confirmed = s.tracks.filter((t) => t.confirmed);
  assert.ok(confirmed.some((t) => near(t, target)), `target still tracked: ${JSON.stringify(s.tracks)}`);
  if (torch) {
    assert.deepEqual(falseAlarms, [], 'false alarms during the scan (lamp, LED strip, keyboard)');
    const calls = await page.evaluate(() => window.__fake.torchCalls);
    assert.ok(calls >= 10, `flashlight toggled ${calls} times`);
    assert.equal(s.locked, exposureLock, 'exposure lock while scanning');
    assert.equal(s.hasCapture, true, 'test capture available');
  }
  const countText = await page.textContent('#count');
  assert.match(countText, torch ? /1 possible lens/ : /bright spot/);

  if (screenshot && (exposureLock || !torch)) {
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
  if (exposureLock) {
    assert.equal(await page.evaluate(() => window.__fake.everLocked), true, 'exposure was locked');
    assert.equal(await page.evaluate(() => window.__fake.locked), false, 'exposure unlocked after stopping');
  }

  assert.deepEqual(errors, [], 'console errors');
  await context.close();
  return { mode, confirmed: confirmed.length };
}

/** The Android app shell: the page sees window.AndroidBridge. */
async function runAndroidShell(browser, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(fakeCamera, { torch: true, exposureLock: false, lens: LENS, lamp: LAMP });
  await page.addInitScript(() => {
    window.__saved = [];
    window.AndroidBridge = {
      saveImage(base64, name) {
        window.__saved.push({ bytes: base64.length, name, mime: 'image/jpeg' });
        return true;
      },
      saveFile(base64, name, mime) {
        window.__saved.push({ bytes: base64.length, name, mime });
        return true;
      },
    };
  });
  await page.goto(base);
  assert.equal(await page.isVisible('.intro .web-only'), false, 'APK link should be hidden inside the app');

  await page.click('#intro-start');
  await page.waitForFunction(() => window.__cameraDetector.snapshot().running, null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.click('#snap');
  await page.waitForFunction(() => window.__saved.length === 1, null, { timeout: 5000 });
  const saved = await page.evaluate(() => window.__saved[0]);
  assert.match(saved.name, /^camera-scan-.*\.jpg$/);
  assert.ok(saved.bytes > 10000, `snapshot too small: ${saved.bytes}`);
  assert.match(await page.textContent('#toast'), /Saved to Photos/);

  assert.equal(await page.evaluate(() => window.cameraDetectorBack()), false, 'back with nothing open leaves the app');
  await page.waitForFunction(() => window.__cameraDetector.snapshot().hasCapture, null, { timeout: 8000 });
  await page.click('#help-open');
  await page.click('#save-capture');
  await page.waitForFunction(() => window.__saved.length === 2, null, { timeout: 5000 });
  const capture = await page.evaluate(() => window.__saved[1]);
  assert.equal(capture.mime, 'image/png');
  assert.match(capture.name, /^camera-detector-test-.*\.png$/);
  assert.ok(capture.bytes > 100000, `test capture too small: ${capture.bytes}`);
  assert.equal(await page.evaluate(() => window.cameraDetectorBack()), true, 'back closes the help sheet');
  assert.equal(await page.isVisible('#help'), false);

  assert.deepEqual(errors, [], 'page errors');
  await context.close();
}

(async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const screenshot = process.env.SCREENSHOT_DIR || null;
  let failed = false;
  for (const [torch, exposureLock] of [
    [true, true],
    [true, false],
    [false, false],
  ]) {
    const label = !torch
      ? 'spot scan (no flashlight control)'
      : exposureLock
        ? 'flash scan (exposure locked)'
        : 'flash scan (camera auto-exposure fighting the flash)';
    try {
      const r = await run(browser, base, { torch, exposureLock, screenshot });
      console.log(`ok - ${label}: ${r.confirmed} confirmed`);
    } catch (err) {
      failed = true;
      console.log(`not ok - ${label}\n  ${err.message}`);
    }
  }
  try {
    await runAndroidShell(browser, base);
    console.log('ok - android app shell (snapshot + test capture saved natively, back button, no APK link)');
  } catch (err) {
    failed = true;
    console.log(`not ok - android app shell\n  ${err.message}`);
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
