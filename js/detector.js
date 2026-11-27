/**
 * Image analysis for Camera Detector. No DOM and no dependencies, so the same
 * code runs in the browser and in the Node tests.
 *
 * Every image here is a Float32Array of brightness values (0–255), row-major,
 * `w` pixels wide and `h` tall.
 *
 * ── Why flash scanning works with the lights on ────────────────────────────
 * A camera lens is a retroreflector: light that goes into it bounces almost
 * straight back toward where it came from. A phone's flashlight sits right
 * next to the phone's own camera, so a hidden lens in front of it lights up
 * far more than the wall around it.
 *
 * We blink the flashlight and compare a frame taken with it ON against frames
 * taken with it OFF just before and just after. Lamps, windows and daylight
 * look the same in both, so they cancel out. The comparison is done as a
 * ratio (in log space), which also cancels surface texture: a white patch and
 * a grey patch both get brighter by the same *factor* when the flash hits
 * them. What survives is anything that got brighter by a much bigger factor
 * than its surroundings, in a spot only a few pixels wide. That is what a
 * lens glint looks like.
 *
 * Phones are hand-held, so the picture shifts, tilts and zooms a little
 * between frames. Before comparing, movement is measured in patches across the
 * frame and the OFF frames are warped to line up with the ON frame. Each pixel
 * is then compared with the brightest OFF pixel right next to it, so leftover
 * wobble can't make a bright detail look new.
 *
 * Real rooms are full of things that can still fool that comparison, so a spot
 * only counts when:
 *  - it was dark with the flash off and got several times brighter, far more
 *    than the rest of the picture did (a lens is a dark hole until lit);
 *  - it beats the strongest "vanishing" spot in the same frame. Hand shake and
 *    moving screens make details appear *and* disappear in equal measure; a
 *    flash glint only ever appears. So the worst vanishing spot sets the bar;
 *  - it stands alone. A hidden camera is one glint. A patch of similar glints
 *    is a glossy surface (a keyboard, a shiny tray), so the whole patch is
 *    ignored.
 */

/** Pixels analysed per frame. */
export const PIXEL_BUDGET = 800 * 450;
/** Pixel-sized parameters below are tuned for this size and scale with it. */
const REFERENCE_PIXELS = 640 * 360;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Size to downscale a video frame to before analysis (keeps aspect ratio). */
export function analysisSize(videoWidth, videoHeight, budget = PIXEL_BUDGET) {
  const s = Math.min(1, Math.sqrt(budget / (videoWidth * videoHeight)));
  return {
    width: Math.max(16, Math.round(videoWidth * s)),
    height: Math.max(16, Math.round(videoHeight * s)),
  };
}

/** How much bigger than the reference size an analysis grid is (linear). */
function sizeScale(w, h) {
  return Math.sqrt((w * h) / REFERENCE_PIXELS);
}

/**
 * RGBA bytes → brightness, using the brightest channel rather than luma so
 * coloured glints (lens coatings, purple infrared LEDs) are not under-counted.
 */
export function brightnessFromRGBA(rgba, out) {
  for (let i = 0, j = 0, n = out.length; i < n; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    out[i] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
  return out;
}

/** Separable box blur with clamped edges. `tmp` and `out` must be w*h long. */
export function boxBlur(src, w, h, r, out, tmp) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + (k < 0 ? 0 : k >= w ? w - 1 : k)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      const add = x + r + 1 < w ? x + r + 1 : w - 1;
      const sub = x - r > 0 ? x - r : 0;
      acc += src[row + add] - src[row + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      const add = y + r + 1 < h ? y + r + 1 : h - 1;
      const sub = y - r > 0 ? y - r : 0;
      acc += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}

/** In place: map -= local average. Leaves only small-scale detail. */
function subtractLocalMean(map, w, h, r, blur, tmp) {
  boxBlur(map, w, h, r, blur, tmp);
  for (let i = 0, n = w * h; i < n; i++) map[i] -= blur[i];
}

/**
 * Median of |map| (sampled every `step` pixels), optionally only where
 * `mask[i] > maskMin`. A noise estimate that real edges in the scene can't
 * inflate, unlike a mean. Uses a histogram, so it runs in linear time.
 */
export function medianAbs(map, { step = 2, mask = null, maskMin = 0, maxValue = 2, bins = 1024 } = {}) {
  const hist = new Uint32Array(bins);
  const scale = bins / maxValue;
  let count = 0;
  for (let i = 0; i < map.length; i += step) {
    if (mask && !(mask[i] > maskMin)) continue;
    let b = (Math.abs(map[i]) * scale) | 0;
    if (b >= bins) b = bins - 1;
    hist[b]++;
    count++;
  }
  if (!count) return 0;
  const half = count / 2;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= half) return (b + 0.5) / scale;
  }
  return maxValue;
}

