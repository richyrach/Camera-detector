import { FlashDetector, SpotDetector, Tracker, analysisSize, brightnessFromRGBA } from './detector.js';

/** Wait after switching the flashlight before grabbing a frame. Each on/off
 *  phase lasts at least this long, which also caps the blink rate at
 *  ~2.5 flashes per second, below the range most likely to affect people
 *  with photosensitivity. */
const SETTLE_MS = 250;
/** Spot scan (no flashlight control) analyses about 9 frames per second. */
const SPOT_INTERVAL_MS = 110;
/** Never wait longer than this for a new video frame. */
const FRAME_TIMEOUT_MS = 300;
const PREFS_KEY = 'camera-detector:prefs';
const ALERT = '#ff3d5a';
const WARN = 'rgba(255, 181, 71, 0.85)';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  video: $('video'),
  overlay: $('overlay'),
  status: $('status'),
  statusText: $('status-text'),
  count: $('count'),
  hint: $('hint'),
  start: $('start'),
  startLabel: $('start-label'),
  flip: $('flip'),
  snap: $('snap'),
  sensitivity: $('sensitivity'),
  intro: $('intro'),
  introStart: $('intro-start'),
  help: $('help'),
  helpOpen: $('help-open'),
  helpClose: $('help-close'),
  optFlash: $('opt-flash'),
  optSound: $('opt-sound'),
  saveCapture: $('save-capture'),
  toast: $('toast'),
};
const viewButtons = [...document.querySelectorAll('[data-view]')].filter((b) => b.tagName === 'BUTTON');
/** Set when running inside the Android app (see android/…/MainActivity.java). */
const android = window.AndroidBridge ?? null;

const prefs = loadPrefs();
const state = {
  stream: null,
  track: null,
  facing: 'environment',
  mirrored: false,
  torchSupported: false,
  torch: false,
  torchDeviceId: null,
  probedTorch: false,
  running: false,
  starting: false,
  runId: 0,
  mode: null, // 'flash' | 'spot' while running
  view: ['normal', 'red', 'heat'].includes(prefs.view) ? prefs.view : 'normal',
  sensitivity: typeof prefs.sensitivity === 'number' ? prefs.sensitivity : 0.5,
  sound: prefs.sound === true,
  allowFlash: prefs.flash !== false,
  analysis: null,
  tracker: new Tracker(),
  /** Exposure/white balance held steady while flash scanning (if supported). */
  lock: null,
  lockLevel: 0,
  /** The last OFF/ON/OFF frames, for "Save test capture". */
  lastCapture: null,
  tracks: [],
  announced: new Set(),
  heatReady: false,
  wakeLock: null,
  reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
};
const overlayCtx = els.overlay.getContext('2d');

/* ── Preferences ───────────────────────────────────────────── */

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        view: state.view,
        sensitivity: state.sensitivity,
        sound: state.sound,
        flash: state.allowFlash,
      }),
    );
  } catch {
    /* storage unavailable (private mode etc.) — preferences just won't stick */
  }
}

/* ── Small helpers ─────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when the video has a new frame (or after a timeout, so a paused
 *  video can never stall the scan loop). */
function nextFrame() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (els.video.requestVideoFrameCallback) els.video.requestVideoFrameCallback(done);
    else requestAnimationFrame(done);
  });
}

let toastTimer = 0;
function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

/* ── Camera ────────────────────────────────────────────────── */

function cameraError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

function getStream(video) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...video },
  });
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Some phones only report the torch a moment after the camera starts. */
async function hasTorch(track, tries = 4) {
  for (let i = 0; i < tries; i++) {
    if (!track || track.readyState !== 'live') return false;
    const caps = track.getCapabilities?.() ?? {};
    if (caps.torch) return true;
    await sleep(180);
  }
  return false;
}

/** Phones with several rear cameras sometimes open one without a flash.
 *  Try the other rear cameras once, and remember the one that has it. */
