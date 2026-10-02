/* ===========================================================
   stateMachine.js
   Drives the whole session as an explicit phase queue instead of
   ad-hoc nested timers. This makes cleanup reliable: at any moment
   there is at most ONE pending timer and ONE active audio activity,
   and stop()/panic() clears them.

   Phase model
   -----------
   The session is a flat sequence of segments, each either a [record] or a
   [playback], defined by the chosen Form. There are no standalone transition
   phases — every segment runs for its natural length:

     - NEW section (never recorded):
         [record]      (durationSeconds)
         [playback]    (buffer.duration × repeats)

     - REUSED section (already recorded, e.g. A in ternary):
         [playback]

   Transitions are a "whoosh" laid ON TOP of the segments at their boundaries.
   For a transition length T, the whoosh rises for T seconds before a boundary
   (over the tail of the outgoing segment) and falls for T seconds after it
   (over the head of the incoming segment), peaking exactly at the boundary.
   The very first segment additionally gets the fall-half at the very start.
   Each segment schedules the whoosh for the boundary at its END, so every
   boundary is covered exactly once. These are scheduled on the audio clock
   (see AudioEngine.scheduleTransition), independent of the segment timers.

   States exposed to the UI: idle, requestingMic, recording, playing,
   stopped, error.
   =========================================================== */

