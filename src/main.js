/* ===========================================================
   main.js
   Orchestrator. Wires UI <-> StateMachine <-> AudioEngine and owns the
   tricky bit of iOS Safari support: AudioContext + getUserMedia must be
   kicked off from within the Start button's user-gesture handler.
   =========================================================== */

import { AudioEngine } from './audioEngine.js';
import { StateMachine } from './stateMachine.js';
import { UI } from './ui.js';

const ui = new UI();
const audio = new AudioEngine();
const machine = new StateMachine({
  audio,
  onEvent: (evt) => {
    ui.handleEvent(evt);
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

ui.onClearRecordings = () => machine.clearRecordings();

// Live playback-volume changes (slider) — apply if the context exists yet.
ui.onPlaybackVolume = (v) => { if (audio.ctx) audio.setOutputGain(v); };

ui.onResetSession = () => {
  machine.resetSession();
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
