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
 * Phones are hand-held, so the picture shifts between frames. Before comparing,
 * the OFF frames are lined up with the ON frame, and each pixel is compared
 * with the brightest OFF pixel right next to it, so any leftover wobble can't
 * make an edge look like a new bright spot.
 */

/** Pixels analysed per frame. Parameters below are tuned for this size. */
export const PIXEL_BUDGET = 640 * 360;

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
  return Math.sqrt((w * h) / PIXEL_BUDGET);
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
 * apart. Returns [{x, y, v}] in integer pixel coordinates.
 */
export function findPeaks(map, w, h, threshold, { border = 2, minDist = 6, max = 16 } = {}) {
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
  for (const p of found) {
    if (kept.length >= max) break;
    if (kept.every((k) => (k.x - p.x) ** 2 + (k.y - p.y) ** 2 >= minD2)) kept.push(p);
  }
  return kept;
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

/** out(x, y) = src(x + dx, y + dy), repeating edge pixels. */
function shiftInto(src, w, h, dx, dy, out) {
  for (let y = 0; y < h; y++) {
    let sy = y + dy;
    sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
    const ro = y * w;
    const rs = sy * w;
    for (let x = 0; x < w; x++) {
      let sx = x + dx;
      sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
      out[ro + x] = src[rs + sx];
    }
  }
}

/** 3×3 maximum filter ("dilate"). */
function dilate3(src, w, h, out, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[row + (x > 0 ? x - 1 : 0)];
      const c = src[row + x];
      const r = src[row + (x < w - 1 ? x + 1 : x)];
      tmp[row + x] = l > c ? (l > r ? l : r) : c > r ? c : r;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const row = y * w;
    const dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const u = tmp[up + x];
      const c = tmp[row + x];
      const d = tmp[dn + x];
      out[row + x] = u > c ? (u > d ? u : d) : c > d ? c : d;
    }
  }
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
    /** Furthest the picture may move between two frames and still line up. */
    this.maxShift = options.maxShift ?? Math.max(4, Math.round(24 * s));
    const n = w * h;
    /** How much more than its surroundings each pixel brightened (log ratio). */
    this.ratio = new Float32Array(n);
    /** How many brightness levels each pixel gained. */
    this.gain = new Float32Array(n);
    /** Final per-pixel score; the "glow map" view draws this. */
    this.score = new Float32Array(n);
    this.threshold = Infinity;
    /** Picture movement found by the last process() call, in pixels. */
    this.motion = { before: { dx: 0, dy: 0 }, after: { dx: 0, dy: 0 } };
    this._base = new Float32Array(n);
    this._blur = new Float32Array(n);
    this._tmp = new Float32Array(n);
    this._tmp2 = new Float32Array(n);
    this._hpOn = new Float32Array(n);
    this._hpOff = new Float32Array(n);
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

  /** How far `off` has moved relative to the ON frame (coarse, then fine). */
  _shiftTo(off) {
    const { w, h } = this;
    this._alignable(off, this._hpOff, this._cOff);
    const coarseRange = Math.ceil(this.maxShift / COARSE);
    const c = bestShift(this._cOn, this._cOff, this._cw, this._ch, 0, 0, coarseRange);
    return bestShift(this._hpOn, this._hpOff, w, h, c.dx * COARSE, c.dy * COARSE, COARSE - 1, 2);
  }

  process(on, offBefore, offAfter = offBefore) {
    const { w, h, ratio, gain, score } = this;
    const base = this._base;
    const blur = this._blur;
    const tmp = this._tmp;
    const tmp2 = this._tmp2;
    const n = w * h;
    const t = clamp01(this.sensitivity);
    const minGain = lerp(32, 12, t); // brightness levels a glint must gain
    const minRatio = lerp(0.55, 0.22, t); // ≈1.7× … 1.25× brighter than surroundings
    const noiseK = lerp(12, 5, t);

    // Line both OFF frames up with the ON frame, then take the brightest OFF
    // value around each pixel as the "before" brightness.
    this._alignable(on, this._hpOn, this._cOn);
    const before = this._shiftTo(offBefore);
    const after = offAfter === offBefore ? before : this._shiftTo(offAfter);
    this.motion = { before, after };
    shiftInto(offBefore, w, h, before.dx, before.dy, tmp2);
    dilate3(tmp2, w, h, base, tmp);
    shiftInto(offAfter, w, h, after.dx, after.dy, tmp2);
    dilate3(tmp2, w, h, blur, tmp);
    for (let i = 0; i < n; i++) if (blur[i] > base[i]) base[i] = blur[i];

    for (let i = 0; i < n; i++) {
      gain[i] = on[i] - base[i];
      ratio[i] = Math.log((on[i] + 8) / (base[i] + 8));
    }
    // Remove the broad wash of the flash and any auto-exposure shift. (`gain`
    // stays raw: it only guards against noise in near-black pixels, where a
    // tiny change is a big ratio.)
    subtractLocalMean(ratio, w, h, this.hatRadius, blur, tmp);

    // Noise level, measured where the image is bright enough to be meaningful.
    const noise = medianAbs(ratio, { mask: base, maskMin: 24 });
    const threshold = Math.max(minRatio, noise * noiseK);

    for (let i = 0; i < n; i++) score[i] = gain[i] > minGain && ratio[i] > 0 ? ratio[i] : 0;

    // Near the frame edges the shifted frames have no real data.
    const moved = Math.max(Math.abs(before.dx), Math.abs(before.dy), Math.abs(after.dx), Math.abs(after.dy));
    const border = Math.max(2, moved + 2);
    const peaks = [];
    const candidates = findPeaks(score, w, h, threshold, { border, minDist: this.spotRadius * 2, max: 24 });
    for (const p of candidates) {
      // A pinhole lens is a small round spot. Lines and patches are not.
      const c = smallSpotCenter(ratio, w, h, p.x, p.y, this.spotRadius, p.v * 0.5);
      if (c) peaks.push({ x: c.x, y: c.y, strength: p.v / threshold });
    }
    this.threshold = threshold;
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

    const peaks = [];
    const candidates = findPeaks(score, w, h, threshold, { minDist: this.spotRadius * 2, max: 24 });
    for (const p of candidates) {
      const c = smallSpotCenter(contrast, w, h, p.x, p.y, this.spotRadius, p.v * 0.5);
      if (c) peaks.push({ x: c.x, y: c.y, strength: p.v / threshold });
    }
    this.threshold = threshold;
    return { peaks, threshold, noise };
  }
}

/**
 * Keeps detections steady across frames. A spot only counts as "confirmed"
 * after it shows up in the same place `confirmHits` times, which filters out
 * one-off flickers. It is dropped after `maxMisses` updates without a match.
 */
export class Tracker {
  constructor({ matchRadius = 15, maxMisses = 2, confirmHits = 2, maxTracks = 12 } = {}) {
    this.opts = { matchRadius, maxMisses, confirmHits, maxTracks };
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
  }

  /** `peaks` should be sorted strongest first (as the detectors return them). */
  update(peaks) {
    const { matchRadius, maxMisses, confirmHits, maxTracks } = this.opts;
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
        if (best.hits >= confirmHits) best.confirmed = true;
      } else {
        born.push({
          id: this.nextId++,
          x: p.x,
          y: p.y,
          hits: 1,
          misses: 0,
          strength: p.strength,
          confirmed: confirmHits <= 1,
        });
      }
    }
    for (const t of unmatched) t.misses++;

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
