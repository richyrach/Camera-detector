import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FlashDetector,
  SpotDetector,
  Tracker,
  analysisSize,
  PIXEL_BUDGET,
  bestShift,
  boxBlur,
  brightnessFromRGBA,
  findPeaks,
} from '../js/detector.js';
import { roomTriple } from './room.js';

const W = 320;
const H = 180;

/** Deterministic pseudo-random numbers so tests never flake. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A "lit room": a textured wall, furniture blocks and a small bright ceiling
 * lamp. Returns a plain brightness map.
 */
function room(seed = 1) {
  const rand = rng(seed);
  const img = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) img[y * W + x] = 110 + 40 * (y / H) + 18 * rand();
  }
  fillRect(img, 20, 100, 120, 60, 45); // dark shelf
  fillRect(img, 180, 30, 90, 60, 200); // pale picture frame
  fillRect(img, 195, 42, 60, 36, 70); // picture inside it
  fillDisc(img, 60, 25, 2, 255); // ceiling lamp, always on
  fillDisc(img, 240, 130, 6, 20); // a dark object (where a lens could hide)
  return img;
}

function fillRect(img, x0, y0, w, h, v) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img[y * W + x] = v;
}

function fillDisc(img, cx, cy, r, v) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.5) img[y * W + x] = v;
    }
  }
}

/** What the flash does: everything gets brighter by a factor, more in the middle. */
function withFlash(img, { exposure = 1 } = {}) {
  const out = new Float32Array(img.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d2 = ((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2;
      const boost = 1 + 0.35 * Math.exp(-d2 * 4);
      out[y * W + x] = Math.min(255, img[y * W + x] * boost * exposure);
    }
  }
  return out;
}

/** The scene as seen after the phone moved: content moves by (dx, dy). */
function shifted(img, dx, dy = 0) {
  const out = new Float32Array(img.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - dx));
      const sy = Math.min(H - 1, Math.max(0, y - dy));
      out[y * W + x] = img[sy * W + sx];
    }
  }
  return out;
}

/** A sub-pixel move: blend of two whole-pixel moves. */
function halfShifted(img, dx, dy) {
  const a = shifted(img, Math.floor(dx), Math.floor(dy));
  const b = shifted(img, Math.ceil(dx), Math.ceil(dy));
  return a.map((v, i) => 0.5 * (v + b[i]));
}

function addNoise(img, seed, amount = 3) {
  const rand = rng(seed);
  return img.map((v) => Math.min(255, Math.max(0, v + (rand() - 0.5) * 2 * amount)));
}

const near = (p, x, y, r = 3) => Math.hypot(p.x - x, p.y - y) <= r;

test('analysisSize keeps aspect ratio and stays within budget', () => {
  const a = analysisSize(1280, 720);
  assert.ok(Math.abs(a.width / a.height - 16 / 9) < 0.01);
  assert.ok(a.width * a.height <= PIXEL_BUDGET * 1.01);
  const b = analysisSize(200, 100);
  assert.deepEqual(b, { width: 200, height: 100 }, 'never upscales');
});

test('brightnessFromRGBA takes the brightest channel', () => {
  const rgba = new Uint8ClampedArray([10, 200, 30, 255, 250, 0, 0, 255, 1, 2, 3, 255]);
  const out = brightnessFromRGBA(rgba, new Float32Array(3));
  assert.deepEqual([...out], [200, 250, 3]);
});

test('boxBlur preserves a flat image and spreads an impulse evenly', () => {
  const flat = new Float32Array(W * H).fill(77);
  const out = boxBlur(flat, W, H, 4, new Float32Array(W * H), new Float32Array(W * H));
  assert.ok(out.every((v) => Math.abs(v - 77) < 1e-3));

  const imp = new Float32Array(W * H);
  imp[90 * W + 160] = 81;
  boxBlur(imp, W, H, 4, out, new Float32Array(W * H));
  assert.ok(Math.abs(out[90 * W + 160] - 1) < 1e-4);
  assert.ok(Math.abs(out[94 * W + 164] - 1) < 1e-4);
  assert.equal(out[95 * W + 160], 0);
});

test('findPeaks returns strongest first and respects minimum distance', () => {
  const map = new Float32Array(W * H);
  map[50 * W + 50] = 5;
  map[50 * W + 52] = 4; // too close to the first
  map[100 * W + 200] = 9;
  const peaks = findPeaks(map, W, H, 1, { minDist: 6 });
  assert.deepEqual(
    peaks.map((p) => [p.x, p.y]),
    [
      [200, 100],
      [50, 50],
    ],
  );
});

test('flash scan finds a lens glint in a lit room', () => {
  const off = addNoise(room(), 11);
  const on = addNoise(withFlash(room()), 12);
  fillDisc(on, 240, 130, 1, 255); // the lens bounces the flash straight back
  const det = new FlashDetector(W, H);
  const { peaks } = det.process(on, off, addNoise(room(), 13));
  assert.equal(peaks.length, 1, `expected one glint, got ${JSON.stringify(peaks)}`);
  assert.ok(near(peaks[0], 240, 130), `glint at ${peaks[0].x},${peaks[0].y}`);
});

