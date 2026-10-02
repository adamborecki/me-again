/* ===========================================================
   audioEngine.js
   Wraps Web Audio API + MediaRecorder.

   Responsibilities:
   - Create/resume a single AudioContext (must happen on a user gesture
     for iOS Safari — see init()).
   - Request microphone access and build a metering analyser.
   - Record mic input via MediaRecorder, then decode the resulting Blob
     into an AudioBuffer so playback can be started/stopped sample-accurate.
   - Play AudioBuffers (recorded sections) with an onEnded callback.
   - Schedule transition cues (see transitions.js) on a separate FX bus.
   - Play a simple speaker-test tone.
   - Track every active source node so panic/stop can kill them instantly.

   Everything routes to ctx.destination through the limiter. The mic analyser is a separate
   branch (input side) and is NOT connected to destination, so we never
   create a feedback loop.
   =========================================================== */

import { scheduleTransition, makeImpulse } from './transitions.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;     // MediaStreamAudioSourceNode for metering
    this.analyser = null;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = '';
    this.activeNodes = new Set();  // AudioBufferSourceNodes + noise nodes currently playing
    this.meterRAF = null;
    this.outputGain = null;        // master make-up gain in front of the drive/limiter
    this.outputGainValue = 1.0;    // unity by default; auto-maximize handles loudness
    this.driveGain = null;         // fixed extra boost to run the output hot
    this.driveValue = 2.8;         // ≈ +9 dB; the limiter below catches the peaks
    this.limiter = null;           // brick-wall-ish limiter so the drive never clips
    this.fxBus = null;             // transition cues: dry + reverb, skips the drive
  }

  /* -------- AudioContext lifecycle -------- */

  // Must be called from within a user-gesture handler (the Start button)
  // so iOS Safari allows audio. Safe to call repeatedly.
  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API is not supported in this browser.');
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    // Output chain (all sound — recorded playback, sweeps, test tone — runs
    // through it):
    //
    //   takes -> outputGain -> driveGain -> limiter -> soft clip -> destination
    //   cues  -> fxBus -> (dry + reverb) ------^
    //
    // outputGain is the volume slider. driveGain pushes the takes hot, and
    // the limiter is a near-brick-wall so that drive never actually clips.
    // Transition cues skip the drive: through it, even a modest cue came out
    // ~9 dB louder than intended and sat on top of the music.
    if (!this.outputGain) {
      this.outputGain = this.ctx.createGain();
      this.outputGain.gain.value = this.outputGainValue;

      this.driveGain = this.ctx.createGain();
      this.driveGain.gain.value = this.driveValue;

      // DynamicsCompressor with a hard knee + high ratio behaves as a limiter.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -2;   // clamp anything above ≈ -2 dBFS
      this.limiter.knee.value = 0;         // hard knee -> limiter, not soft comp
      this.limiter.ratio.value = 20;       // brick-wall-ish
      this.limiter.attack.value = 0.002;   // catch transients fast
      this.limiter.release.value = 0.18;

      // The compressor alone is not quite brick-wall: it adds its own makeup
      // gain and lets the first milliseconds of a transient through, so
      // measured peaks reached +1.6 dBFS (hard digital clipping). A soft
      // clipper after it rounds those overs off (peaks now ≈ -0.2 dBFS) and
      // leaves everything below ~-2.5 dBFS untouched.
      const safety = softClipper(this.ctx);

      this.outputGain.connect(this.driveGain);
      this.driveGain.connect(this.limiter);
      this.limiter.connect(safety.input);
      safety.output.connect(this.ctx.destination);

      // FX bus: mostly dry, with a soft synthetic hall for bloom and tails.
      this.fxBus = this.ctx.createGain();
      const reverb = this.ctx.createConvolver();
      reverb.buffer = makeImpulse(this.ctx);
      const wet = this.ctx.createGain();
      wet.gain.value = 0.55;
      this.fxBus.connect(this.limiter);
      this.fxBus.connect(reverb).connect(wet).connect(this.limiter);
    }
    return this.ctx;
  }

  // 0 = silent, 1 = unity (recorded level), >1 = boost. Smoothed to avoid clicks.
  setOutputGain(value) {
    this.outputGainValue = value;
    if (this.outputGain) {
      const now = this.ctx.currentTime;
      this.outputGain.gain.setTargetAtTime(value, now, 0.02);
    }
  }

  /* -------- Microphone -------- */

  async requestMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not supported in this browser.');
    }
    // Disable processing that would fight an acoustic instrument.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    // Metering branch: stream -> analyser (NOT connected to destination).
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.micSource.connect(this.analyser);

    this.mimeType = this.getSupportedMimeType();
    return this.micStream;
  }

  // Feature-detect a recordable MIME type. iOS Safari typically only
  // offers audio/mp4; Chrome/Firefox offer webm/ogg.
  getSupportedMimeType() {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not supported in this browser.');
    }
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/aac',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return ''; // let the browser pick its default
  }

  /* -------- Metering -------- */
  // cb receives a 0..1 level each animation frame.
  startMeter(cb) {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.fftSize);
    const tick = () => {
      this.analyser.getByteTimeDomainData(data);
      // RMS around the 128 midpoint -> perceptual-ish level.
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      cb(Math.min(1, rms * 2.2)); // small boost so quiet input is visible
      this.meterRAF = requestAnimationFrame(tick);
    };
    this.stopMeter();
    tick();
  }

  stopMeter() {
    if (this.meterRAF) cancelAnimationFrame(this.meterRAF);
    this.meterRAF = null;
  }

  /* -------- Recording -------- */

  startRecording() {
    if (!this.micStream) throw new Error('Microphone not initialized.');
    this.chunks = [];
    const opts = this.mimeType ? { mimeType: this.mimeType } : undefined;
    try {
      this.recorder = new MediaRecorder(this.micStream, opts);
    } catch (e) {
      // Fall back to default options if the chosen mime type is rejected.
      this.recorder = new MediaRecorder(this.micStream);
    }
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.recorder.start();
  }

  get isRecording() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  // Stops the recorder and resolves with a decoded AudioBuffer (or null if empty).
  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        resolve(null);
        return;
      }
      this.recorder.onstop = async () => {
        try {
          if (!this.chunks.length) { resolve(null); return; }
          const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
          const arrayBuf = await blob.arrayBuffer();
          // decodeAudioData is the universal way to get a playable buffer
          // that we can stop sample-accurately (unlike an <audio> element).
          const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
          resolve(audioBuf);
        } catch (err) {
          reject(err);
        } finally {
          this.chunks = [];
        }
      };
      this.recorder.stop();
    });
  }

  // Hard stop with no decode — used by panic/cleanup.
  abortRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      try { this.recorder.stop(); } catch (_) { /* ignore */ }
    }
    this.recorder = null;
    this.chunks = [];
  }

  /* -------- Auto-maximize (loudness normalization) -------- */

  // Boost a freshly recorded buffer toward a loud target WITHOUT clipping.
  // The iPhone built-in mic records acoustic sources very quietly (peak often
  // ~0.1), so we compute two candidate gains and take the gentler one:
  //   gainPeak = ceiling / peak     -> the most we can boost before clipping
  //   gainRms  = targetRms / rms    -> the gain to reach a loud RMS target
  // min(gainPeak, gainRms) is loud yet guaranteed clean. The gain is baked
  // into the samples in place. Returns the linear gain applied (1 = unchanged).
  maximizeBuffer(buffer, { ceiling = 0.97, targetRms = 0.33, maxGain = 40 } = {}) {
    const chans = buffer.numberOfChannels;
    let peak = 0, sumSq = 0, count = 0;
    for (let c = 0; c < chans; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sumSq += v * v;
      }
      count += data.length;
    }
    if (peak < 1e-4 || count === 0) return 1; // essentially silent -> leave alone
    const rms = Math.sqrt(sumSq / count);
    const gainPeak = ceiling / peak;
    const gainRms = rms > 0 ? targetRms / rms : maxGain;
    const gain = Math.min(gainPeak, gainRms, maxGain);
    // Boost-only: never pull a loud take down. Report 1 = left unchanged.
    if (gain <= 1.0001) return 1;
    for (let c = 0; c < chans; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] *= gain;
    }
    return gain;
  }

  /* -------- Playback -------- */

  // Plays an AudioBuffer once. Returns the source node; calls onEnded when done
  // (unless it was stopped manually).
  playBuffer(buffer, { onEnded } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outputGain);
    src.onended = () => {
      this.activeNodes.delete(src);
      if (onEnded) onEnded();
    };
    this.activeNodes.add(src);
    src.start();
    return src;
  }

  /* -------- Transition cues -------- */

  // Schedules one cue that PEAKS at `peakTime` (an AudioContext time), rising
  // for `rise` seconds before and falling for `fall` seconds after, so it
  // straddles a section boundary. `type` is swell | reverse | chime; `take`
  // is the AudioBuffer the reverse cue uses. Scheduled on the audio clock, so
  // it stays sample-accurate regardless of JS timer jitter.
  scheduleTransition(opts) {
    const nodes = scheduleTransition(this.ctx, this.fxBus, opts);
    for (const n of nodes) {
      this.activeNodes.add(n);
      n.onended = () => this.activeNodes.delete(n);
    }
    return nodes;
  }

  // Audition a cue on its own: rise into "now + rise", then fall.
  previewTransition({ type, duration, volume, take }) {
    const peakTime = this.ctx.currentTime + 0.05 + duration;
    return this.scheduleTransition({ type, peakTime, rise: duration, fall: duration, volume, take });
  }

  /* -------- Speaker test -------- */

  // Short pleasant two-note tone so the user can confirm output works.
  playTestTone() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    gain.connect(this.outputGain);

    [523.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now + i * 0.18);
      osc.stop(now + 0.6);
    });
  }

  /* -------- Stop / cleanup -------- */

  // Stop everything currently sounding (playback + transitions).
  stopAllPlayback() {
    for (const node of this.activeNodes) {
      try { node.onended = null; node.stop(); } catch (_) { /* already stopped */ }
    }
    this.activeNodes.clear();
  }

  // Full teardown for panic. Keeps the AudioContext/mic alive so the app
  // can be restarted without re-prompting; pass releaseMic=true to fully release.
  cleanup({ releaseMic = false } = {}) {
    this.abortRecording();
    this.stopAllPlayback();
    if (releaseMic) {
      this.stopMeter();
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }
      this.micSource = null;
      this.analyser = null;
    }
  }
}

// Unity below |x| = 0.75, then a tanh knee that approaches (never passes) 0.99.
// The shaper's curve only spans -1..1, so the input is scaled down by 1.5 and
// the curve scaled back up, letting overs up to +3.5 dBFS land on the knee
// instead of the curve's hard edge.
function softClipper(ctx) {
  const range = 1.5, knee = 0.75, room = 0.24;
  const input = ctx.createGain();
  input.gain.value = 1 / range;
  const shaper = ctx.createWaveShaper();
  const n = 2049;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = range * ((i / (n - 1)) * 2 - 1);
    const a = Math.abs(u);
    curve[i] = Math.sign(u) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  input.connect(shaper);
  return { input, output: shaper };
}
