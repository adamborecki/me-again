/* ===========================================================
   ui.js
   All DOM wiring lives here: element refs, rendering of state-machine
   events, reading the settings panel into a config object, and small
   bits of interactive chrome (chips, segmented control, log).

   ui.js knows nothing about audio internals — it only renders events
   emitted by the StateMachine and exposes onStart/onStop/etc. hooks
   that main.js fills in.
   =========================================================== */

const STATE_LABELS = {
  idle: 'Idle',
  requestingMic: 'Getting microphone…',
  recording: 'Recording',
  transition: 'Transition',
  playing: 'Playing',
  stopped: 'Stopped',
  error: 'Error',
};

export class UI {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.app = this.$('app');

    // hooks (assigned by main.js)
    this.onStart = () => {};
    this.onStop = () => {};
    this.onPanic = () => {};
    this.onSpeakerTest = () => {};
    this.onClearRecordings = () => {};
    this.onResetSession = () => {};
    this.onPlaybackVolume = () => {};

    this.running = false;
    this._cacheEls();
    this._bindControls();
    this._bindSettings();
    this._loadPersisted();
    this.updateMusicalCalc();
    this.updateRecordingsInfo(0);
  }

  _cacheEls() {
    this.els = {
      startStop: this.$('startStop'),
      startStopLabel: this.$('startStopLabel'),
      panicStop: this.$('panicStop'),
      speakerTest: this.$('speakerTest'),
      stateLabel: this.$('stateLabel'),
      sectionBadge: this.$('sectionBadge'),
      repeatInfo: this.$('repeatInfo'),
      countdown: this.$('countdown'),
      meterFill: this.$('meterFill'),
      log: this.$('log'),
      recordingsInfo: this.$('recordingsInfo'),
      musicalCalc: this.$('musicalCalc'),
      playbackVolumeLabel: this.$('playbackVolumeLabel'),
    };
  }

  /* ---------------- transport + global buttons ---------------- */

  _bindControls() {
    this.els.startStop.addEventListener('click', () => {
      if (this.running) this.onStop();
      else this.onStart();
    });
    this.els.panicStop.addEventListener('click', () => this.onPanic());
    this.els.speakerTest.addEventListener('click', () => this.onSpeakerTest());
    this.$('clearRecordings').addEventListener('click', () => this.onClearRecordings());
    this.$('resetSession').addEventListener('click', () => this.onResetSession());

    // Playback volume: live label + apply to the running engine immediately.
    const vol = this.$('playbackVolume');
    vol.addEventListener('input', () => {
      this._renderVolumeLabel();
      this.onPlaybackVolume(Number(vol.value));
      this._persist();
    });
  }

  _renderVolumeLabel() {
    const v = Number(this.$('playbackVolume').value);
    this.els.playbackVolumeLabel.textContent = `${Math.round(v * 100)}%`;
  }

  /* ---------------- settings interactions ---------------- */

  _bindSettings() {
    // Timing mode segmented control
    document.querySelectorAll('#timingMode .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#timingMode .seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const manual = btn.dataset.mode === 'manual';
        this.$('manualPanel').toggleAttribute('hidden', !manual);
        this.$('musicalPanel').toggleAttribute('hidden', manual);
        this._persist();
      });
    });

    // Duration preset chips -> mirror into custom field
    document.querySelectorAll('#durationPresets .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        this._activateChip('#durationPresets', chip);
        this.$('customSeconds').value = chip.dataset.sec;
        this._persist();
      });
    });
    this.$('customSeconds').addEventListener('input', () => {
      this._clearChips('#durationPresets');
      this._persist();
    });

    // Repeat preset chips
    document.querySelectorAll('#repeatPresets .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        this._activateChip('#repeatPresets', chip);
        this.$('customRepeats').value = chip.dataset.rep;
        this._persist();
      });
    });
    this.$('customRepeats').addEventListener('input', () => {
      this._clearChips('#repeatPresets');
      this._persist();
    });

    // Musical fields -> live recompute
    ['bpm', 'beatsPerBar', 'bars'].forEach((id) => {
      this.$(id).addEventListener('input', () => { this.updateMusicalCalc(); this._persist(); });
    });

    // Persist remaining inputs on change
    ['form', 'transitionEnabled', 'transitionDuration', 'transitionType',
     'sweepDirection', 'transitionVolume', 'recordDuringTransition', 'strictNoOverlap',
     'autoMaximize']
      .forEach((id) => this.$(id).addEventListener('change', () => this._persist()));

    this._renderVolumeLabel();
  }

  _activateChip(scope, chip) {
    document.querySelectorAll(`${scope} .chip`).forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
  }
  _clearChips(scope) {
    document.querySelectorAll(`${scope} .chip`).forEach((c) => c.classList.remove('active'));
  }

  updateMusicalCalc() {
    const bpm = Number(this.$('bpm').value) || 120;
    const beats = Number(this.$('beatsPerBar').value) || 4;
    const bars = Number(this.$('bars').value) || 1;
    const dur = (60 / bpm) * beats * bars;
    this.els.musicalCalc.textContent = `${dur.toFixed(1)}s`;
    return dur;
  }

  /* ---------------- read config ---------------- */

  // Build the config object the StateMachine consumes.
  readConfig() {
    const manualMode = document.querySelector('#timingMode .seg-btn.active').dataset.mode === 'manual';
    let durationSeconds;
    if (manualMode) {
      durationSeconds = Math.max(1, Number(this.$('customSeconds').value) || 4);
    } else {
      durationSeconds = Math.max(1, this.updateMusicalCalc());
    }

    return {
      durationSeconds,
      repeats: Math.max(1, Number(this.$('customRepeats').value) || 1),
      playbackVolume: Number(this.$('playbackVolume').value),
      autoMaximize: this.$('autoMaximize').checked,
      form: this.$('form').value,
      recordDuringTransition: this.$('recordDuringTransition').checked,
      strictNoOverlap: this.$('strictNoOverlap').checked,
      transition: {
        enabled: this.$('transitionEnabled').checked,
        duration: Math.max(0.5, Number(this.$('transitionDuration').value) || 5),
        type: this.$('transitionType').value,
        direction: this.$('sweepDirection').value,
        volume: Number(this.$('transitionVolume').value),
      },
    };
  }

  /* ---------------- render state-machine events ---------------- */

  handleEvent(evt) {
    switch (evt.type) {
      case 'state':      return this._renderState(evt);
      case 'countdown':  return this._renderCountdown(evt.seconds);
      case 'section':    return this._renderSection(evt.label);
      case 'recordings': return this.updateRecordingsInfo(evt.count);
      case 'log':        return this.addLog(evt.message);
    }
  }

  _renderState(evt) {
    this.app.dataset.state = evt.state;
    let label = STATE_LABELS[evt.state] || evt.state;
    if (evt.label && (evt.state === 'recording' || evt.state === 'playing' || evt.state === 'transition')) {
      label += evt.state === 'transition' ? '' : ` ${evt.label}`;
    }
    this.els.stateLabel.textContent = label;

    if (evt.state === 'playing' && evt.repeats > 1) {
      this.els.repeatInfo.textContent = `repeat ${evt.repeat} / ${evt.repeats}`;
    } else {
      this.els.repeatInfo.textContent = '';
    }
  }

  _renderCountdown(seconds) {
    const s = Math.ceil(seconds);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    this.els.countdown.textContent = `${m}:${String(rem).padStart(2, '0')}`;
  }

  _renderSection(label) {
    this.els.sectionBadge.textContent = label || '—';
  }

  setMeter(level) {
    this.els.meterFill.style.width = `${Math.round(level * 100)}%`;
  }

  setRunning(running) {
    this.running = running;
    this.els.startStopLabel.textContent = running ? 'Stop' : 'Start';
  }

  addLog(message) {
    const li = document.createElement('li');
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    li.innerHTML = `<span class="ts">${ts}</span><span>${message}</span>`;
    this.els.log.prepend(li);
    // Cap the log length.
    while (this.els.log.children.length > 40) {
      this.els.log.removeChild(this.els.log.lastChild);
    }
  }

  updateRecordingsInfo(count) {
    this.els.recordingsInfo.textContent =
      count === 0 ? 'No recordings yet.' : `${count} section${count === 1 ? '' : 's'} in memory.`;
  }

  resetView() {
    this.app.dataset.state = 'idle';
    this.els.stateLabel.textContent = STATE_LABELS.idle;
    this.els.countdown.textContent = '0:00';
    this.els.repeatInfo.textContent = '';
    this.els.sectionBadge.textContent = '—';
    this.setMeter(0);
  }

  /* ---------------- persistence (settings only) ---------------- */

  _persist() {
    try {
      const cfg = this.readConfig();
      const mode = document.querySelector('#timingMode .seg-btn.active').dataset.mode;
      localStorage.setItem('meAgain.settings', JSON.stringify({
        ...cfg,
        _mode: mode,
        _bpm: this.$('bpm').value,
        _beats: this.$('beatsPerBar').value,
        _bars: this.$('bars').value,
        _customSeconds: this.$('customSeconds').value,
        _customRepeats: this.$('customRepeats').value,
      }));
    } catch (_) { /* storage may be unavailable; non-fatal */ }
  }

  _loadPersisted() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('meAgain.settings') || 'null'); }
    catch (_) { saved = null; }
    if (!saved) return;

    const set = (id, val) => { if (val != null) this.$(id).value = val; };
    const check = (id, val) => { if (val != null) this.$(id).checked = !!val; };

    set('bpm', saved._bpm);
    set('beatsPerBar', saved._beats);
    set('bars', saved._bars);
    set('customSeconds', saved._customSeconds);
    set('customRepeats', saved._customRepeats);
    set('playbackVolume', saved.playbackVolume);
    set('form', saved.form);
    if (saved.transition) {
      check('transitionEnabled', saved.transition.enabled);
      set('transitionDuration', saved.transition.duration);
      set('transitionType', saved.transition.type);
      set('sweepDirection', saved.transition.direction);
      set('transitionVolume', saved.transition.volume);
    }
    check('recordDuringTransition', saved.recordDuringTransition);
    check('strictNoOverlap', saved.strictNoOverlap);
    if (saved.autoMaximize != null) check('autoMaximize', saved.autoMaximize);

    // Restore timing mode panel.
    if (saved._mode === 'musical') {
      document.querySelectorAll('#timingMode .seg-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === 'musical'));
      this.$('manualPanel').setAttribute('hidden', '');
      this.$('musicalPanel').removeAttribute('hidden');
    }
    // Sync chips to restored custom values.
    this._syncChip('#durationPresets', 'sec', saved._customSeconds);
    this._syncChip('#repeatPresets', 'rep', saved._customRepeats);
  }

  _syncChip(scope, attr, value) {
    let matched = false;
    document.querySelectorAll(`${scope} .chip`).forEach((c) => {
      const on = String(c.dataset[attr]) === String(value);
      c.classList.toggle('active', on);
      if (on) matched = true;
    });
    if (!matched) this._clearChips(scope);
  }

  /* ---------------- error surfacing ---------------- */

  showError(message) {
    this.app.dataset.state = 'error';
    this.els.stateLabel.textContent = 'Error';
    this.addLog(`⚠ ${message}`);
    // A blocking alert is the most reliable cross-browser way to make sure
    // the user sees a hard failure (e.g. mic permission denied).
    try { window.alert(message); } catch (_) { /* ignore */ }
  }
}
