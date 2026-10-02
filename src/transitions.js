/* ===========================================================
   transitions.js
   The cues laid over section boundaries. Each one PEAKS at `peakTime`
   (an AudioContext time): it rises for `rise` seconds before the boundary
   and falls for `fall` seconds after it. Either side may be 0.

   Types
   -----
   swell    soft airy swell: stereo pink noise through a gently resonant
            low-pass sweep, with a quiet "sheen" band an octave up.
   reverse  a reversed snippet of your most recent take swelling into the
            boundary (falls back to `swell` before anything is recorded).
   chime    a synthesized bell: played backwards into the boundary, then
            struck forwards out of it.

   Every cue feeds `dest`, the engine's FX bus, which adds a shared reverb
   and goes straight to the limiter (it skips the music's drive stage, which
   is why the old white-noise whoosh came out so loud).

   Loudness: the three types are calibrated so that the same `volume`
   (0..1 slider) gives roughly the same perceived level. The slider is
   squared, so its lower half has finer control. Measured offline against
   an auto-maximized take (loudest 400 ms, RMS): the default 0.45 sits about
   15 dB under the music (the old whoosh sat ~6 dB under it); 1.0 is about
   as loud as the old whoosh was, or a bit louder.
   =========================================================== */

export const TRANSITION_TYPES = ['swell', 'reverse', 'chime'];

// Per-type trims so the slider means the same thing for every cue
// (measured by rendering each cue offline in Chromium).
const TRIM = { swell: 1.9, reverse: 1.42, chime: 0.9 };

const CURVE_POINTS = 128;
const SILENT = 0.0001;

/* ---------------- envelope helpers ---------------- */

// Ease-in swell from silence to `peak` (blooms near the boundary).
function riseCurve(peak) {
  const c = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = i / (CURVE_POINTS - 1);
    c[i] = Math.max(SILENT, peak * Math.pow(x, 2.2));
  }
  return c;
}

// Fast-then-slow decay from `peak` to silence after the boundary.
function fallCurve(peak) {
  const c = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = i / (CURVE_POINTS - 1);
    c[i] = Math.max(SILENT, peak * Math.pow(1 - x, 2.6));
  }
  return c;
}

// Apply rise -> peak -> fall to a gain param. start/peakTime/end are
// already clamped to the future by the caller.
// (No other automation shares a curve's time span — Safari throws if it does.)
function shapeGain(param, { start, peakTime, end, peak }) {
  const rise = peakTime - start;
  const fall = end - peakTime;
  if (rise > 0.005) param.setValueCurveAtTime(riseCurve(peak), start, rise);
  else param.setValueAtTime(peak, start);
  if (fall > 0.005) param.setValueCurveAtTime(fallCurve(peak), peakTime + 0.0001, fall - 0.0001);
}

/* ---------------- cached sources ---------------- */

const cache = new WeakMap(); // ctx -> { pink, bells: Map, reversed: WeakMap }
function store(ctx) {
  let s = cache.get(ctx);
  if (!s) { s = { pink: null, bells: new Map(), reversed: new WeakMap() }; cache.set(ctx, s); }
  return s;
}

// 3 s of decorrelated stereo pink noise (Paul Kellet's filter), peak-normalized.
function pinkNoise(ctx) {
  const s = store(ctx);
  if (s.pink) return s.pink;
  const len = Math.floor(ctx.sampleRate * 3);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, peak = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = b0 + b1 + b2 + w * 0.1848;
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
    for (let i = 0; i < len; i++) d[i] /= peak;
  }
  s.pink = buf;
  return buf;
}

// Synthesized bell (gently inharmonic partials, higher ones die faster).
// Stereo: each partial is panned slightly differently for width.
const BELL_F0 = 523.25; // C5
const BELL_PARTIALS = [
  { r: 1.0,  a: 1.0,  t: 1.0,  pan: 0 },
  { r: 2.0,  a: 0.45, t: 0.7,  pan: -0.3 },
  { r: 2.76, a: 0.3,  t: 0.5,  pan: 0.35 },
  { r: 4.07, a: 0.14, t: 0.32, pan: -0.2 },
  { r: 5.43, a: 0.07, t: 0.22, pan: 0.25 },
];
function bell(ctx, seconds) {
  const s = store(ctx);
  const key = Math.round(seconds * 100);
  if (s.bells.has(key)) return s.bells.get(key);
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const tau = Math.max(0.4, seconds * 0.45);
  const attack = Math.floor(sr * 0.004);
  for (const p of BELL_PARTIALS) {
    const w = 2 * Math.PI * BELL_F0 * p.r / sr;
    const decay = Math.exp(-1 / (sr * tau * p.t));
    const gl = p.a * Math.cos((p.pan + 1) * Math.PI / 4);
    const gr = p.a * Math.sin((p.pan + 1) * Math.PI / 4);
    let env = 1;
    for (let i = 0; i < len; i++) {
      const atk = i < attack ? i / attack : 1;
      const v = Math.sin(w * i) * env * atk;
      L[i] += v * gl;
      R[i] += v * gr;
      env *= decay;
    }
  }
  normalize(buf, 0.9);
  s.bells.set(key, buf);
  return buf;
}

function normalize(buf, target) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak < 1e-6) return;
  const g = target / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}

function reversedCopy(ctx, buf, fromSample = 0, toSample = buf.length) {
  const len = Math.max(1, toSample - fromSample);
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < len; i++) dst[i] = src[toSample - 1 - i];
  }
  return out;
}