async function findTorchCamera(skipId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const candidates = devices.filter(
    (d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== skipId && !/front|user|face/i.test(d.label),
  );
  for (const device of candidates.slice(0, 4)) {
    let stream;
    try {
      stream = await getStream({ deviceId: { exact: device.deviceId } });
    } catch {
      continue;
    }
    if (await hasTorch(stream.getVideoTracks()[0], 3)) return stream;
    stopStream(stream);
  }
  return null;
}

async function attach(stream) {
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.torch = false;
  const settings = state.track.getSettings?.() ?? {};
  state.mirrored = settings.facingMode ? settings.facingMode === 'user' : state.facing === 'user';
  els.stage.classList.toggle('mirrored', state.mirrored);
  els.video.srcObject = stream;
  await els.video.play().catch(() => {});
  if (!els.video.videoWidth) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      els.video.addEventListener(
        'loadedmetadata',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  setupAnalysis();
  state.track.addEventListener('ended', () => {
    if (state.track?.readyState === 'ended') {
      stopScan();
      setStatus('idle', 'Camera stopped');
    }
  });
}

async function openCamera() {
  closeCamera();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw cameraError('InsecureContext', 'Camera needs a secure (https) page');
  }
  const preferred =
    state.facing === 'environment' && state.torchDeviceId
      ? { deviceId: { exact: state.torchDeviceId } }
      : { facingMode: { ideal: state.facing } };
  let stream;
  try {
    stream = await getStream(preferred);
  } catch (err) {
    if (!preferred.deviceId) throw err;
    state.torchDeviceId = null;
    stream = await getStream({ facingMode: { ideal: state.facing } });
  }
  await attach(stream);

  let torch = await hasTorch(state.track);
  if (!torch && state.facing === 'environment' && !state.probedTorch) {
    state.probedTorch = true;
    const currentId = state.track.getSettings?.().deviceId;
    closeCamera(); // most phones can't open two cameras at once
    const alt = await findTorchCamera(currentId).catch(() => null);
    await attach(alt ?? (await getStream({ facingMode: { ideal: 'environment' } })));
    torch = Boolean(alt);
    if (alt) state.torchDeviceId = state.track.getSettings?.().deviceId ?? null;
  }
  state.torchSupported = torch;
}

function closeCamera() {
  stopStream(state.stream);
  state.stream = null;
  state.track = null;
  state.torch = false;
  els.video.srcObject = null;
}

/** Flashlight calls are queued so they always apply in order. */
let torchQueue = Promise.resolve();
function setTorch(on) {
  const apply = async () => {
    const track = state.track;
    if (!track || track.readyState !== 'live') {
      state.torch = false;
      return;
    }
    if (state.torch === on || (on && !state.torchSupported)) return;
    // Repeat the exposure lock with every flash change: some browsers reset
    // settings that aren't mentioned.
    await track.applyConstraints({ advanced: [{ torch: on, ...(state.lock ?? {}) }] });
    const reported = track.getSettings?.().torch;
    if (state.lock && typeof reported === 'boolean' && reported !== on) {
      // The browser ignored the combined request: drop the lock, keep the flash.
      state.lock = null;
      await track.applyConstraints({ advanced: [{ torch: on }] });
    }
    state.torch = on;
  };
  const result = torchQueue.then(apply, apply);
  torchQueue = result.catch(() => {});
  return result;
}

/**
 * Hold exposure and white balance where they are, so the camera doesn't
 * re-adjust every time the flash fires (that makes ordinary details look like
 * they lit up). Only on phones and browsers that support it; otherwise the
 * detector copes without.
 */
async function lockExposure(level) {
  const track = state.track;
  if (!track?.getCapabilities) return;
  const caps = track.getCapabilities() ?? {};
  const now = track.getSettings?.() ?? {};
  const lock = {};
  if (caps.exposureMode?.includes?.('manual') && typeof now.exposureTime === 'number') {
    lock.exposureMode = 'manual';
    lock.exposureTime = now.exposureTime;
    if (caps.iso && typeof now.iso === 'number') lock.iso = now.iso;
  }
  if (caps.whiteBalanceMode?.includes?.('manual') && typeof now.colorTemperature === 'number') {
    lock.whiteBalanceMode = 'manual';
    lock.colorTemperature = now.colorTemperature;
  }
  if (!Object.keys(lock).length) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: false, ...lock }] });
    state.lock = lock;
    state.lockLevel = level;
  } catch {
    state.lock = null;
  }
}

async function unlockExposure() {
  const lock = state.lock;
  state.lock = null;
  if (!lock || state.track?.readyState !== 'live') return;
  const auto = {};
  if (lock.exposureMode) auto.exposureMode = 'continuous';
  if (lock.whiteBalanceMode) auto.whiteBalanceMode = 'continuous';
  await state.track.applyConstraints({ advanced: [{ torch: state.torch, ...auto }] }).catch(() => {});
}