/** Median of `map` (sampled), optionally only where `mask[i] > maskMin`. */
export function median(map, { step = 2, mask = null, maskMin = 0, lo = -4, hi = 4, bins = 2048 } = {}) {
  const hist = new Uint32Array(bins);
  const scale = bins / (hi - lo);
  let count = 0;
  for (let i = 0; i < map.length; i += step) {
    if (mask && !(mask[i] > maskMin)) continue;
    let b = ((map[i] - lo) * scale) | 0;
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    hist[b]++;
    count++;
  }
  if (!count) return 0;
  const half = count / 2;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= half) return lo + (b + 0.5) / scale;
  }
  return hi;
}

function isLocalMax(map, w, x, y, v) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const u = map[(y + dy) * w + x + dx];
      if (u > v) return false;
      // On a flat-topped peak (saturated pixels) keep only the first pixel.
      if (u === v && (dy < 0 || (dy === 0 && dx < 0))) return false;
    }
  }
  return true;
}

/**
 * Local maxima at or above `threshold`, strongest first, at least `minDist`
 * apart. Returns [{x, y, v}] in integer pixel coordinates. With `accept`, each
 * peak is passed through it (return a value to keep, or null to drop) before
 * it counts toward `max`, so rejected peaks can't crowd out real ones.
 */
export function findPeaks(map, w, h, threshold, { border = 2, minDist = 6, max = 16, accept = null } = {}) {
  const found = [];
  for (let y = border; y < h - border; y++) {
    const row = y * w;
    for (let x = border; x < w - border; x++) {
      const v = map[row + x];
      if (v >= threshold && v > 0 && isLocalMax(map, w, x, y, v)) found.push({ x, y, v });
    }
  }
  found.sort((a, b) => b.v - a.v);
  const kept = [];
  const minD2 = minDist * minDist;
  const out = [];
  for (const p of found) {
    if (out.length >= max) break;
    if (!kept.every((k) => (k.x - p.x) ** 2 + (k.y - p.y) ** 2 >= minD2)) continue;
    kept.push(p);
    const a = accept ? accept(p) : p;
    if (a) out.push(a);
  }
  return out;
}

/**
 * How many of 16 points on a circle of `radius` around (x, y) are above
 * `level`. A small round spot scores 0; a line through it scores ~2; a big
 * bright patch scores high.
 */
export function ringCount(map, w, h, x, y, radius, level) {
  let count = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const sx = Math.round(x + radius * Math.cos(a));
    const sy = Math.round(y + radius * Math.sin(a));
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    if (map[sy * w + sx] > level) count++;
  }
  return count;
}

/** Smallest value in the square window of half-size `r` around (x, y). */
export function windowMin(map, w, h, x, y, r) {
  let m = Infinity;
  const x0 = Math.max(0, x - r);
  const x1 = Math.min(w - 1, x + r);
  const y0 = Math.max(0, y - r);
  const y1 = Math.min(h - 1, y + r);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const v = map[yy * w + xx];
      if (v < m) m = v;
    }
  }
  return m;
}

/**
 * Centre of the bright blob around a peak, or null if the blob is not a
 * small round spot (it is a line, an edge or a large patch). The peak pixel
 * itself can sit anywhere on a flat-topped (saturated) blob, so the ring test
 * is measured from the blob's centre, not from the peak.
 */
