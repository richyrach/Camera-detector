/**
 * A harder synthetic test scene, modelled on a real phone screenshot that
 * produced lots of false alarms: a laptop keyboard (bright key letters on dark
 * keys, glossy keycaps that throw back little flash highlights), a glowing
 * laptop screen with moving video, a bright LED strip, and one small camera
 * lens in a dark housing.
 *
 * Frames are rendered like a hand-held phone would see them: the picture
 * shifts, rotates and zooms slightly between frames, the camera re-adjusts
 * exposure and contrast when the flash fires, and there is sensor noise.
 */

const HI = 2; // render at 2× and average down, so edges land between pixels

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Scene description in output-pixel units (w × h). */
function layout(w, h, seed, glossy = true) {
  const rand = rng(seed);
  const keys = [];
  const kb = { x: w * 0.18, y: h * 0.6, cols: 13, rows: 4, size: w * 0.038, gap: w * 0.008 };
  for (let r = 0; r < kb.rows; r++) {
    for (let c = 0; c < kb.cols; c++) {
      const x = kb.x + c * (kb.size + kb.gap);
      const y = kb.y + r * (kb.size + kb.gap);
      keys.push({
        x,
        y,
        // letter position inside the key
        lx: x + kb.size * (0.3 + 0.4 * rand()),
        ly: y + kb.size * (0.3 + 0.4 * rand()),
        // glossy keycap highlight (only when the flash is on)
        shine: glossy && rand() < 0.45 ? { x: x + kb.size * (0.2 + 0.6 * rand()), y: y + kb.size * 0.25, k: 0.5 + 0.5 * rand() } : null,
      });
    }
  }
  return {
    keys,
    kb,
    screen: { x: w * 0.2, y: h * 0.18, w: w * 0.55, h: h * 0.36 },
    strip: { y: h * 0.06, x0: w * 0.1, x1: w * 0.9 },
    lens: { x: w * 0.47, y: h * 0.16 }, // top of the laptop bezel, like a webcam
  };
}

/**
 * Light leaving each scene point toward the camera, before the camera's own
 * processing. `flash` adds the phone's flashlight; `videoT` moves the video
 * shown on the laptop screen.
 */
function radiance(L, x, y, w, h, { flash, videoT }) {
  const ambient = 0.55;
  const torch = flash ? 0.25 : 0; // flash is weaker than the room lights at this distance
  // wall
  let albedo = 0.62 + 0.08 * Math.sin(x * 0.05) * Math.sin(y * 0.07);
  let emitted = 0;
  let extra = 0;

  const s = L.screen;
  const inScreen = x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
  // laptop bezel (dark) around the screen
  if (x >= s.x - 6 && x < s.x + s.w + 6 && y >= s.y - 8 && y < s.y + s.h + 4 && !inScreen) albedo = 0.08;
  if (inScreen) {
    albedo = 0.03;
    // a video call: soft blob that moves between frames, plus static UI text
    const bx = s.x + s.w * (0.5 + 0.08 * Math.sin(videoT));
    const by = s.y + s.h * 0.55;
    emitted = 0.25 + 0.45 * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (s.h * s.h * 0.04));
    if (Math.floor(y / 4) % 3 === 0 && (Math.floor(x / 3) % 4 !== 0) && x < s.x + s.w * 0.3) emitted += 0.35;
  }

  const kb = L.kb;
  for (const k of L.keys) {
    if (x >= k.x && x < k.x + kb.size && y >= k.y && y < k.y + kb.size) {
      albedo = 0.1;
      if (Math.abs(x - k.lx) < 1.2 && Math.abs(y - k.ly) < 1.2) albedo = 0.85; // key letter
      if (flash && k.shine && Math.abs(x - k.shine.x) < 0.9 && Math.abs(y - k.shine.y) < 0.9) extra += 3 * k.shine.k;
      break;
    }
  }

  // LED strip: very bright, always on
  if (Math.abs(y - L.strip.y) < 1.5 && x > L.strip.x0 && x < L.strip.x1) emitted += 3;

  // camera lens: dark hole in the bezel; retroreflects the flash
  const dl = (x - L.lens.x) ** 2 + (y - L.lens.y) ** 2;
  if (dl < 9) albedo = 0.03;
  if (flash && dl < 0.6) extra += L.glint;

  return albedo * (ambient + torch) + emitted + extra;
}

/** Camera processing: exposure, a tone curve, 8-bit clipping, noise. */
function develop(v, { gain, gamma }, noise) {
  const x = Math.max(0, v * gain);
  return Math.min(255, Math.max(0, 255 * Math.min(1, x) ** gamma + noise));
}

/**
 * One frame as the phone camera sees it.
 * pose: { dx, dy, rot (degrees), zoom } — how the phone has moved.
 */
function frame(L, w, h, { flash, pose, camera, videoT, seed }) {
  const rand = rng(seed);
  const out = new Float32Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const a = (pose.rot * Math.PI) / 180;
  const cos = Math.cos(a) / pose.zoom;
  const sin = Math.sin(a) / pose.zoom;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < HI; sy++) {
        for (let sx = 0; sx < HI; sx++) {
          // sensor position → scene position
          const px = x + (sx + 0.5) / HI - cx - pose.dx;
          const py = y + (sy + 0.5) / HI - cy - pose.dy;
          const qx = cx + px * cos - py * sin;
          const qy = cy + px * sin + py * cos;
          sum += radiance(L, qx, qy, w, h, { flash, videoT });
        }
      }
      const noise = (rand() + rand() + rand() - 1.5) * 2.5;
      out[y * w + x] = develop(sum / (HI * HI), camera, noise);
    }
  }
  return out;
}

/**
 * OFF, ON, OFF frames of the room plus where the lens is.
 * `shake` scales the hand movement; `autoExposure` makes the camera react to
 * the flash (darker, more contrast) like most phones do.
 */
export function roomTriple(w, h, { seed = 1, shake = 1, autoExposure = true, lens = true, glossy = true, glint = 4 } = {}) {
  const L = layout(w, h, seed, glossy);
  L.glint = glint;
  if (!lens) L.lens = { x: -100, y: -100 };
  const steady = { gain: 1, gamma: 1 / 1.25 };
  const flashCam = autoExposure ? { gain: 0.82, gamma: 1 / 1.1 } : steady;
  const pose = (dx, dy, rot, zoom) => ({ dx: dx * shake, dy: dy * shake, rot: rot * shake, zoom: 1 + (zoom - 1) * shake });
  return {
    offBefore: frame(L, w, h, { flash: false, pose: pose(-1.3, 0.8, -0.12, 0.998), camera: steady, videoT: 0, seed: seed * 7 + 1 }),
    on: frame(L, w, h, { flash: true, pose: pose(0, 0, 0, 1), camera: flashCam, videoT: 0.5, seed: seed * 7 + 2 }),
    offAfter: frame(L, w, h, { flash: false, pose: pose(1.6, -1.1, 0.15, 1.003), camera: steady, videoT: 1, seed: seed * 7 + 3 }),
    lens: lens ? { x: L.lens.x, y: L.lens.y } : null,
  };
}
