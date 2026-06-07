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
   - Generate a white-noise filter-sweep transition cue.
   - Play a simple speaker-test tone.
   - Track every active source node so panic/stop can kill them instantly.

   Everything routes to ctx.destination. The mic analyser is a separate
   branch (input side) and is NOT connected to destination, so we never
   create a feedback loop.
   =========================================================== */

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
    this.outputGain = null;        // master make-up gain in front of destination
    this.outputGainValue = 1.5;    // default boost for quiet acoustic takes
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
    // Master make-up gain node: ALL output (recorded playback, transition
    // cue, test tone) routes through this so one slider controls volume.
    if (!this.outputGain) {
      this.outputGain = this.ctx.createGain();
      this.outputGain.gain.value = this.outputGainValue;
      this.outputGain.connect(this.ctx.destination);
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

  /* -------- White-noise filter sweep transition -------- */

  // Generates band-passy white noise and sweeps the filter cutoff across
  // `duration` seconds with a fade-in/peak/fade-out gain envelope.
  // Returns a handle; auto-stops after duration. onEnded fires at the end.
  playTransition({ duration = 5, direction = 'up', volume = 0.5, onEnded } = {}) {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1) White noise buffer (1s, looped).
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;

    // 2) Band-pass filter we sweep.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;

    const lo = 200;
    const hi = 8000;
    if (direction === 'down') {
      filter.frequency.setValueAtTime(hi, now);
      filter.frequency.exponentialRampToValueAtTime(lo, now + duration);
    } else {
      filter.frequency.setValueAtTime(lo, now);
      filter.frequency.exponentialRampToValueAtTime(hi, now + duration);
    }

    // 3) Gain envelope: fade in, peak mid, fade out — reads as a "whoosh" cue.
    const gain = ctx.createGain();
    const peak = Math.max(0, Math.min(1, volume));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), now + duration * 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    noise.connect(filter).connect(gain).connect(this.outputGain);

    noise.onended = () => {
      this.activeNodes.delete(noise);
      if (onEnded) onEnded();
    };
    this.activeNodes.add(noise);
    noise.start(now);
    noise.stop(now + duration);
    return noise;
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