export function smallSpotCenter(map, w, h, x, y, radius, level) {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  const r = radius - 1;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const v = map[yy * w + xx];
      if (v > level) {
        sx += v * xx;
        sy += v * yy;
        sw += v;
      }
    }
  }
  const cx = sw ? sx / sw : x;
  const cy = sw ? sy / sw : y;
  if (ringCount(map, w, h, cx, cy, radius, level) > 1) return null;
  return { x: cx, y: cy };
}

/** Box-average downsample by an integer factor `f` into `out`. */
function downsample(src, w, h, f, out) {
  const cw = Math.floor(w / f);
  const ch = Math.floor(h / f);
  const inv = 1 / (f * f);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let sum = 0;
      for (let y = cy * f; y < cy * f + f; y++) {
        const row = y * w;
        for (let x = cx * f; x < cx * f + f; x++) sum += src[row + x];
      }
      out[cy * cw + cx] = sum * inv;
    }
  }
}

/**
 * The shift (dx, dy) within `range` of (x0, y0) that best lines `b` up with
 * `a`, i.e. minimises the mean |a(x, y) − b(x + dx, y + dy)|. Checks every
 * `step`-th pixel. Ties go to the smaller shift, so a featureless view
 * (a blank wall) reads as "no movement".
 */
export function bestShift(a, b, w, h, x0, y0, range, step = 1) {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let dy = y0 - range; dy <= y0 + range; dy++) {
    for (let dx = x0 - range; dx <= x0 + range; dx++) {
      const xs = Math.max(0, -dx);
      const xe = Math.min(w, w - dx);
      const ys = Math.max(0, -dy);
      const ye = Math.min(h, h - dy);
      if (xe - xs < w / 2 || ye - ys < h / 2) continue;
      let sum = 0;
      let n = 0;
      for (let y = ys; y < ye; y += step) {
        const ra = y * w;
        const rb = (y + dy) * w + dx;
        for (let x = xs; x < xe; x += step) {
          sum += Math.abs(a[ra + x] - b[rb + x]);
          n++;
        }
      }
      const cost = sum / n;
      if (cost < best - 1e-9 || (cost < best + 1e-9 && dx * dx + dy * dy < bx * bx + by * by)) {
        best = cost;
        bx = dx;
        by = dy;
      }
    }
  }
  return { dx: bx, dy: by };
}

/**
 * Like bestShift, but for one rectangular patch, searching ±`range` around
 * (x0, y0). Also returns how confident the match is (`weight`: how sharply the
 * error rises away from the best shift; ~0 on a featureless patch) and refines
 * the shift to a fraction of a pixel.
 */
function patchShift(a, b, w, h, px, py, pw, ph, x0, y0, range, step) {
  const size = 2 * range + 1;
  const costs = new Float64Array(size * size);
  let best = Infinity;
  let bi = -1;
  for (let j = 0; j < size; j++) {
    const dy = y0 - range + j;
    for (let i = 0; i < size; i++) {
      const dx = x0 - range + i;
      const xs = Math.max(px, -dx);
      const xe = Math.min(px + pw, w - dx);
      const ys = Math.max(py, -dy);
      const ye = Math.min(py + ph, h - dy);
      let sum = 0;
      let n = 0;
      for (let y = ys; y < ye; y += step) {
        const ra = y * w;
        const rb = (y + dy) * w + dx;
        for (let x = xs; x < xe; x += step) {
          sum += Math.abs(a[ra + x] - b[rb + x]);
          n++;
        }
      }
      const cost = n > 16 ? sum / n : Infinity;
      costs[j * size + i] = cost;
      if (cost < best) {
        best = cost;
        bi = j * size + i;
      }
    }
  }
  if (bi < 0) return null;
  const bx = bi % size;
  const by = (bi / size) | 0;
  let fx = 0;
  let fy = 0;
  let curve = 0;
  if (bx > 0 && bx < size - 1) {
    const l = costs[bi - 1];
    const r = costs[bi + 1];
    const d = l + r - 2 * best;
    if (d > 1e-9 && Number.isFinite(d)) {
      fx = Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d)));
      curve += d;
    }
  }
  if (by > 0 && by < size - 1) {
    const u = costs[bi - size];
    const dn = costs[bi + size];
    const d = u + dn - 2 * best;
    if (d > 1e-9 && Number.isFinite(d)) {
      fy = Math.max(-0.5, Math.min(0.5, (u - dn) / (2 * d)));
      curve += d;
    }
  }
  return { dx: x0 - range + bx + fx, dy: y0 - range + by + fy, weight: curve };
}

