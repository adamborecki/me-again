# Me Again

**A delayed self-duet looper for practicing with your past self.**

You play or sing a phrase; the app records it, plays it back, then records your
next phrase over a transition cue — turning a solo practice session into a
turn-taking duet with yourself. Built for ukulele, voice, or any acoustic
instrument. Runs entirely in the browser (works on iOS Safari), no backend,
no uploads — takes stay on your device.

> Record → transition → playback → transition while the next recording begins → repeat.

This is **not** a live looper. It's a delayed, turn-taking recorder/practice partner.

---

## How it works

1. Tap **Start**. The app asks for microphone permission and unlocks audio
   (both must happen on the tap — an iOS Safari requirement).
2. It records **Section A** for the configured duration (default 4s).
3. It **plays back A**.
4. It **records B**, plays B back, and continues with C, D, … until you stop.

A short **transition cue** straddles every boundary between segments: it rises
over the last seconds of one segment, peaks exactly at the boundary, and falls
over the first seconds of the next. It overlaps recording and playback by
design (see *Transitions* below).

Reused sections (e.g. `A` in a Ternary form) **replay the saved take** instead
of re-recording.

The **form strip** at the top of the screen shows the whole form: one coloured
tile per section, marked ● (will be recorded) or ▶ (replays your saved take).
The current tile is lit and fills up as the section runs; finished ones dim.
Under the timer, **Next:** says what's coming (record C, replay A, back to
the top, or the end of the form).

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
  (and any room sound) leaks into the recording. Use headphones for clean
  takes, or turn the cue off.
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
  loud target on save, with a no-clip ceiling. Built for the quiet iPhone
  built-in mic. *Playback volume* is an extra trim on top. Playback runs hot
  into a limiter and then a soft clipper, so it stays loud without digital
  overs.
- **Form** — picked from icon cards: Free (A B C …), Sections (ABCD),
  Ternary (ABA), Song form (AABA), Rondo 5 (ABACA), Rondo 7 (ABACABA),
  Rondo 7 with a new D (ABACADA), or Custom (type any letters). **At the end
  of the form**: loop back to the top, or stop. The ↻/■ button at the end of
  the strip flips it, even mid-session.
- **Transitions** — enable/disable, sound, length, volume, and **Preview cue**
  to audition it. Sounds:
  - *Soft swell* (default) — stereo pink noise through a gently resonant
    low-pass sweep.
  - *Reverse swell* — the end of your most recent take, played backwards into
    the boundary. Uses a soft swell until something has been recorded.
  - *Chime* — a synthesized bell, played backwards into the boundary and then
    struck forwards out of it.

  All cues share a soft reverb and bypass the playback drive, so they sit
  under the music (default volume ≈ 15 dB below an auto-maximized take).
- **Session** — Clear Recordings, Reset Session, **Export takes (WAV)** (one
  file per section, via the iPhone share sheet or as downloads).

Settings persist in `localStorage`. Takes are kept in IndexedDB (localStorage
is far too small for audio). After a reload, a card offers **Restore** (Start
then replays the saved sections and records the next new one) or **Start
fresh**. Starting a new session replaces the saved one once its first take is
saved. iOS Safari can clear site data after ~7 days without a visit, so export
anything you want to keep.

---

## Known limitations

- The chime is pitched on C. It's bell-like enough to sit OK in most keys,
  but it isn't tuned to your music.
- The app never records over a full playback; only the short transition cue
  overlaps a recording (by design).
- Free/Infinite form recycles letters after `Z` (Z → A) rather than `AA`.

---

## Future ideas

- Waveform display.
- Metronome / count-in.
- Smarter form engine (custom patterns).
- Several saved sessions (only the latest is kept today).
- Device input/output selection where browser support allows.

---

## Project structure

```
index.html          markup + settings panel
src/styles.css      dark, mobile-first, state-driven theming
src/audioEngine.js  Web Audio + MediaRecorder (record, decode, playback,
                    output limiter, FX bus, metering, test tone)
src/transitions.js  the transition cues (swell, reverse, chime) + reverb
src/store.js        keeps the session's takes on this device (IndexedDB)
src/wav.js          WAV encoding + share / download
src/stateMachine.js phase-queue session driver (record/transition/playback)
src/forms.js        the forms + the plan the strip draws (record vs replay)
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
- [ ] Each transition sound previews (Preview cue) and plays at boundaries
- [ ] Reverse swell uses the previous take once one exists
- [ ] Playback repeats (set to 2 or 3) play the section that many times
- [ ] Stop ends the session cleanly
- [ ] Panic Stop immediately kills all audio/timers
- [ ] Ternary/Rondo replay the saved `A` instead of re-recording it
- [ ] Clear Recordings empties memory; Reset Session returns to idle
- [ ] Reload after a session shows the Restore card; Restore + Start replays
      the saved sections, then records the next one
- [ ] Export takes opens the share sheet on iPhone; the WAVs play