// The last `seconds` of a take, reversed (cached per take + length).
function reversedTail(ctx, take, seconds) {
  const s = store(ctx);
  let byLen = s.reversed.get(take);
  if (!byLen) { byLen = new Map(); s.reversed.set(take, byLen); }
  const key = Math.round(seconds * 100);
  if (!byLen.has(key)) {
    const n = Math.min(take.length, Math.floor(seconds * take.sampleRate));
    byLen.set(key, reversedCopy(ctx, take, take.length - n, take.length));
  }
  return byLen.get(key);
}

/* ---------------- reverb impulse ---------------- */

// Synthetic stereo hall: decaying noise that also gets darker over time.
export function makeImpulse(ctx, seconds = 2.6) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      // one-pole low-pass whose cutoff falls as the tail decays
      const k = 0.55 - 0.45 * x;
      lp += k * ((Math.random() * 2 - 1) - lp);
      const pre = i < sr * 0.012 ? i / (sr * 0.012) : 1; // short pre-delay fade
      d[i] = lp * Math.pow(1 - x, 3) * pre;
    }
  }
  return buf;
}

/* ---------------- the cues ---------------- */

/**
 * Schedule one transition cue.
 * @returns {AudioScheduledSourceNode[]} nodes to track for stop/panic
 */
export function scheduleTransition(ctx, dest, {
  type = 'swell', peakTime, rise = 0, fall = 2, volume = 0.45, take = null,
} = {}) {
  let start = peakTime - rise;
  const end = peakTime + fall;
  // Never schedule in the past (a section shorter than the transition);
  // clamp the start to "now" and shorten the rise accordingly.
  const now = ctx.currentTime + 0.01;
  if (start < now) start = now;
  if (peakTime < start) peakTime = start;
  if (end <= start) return [];

  if (type === 'reverse' && !take) type = 'swell';
  if (!TRIM[type]) type = 'swell';
  const v = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.45;
  const peak = v * v * TRIM[type];
  if (peak < 0.0005) return [];
  const t = { start, peakTime, end, peak };

  switch (type) {
    case 'reverse': return reverseCue(ctx, dest, t, take);
    case 'chime':   return chimeCue(ctx, dest, t);
    default:        return swellCue(ctx, dest, t);
  }
}

function swellCue(ctx, dest, { start, peakTime, end, peak }) {
  const noise = ctx.createBufferSource();
  noise.buffer = pinkNoise(ctx);
  noise.loop = true;

  const lo = 180, hi = 2600;
  const hasRise = peakTime - start > 0.005;

  // Main body: gently resonant low-pass sweeping up into the boundary.
  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.Q.value = 2.2;
  body.frequency.setValueAtTime(hasRise ? lo : hi, start);
  if (hasRise) body.frequency.exponentialRampToValueAtTime(hi, peakTime);
  body.frequency.exponentialRampToValueAtTime(lo, end);

  // Sheen: a narrow band an octave-and-a-bit above the body, kept quiet.
  const sheen = ctx.createBiquadFilter();
  sheen.type = 'bandpass';
  sheen.Q.value = 9;
  sheen.frequency.setValueAtTime((hasRise ? lo : hi) * 2.3, start);
  if (hasRise) sheen.frequency.exponentialRampToValueAtTime(hi * 2.3, peakTime);
  sheen.frequency.exponentialRampToValueAtTime(lo * 2.3, end);
  const sheenGain = ctx.createGain();
  sheenGain.gain.value = 0.35;

  const env = ctx.createGain();
  shapeGain(env.gain, { start, peakTime, end, peak });

  noise.connect(body).connect(env);
  noise.connect(sheen).connect(sheenGain).connect(env);
  env.connect(dest);

  noise.start(start);
  noise.stop(end + 0.05);
  return [noise];
}

function reverseCue(ctx, dest, { start, peakTime, end, peak }, take) {
  // Reverse the last (rise + fall) seconds of the take: what plays into the
  // boundary is the take's ending, backwards.
  const len = Math.min(take.duration, end - start);
  const src = ctx.createBufferSource();
  src.buffer = reversedTail(ctx, take, len);

  const hp = ctx.createBiquadFilter(); // keep the low end from muddying
  hp.type = 'highpass';
  hp.frequency.value = 140;

  const env = ctx.createGain();
  shapeGain(env.gain, { start, peakTime, end, peak });

  src.connect(hp).connect(env).connect(dest);
  src.start(start);
  src.stop(end + 0.05);
  return [src];
}

function chimeCue(ctx, dest, { start, peakTime, end, peak }) {
  const nodes = [];
  const rise = peakTime - start;
  const fall = end - peakTime;

  // Rise: a reversed bell blooming into the boundary. Its own reversed decay
  // already swells, so the envelope only fades the very start in.
  if (rise > 0.05) {
    const bells = store(ctx).bells;
    const revKey = `rev${Math.round(rise * 100)}`;
    if (!bells.has(revKey)) bells.set(revKey, reversedCopy(ctx, bell(ctx, rise)));
    const rev = bells.get(revKey);
    const src = ctx.createBufferSource();
    src.buffer = rev;
    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, start);
    g.gain.exponentialRampToValueAtTime(peak * 0.7, start + Math.min(0.3, rise * 0.5));
    src.connect(g).connect(dest);
    src.start(start);
    src.stop(peakTime + 0.01);
    nodes.push(src);
  }

  // Fall: the bell struck at the boundary, ringing out over the next section.
  if (fall > 0.05) {
    const src = ctx.createBufferSource();
    src.buffer = bell(ctx, Math.max(fall, 1.5));
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, peakTime);
    g.gain.setValueAtTime(peak, end - Math.min(0.3, fall * 0.3));
    g.gain.exponentialRampToValueAtTime(SILENT, end);
    src.connect(g).connect(dest);
    src.start(peakTime);
    src.stop(end + 0.05);
    nodes.push(src);
  }
  return nodes;
}