/**
 * Least-squares fit of a smooth movement (shift + rotation + zoom + shear) to
 * patch shifts: displacement(x, y) = (p0 + p1·u + p2·v, q0 + q1·u + q2·v)
 * with u, v measured from the frame centre. Patches that disagree with the
 * fit (a moving screen, something close to the camera) are dropped and the
 * fit is redone. Falls back to a plain shift when there isn't enough detail.
 */
export function fitMotion(patches, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  let use = patches.filter((p) => p.weight > 0);
  let model = null;
  for (let round = 0; round < 3 && use.length; round++) {
    model = solveAffine(use, cx, cy);
    const resid = use.map((p) => {
      const u = p.x - cx;
      const v = p.y - cy;
      return Math.hypot(model.p0 + model.p1 * u + model.p2 * v - p.dx, model.q0 + model.q1 * u + model.q2 * v - p.dy);
    });
    const keep = use.filter((p, i) => resid[i] < 1.2);
    if (keep.length === use.length || keep.length < 4) break;
    use = keep;
  }
  return model ?? { p0: 0, p1: 0, p2: 0, q0: 0, q1: 0, q2: 0 };
}

function solveAffine(pts, cx, cy) {
  let sw = 0;
  let su = 0;
  let sv = 0;
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let sx = 0;
  let sxu = 0;
  let sxv = 0;
  let sy = 0;
  let syu = 0;
  let syv = 0;
  for (const p of pts) {
    const k = p.weight;
    const u = p.x - cx;
    const v = p.y - cy;
    sw += k;
    su += k * u;
    sv += k * v;
    suu += k * u * u;
    suv += k * u * v;
    svv += k * v * v;
    sx += k * p.dx;
    sxu += k * p.dx * u;
    sxv += k * p.dx * v;
    sy += k * p.dy;
    syu += k * p.dy * u;
    syv += k * p.dy * v;
  }
  const shift = { p0: sx / sw, p1: 0, p2: 0, q0: sy / sw, q1: 0, q2: 0 };
  if (pts.length < 4) return shift;
  // Normal equations [sw su sv; su suu suv; sv suv svv] · [c0 c1 c2] = rhs.
  // A small ridge keeps rotation/zoom near zero when the detail is all in one line.
  const ridge = 1e-3 * (suu + svv) + 1e-9;
  const m = [
    [sw, su, sv],
    [su, suu + ridge, suv],
    [sv, suv, svv + ridge],
  ];
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!(Math.abs(det) > 1e-9 * sw * (suu + 1) * (svv + 1))) return shift;
  const solve = (r0, r1, r2) => {
    const d = (a, b, c) =>
      a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    const col = [
      [m[0][0], m[1][0], m[2][0]],
      [m[0][1], m[1][1], m[2][1]],
      [m[0][2], m[1][2], m[2][2]],
    ];
    const rhs = [r0, r1, r2];
    return [d(rhs, col[1], col[2]) / det, d(col[0], rhs, col[2]) / det, d(col[0], col[1], rhs) / det];
  };
  const [p0, p1, p2] = solve(sx, sxu, sxv);
  const [q0, q1, q2] = solve(sy, syu, syv);
  // Hand shake between two frames is small; anything wild is a bad fit.
  if (Math.abs(p1) > 0.05 || Math.abs(p2) > 0.05 || Math.abs(q1) > 0.05 || Math.abs(q2) > 0.05) return shift;
  return { p0, p1, p2, q0, q1, q2 };
}