/** Average brightness of a frame (sampled). */
function meanLevel(buf) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 61) {
    sum += buf[i];
    n++;
  }
  return n ? sum / n : 0;
}

/* ── Analysis buffers ──────────────────────────────────────── */

function setupAnalysis() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return;
  const { width: W, height: H } = analysisSize(vw, vh);
  const A = state.analysis;
  if (A && A.W === W && A.H === H) return;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const heatCanvas = document.createElement('canvas');
  heatCanvas.width = W;
  heatCanvas.height = H;
  const heatCtx = heatCanvas.getContext('2d');
  const n = W * H;
  state.analysis = {
    W,
    H,
    ctx,
    on: new Float32Array(n),
    offA: new Float32Array(n),
    offB: new Float32Array(n),
    flash: new FlashDetector(W, H, { sensitivity: state.sensitivity }),
    spot: new SpotDetector(W, H, { sensitivity: state.sensitivity }),
    heatCanvas,
    heatCtx,
    heatImage: heatCtx.createImageData(W, H),
    /** Latest colour frame behind each brightness buffer. */
    rgba: new Map(),
  };
  state.tracks = [];
  state.heatReady = false;
}

function grab(A, out) {
  A.ctx.drawImage(els.video, 0, 0, A.W, A.H);
  const img = A.ctx.getImageData(0, 0, A.W, A.H);
  A.rgba.set(out, img);
  brightnessFromRGBA(img.data, out);
}

/* ── Scanning ──────────────────────────────────────────────── */

async function startScan() {
  if (state.running || state.starting) return;
  state.starting = true;
  els.start.disabled = true;
  setStatus('starting', 'Starting camera…');
  showHint(null);
  try {
    if (!state.track || state.track.readyState !== 'live') await openCamera();
  } catch (err) {
    showCameraError(err);
    return;
  } finally {
    state.starting = false;
    els.start.disabled = false;
  }
  if (!state.analysis) {
    showCameraError(cameraError('NoVideo', 'The camera did not send any video'));
    return;
  }
  if (state.sound) unlockAudio();

  const mode = state.torchSupported && state.allowFlash ? 'flash' : 'spot';
  const A = state.analysis;
  const radius = A.flash.spotRadius * 3;
  // Flash scan: a spot must show up on 3 of the last 4 flashes.
  state.tracker =
    mode === 'flash'
      ? new Tracker({ matchRadius: radius, confirmHits: 3, window: 4, maxMisses: 2 })
      : new Tracker({ matchRadius: radius, confirmHits: 3, maxMisses: 4 });
  state.lastCapture = null;
  state.mode = mode;
  state.running = true;
  state.tracks = [];
  state.announced.clear();
  state.heatReady = false;
  const id = ++state.runId;
  updateUI();
  requestWakeLock();
  if (mode === 'flash') flashLoop(id);
  else spotLoop(id);
}

async function stopScan() {
  if (!state.running) return;
  state.running = false;
  state.runId++;
  state.mode = null;
  state.tracks = [];
  releaseWakeLock();
  updateUI();
  await setTorch(false).catch(() => {});
  await unlockExposure();
}

/**
 * Flash scan: OFF, ON, OFF, ON, … Each ON frame is compared with the OFF
 * frames on either side of it, so steady movement cancels out too.
 */
