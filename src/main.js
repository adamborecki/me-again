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
import { ask } from './ask.js';

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
  // A saved session is waiting: never replace it without asking.
  if (pendingSaved) {
    const labels = pendingSaved.map((t) => t.label).join(' ');
    const choice = await ask({
      title: 'Restore your last session?',
      body: `Your last session (${labels}) is saved on this device. Starting fresh deletes it.`,
      buttons: [
        { label: 'Restore & start', value: 'restore', kind: 'primary' },
        { label: 'Start fresh (delete it)', value: 'fresh', kind: 'danger', confirm: true },
        { label: 'Cancel', value: null },
      ],
    });
    if (!choice) return;
    if (choice === 'restore') {
      if (!restoreSaved()) return; // never start (and overwrite) if restore failed
    } else forgetSaved();
  }
  try {
    // 1) Unlock/resume AudioContext (needs the tap on iOS).
    await audio.init();

    // 2) Ask for the mic the first time; reuse the stream afterwards.

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

// Deleting takes always asks first, and offers to export them.
async function confirmDelete(what) {
  const labels = [...machine.recordings.keys()];
  if (!labels.length && !pendingSaved) return true; // nothing to lose
  const list = labels.length ? labels : pendingSaved.map((t) => t.label);
  const choice = await ask({
    title: `${what}?`,
    body: `This deletes ${list.length} take${list.length === 1 ? '' : 's'} (${list.join(' ')}) from this device. It can't be undone.`,
    buttons: [
      { label: 'Export first', value: 'export' },
      { label: 'Delete', value: 'delete', kind: 'danger', confirm: true },
      { label: 'Cancel', value: null },
    ],
  });
  if (choice === 'export') {
    await exportTakes(labels.length ? [...machine.recordings.entries()] : savedEntries());
    return false; // they can delete after checking the files
  }
  return choice === 'delete';
}

ui.onClearRecordings = async () => {
  if (!(await confirmDelete('Clear all recordings'))) return;
  machine.clearRecordings();
  forgetSaved();
};

// Live playback-volume changes (slider) — apply if the context exists yet.
ui.onPlaybackVolume = (v) => { if (audio.ctx) audio.setOutputGain(v); };

ui.onResetSession = async () => {
  if (!(await confirmDelete('Reset the session'))) return;
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
      // Only reachable if a saved session was never offered (Start asks).
      await clearTakes();
      storeOwned = true;
      pendingSaved = null;
      ui.showSavedSession(null);
    }
    const ok = await saveTake(label, buffer, order);
    if (ok === null) {
      ui.warn(`Couldn't keep ${label} on this device (storage full or blocked). Export to keep it.`);
    }
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

ui.onRestoreSession = () => restoreSaved();

function savedEntries() {
  return pendingSaved ? pendingSaved.map((t) => [t.label, toAudioBuffer(t)]) : [];
}

// Returns true if the saved takes are now loaded.
function restoreSaved() {
  if (!pendingSaved || machine.running) return false;
  try {
    const takes = pendingSaved.map((t) => ({ label: t.label, buffer: toAudioBuffer(t) }));
    machine.restore(takes);
    storeOwned = true;
    pendingSaved = null;
    ui.showSavedSession(null);
    ui.addLog(`Restored ${takes.map((t) => t.label).join(' ')}. Start replays them, then records what's next.`);
    return true;
  } catch (err) {
    ui.showError(`Couldn't restore the saved takes: ${err.message || err}`);
    return false;
  }
}

ui.onDismissSession = async () => {
  if (await confirmDelete('Delete the saved session')) forgetSaved();
};

// Loop / Stop at the end of the form can change mid-session.
ui.onEndAction = (action) => { if (machine.config) machine.config.endAction = action; };

// One WAV per section. Encoding is synchronous so the share sheet still
// counts as part of the tap (iOS requires that).
ui.onExport = () => exportTakes([...machine.recordings.entries()]);

async function exportTakes(takes) {
  if (!takes.length) return;
  const when = stamp();
  const files = takes.map(([label, buf]) =>
    new File([wavFromBuffer(buf)], `Me Again - ${label} - ${when}.wav`, { type: 'audio/wav' }));
  const how = await saveFiles(files);
  if (how === 'shared') ui.addLog(`Shared ${files.length} take${files.length === 1 ? '' : 's'}`);
  else if (how === 'downloaded') ui.addLog(`Downloaded ${files.length} WAV file${files.length === 1 ? '' : 's'}`);
}

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
