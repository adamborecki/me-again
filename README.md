# Me Again

**A delayed self-duet looper for practicing with your past self.**

You play or sing a phrase; the app records it, plays it back, then records your
next phrase over a transition cue — turning a solo practice session into a
turn-taking duet with yourself. Built for ukulele, voice, or any acoustic
instrument. Runs entirely in the browser (works on iOS Safari), no backend,
no uploads — recordings live in memory only.

> Record → transition → playback → transition while the next recording begins → repeat.

This is **not** a live looper. It's a delayed, turn-taking recorder/practice partner.

---

## How it works

1. Tap **Start**. The app asks for microphone permission and unlocks audio
   (both must happen on the tap — an iOS Safari requirement).
2. It records **Section A** for the configured duration (default 90s).
3. It plays a **transition** cue (a white-noise filter sweep).
4. It **plays back A**.
5. As it transitions into the next section, it starts **recording B** while the
   transition cue is still playing (overlap is intentional — see below).
6. It records B, plays B back, and continues with C, D, … until you stop.

Reused sections (e.g. `A` in a Ternary form) **replay the saved take** instead
of re-recording.

---

## Running locally

It's plain HTML + ES modules — no build step. But ES modules and microphone
access need to be served over `http(s)://`, not opened as a `file://` path.

```bash
# any static server works; pick one:
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>. Microphone access works on `localhost`
without HTTPS.

---

## Deploying to GitHub Pages

1. Push this repo to GitHub (default branch `main`).
2. Repo **Settings → Pages → Build and deployment**.
3. Source: **Deploy from a branch**. Branch: **`main`**, folder: **`/ (root)`**.
4. Save. Your app will be live at
   `https://<user>.github.io/me-again/`.

GitHub Pages serves over HTTPS, which is required for microphone access on
mobile browsers. No further configuration is needed (the app uses relative
paths).

---

## iOS Safari notes

- **Use the Start button.** AudioContext is created/resumed and the mic is
  requested inside that tap, which is what Safari requires.
- **Headphones strongly recommended.** When using speakers, the transition cue
  (and any room sound) leaks into the next recording. With "Record during
  transition" on, that's expected; use headphones for clean takes, or enable
  **Strict no-overlap mode**.
- Recording uses `MediaRecorder` with a feature-detected MIME type
  (`audio/mp4` on iOS, `audio/webm` on Chrome/Firefox). If recording isn't
  supported, you'll get a clear error message.
- Backgrounding the tab stops the session for safety (iOS can suspend audio).

---

## Settings

- **Section length** — manual seconds (presets 15/30/60/90/120 + custom) or
  musical time: `duration = (60 / BPM) × beatsPerBar × bars`.
- **Playback repeats** — play each section 1–N times before moving on.
- **Auto-maximize loudness** (on by default) — each take is boosted toward a
  loud target on save, with a hard no-clip ceiling. Built for the quiet iPhone
  built-in mic. *Playback volume* is an extra trim on top.
- **Form** — Free/Infinite, Simple (A B C D), Ternary (A B A), Rondo (A B A C A).
- **Transitions** — enable/disable, duration, type, sweep direction (up/down),
  volume. White-noise sweep is the implemented cue.
- **Overlap** — *Record during transition* (on by default) and *Strict
  no-overlap mode* (never record while anything is playing; overrides the
  former).
- **Session** — Clear Recordings, Reset Session.

Settings persist in `localStorage`. Recordings do **not** — they're in memory
and clear on reload.

---

## Known limitations

- **Recordings are in-memory only.** Reloading the page loses them. (Export is
  designed-for but not implemented — see below.)
- **Reverse-intro transition is not implemented.** Selecting "Reverse intro" or
  "Both" falls back to the white-noise sweep so the app stays functional. The
  options are visible but stubbed (TODO in `stateMachine.js`).
- Overlap only layers the short transition cue onto the **start** of the next
  recording — the app never records over a full playback (by design for MVP).
- Free/Infinite form recycles letters after `Z` (Z → A) rather than `AA`.

---

## Future ideas

- Export recordings (the engine already decodes to `AudioBuffer`; add WAV
  encoding + download).
- Waveform display.
- Metronome / count-in.
- Smarter form engine (custom patterns).
- Saved sessions (IndexedDB).
- Reverse-audio transitions.
- Device input/output selection where browser support allows.

---

## Project structure

```
index.html          markup + settings panel
src/styles.css      dark, mobile-first, state-driven theming
src/audioEngine.js  Web Audio + MediaRecorder (record, decode, playback,
                    noise-sweep transition, metering, test tone)
src/stateMachine.js phase-queue session driver (record/transition/playback)
src/ui.js           DOM rendering, settings <-> config, event log
src/main.js         orchestrator + iOS user-gesture handling
```

---

## Testing checklist

- [ ] Start app on desktop Chrome
- [ ] Start app on iOS Safari
- [ ] Microphone permission prompt appears
- [ ] Mic input meter moves with sound
- [ ] Speaker test plays a tone
- [ ] A 10-second test recording records and plays back
- [ ] A 90-second recording works
- [ ] Transition sound (white-noise sweep) plays between phases
- [ ] Playback repeats (set to 2 or 3) play the section that many times
- [ ] Stop ends the session cleanly
- [ ] Panic Stop immediately kills all audio/timers
- [ ] Strict no-overlap mode never records while audio is playing
- [ ] Record-during-transition overlaps the cue onto the next recording's start
- [ ] Ternary/Rondo replay the saved `A` instead of re-recording it
- [ ] Clear Recordings empties memory; Reset Session returns to idle