async function flashLoop(id) {
  const alive = () => state.running && state.runId === id;
  let A = null;
  let prevOff = null;
  try {
    while (alive()) {
      if (A !== state.analysis) {
        // The video size changed (phone rotated): start over with new buffers.
        A = state.analysis;
        prevOff = null;
        state.tracker.reset();
      }
      if (!prevOff) {
        await setTorch(false);
        await sleep(SETTLE_MS);
        await nextFrame();
        if (!alive() || A !== state.analysis) continue;
        grab(A, A.offA);
        prevOff = A.offA;
        if (!state.lock) await lockExposure(meanLevel(A.offA));
      }
      await setTorch(true);
      await sleep(SETTLE_MS);
      await nextFrame();
      if (!alive() || A !== state.analysis) continue;
      grab(A, A.on);

      await setTorch(false);
      await sleep(SETTLE_MS);
      await nextFrame();
      if (!alive() || A !== state.analysis) continue;
      const off = prevOff === A.offA ? A.offB : A.offA;
      grab(A, off);

      A.flash.sensitivity = state.sensitivity;
      handleResult(A, A.flash.process(A.on, prevOff, off), A.flash);
      state.lastCapture = { W: A.W, H: A.H, frames: [A.rgba.get(prevOff), A.rgba.get(A.on), A.rgba.get(off)] };
      prevOff = off;

      // Pointed somewhere much brighter or darker since exposure was locked:
      // let the camera re-adjust, then lock again.
      if (state.lock) {
        const level = meanLevel(off);
        if (level > state.lockLevel * 2.2 || level < state.lockLevel / 2.2 || level > 235) {
          await unlockExposure();
          await sleep(700);
          prevOff = null;
        }
      }
    }
  } catch (err) {
    console.warn('Flash scan stopped:', err);
    if (alive()) {
      state.torchSupported = false;
      await setTorch(false).catch(() => {});
      toast("Couldn't control the flashlight, so switched to Spot scan.");
      state.mode = 'spot';
      await unlockExposure();
      state.tracker = new Tracker({ matchRadius: state.analysis.spot.spotRadius * 3, confirmHits: 3, maxMisses: 4 });
      state.tracks = [];
      updateUI();
      spotLoop(id);
      return;
    }
  }
  await setTorch(false).catch(() => {});
}

/** Spot scan: one frame at a time, looking for tiny bright points. */
async function spotLoop(id) {
  const alive = () => state.running && state.runId === id;
  let A = null;
  while (alive()) {
    await nextFrame();
    if (!alive()) break;
    if (A !== state.analysis) {
      A = state.analysis;
      state.tracker.reset();
    }
    grab(A, A.on);
    A.spot.sensitivity = state.sensitivity;
    handleResult(A, A.spot.process(A.on), A.spot);
    await sleep(SPOT_INTERVAL_MS);
  }
}

function handleResult(A, result, detector) {
  state.tracks = state.tracker.update(result.peaks);
  if (state.view === 'heat') paintHeat(A, detector.score, result.threshold);
  let fresh = false;
  for (const t of state.tracks) {
    if (t.confirmed && !state.announced.has(t.id)) {
      state.announced.add(t.id);
      fresh = true;
    }
  }
  if (fresh) notifyFound();
  updateCount();
}

/** Colour the score map: faint red below the threshold, yellow-white above. */
function paintHeat(A, score, threshold) {
  const data = A.heatImage.data;
  const inv = 1 / threshold;
  for (let i = 0, j = 0; i < score.length; i++, j += 4) {
    const v = score[i] * inv;
    if (v < 0.2) {
      data[j + 3] = 0;
      continue;
    }
    data[j] = 255;
    data[j + 1] = v > 1 ? Math.min(255, 110 + 145 * (v - 1)) : 40 * v;
    data[j + 2] = v > 2 ? Math.min(255, 120 * (v - 2)) : 30;
    data[j + 3] = Math.min(255, 255 * v);
  }
  A.heatCtx.putImageData(A.heatImage, 0, 0);
  state.heatReady = true;
}

/* ── Alerts ────────────────────────────────────────────────── */

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1320, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.22);
}

function notifyFound() {
  try {
    navigator.vibrate?.([40, 60, 40]);
  } catch {
    /* not supported */
  }
  if (state.sound) beep();
}

/* ── Screen wake lock (keeps the screen on while scanning) ── */

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

/* ── Drawing ───────────────────────────────────────────────── */

function viewTransform(cw, ch, A) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const s = Math.max(cw / vw, ch / vh); // matches object-fit: cover
  const dw = vw * s;
  const dh = vh * s;
  return { cw, ch, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2, kx: dw / A.W, ky: dh / A.H };
}

function toScreen(T, ax, ay) {
  const x = T.ox + (ax + 0.5) * T.kx;
  return { x: state.mirrored ? T.cw - x : x, y: T.oy + (ay + 0.5) * T.ky };
}