test('flash scan ignores lamps and texture, even when exposure shifts', () => {
  for (const exposure of [0.75, 1, 1.2]) {
    const off = addNoise(room(), 21);
    const on = addNoise(withFlash(room(), { exposure }), 22);
    const det = new FlashDetector(W, H, { sensitivity: 0.8 });
    const { peaks } = det.process(on, off, addNoise(room(), 23));
    assert.deepEqual(peaks, [], `exposure ${exposure}: ${JSON.stringify(peaks)}`);
  }
});

test('flash scan rejects things that only lit up because the phone moved', () => {
  const scene = room();
  // Phone drifts sideways: OFF, ON, OFF frames are each 2px apart.
  const det = new FlashDetector(W, H, { sensitivity: 0.8 });
  const { peaks } = det.process(withFlash(scene), shifted(scene, -2), shifted(scene, 2));
  assert.deepEqual(peaks, [], JSON.stringify(peaks));
});

test('flash scan still finds a real glint while the phone drifts', () => {
  const scene = room();
  const on = withFlash(scene);
  fillDisc(on, 240, 130, 1, 255);
  const det = new FlashDetector(W, H);
  const { peaks } = det.process(on, shifted(scene, -2), shifted(scene, 2));
  assert.equal(peaks.length, 1, JSON.stringify(peaks));
  assert.ok(near(peaks[0], 240, 130));
});

test('bestShift measures how far the picture moved', () => {
  const scene = room();
  const moved = shifted(scene, 5, -3);
  // moved(x + dx, y + dy) ≈ scene(x, y)
  assert.deepEqual(bestShift(scene, moved, W, H, 0, 0, 8), { dx: 5, dy: -3 });
  const flat = new Float32Array(W * H).fill(100);
  assert.deepEqual(bestShift(flat, flat, W, H, 0, 0, 4), { dx: 0, dy: 0 }, 'featureless → no movement');
});

test('flash scan copes with a sweep of several pixels between frames', () => {
  const scene = room();
  const on = withFlash(shifted(scene, 7, 2));
  const det = new FlashDetector(W, H, { sensitivity: 0.8 });
  let r = det.process(on, scene, shifted(scene, 14, 4));
  assert.deepEqual(r.peaks, [], `false alarm while sweeping: ${JSON.stringify(r.peaks)}`);

  fillDisc(on, 247, 132, 1, 255); // lens (which sits at 240,130 before the move)
  r = det.process(on, scene, shifted(scene, 14, 4));
  assert.equal(r.peaks.length, 1, JSON.stringify(r.peaks));
  assert.ok(near(r.peaks[0], 247, 132));
});

test('flash scan finds a lens in a dark housing despite sub-pixel shake', () => {
  const img = new Float32Array(W * H).fill(205); // a pale smoke detector / clock face
  fillDisc(img, 160, 90, 4, 22); // dark lens housing
  const on = withFlash(halfShifted(img, 0.5, -0.5));
  fillDisc(on, 160, 90, 1, 255);
  const det = new FlashDetector(W, H);
  const r = det.process(on, halfShifted(img, -0.5, 0.5), halfShifted(img, 0.5, 0.5));
  assert.equal(r.peaks.length, 1, JSON.stringify(r.peaks));
  assert.ok(near(r.peaks[0], 160, 90));
});

test('flash scan rejects a large reflective patch (a mirror or screen)', () => {
  const off = room();
  const on = withFlash(room());
  fillRect(on, 100, 40, 30, 30, 255); // a whole patch lights up, not a pinhole
  const det = new FlashDetector(W, H, { sensitivity: 1 });
  const { peaks } = det.process(on, off, off);
  assert.ok(
    peaks.every((p) => !(p.x > 102 && p.x < 128 && p.y > 42 && p.y < 68)),
    `flagged inside the patch: ${JSON.stringify(peaks)}`,
  );
});

test('higher sensitivity catches a fainter glint', () => {
  const off = room();
  const on = withFlash(room());
  fillDisc(on, 240, 130, 1, 70); // a fainter glint (distant lens)
  const low = new FlashDetector(W, H, { sensitivity: 0 }).process(on, off, off);
  const high = new FlashDetector(W, H, { sensitivity: 1 }).process(on, off, off);
  assert.equal(low.peaks.length, 0);
  assert.ok(high.peaks.some((p) => near(p, 240, 130)));
});

test('spot scan finds a small bright point but not a bright window', () => {
  const img = room();
  fillRect(img, 120, 20, 40, 50, 250); // window
  const det = new SpotDetector(W, H);
  const { peaks } = det.process(img);
  assert.ok(peaks.some((p) => near(p, 60, 25)), `lamp missing: ${JSON.stringify(peaks)}`);
  assert.ok(
    peaks.every((p) => !(p.x >= 118 && p.x <= 162 && p.y >= 18 && p.y <= 72)),
    `flagged the window: ${JSON.stringify(peaks)}`,
  );
});

