/* ===========================================================
   stateMachine.js
   Drives the whole session as an explicit phase queue instead of
   ad-hoc nested timers. This makes cleanup reliable: at any moment
   there is at most ONE pending timer and ONE active audio activity,
   and stop()/panic() clears them.

   Phase model
   -----------
   The session is a sequence of "steps" defined by the chosen Form.
   Each step has a section label (A, B, C, …). For each step we build
   a small list of phases and run them in order:

     - NEW section (never recorded):
         [record]            (transition is overlapped onto the start,
                              unless strict-no-overlap, where it becomes
                              a separate leading [transition] phase)
         [transition]        (cue before playback)
         [playback]          (repeated `repeats` times internally)

     - REUSED section (already recorded, e.g. A in ternary):
         [transition]
         [playback]

   The very first record has no leading/overlapping transition (per spec:
   tap Start -> record A immediately).

   States exposed to the UI: idle, requestingMic, recording, transition,
   playing, stopped, error.
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
    this.stepIndex = 0;          // index into the form pattern (wraps)
    this.phaseQueue = [];        // pending phases for the current step
    this.currentPhase = null;
    this.isFirstPhase = true;
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
    this.isFirstPhase = true;
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

  // Build the phases for the upcoming step and push them onto the queue.
  _enqueueStep() {
    const label = this._labelForStep(this.stepIndex);
    const isNew = !this.recordings.has(label);
    const t = this.config.transition;
    const transitionsOn = t.enabled;
    const strict = this.config.strictNoOverlap;
    // Overlap allowed only when: transitions on, record-during-transition on,
    // and strict mode off.
    const overlap = transitionsOn && this.config.recordDuringTransition && !strict;

    const phases = [];

    if (isNew) {
      if (this.isFirstPhase) {
        // First record: straight into recording, no leading transition.
        phases.push({ type: 'record', label, overlapTransition: false });
      } else if (overlap) {
        // Transition sound is layered onto the first seconds of recording.
        phases.push({ type: 'record', label, overlapTransition: true });
      } else {
        // Strict / no-overlap: transition plays first, then dry recording.
        if (transitionsOn) phases.push({ type: 'transition', label });
        phases.push({ type: 'record', label, overlapTransition: false });
      }
      // Cue before playback, then playback.
      if (transitionsOn) phases.push({ type: 'transition', label });
      phases.push({ type: 'playback', label });
    } else {
      // Reused section: just cue + replay the saved take.
      if (transitionsOn && !this.isFirstPhase) phases.push({ type: 'transition', label });
      phases.push({ type: 'playback', label });
    }

    this.phaseQueue = phases;
    this.onEvent({ type: 'section', label });
  }

  /* ---------------- driver ---------------- */

  // Pull and run the next phase; generate a new step when the queue empties.
  _advance() {
    if (!this.running) return;

    if (this.phaseQueue.length === 0) {
      this._enqueueStep();
      // After enqueuing a step we are no longer on the very first phase.
      this.isFirstPhase = false;
    }

    const phase = this.phaseQueue.shift();
    this.currentPhase = phase;

    switch (phase.type) {
      case 'record':      return this._runRecord(phase);
      case 'transition':  return this._runTransition(phase);
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

    // Overlap: play the transition cue on top of the first seconds.
    if (phase.overlapTransition) {
      this._playTransitionSound(); // fire-and-forget; self-stops
    }

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
        this.onEvent({ type: 'recordings', count: this.recordings.size });
        this.onEvent({ type: 'log', message: `Saved ${phase.label}${boost}` });
      } else {
        this.onEvent({ type: 'log', message: `⚠ ${phase.label} recorded empty` });
      }
      this._afterPhase();
    }, dur * 1000);
  }

  _runTransition(phase) {
    const dur = this.config.transition.duration;
    this._setState('transition', { label: phase.label });
    this.onEvent({ type: 'log', message: 'Transition…' });
    this._startCountdown(dur);
    this._playTransitionSound();
    // Drive advance by timer (transition node self-stops too).
    this._setTimer(() => this._afterPhase(), dur * 1000);
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

  _playTransitionSound() {
    const t = this.config.transition;
    if (!t.enabled) return;
    // Reverse / both types are stubbed -> fall back to the sweep cue so the
    // app stays fully functional. (See README "Known limitations".)
    this.audio.playTransition({
      duration: t.duration,
      direction: t.direction,
      volume: t.volume,
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