function render(now) {
  requestAnimationFrame(render);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = els.stage.clientWidth;
  const ch = els.stage.clientHeight;
  const pw = Math.round(cw * dpr);
  const ph = Math.round(ch * dpr);
  if (els.overlay.width !== pw || els.overlay.height !== ph) {
    els.overlay.width = pw;
    els.overlay.height = ph;
  }
  const ctx = overlayCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const A = state.analysis;
  if (!A || !els.video.videoWidth || !state.running) return;
  const T = viewTransform(cw, ch, A);

  if (state.view === 'heat' && state.heatReady) {
    ctx.save();
    if (state.mirrored) {
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(A.heatCanvas, T.ox, T.oy, T.dw, T.dh);
    ctx.restore();
  }
  if (!state.reducedMotion) drawSweep(ctx, cw, ch, now);
  if (state.tracks.length) {
    // Keep marker labels clear of the status bar and notices at the top.
    const topmost = !els.hint.hidden ? els.hint : !els.count.hidden ? els.count : els.status;
    T.labelTop = topmost.getBoundingClientRect().bottom + 6;
  }
  for (const t of state.tracks) if (!t.confirmed) drawMarker(ctx, T, t, now, false);
  // Strongest first; only the strongest gets a label, to keep the view readable.
  const confirmed = state.tracks.filter((t) => t.confirmed).sort((a, b) => b.strength - a.strength);
  confirmed.slice(0, 4).forEach((t, i) => drawMarker(ctx, T, t, now, i === 0));
}

function drawSweep(ctx, cw, ch, now) {
  const y = ((now % 2800) / 2800) * ch;
  const g = ctx.createLinearGradient(0, y - 70, 0, y);
  const color = state.mode === 'flash' ? '62, 224, 180' : '255, 181, 71';
  g.addColorStop(0, `rgba(${color}, 0)`);
  g.addColorStop(1, `rgba(${color}, 0.10)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 70, cw, 70);
  ctx.fillStyle = `rgba(${color}, 0.35)`;
  ctx.fillRect(0, y - 1, cw, 1);
}

function drawMarker(ctx, T, t, now, withLabel) {
  const { x, y } = toScreen(T, t.x, t.y);
  if (!t.confirmed) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = WARN;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const pulse = state.reducedMotion ? 0.5 : (Math.sin(now / 170) + 1) / 2;
  const r = 20 + pulse * 5;
  // Red markers vanish on the red-filter view, so use white there.
  const color = state.view === 'red' ? '#ffffff' : ALERT;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  // crosshair ticks
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.moveTo(x + dx * (r - 6), y + dy * (r - 6));
    ctx.lineTo(x + dx * (r + 6), y + dy * (r + 6));
  }
  ctx.stroke();
  ctx.globalAlpha = 0.45 * (1 - pulse);
  ctx.beginPath();
  ctx.arc(x, y, r + 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (!withLabel) return;
  const label = state.mode === 'flash' ? 'Possible lens' : 'Bright spot';
  ctx.save();
  ctx.font = '700 12px system-ui, -apple-system, sans-serif';
  const tw = ctx.measureText(label).width;
  const bw = tw + 16;
  const bh = 22;
  let bx = x - bw / 2;
  bx = Math.max(8, Math.min(T.cw - bw - 8, bx));
  const by = y - r - bh - 12 > (T.labelTop ?? 8) ? y - r - bh - 12 : y + r + 12;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 11);
  else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.fillStyle = state.view === 'red' ? '#8a0016' : '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + 8, by + bh / 2 + 0.5);
  ctx.restore();
}

/* ── Snapshot ──────────────────────────────────────────────── */

async function snapshot() {
  const v = els.video;
  const A = state.analysis;
  if (!v.videoWidth || !A || !state.stream) {
    toast('Start a scan first.');
    return;
  }
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const c = document.createElement('canvas');
  c.width = vw;
  c.height = vh;
  const ctx = c.getContext('2d');
  ctx.save();
  if (state.mirrored) {
    ctx.translate(vw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(v, 0, 0, vw, vh);
  ctx.restore();

  const k = vw / A.W;
  const r = Math.max(14, vw / 40);
  ctx.lineWidth = Math.max(3, vw / 320);
  ctx.strokeStyle = ALERT;
  for (const t of state.tracks.filter((t) => t.confirmed)) {
    let x = (t.x + 0.5) * k;
    if (state.mirrored) x = vw - x;
    const y = (t.y + 0.5) * (vh / A.H);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const stamp = new Date();
  ctx.font = `600 ${Math.round(vw / 45)}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  const text = `Camera Detector · ${stamp.toLocaleString()}`;
  const pad = vw / 80;
  const tw = ctx.measureText(text).width;
  ctx.fillRect(pad, vh - pad * 2 - vw / 45, tw + pad * 2, vw / 45 + pad * 1.5);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, pad * 2, vh - pad * 1.2);

  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) {
    toast("Couldn't save the snapshot.");
    return;
  }
  const name = `camera-scan-${stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
  if (android?.saveImage) {
    const base64 = c.toDataURL('image/jpeg', 0.92).split(',')[1];
    toast(android.saveImage(base64, name) ? 'Saved to Photos (Pictures/Camera Detector).' : "Couldn't save the snapshot.");
    return;
  }
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Camera scan' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  downloadBlob(blob, name);
  toast('Snapshot saved.');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Saves the last flash-OFF, flash-ON and flash-OFF frames side by side as one
 * lossless PNG, exactly as the detector saw them, so a missed camera or a
 * false alarm can be reproduced and tuned for.
 */
async function saveCapture() {
  const cap = state.lastCapture;
  if (!cap || cap.frames.some((f) => !f)) {
    toast('Start a Flash scan first, then try again.');
    return;
  }
  const c = document.createElement('canvas');
  c.width = cap.W * 3;
  c.height = cap.H;
  const ctx = c.getContext('2d');
  cap.frames.forEach((img, i) => ctx.putImageData(img, i * cap.W, 0));
  const name = `camera-detector-test-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  if (android?.saveFile) {
    const ok = android.saveFile(c.toDataURL('image/png').split(',')[1], name, 'image/png');
    toast(ok ? 'Test capture saved to Photos.' : "Couldn't save the test capture.");
    return;
  }
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  if (!blob) {
    toast("Couldn't save the test capture.");
    return;
  }
  downloadBlob(blob, name);
  toast('Test capture saved to Downloads.');
}

