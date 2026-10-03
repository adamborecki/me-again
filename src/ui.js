/* ===========================================================
   ui.js
   All DOM wiring lives here: element refs, rendering of state-machine
   events, reading the settings panel into a config object, and small
   bits of interactive chrome (chips, segmented control, log).

   ui.js knows nothing about audio internals — it only renders events
   emitted by the StateMachine and exposes onStart/onStop/etc. hooks
   that main.js fills in.
   =========================================================== */

import { FORMS, DEFAULT_CUSTOM, cleanPattern, patternFor, labelAt, hueFor, planSteps } from './forms.js';

const STATE_LABELS = {
  idle: 'Ready',
  requestingMic: 'Getting microphone…',
  recording: 'Recording',
  transition: 'Transition',
  playing: 'Playing',
  stopped: 'Stopped',
  error: 'Error',
};

// Bump when a saved setting's meaning changes (v2: new transition engine).
const SETTINGS_VERSION = 2;

export class UI {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.app = this.$('app');

    // hooks (assigned by main.js)
    this.onStart = () => {};
    this.onStop = () => {};
    this.onStopMic = () => {};
    this.onPanic = () => {};
    this.onSpeakerTest = () => {};
    this.onClearRecordings = () => {};
    this.onResetSession = () => {};
    this.onPlaybackVolume = () => {};
    this.onPreviewTransition = () => {};
    this.onExport = () => {};
    this.onRestoreSession = () => {};
    this.onDismissSession = () => {};
    this.onEndAction = () => {};