test('tracker confirms repeated spots and forgets vanished ones', () => {
  const tr = new Tracker({ matchRadius: 10, confirmHits: 2, maxMisses: 1 });
  let t = tr.update([{ x: 50, y: 50, strength: 2 }]);
  assert.equal(t.length, 1);
  assert.equal(t[0].confirmed, false);

  t = tr.update([{ x: 53, y: 49, strength: 2 }]); // small drift: same spot
  assert.equal(t.length, 1);
  assert.equal(t[0].confirmed, true);
  const id = t[0].id;

  t = tr.update([{ x: 200, y: 100, strength: 1 }]); // a different spot appears
  assert.equal(t.length, 2);
  assert.equal(t.find((k) => k.id === id).misses, 1);

  t = tr.update([]);
  t = tr.update([]);
  assert.equal(t.length, 0, 'both forgotten after too many misses');
});

// ── The realistic room (see room.js): keyboard, glossy keys, a laptop screen
// playing video, an LED strip, hand shake and auto-exposure. ───────────────

const RW = 480;
const RH = 270;
const onLens = (p, lens) => Math.hypot(p.x - lens.x, p.y - lens.y) < 4;

test('room: finds the webcam and nothing else, steady or shaky', () => {
  for (const [seed, shake, autoExposure] of [
    [1, 0.5, true],
    [2, 1.5, true],
    [3, 4, true],
    [4, 1.5, false],
  ]) {
    const r = roomTriple(RW, RH, { seed, shake, autoExposure });
    const { peaks } = new FlashDetector(RW, RH).process(r.on, r.offBefore, r.offAfter);
    const label = `seed ${seed} shake ${shake} AE ${autoExposure}`;
    assert.ok(peaks.some((p) => onLens(p, r.lens)), `${label}: lens missed`);
    assert.deepEqual(peaks.filter((p) => !onLens(p, r.lens)), [], `${label}: false alarms`);
  }
});

test('room: no lens means no alarms, even at full sensitivity', () => {
  for (const seed of [5, 6]) {
    const r = roomTriple(RW, RH, { seed, shake: 2, lens: false });
    const { peaks } = new FlashDetector(RW, RH, { sensitivity: 1 }).process(r.on, r.offBefore, r.offAfter);
    assert.deepEqual(peaks, [], `seed ${seed}`);
  }
});

test('room: a faint, distant lens is still found', () => {
  const r = roomTriple(RW, RH, { seed: 7, shake: 1.5, glint: 0.5 });
  const { peaks } = new FlashDetector(RW, RH).process(r.on, r.offBefore, r.offAfter);
  assert.ok(peaks.some((p) => onLens(p, r.lens)), JSON.stringify(peaks));
});

test('room: big hand movement (tilt + zoom) is lined up', () => {
  const r = roomTriple(RW, RH, { seed: 8, shake: 8, glossy: false });
  const det = new FlashDetector(RW, RH);
  const { peaks } = det.process(r.on, r.offBefore, r.offAfter);
  assert.ok(Math.abs(det.motion.after.p0) > 8, 'should have measured the movement');
  assert.ok(peaks.some((p) => onLens(p, r.lens)));
  assert.equal(peaks.length, 1, JSON.stringify(peaks));
});

test('tracker can require hits in most of the recent updates', () => {
  const tr = new Tracker({ matchRadius: 10, confirmHits: 3, window: 4, maxMisses: 2 });
  const spot = [{ x: 50, y: 50, strength: 1 }];
  tr.update(spot);
  tr.update([]);
  tr.update(spot);
  assert.equal(tr.tracks[0].confirmed, false, '2 of 3 is not enough');
  tr.update(spot);
  assert.equal(tr.tracks[0].confirmed, true, '3 of the last 4');

  const flicker = new Tracker({ matchRadius: 10, confirmHits: 3, window: 4, maxMisses: 2 });
  for (const seen of [true, false, false, true, false, false, true]) flicker.update(seen ? spot : []);
  assert.ok(flicker.tracks.every((t) => !t.confirmed), 'a spot seen 1 time in 3 never confirms');
});

test('findPeaks: rejected peaks do not use up the limit', () => {
  const map = new Float32Array(W * H);
  for (let i = 0; i < 10; i++) map[20 * W + 20 + i * 10] = 9; // strong but unwanted
  map[100 * W + 200] = 2; // weaker, wanted
  const wanted = (p) => (p.y === 100 ? p : null);
  assert.deepEqual(
    findPeaks(map, W, H, 1, { max: 3, accept: wanted }).map((p) => [p.x, p.y]),
    [[200, 100]],
  );
});

test('room: a lens with only a tiny dark rim (pale housing) is found', () => {
  // In the portrait layout the lens sits on the pale wall, not in the bezel.
  for (const seed of [3, 4]) {
    const r = roomTriple(450, 800, { seed, shake: 2 });
    const { peaks } = new FlashDetector(450, 800).process(r.on, r.offBefore, r.offAfter);
    assert.ok(peaks.some((p) => onLens(p, r.lens)), `seed ${seed}: ${JSON.stringify(peaks)}`);
    assert.equal(peaks.length, 1, JSON.stringify(peaks));
  }
});
