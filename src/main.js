/* ===========================================================
   main.js
   Orchestrator. Wires UI <-> StateMachine <-> AudioEngine and owns the
   tricky bit of iOS Safari support: AudioContext + getUserMedia must be
   kicked off from within the Start button's user-gesture handler.
   =========================================================== */

import { AudioEngine } from './audioEngine.js';
import { StateMachine } from './stateMachine.js';
import { UI } from './ui.js';
import { saveTake, clearTakes, loadTakes, toAudioBuffer } from './store.js';
import { wavFromBuffer, saveFiles, stamp } from './wav.js';

const ui = new UI();
const audio = new AudioEngine();
const machine = new StateMachine({
  audio,
  onEvent: (evt) => {
    ui.handleEvent(evt);
    if (evt.type === 'take') keepTake(evt);
    // Keep the transport button label in sync with run state.
    if (evt.type === 'state') {
      const running = evt.state !== 'idle' && evt.state !== 'stopped' && evt.state !== 'error';
      ui.setRunning(running);
    }
  },
});

let micReady = false;

/* ---------------- Start flow (the user gesture) ---------------- */

ui.onStart = async () => {
  try {
    // 1) Unlock/resume AudioContext synchronously inside the gesture.
    await audio.init();

    // 2) Ask for the mic the first time; reuse the stream afterwards.
    // Starting without restoring = starting fresh (the saved session is
    // replaced once the first new take is saved).
    if (pendingSaved) ui.showSavedSession(null);

    const cfg = ui.readConfig();
    audio.setOutputGain(cfg.playbackVolume);
    machine.start(cfg);                   // -> state: requestingMic
    if (!micReady) {
      await audio.requestMic();
      micReady = true;
      // Live mic meter for the rest of the session.
      audio.startMeter((level) => ui.setMeter(level));
      ui.addLog('Microphone ready');
    }

    // 3) Kick off the record/transition/playback loop.
    machine.beginLoop();
  } catch (err) {
    handleStartError(err);
  }
};

function handleStartError(err) {
  machine.panic();
  ui.setRunning(false);
  let msg = err && err.message ? err.message : String(err);
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    msg = 'Microphone permission was denied. Enable it in your browser settings and try again.';
  } else if (err && err.name === 'NotFoundError') {
    msg = 'No microphone was found on this device.';
  }
  ui.showError(msg);
}

/* ---------------- Stop / Panic ---------------- */

ui.onStop = () => {
  machine.stop();
  ui.setRunning(false);
};

// Stop the session AND fully release the microphone, so the browser/OS mic
// indicator turns off. The next Start will re-acquire the mic (no re-prompt on
// browsers that remember the permission).
ui.onStopMic = () => {
  machine.stop();
  audio.cleanup({ releaseMic: true });
  micReady = false;
  ui.setRunning(false);
  ui.setMeter(0);
  ui.addLog('Microphone released');
};

ui.onPanic = () => {
  machine.panic();
  ui.setRunning(false);
};

/* ---------------- Session buttons ---------------- */

ui.onClearRecordings = () => {
  machine.clearRecordings();
  forgetSaved();
};

// Live playback-volume changes (slider) — apply if the context exists yet.
ui.onPlaybackVolume = (v) => { if (audio.ctx) audio.setOutputGain(v); };

ui.onResetSession = () => {
  machine.resetSession();
  forgetSaved();
  ui.setRunning(false);
  ui.resetView();
};

/* ---------------- Speaker test ---------------- */

ui.onSpeakerTest = async () => {
  try {
    await audio.init();              // resume context on this gesture too
    audio.setOutputGain(ui.readConfig().playbackVolume);
    audio.playTestTone();
    ui.addLog('Speaker test played');
  } catch (err) {
    ui.showError(err.message || 'Could not play test tone.');
  }
};

/* ---------------- Transition preview ---------------- */

ui.onPreviewTransition = async () => {
  try {
    await audio.init();
    const { transition: t } = ui.readConfig();
    const take = machine.lastTake;
    audio.previewTransition({ type: t.type, duration: t.duration, volume: t.volume, take });
    const note = t.type === 'reverse' && !take ? ' (no take yet, so a plain swell)' : '';
    ui.addLog(`Previewing ${t.type} cue${note}`);
  } catch (err) {
    ui.showError(err.message || 'Could not play the preview.');
  }
};

/* ---------------- Keeping takes (IndexedDB) + export ---------------- */
// The store holds ONE session. Until the saved one is restored or dismissed,
// it's left alone; the first take of a new session replaces it.

let pendingSaved = null;           // takes from last visit, not yet restored
let storeOwned = false;            // store now holds this visit's session
let storeQueue = Promise.resolve(); // keep IndexedDB writes in order

function keepTake({ label, buffer, order }) {
  storeQueue = storeQueue.then(async () => {
    if (!storeOwned) {
      await clearTakes();
      storeOwned = true;
      pendingSaved = null;
      ui.showSavedSession(null);
    }
    await saveTake(label, buffer, order);
  });
}

function forgetSaved() {
  pendingSaved = null;
  storeOwned = true;
  ui.showSavedSession(null);
  storeQueue = storeQueue.then(() => clearTakes());
}

loadTakes().then((takes) => {
  if (!takes.length || machine.recordingCount > 0 || storeOwned) return;
  pendingSaved = takes;
  ui.showSavedSession(takes);
});

ui.onRestoreSession = () => {
  if (!pendingSaved || machine.running) return;
  try {
    const takes = pendingSaved.map((t) => ({ label: t.label, buffer: toAudioBuffer(t) }));
    machine.restore(takes);
    storeOwned = true;
    pendingSaved = null;
    ui.showSavedSession(null);
    ui.addLog(`Restored ${takes.map((t) => t.label).join(' ')}. Start replays them, then records what's next.`);
  } catch (err) {
    ui.showError(`Couldn't restore the saved takes: ${err.message || err}`);
  }
};

ui.onDismissSession = () => forgetSaved();

// One WAV per section. Encoding is synchronous so the share sheet still
// counts as part of the tap (iOS requires that).
ui.onExport = async () => {
  const takes = [...machine.recordings.entries()];
  if (!takes.length) return;
  const when = stamp();
  const files = takes.map(([label, buf]) =>
    new File([wavFromBuffer(buf)], `Me Again - ${label} - ${when}.wav`, { type: 'audio/wav' }));
  const how = await saveFiles(files);
  if (how === 'shared') ui.addLog(`Shared ${files.length} take${files.length === 1 ? '' : 's'}`);
  else if (how === 'downloaded') ui.addLog(`Downloaded ${files.length} WAV file${files.length === 1 ? '' : 's'}`);
};

/* ---------------- Safety: stop audio if tab is hidden ---------------- */
// iOS can suspend audio when backgrounded; make the stop explicit so the
// app doesn't come back in a half-running state.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && machine.running) {
    machine.panic();
    ui.setRunning(false);
    ui.addLog('Backgrounded — session stopped for safety');
  }
});

// Expose for quick console debugging.
window.meAgain = { ui, audio, machine };