    this.running = false;
    // Where the session is, for the form strip and the "next" line.
    this.formId = 'free';
    this.endAction = 'loop';
    this.track = { current: -1, isNewNow: false, phase: 'idle', label: null, complete: false };
    this.recordedLabels = new Set();
    this._cacheEls();
    this._buildFormGrid();
    this._bindControls();
    this._bindSettings();
    this._loadPersisted();
    this.updateMusicalCalc();
    this.updateRecordingsInfo(0);
    this.renderPlan();
  }

  _cacheEls() {
    this.els = {
      startStop: this.$('startStop'),
      startStopLabel: this.$('startStopLabel'),
      stopMic: this.$('stopMic'),
      panicStop: this.$('panicStop'),
      speakerTest: this.$('speakerTest'),
      stateLabel: this.$('stateLabel'),
      startStopIcon: this.$('startStopIcon'),
      formName: this.$('formName'),
      roundInfo: this.$('roundInfo'),
      strip: this.$('strip'),
      endToggle: this.$('endToggle'),
      nextInfo: this.$('nextInfo'),
      progressFill: this.$('progressFill'),
      formGrid: this.$('formGrid'),
      customField: this.$('customField'),
      customPattern: this.$('customPattern'),
      repeatInfo: this.$('repeatInfo'),
      countdown: this.$('countdown'),
      meterFill: this.$('meterFill'),
      log: this.$('log'),
      recordingsInfo: this.$('recordingsInfo'),
      musicalCalc: this.$('musicalCalc'),
      playbackVolumeLabel: this.$('playbackVolumeLabel'),
      transitionVolumeLabel: this.$('transitionVolumeLabel'),
    };
  }

  /* ---------------- transport + global buttons ---------------- */

  _bindControls() {
    this.els.startStop.addEventListener('click', () => {
      if (this.running) this.onStop();
      else this.onStart();
    });
    this.els.stopMic.addEventListener('click', () => this.onStopMic());
    this.els.panicStop.addEventListener('click', () => this.onPanic());
    this.els.speakerTest.addEventListener('click', () => this.onSpeakerTest());
    this.$('clearRecordings').addEventListener('click', () => this.onClearRecordings());
    this.$('resetSession').addEventListener('click', () => this.onResetSession());
    this.$('previewTransition').addEventListener('click', () => this.onPreviewTransition());
    this.$('exportTakes').addEventListener('click', () => this.onExport());
    this.$('restoreSession').addEventListener('click', () => this.onRestoreSession());
    this.$('dismissSession').addEventListener('click', () => this.onDismissSession());

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
    const t = Number(this.$('transitionVolume').value);
    this.els.transitionVolumeLabel.textContent = `${Math.round(t * 100)}%`;
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

    // Form: end action (segmented control + the toggle at the end of the strip)
    document.querySelectorAll('#endSeg .seg-btn').forEach((b) => {
      b.addEventListener('click', () => this._setEndAction(b.dataset.end));
    });
    this.els.endToggle.addEventListener('click', () =>
      this._setEndAction(this.endAction === 'loop' ? 'stop' : 'loop'));
    this.els.customPattern.addEventListener('input', () => { this._clearComplete(); this.renderPlan(); this._persist(); });
    this.els.customPattern.addEventListener('change', () => {
      this.els.customPattern.value = cleanPattern(this.els.customPattern.value) || DEFAULT_CUSTOM;
      this.renderPlan();
      this._persist();
    });

    // Persist remaining inputs on change
    ['transitionEnabled', 'transitionType', 'transitionDuration', 'transitionVolume',
     'autoMaximize']
      .forEach((id) => this.$(id).addEventListener('change', () => this._persist()));
    this.$('transitionVolume').addEventListener('input', () => this._renderVolumeLabel());

    this._renderVolumeLabel();
  }

  /* ---------------- form picker ---------------- */

  // Small icon cards: a mini coloured strip of the form's letters.
  _buildFormGrid() {
    for (const f of FORMS) {
      const b = document.createElement('button');
      b.className = 'form-card';
      b.dataset.form = f.id;
      b.setAttribute('role', 'radio');
      b.title = f.blurb;
      const icon = document.createElement('span');
      icon.className = 'mini';
      const letters = f.id === 'free' ? ['A', 'B', 'C'] : f.id === 'custom' ? [] : f.pattern;
      for (const ch of letters) icon.append(miniTile(ch));
      if (f.id === 'free') icon.append(Object.assign(document.createElement('span'), { className: 'mini-more', textContent: '…' }));
      if (f.id === 'custom') icon.append(Object.assign(document.createElement('span'), { className: 'mini-more', textContent: '✎' }));
      const name = document.createElement('span');
      name.className = 'form-card-name';
      name.textContent = f.name;
      b.append(icon, name);
      b.addEventListener('click', () => {
        if (this.running) return; // changing form mid-session would be confusing
        this.formId = f.id;
        this._clearComplete();
        this._renderFormPicker();
        this.renderPlan();
        this._persist();
        if (f.id === 'custom') this.els.customPattern.focus();
      });
      this.els.formGrid.append(b);
    }
    this._renderFormPicker();
  }

  // After "Form complete", changing the form starts a new picture.
  _clearComplete() {
    if (!this.track.complete) return;
    this.track.complete = false;
    this.els.stateLabel.textContent = STATE_LABELS.idle;
  }

  _renderFormPicker() {
    this.els.formGrid.querySelectorAll('.form-card').forEach((b) => {
      const on = b.dataset.form === this.formId;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = this.running && !on;
    });
    this.els.customField.hidden = this.formId !== 'custom';
    this.els.customPattern.disabled = this.running;
    document.querySelectorAll('#endSeg .seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.end === this.endAction));
  }

  _setEndAction(action) {
    this.endAction = action;
    this._renderFormPicker();
    this.renderPlan();
    this._persist();
    this.onEndAction(action);
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
      form: this.formId,
      pattern: patternFor(this.formId, this.els.customPattern.value),
      endAction: this.endAction,
      transition: {
        enabled: this.$('transitionEnabled').checked,
        type: this.$('transitionType').value,
        duration: Math.max(0.5, Number(this.$('transitionDuration').value) || 2),
        volume: Number(this.$('transitionVolume').value),
      },
    };
  }

  /* ---------------- render state-machine events ---------------- */

  handleEvent(evt) {
    switch (evt.type) {
      case 'state':      return this._renderState(evt);
      case 'countdown':  return this._renderCountdown(evt.seconds, evt.total);
      case 'step':
        Object.assign(this.track, { current: evt.index, isNewNow: evt.isNew, label: evt.label, complete: false });
        return this.renderPlan();
      case 'recordings':
        this.recordedLabels = new Set(evt.labels || []);
        this.updateRecordingsInfo(evt.count);
        return this.renderPlan();
      case 'log':        return this.addLog(evt.message);
    }
  }

  _renderState(evt) {
    this.app.dataset.state = evt.state;
    const t = this.track;
    t.phase = evt.state;
    if (evt.state === 'stopped' || evt.state === 'idle' || evt.state === 'error') {
      t.complete = !!evt.complete;
      t.current = -1;
      this._renderProgress(0);
      this.els.countdown.textContent = '0:00';
    }
    if (evt.state === 'requestingMic') t.complete = false;

    let label = STATE_LABELS[evt.state] || evt.state;
    if (evt.state === 'recording') label = `● Recording ${evt.label}`;
    else if (evt.state === 'playing') label = `▶ ${t.isNewNow ? 'Playing back' : 'Replaying'} ${evt.label}`;
    else if (t.complete) label = 'Form complete ✓';
    this.els.stateLabel.textContent = label;

    this.els.repeatInfo.textContent =
      evt.state === 'playing' && evt.repeats > 1 ? `repeat ${evt.repeat} of ${evt.repeats}` : '';
    this.renderPlan();
  }

  _renderCountdown(seconds, total) {
    const s = Math.ceil(seconds);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    this.els.countdown.textContent = `${m}:${String(rem).padStart(2, '0')}`;
    if (total > 0) this._renderProgress(1 - seconds / total);
  }

  _renderProgress(frac) {
    const pct = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    this.els.progressFill.style.width = pct;
    const tileBar = this.els.strip.querySelector('.tile.is-now .tile-progress');
    if (tileBar) tileBar.style.width = pct;
  }

  /* ---------------- form strip + "next" ---------------- */

  // Redraws the form strip, the form name and the "Next:" line from the
  // chosen form, what's been recorded, and where the session is.
  renderPlan() {
    const cfg = this.readConfig();
    const pattern = cfg.pattern;
    const t = this.track;
    const running = t.current >= 0;

    // Labels known *before* the current step (so the current tile still
    // shows "record" while its take is being played back).
    const known = new Set(this.recordedLabels);
    if (running && t.isNewNow) known.delete(t.label);

    const form = FORMS.find((f) => f.id === cfg.form) || FORMS[0];
    this.els.formName.textContent = pattern
      ? `${form.name} · ${form.shown || pattern.join(' ')}`
      : 'Free · a new section every time';
    const pass = running && pattern ? Math.floor(t.current / pattern.length) + 1 : 0;
    this.els.roundInfo.textContent = pass > 1 ? `pass ${pass}` : '';

    // Strip
    const steps = planSteps(pattern, known, running ? t.current : -1);
    const strip = this.els.strip;
    strip.textContent = '';
    for (const st of steps) {
      const li = document.createElement('li');
      li.className = `tile is-${st.status}${st.label.length > 1 ? ' is-long' : ''}${isLower(st.label) ? ' is-lower' : ''}`;
      li.style.setProperty('--hue', hueFor(st.label));
      const b = document.createElement('b');
      b.textContent = st.label;
      const mark = document.createElement('i');
      mark.className = `mark ${st.status === 'done' ? 'done' : st.isNew ? 'rec' : 'play'}`;
      li.append(b, mark);
      if (st.status === 'now') {
        const bar = document.createElement('span');
        bar.className = 'tile-progress';
        li.append(bar);
      }
      li.setAttribute('aria-label', `${st.label}: ${st.status === 'done' ? 'done' : st.isNew ? 'record' : 'replay'}${st.status === 'now' ? ' (now)' : ''}`);
      strip.append(li);
    }
    if (!pattern) {
      const more = document.createElement('li');
      more.className = 'tile is-more';
      more.textContent = '…';
      strip.append(more);
    }
    const nowTile = strip.querySelector('.tile.is-now');
    if (nowTile && nowTile.scrollIntoView) nowTile.scrollIntoView({ block: 'nearest', inline: 'center' });

    // End-of-form toggle (meaningless for free form)
    this.els.endToggle.hidden = !pattern;
    this.els.endToggle.textContent = this.endAction === 'loop' ? '↻' : '■';
    this.els.endToggle.title = this.endAction === 'loop'
      ? 'Loops back to the start at the end (tap to stop at the end instead)'
      : 'Stops at the end of the form (tap to loop instead)';

    this.els.nextInfo.textContent = this._nextText(pattern, known);
  }

  _describe(pattern, step, known) {
    const label = labelAt(pattern, step);
    return known.has(label) ? `▶ replay ${label}` : `● record ${label}`;
  }

  _nextText(pattern, known) {
    const t = this.track;
    if (t.current < 0) {
      if (t.complete) return 'Start replays the whole form from your takes. To record fresh ones, Clear Recordings in Settings.';
      if (t.phase === 'requestingMic') return '';
      return `First: ${this._describe(pattern, 0, known)}`;
    }
    if (t.phase === 'recording') return `Next: ▶ play ${t.label} back`;
    const after = new Set(known);
    after.add(t.label);
    const nextStep = t.current + 1;
    if (pattern && nextStep % pattern.length === 0) {
      if (this.endAction === 'stop') return 'Next: ■ end of the form';
      return `Next: ↻ back to the top, ${this._describe(pattern, nextStep, after)}`;
    }
    return `Next: ${this._describe(pattern, nextStep, after)}`;
  }

  setMeter(level) {
    this.els.meterFill.style.width = `${Math.round(level * 100)}%`;
  }

  setRunning(running) {
    this.running = running;
    this.els.startStopLabel.textContent = running ? 'Stop' : 'Start';
    this.els.startStopIcon.textContent = running ? '■' : '●';
    this._renderFormPicker();
  }

  // A warning that must not be missed (the log is folded away).
  warn(message) {
    const el = this.$('warnLine');
    el.textContent = `⚠ ${message}`;
    el.hidden = false;
    this.addLog(`⚠ ${message}`);
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

  // takes: [{ label, savedAt }] kept from a previous visit, or null to hide.
  showSavedSession(takes) {
    const box = this.$('savedSession');
    if (!takes || !takes.length) { box.hidden = true; return; }
    const when = new Date(Math.max(...takes.map((t) => t.savedAt || 0)));
    const labels = takes.map((t) => t.label).join(' ');
    this.$('savedSessionInfo').textContent =
      `Last session (${labels}) from ${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ` +
      `${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} is saved on this device.`;
    box.hidden = false;
  }

  updateRecordingsInfo(count) {
    this.$('exportTakes').disabled = count === 0;
    this.els.recordingsInfo.textContent =
      count === 0 ? 'No recordings yet.' : `${count} section${count === 1 ? '' : 's'} kept on this device.`;
  }

  resetView() {
    this.app.dataset.state = 'idle';
    this.els.stateLabel.textContent = STATE_LABELS.idle;
    this.els.countdown.textContent = '0:00';
    this.els.repeatInfo.textContent = '';
    this.track = { current: -1, isNewNow: false, phase: 'idle', label: null, complete: false };
    this._renderProgress(0);
    this.renderPlan();
    this.setMeter(0);
  }

  /* ---------------- persistence (settings only) ---------------- */

  _persist() {
    try {
      const cfg = this.readConfig();
      const mode = document.querySelector('#timingMode .seg-btn.active').dataset.mode;
      localStorage.setItem('meAgain.settings', JSON.stringify({
        ...cfg,
        _v: SETTINGS_VERSION,
        _mode: mode,
        _bpm: this.$('bpm').value,
        _beats: this.$('beatsPerBar').value,
        _bars: this.$('bars').value,
        _customSeconds: this.$('customSeconds').value,
        _customRepeats: this.$('customRepeats').value,
        _customPattern: this.els.customPattern.value,
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
    if (FORMS.some((f) => f.id === saved.form)) this.formId = saved.form;
    if (saved.endAction === 'stop' || saved.endAction === 'loop') this.endAction = saved.endAction;
    if (saved._customPattern) this.els.customPattern.value = cleanPattern(saved._customPattern) || DEFAULT_CUSTOM;
    this._renderFormPicker();
    if (saved.transition) {
      check('transitionEnabled', saved.transition.enabled);
      set('transitionDuration', saved.transition.duration);
      // v1 volumes were for the old (much louder) white-noise whoosh; start
      // those users on the new default instead of carrying the level over.
      if (saved._v >= 2) {
        set('transitionVolume', saved.transition.volume);
        set('transitionType', saved.transition.type);
      }
    }
    if (saved.autoMaximize != null) check('autoMaximize', saved.autoMaximize);
    this._renderVolumeLabel();

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

// Lower-case labels (a, b') are phrase-level sections: drawn smaller and lighter.
const isLower = (label) => /^[a-z]/.test(label);

function miniTile(ch) {
  const t = document.createElement('span');
  t.className = isLower(ch) ? 'mini-tile is-lower' : 'mini-tile';
  t.style.setProperty('--hue', hueFor(ch));
  t.textContent = ch;
  return t;
}