/* ── UI state ──────────────────────────────────────────────── */

function setStatus(mode, text) {
  els.status.dataset.mode = mode;
  els.statusText.textContent = text;
}

let hintTimer = 0;
function showHint(message, tone = 'info') {
  clearTimeout(hintTimer);
  els.hint.hidden = !message;
  els.hint.textContent = message ?? '';
  els.hint.dataset.tone = tone;
  // Tips get out of the way after a while; errors stay until dealt with.
  if (message && tone !== 'error') hintTimer = setTimeout(() => (els.hint.hidden = true), 9000);
}

function updateUI() {
  els.start.setAttribute('aria-pressed', String(state.running));
  els.startLabel.textContent = state.running ? 'Stop' : 'Scan';
  els.start.setAttribute('aria-label', state.running ? 'Stop scanning' : 'Start scanning');
  if (state.running && state.mode === 'flash') {
    setStatus('flash', 'Flash scan');
    showHint(null);
  } else if (state.running && state.mode === 'spot') {
    setStatus('spot', state.facing === 'user' ? 'Spot scan · front camera' : 'Spot scan');
    if (state.facing === 'user') {
      showHint('Night-vision check: turn the lights off and look for small purple or white glowing dots.');
    } else if (!state.allowFlash) {
      showHint('Flashlight blinking is off, so this looks for tiny bright points. Turn it back on under the ? button for the best results.');
    } else {
      showHint("This browser can't blink your flashlight, so this looks for tiny bright points instead. Hold a light right beside the camera for best results.");
    }
  } else if (!state.starting && els.status.dataset.mode !== 'error') {
    setStatus('idle', state.stream ? 'Paused' : 'Ready');
  }
  updateCount();
}

function updateCount() {
  if (!state.running) {
    els.count.hidden = true;
    return;
  }
  const found = state.tracks.filter((t) => t.confirmed).length;
  const noun = state.mode === 'flash' ? ['possible lens', 'possible lenses'] : ['bright spot', 'bright spots'];
  els.count.hidden = false;
  els.count.dataset.found = String(found > 0);
  els.count.textContent =
    found === 0
      ? state.mode === 'flash'
        ? 'Scanning… sweep slowly'
        : 'Scanning…'
      : `${found} ${found === 1 ? noun[0] : noun[1]}`;
}