const FORMS = {
  free:    null,                  // dynamic: A, B, C, D … (handled specially)
  simple:  ['A', 'B', 'C', 'D'],
  ternary: ['A', 'B', 'A'],
  rondo:   ['A', 'B', 'A', 'C', 'A'],
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export class StateMachine {
  /**
   * @param {object} deps
   * @param {AudioEngine} deps.audio
   * @param {(evt:object)=>void} deps.onEvent  UI notification sink
   */
  constructor({ audio, onEvent }) {
    this.audio = audio;
    this.onEvent = onEvent || (() => {});
    this._reset();
  }

  _reset() {
    this.state = 'idle';
    this.running = false;
    this.config = null;
    this.recordings = new Map(); // label -> AudioBuffer
    this.lastTake = null;        // most recently saved take (for the reverse cue)
    this.stepIndex = 0;          // index into the form pattern (wraps)
    this.phaseQueue = [];        // pending phases for the current step
    this.currentPhase = null;
    this.firstSegment = true;    // first segment gets the leading "fall" whoosh
    this.timer = null;           // single pending setTimeout id
    this.tick = null;            // countdown interval id
    this.deadline = 0;           // performance.now() when current phase ends
  }

  /* ---------------- public API ---------------- */

  get recordingCount() { return this.recordings.size; }

  start(config) {
    this.config = config;
    this.running = true;
    this.stepIndex = 0;
    this.firstSegment = true;
    this.phaseQueue = [];
    this._setState('requestingMic');
    this.onEvent({ type: 'log', message: 'Session started' });
    // The actual mic/audio init is done by the orchestrator (main.js) before
    // calling beginLoop(), because it must run inside the user gesture.
  }

  // Called by main.js once mic + audio are ready.
  beginLoop() {
    if (!this.running) return;
    this._advance();
  }

  stop() {
    if (!this.running && this.state === 'idle') return;
    this._clearTimers();
    this._finishActiveAudio();
    this.running = false;
    this._setState('stopped');
    this.onEvent({ type: 'log', message: 'Stopped' });
  }

  // Immediate, no-await hard stop of everything.
  panic() {
    this._clearTimers();
    this.audio.abortRecording();
    this.audio.stopAllPlayback();
    this.running = false;
    this.currentPhase = null;
    this.phaseQueue = [];
    this._setState('stopped');
    this.onEvent({ type: 'log', message: '⛔ Panic stop — all audio killed' });
  }

  clearRecordings() {
    this.recordings.clear();
    this.lastTake = null;
    this.onEvent({ type: 'recordings', count: 0 });
    this.onEvent({ type: 'log', message: 'Recordings cleared' });
  }

  resetSession() {
    this.panic();
    this.recordings.clear();
    this._reset();
    this._setState('idle');
    this.onEvent({ type: 'recordings', count: 0 });
    this.onEvent({ type: 'log', message: 'Session reset' });
    this.onEvent({ type: 'section', label: '—' });
  }

  /* ---------------- phase generation ---------------- */

  // Returns the section label for the current stepIndex given the form.
  _labelForStep(idx) {
    const pattern = FORMS[this.config.form];
    if (!pattern) {
      // Free / infinite: a brand new letter each step.
      return LETTERS[idx % LETTERS.length];
    }
    return pattern[idx % pattern.length];
  }

  // Build the segments for the upcoming step and push them onto the queue.
  // New sections record then play back; reused sections just replay the take.
  // (Boundary whooshes are scheduled per-segment in _runRecord/_runPlayback.)
  _enqueueStep() {
    const label = this._labelForStep(this.stepIndex);
    const isNew = !this.recordings.has(label);

    const phases = [];
    if (isNew) phases.push({ type: 'record', label });
    phases.push({ type: 'playback', label });

    this.phaseQueue = phases;
    this.onEvent({ type: 'section', label });
  }

  /* ---------------- driver ---------------- */

  // Pull and run the next phase; generate a new step when the queue empties.
  _advance() {
    if (!this.running) return;

    if (this.phaseQueue.length === 0) {
      this._enqueueStep();
    }

    const phase = this.phaseQueue.shift();
    this.currentPhase = phase;

    switch (phase.type) {
      case 'record':      return this._runRecord(phase);
      case 'playback':    return this._runPlayback(phase);
      default:            return this._stepDone();
    }
  }

  // Called when all phases of a step are done -> move to next step.
  _stepDone() {
    this.stepIndex += 1;
    this._advance();
  }

  _runRecord(phase) {
    const dur = this.config.durationSeconds;
    this._setState('recording', { label: phase.label });
    this.onEvent({ type: 'log', message: `Recording ${phase.label} (${dur}s)` });

    this.audio.startRecording();

    // Lay the boundary whoosh(es) over this segment (peaking at its end).
    this._armSweeps(dur, this.lastTake);

    this._startCountdown(dur);
    this._setTimer(async () => {
      const buffer = await this.audio.stopRecording();
      if (buffer) {
        // Auto-maximize: bake a loudness boost into the take so quiet
        // iPhone-mic recordings play back at a usable level.
        let boost = '';
        if (this.config.autoMaximize) {
          const g = this.audio.maximizeBuffer(buffer);
          const dB = 20 * Math.log10(g);
          boost = ` (${dB >= 0 ? '+' : ''}${dB.toFixed(1)} dB)`;
        }
        this.recordings.set(phase.label, buffer);
        this.lastTake = buffer;
        this.onEvent({ type: 'recordings', count: this.recordings.size });
        this.onEvent({ type: 'log', message: `Saved ${phase.label}${boost}` });
      } else {
        this.onEvent({ type: 'log', message: `⚠ ${phase.label} recorded empty` });
      }
      this._afterPhase();
    }, dur * 1000);
  }

  _runPlayback(phase) {
    const buffer = this.recordings.get(phase.label);
    if (!buffer) {
      // Shouldn't happen, but stay resilient.
      this.onEvent({ type: 'log', message: `⚠ No recording for ${phase.label}` });
      return this._afterPhase();
    }
    const repeats = this.config.repeats;
    let n = 0;

    // Whoosh peaks at the very end of the whole (possibly repeated) playback.
    this._armSweeps(buffer.duration * repeats, buffer);

    const playOnce = () => {
      if (!this.running) return;
      n += 1;
      this._setState('playing', { label: phase.label, repeat: n, repeats });
      this.onEvent({ type: 'log', message: `Playing ${phase.label} (${n}/${repeats})` });
      this._startCountdown(buffer.duration);
      this.audio.playBuffer(buffer, {
        onEnded: () => {
          if (!this.running) return;
          if (n < repeats) playOnce();
          else this._afterPhase();
        },
      });
    };
    playOnce();
  }

  // Generic "phase finished" hook: if more phases remain in the step run them,
  // otherwise advance to the next step.
  _afterPhase() {
    if (!this.running) return;
    this._clearCountdown();
    if (this.phaseQueue.length > 0) this._advance();
    else this._stepDone();
  }

  // Schedule the cue(s) for a segment of length `segmentSeconds`:
  //   - the very first segment also gets the leading "fall" half at the start
  //   - every segment gets the cue that PEAKS at its end (rise over this
  //     segment's tail, fall over the next segment's head)
  // `take` is the audio the reverse cue plays backwards: the take being
  // played back, or while recording, the previous take.
  _armSweeps(segmentSeconds, take) {
    const t = this.config.transition;
    const wasFirst = this.firstSegment;
    this.firstSegment = false;
    if (!t.enabled) return;

    const now = this.audio.ctx.currentTime;
    const base = { type: t.type, volume: t.volume };
    if (wasFirst) {
      // Intro: peak at the very start, fall into the head of section A.
      this.audio.scheduleTransition({ ...base, peakTime: now, rise: 0, fall: t.duration });
    }
    // Boundary at the end of this segment.
    this.audio.scheduleTransition({
      ...base,
      take,
      peakTime: now + segmentSeconds,
      rise: t.duration,
      fall: t.duration,
    });
  }

  /* ---------------- timers & countdown ---------------- */

  _setTimer(fn, ms) {
    this._clearTimer();
    this.timer = setTimeout(fn, ms);
  }
  _clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  _startCountdown(seconds) {
    this._clearCountdown();
    this.deadline = performance.now() + seconds * 1000;
    const update = () => {
      const remain = Math.max(0, (this.deadline - performance.now()) / 1000);
      this.onEvent({ type: 'countdown', seconds: remain });
    };
    update();
    this.tick = setInterval(update, 100);
  }
  _clearCountdown() {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
  }

  _clearTimers() {
    this._clearTimer();
    this._clearCountdown();
  }

  // Gracefully end whatever audio is active right now (used by stop()).
  _finishActiveAudio() {
    this.audio.abortRecording();
    this.audio.stopAllPlayback();
    this.currentPhase = null;
    this.phaseQueue = [];
  }

  /* ---------------- state notify ---------------- */

  _setState(state, extra = {}) {
    this.state = state;
    this.onEvent({ type: 'state', state, ...extra });
  }
}