/**
 * out(x, y) = src at (x, y) + displacement, nearest pixel, edges repeated.
 * Nearest-pixel sampling keeps small details sharp (interpolating would blur
 * them and make them look dimmer than in the ON frame). The ≤½-pixel rounding
 * error is absorbed by the max filter afterwards.
 */
function warpInto(src, w, h, m, out) {
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    const v = y - cy;
    const ro = y * w;
    for (let x = 0; x < w; x++) {
      const u = x - cx;
      let sx = Math.round(x + m.p0 + m.p1 * u + m.p2 * v);
      let sy = Math.round(y + m.q0 + m.q1 * u + m.q2 * v);
      sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
      sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
      out[ro + x] = src[sy * w + sx];
    }
  }
}

/** Largest displacement anywhere in the frame (for a safe border). */
function maxDisplacement(m, w, h) {
  let best = 0;
  for (const [u, v] of [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [-w / 2, h / 2],
    [w / 2, h / 2],
  ]) {
    best = Math.max(best, Math.abs(m.p0 + m.p1 * u + m.p2 * v), Math.abs(m.q0 + m.q1 * u + m.q2 * v));
  }
  return best;
}

/** Separable (2r+1)×(2r+1) maximum filter. */
export function maxFilter(src, w, h, r, out, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= w ? w - 1 : x + r;
      for (let k = x0; k <= x1; k++) if (src[row + k] > m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      const y0 = y - r < 0 ? 0 : y - r;
      const y1 = y + r >= h ? h - 1 : y + r;
      for (let k = y0; k <= y1; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Keeps spots at or above `threshold` that stand alone. A hidden camera is one
 * glint; a patch of similar spots is a glossy surface or a keyboard's letters.
 * `spots` must include weaker ones too, so crowding can be judged.
 */
function keepIsolated(spots, threshold, radius) {
  const kept = [];
  let crowded = 0;
  const r2 = radius * radius;
  for (const p of spots) {
    if (p.v < threshold) continue;
    let similar = 0;
    let twin = false;
    for (const q of spots) {
      if (q === p || (q.x - p.x) ** 2 + (q.y - p.y) ** 2 >= r2) continue;
      if (q.v >= p.v * 0.35) similar++;
      if (q.v >= p.v * 0.6) twin = true;
    }
    if (similar >= 2 || twin) crowded++;
    else kept.push({ x: p.x, y: p.y, strength: p.v / threshold });
  }
  return { kept, crowded };
}

const COARSE = 4;

/**
 * Finds lens glints by comparing a flash-ON frame with the flash-OFF frames
 * taken just before and after it.
 */
export class FlashDetector {
  constructor(w, h, options = {}) {
    const s = sizeScale(w, h);
    this.w = w;
    this.h = h;
    /** 0 = only obvious glints, 1 = flag faint ones too. */
    this.sensitivity = options.sensitivity ?? 0.5;
    /** Radius of the "surroundings" a spot is compared against. */
    this.hatRadius = options.hatRadius ?? Math.max(4, Math.round(9 * s));
    /** Largest glint radius we expect; anything wider is not a pinhole lens. */
    this.spotRadius = options.spotRadius ?? Math.max(3, Math.round(5 * s));
    /** Leftover misalignment (pixels) tolerated after lining frames up. Kept
     *  small: a lens in a pale housing has very little dark around it. */
    this.tolerance = options.tolerance ?? 1;
    /** A glint with this many similar glints nearby is part of a glossy surface. */
    this.crowdRadius = options.crowdRadius ?? Math.round(this.spotRadius * 14);
    /** Furthest the picture may move between two frames and still line up. */
    this.maxShift = options.maxShift ?? Math.max(4, Math.round(24 * s));
    const n = w * h;
    /** Final per-pixel score; the "glow map" view draws this. */
    this.score = new Float32Array(n);
    /** How much more than its surroundings each pixel brightened (log ratio). */
    this.ratio = new Float32Array(n);
    this.threshold = Infinity;
    /** Movement found by the last process() call (see fitMotion). */
    this.motion = null;
    /** Why candidates were dropped in the last call (for tuning). */
    this.stats = {};
    for (const k of ['_offB', '_offA', '_base', '_onMax', '_negScore', '_neg', '_gain', '_blur', '_tmp', '_hpOn', '_hpOff']) {
      this[k] = new Float32Array(n);
    }
    this._cw = Math.floor(w / COARSE);
    this._ch = Math.floor(h / COARSE);
    const cn = this._cw * this._ch;
    this._cOn = new Float32Array(cn);
    this._cOff = new Float32Array(cn);
    this._cBlur = new Float32Array(cn);
    this._cTmp = new Float32Array(cn);
  }

  /** Log brightness with lighting gradients removed, at full and 1/4 size.
   *  This is what frames are lined up on: edges and texture, not lighting. */
  _alignable(src, hp, coarse) {
    const { w, h } = this;
    for (let i = 0, n = w * h; i < n; i++) hp[i] = Math.log(src[i] + 8);
    downsample(hp, w, h, COARSE, coarse);
    subtractLocalMean(coarse, this._cw, this._ch, 2, this._cBlur, this._cTmp);
    subtractLocalMean(hp, w, h, 4, this._blur, this._tmp);
  }

  /** Movement of `off` relative to the ON frame: a coarse shift for the whole
   *  frame, then a fine shift per patch, then one smooth fit through them. */
  _motionTo(off) {
    const { w, h } = this;
    this._alignable(off, this._hpOff, this._cOff);
    const coarseRange = Math.ceil(this.maxShift / COARSE);
    const g = bestShift(this._cOn, this._cOff, this._cw, this._ch, 0, 0, coarseRange, 2);
    const portrait = h > w;
    const nx = portrait ? 4 : 6;
    const ny = portrait ? 6 : 4;
    const pw = Math.floor(w / nx);
    const ph = Math.floor(h / ny);
    const patches = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const r = patchShift(this._hpOn, this._hpOff, w, h, i * pw, j * ph, pw, ph, g.dx * COARSE, g.dy * COARSE, COARSE, 3);
        if (r) patches.push({ x: i * pw + pw / 2, y: j * ph + ph / 2, ...r });
      }
    }
    const m = fitMotion(patches, w, h);
    if (!patches.some((p) => p.weight > 0)) {
      m.p0 = g.dx * COARSE;
      m.q0 = g.dy * COARSE;
    }
    return m;
  }

  process(on, offBefore, offAfter = offBefore) {
    const { w, h, ratio, score } = this;
    const offB = this._offB;
    const offA = this._offA;
    const base = this._base;
    const onMax = this._onMax;
    const neg = this._neg;
    const negScore = this._negScore;
    const gain = this._gain;
    const blur = this._blur;
    const tmp = this._tmp;
    const n = w * h;
    const t = clamp01(this.sensitivity);
    const minGain = lerp(45, 18, t); // brightness levels a glint must gain
    const minJump = lerp(1.25, 0.6, t); // must brighten ≈3.5× … 1.8× more than the scene did
    const minRatio = lerp(0.65, 0.3, t); // and stand out from its surroundings
    const noiseK = lerp(12, 6, t);
    const r = this.tolerance;

    // 1. Line the OFF frames up with the ON frame.
    this._alignable(on, this._hpOn, this._cOn);
    const before = this._motionTo(offBefore);
    const after = offAfter === offBefore ? before : this._motionTo(offAfter);
    this.motion = { before, after };
    warpInto(offBefore, w, h, before, offB);
    warpInto(offAfter, w, h, after, offA);

    // 2. "Appeared": ON compared with the brightest aligned OFF pixel nearby.
    maxFilter(offB, w, h, r, base, tmp);
    maxFilter(offA, w, h, r, blur, tmp);
    for (let i = 0; i < n; i++) if (blur[i] > base[i]) base[i] = blur[i];
    // "Vanished": the mirror image, OFF compared with the brightest ON pixel
    // nearby. Flash glints never vanish, so these come only from movement,
    // screens and camera processing: they show how noisy this frame is.
    maxFilter(on, w, h, r, onMax, tmp);
    for (let i = 0; i < n; i++) {
      const b = base[i];
      const off = offB[i] < offA[i] ? offB[i] : offA[i];
      gain[i] = on[i] - b;
      ratio[i] = Math.log((on[i] + 8) / (b + 8));
      neg[i] = Math.log((off + 8) / (onMax[i] + 8));
      negScore[i] = off - onMax[i]; // vanished brightness, in levels
    }

    // 3. How much the whole picture changed (exposure, the flash's general wash).
    const typical = median(ratio, { mask: base, maskMin: 12 });
    const typicalNeg = median(neg, { mask: onMax, maskMin: 12 });
    // jump = how much more than typical each pixel brightened (kept in `blur`)
    for (let i = 0; i < n; i++) blur[i] = ratio[i] - typical;
    // Local excess over the surroundings.
    subtractLocalMean(ratio, w, h, this.hatRadius, onMax, tmp);
    const negJump = this._hpOff; // reuse as scratch
    for (let i = 0; i < n; i++) negJump[i] = neg[i] - typicalNeg;
    subtractLocalMean(neg, w, h, this.hatRadius, onMax, tmp);

    const noise = medianAbs(ratio, { mask: base, maskMin: 24 });
    let threshold = Math.max(minRatio, noise * noiseK);

    for (let i = 0; i < n; i++) {
      score[i] = gain[i] > minGain && blur[i] > minJump && ratio[i] > 0 ? ratio[i] : 0;
      negScore[i] = negScore[i] > minGain && negJump[i] > minJump && neg[i] > 0 ? neg[i] : 0;
    }

    // Near the frame edges the warped frames have no real data.
    const moved = Math.max(maxDisplacement(before, w, h), maxDisplacement(after, w, h));
    const border = Math.max(2, Math.ceil(moved) + r + 2);
    const minDist = this.spotRadius * 2;

    // 4. The strongest small "vanished" spot sets the bar for this frame.
    let worstVanished = 0;
    const vanished = findPeaks(negScore, w, h, threshold * 0.5, {
      border,
      minDist,
      max: 1,
      accept: (p) => (smallSpotCenter(neg, w, h, p.x, p.y, this.spotRadius, p.v * 0.5) ? p : null),
    });
    if (vanished.length) worstVanished = vanished[0].v;
    const raised = worstVanished * 1.2 > threshold;
    threshold = Math.max(threshold, worstVanished * 1.2);

    // 5. Small round spots, including weaker ones (to judge crowding).
    const spots = findPeaks(score, w, h, threshold * 0.35, {
      border,
      minDist,
      max: 64,
      accept: (p) => {
        const c = smallSpotCenter(ratio, w, h, p.x, p.y, this.spotRadius, p.v * 0.5);
        return c && { x: c.x, y: c.y, v: p.v };
      },
    });

    // 6. Keep strong spots that stand alone.
    const { kept: peaks, crowded } = keepIsolated(spots, threshold, this.crowdRadius);

    this.threshold = threshold;
    this.stats = { threshold, typical, worstVanished, raisedByVanished: raised, spots: spots.length, crowded, kept: peaks.length };
    return { peaks, threshold, noise, motion: this.motion };
  }
}

/**
 * Fallback when the browser can't blink the flashlight: finds tiny points
 * that are much brighter than their surroundings in a single frame. It flags
 * more harmless things (LEDs, reflections) than flash scanning does. It works
 * best with a light held right next to the camera, or in the dark when
 * looking for infrared LEDs.
 */
export class SpotDetector {
  constructor(w, h, options = {}) {
    const s = sizeScale(w, h);
    this.w = w;
    this.h = h;
    this.sensitivity = options.sensitivity ?? 0.5;
    this.hatRadius = options.hatRadius ?? Math.max(4, Math.round(9 * s));
    this.spotRadius = options.spotRadius ?? Math.max(3, Math.round(5 * s));
    this.crowdRadius = options.crowdRadius ?? Math.round(this.spotRadius * 14);
    const n = w * h;
    this.contrast = new Float32Array(n);
    this.score = new Float32Array(n);
    this.threshold = Infinity;
    this._blur = new Float32Array(n);
    this._tmp = new Float32Array(n);
  }

  process(frame) {
    const { w, h, contrast, score } = this;
    const n = w * h;
    const t = clamp01(this.sensitivity);
    const minBrightness = lerp(215, 130, t);
    const minContrast = lerp(0.75, 0.3, t);
    const noiseK = lerp(14, 6, t);

    for (let i = 0; i < n; i++) contrast[i] = Math.log(frame[i] + 8);
    subtractLocalMean(contrast, w, h, this.hatRadius, this._blur, this._tmp);

    const noise = medianAbs(contrast);
    const threshold = Math.max(minContrast, noise * noiseK);
    for (let i = 0; i < n; i++) {
      score[i] = frame[i] >= minBrightness && contrast[i] > 0 ? contrast[i] : 0;
    }

    const spots = findPeaks(score, w, h, threshold * 0.35, {
      minDist: this.spotRadius * 2,
      max: 96,
      accept: (p) => {
        const c = smallSpotCenter(contrast, w, h, p.x, p.y, this.spotRadius, p.v * 0.5);
        return c && { x: c.x, y: c.y, v: p.v };
      },
    });
    const { kept: peaks, crowded } = keepIsolated(spots, threshold, this.crowdRadius);
    this.threshold = threshold;
    this.stats = { threshold, noise, spots: spots.length, crowded, kept: peaks.length };
    return { peaks, threshold, noise };
  }
}

/**
 * Keeps detections steady across frames. A spot only counts as "confirmed"
 * after it shows up in the same place `confirmHits` times within the last
 * `window` updates, which filters out one-off flickers. It is dropped after
 * `maxMisses` updates in a row without a match.
 */
export class Tracker {
  constructor({ matchRadius = 15, maxMisses = 2, confirmHits = 2, window = Infinity, maxTracks = 12 } = {}) {
    this.opts = { matchRadius, maxMisses, confirmHits, window, maxTracks };
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
  }

  /** `peaks` should be sorted strongest first (as the detectors return them). */
  update(peaks) {
    const { matchRadius, maxMisses, confirmHits, window, maxTracks } = this.opts;
    const remember = (t, hit) => {
      t.recent.push(hit);
      if (t.recent.length > window) t.recent.shift();
      if (t.recent.filter(Boolean).length >= confirmHits) t.confirmed = true;
    };
    const maxD2 = matchRadius * matchRadius;
    const unmatched = new Set(this.tracks);
    const born = [];

    for (const p of peaks) {
      let best = null;
      let bestD2 = maxD2;
      for (const t of unmatched) {
        const d2 = (t.x - p.x) ** 2 + (t.y - p.y) ** 2;
        if (d2 <= bestD2) {
          bestD2 = d2;
          best = t;
        }
      }
      if (best) {
        unmatched.delete(best);
        best.x += (p.x - best.x) * 0.6;
        best.y += (p.y - best.y) * 0.6;
        best.hits++;
        best.misses = 0;
        best.strength = 0.5 * best.strength + 0.5 * p.strength;
        remember(best, true);
      } else {
        born.push({
          id: this.nextId++,
          x: p.x,
          y: p.y,
          hits: 1,
          misses: 0,
          strength: p.strength,
          confirmed: confirmHits <= 1,
          recent: [true],
        });
      }
    }
    for (const t of unmatched) {
      t.misses++;
      remember(t, false);
    }

    let tracks = this.tracks.filter((t) => t.misses <= maxMisses).concat(born);
    if (tracks.length > maxTracks) {
      tracks.sort(
        (a, b) => b.confirmed - a.confirmed || b.hits - a.hits || b.strength - a.strength,
      );
      tracks = tracks.slice(0, maxTracks);
    }
    this.tracks = tracks;
    return tracks;
  }
}