function showCameraError(err) {
  const blocked = android
    ? 'Camera access was blocked. Allow it in Android Settings → Apps → Camera Detector → Permissions, then tap Scan again.'
    : 'Camera access was blocked. Allow the camera for this site in your browser settings, then tap Scan again.';
  const messages = {
    NotAllowedError: blocked,
    SecurityError: blocked,
    NotFoundError: 'No camera was found on this device.',
    OverconstrainedError: 'No camera was found on this device.',
    NotReadableError: 'The camera is being used by another app. Close it and tap Scan again.',
    InsecureContext: 'The camera only works on a secure page. Open the app from its https:// link.',
  };
  console.warn('Camera error:', err);
  setStatus('error', 'Camera unavailable');
  showHint(messages[err?.name] ?? `Couldn't start the camera: ${err?.message ?? err}`, 'error');
}

function setView(view) {
  state.view = view;
  els.stage.dataset.view = view;
  for (const b of viewButtons) b.setAttribute('aria-checked', String(b.dataset.view === view));
  state.heatReady = false;
  savePrefs();
}

async function flipCamera() {
  const wasRunning = state.running;
  await stopScan();
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  els.flip.disabled = true;
  try {
    setStatus('starting', 'Switching camera…');
    await openCamera();
    updateUI();
    if (wasRunning) await startScan();
  } catch (err) {
    showCameraError(err);
  } finally {
    els.flip.disabled = false;
  }
}

function openHelp() {
  els.help.hidden = false;
  els.helpClose.focus();
}

function closeHelp() {
  els.help.hidden = true;
  els.helpOpen.focus();
}

/** The Android app's back button: close the help sheet first. */
window.cameraDetectorBack = () => {
  if (els.help.hidden) return false;
  closeHelp();
  return true;
};

/* ── Wiring ────────────────────────────────────────────────── */

els.introStart.addEventListener('click', () => {
  els.intro.hidden = true;
  startScan();
});

els.start.addEventListener('click', () => {
  els.intro.hidden = true;
  if (state.running) stopScan();
  else startScan();
});

els.flip.addEventListener('click', flipCamera);
els.saveCapture.addEventListener('click', saveCapture);
els.snap.addEventListener('click', snapshot);

for (const b of viewButtons) b.addEventListener('click', () => setView(b.dataset.view));

els.sensitivity.value = String(Math.round(state.sensitivity * 100));
els.sensitivity.addEventListener('input', () => {
  state.sensitivity = Number(els.sensitivity.value) / 100;
  savePrefs();
});

els.optFlash.checked = state.allowFlash;
els.optFlash.addEventListener('change', async () => {
  state.allowFlash = els.optFlash.checked;
  savePrefs();
  if (state.running) {
    await stopScan();
    startScan();
  }
});

els.optSound.checked = state.sound;
els.optSound.addEventListener('change', () => {
  state.sound = els.optSound.checked;
  savePrefs();
  if (state.sound) {
    unlockAudio();
    beep();
  }
});

els.hint.addEventListener('click', () => {
  if (els.hint.dataset.tone !== 'error') els.hint.hidden = true;
});

els.helpOpen.addEventListener('click', openHelp);
els.helpClose.addEventListener('click', closeHelp);
els.help.addEventListener('click', (e) => {
  if (e.target === els.help) closeHelp();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.help.hidden) closeHelp();
});

els.video.addEventListener('resize', () => {
  setupAnalysis();
});

// Leaving the app: stop the flashlight and release the camera.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (state.running || state.stream)) {
    stopScan();
    closeCamera();
    setStatus('idle', 'Paused');
  }
});

setView(state.view);
updateUI();
requestAnimationFrame(render);

if (android) {
  // Already an app: hide "get the app" links. No offline cache needed either,
  // since the files are bundled inside the app.
  for (const el of document.querySelectorAll('.web-only')) el.hidden = true;
} else if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Read-only hook used by the automated browser tests.
Object.defineProperty(window, '__cameraDetector', {
  value: Object.freeze({
    snapshot() {
      const A = state.analysis;
      return {
        running: state.running,
        mode: state.mode,
        torch: state.torch,
        torchSupported: state.torchSupported,
        status: els.statusText.textContent,
        locked: Boolean(state.lock),
        stats: state.mode && A ? { ...(state.mode === 'flash' ? A.flash : A.spot).stats } : null,
        hasCapture: Boolean(state.lastCapture),
        tracks: A
          ? state.tracks.map((t) => ({ x: (t.x + 0.5) / A.W, y: (t.y + 0.5) / A.H, confirmed: t.confirmed, hits: t.hits }))
          : [],
      };
    },
  }),
});
