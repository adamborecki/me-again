/* ===========================================================
   forms.js
   The musical forms you can pick, plus the helpers that turn a form into
   the plan the UI draws (which sections get recorded vs replayed, where
   you are, what's next).
   =========================================================== */

export const FORMS = [
  { id: 'free',    name: 'Free',      pattern: null,      blurb: 'A new section every time, forever' },
  { id: 'simple',  name: 'Sections',  pattern: 'ABCD',    blurb: 'Four new sections' },
  { id: 'ternary', name: 'Ternary',   pattern: 'ABA',     blurb: 'Statement, contrast, return' },
  { id: 'song',    name: 'Song form', pattern: 'AABA',    blurb: '32-bar song form' },
  { id: 'rondo',   name: 'Rondo 5',   pattern: 'ABACA',   blurb: '5-part rondo' },
  { id: 'rondo7',  name: 'Rondo 7',   pattern: 'ABACABA', blurb: '7-part rondo' },
  { id: 'rondoD',  name: 'Rondo 7 · new D', pattern: 'ABACADA', blurb: 'Rondo with three episodes' },
  { id: 'custom',  name: 'Custom',    pattern: '',        blurb: 'Type your own' },
];

export const DEFAULT_CUSTOM = 'AABACA';

// "a b-a c" -> "ABAC" (letters only, max 26 sections).
export function cleanPattern(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 26);
}

// The pattern for a form id (custom uses the typed text). null = free.
export function patternFor(id, customText) {
  const f = FORMS.find((x) => x.id === id) || FORMS[0];
  if (f.id === 'custom') return cleanPattern(customText) || DEFAULT_CUSTOM;
  return f.pattern;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const labelAt = (pattern, step) =>
  pattern ? pattern[step % pattern.length] : LETTERS[step % LETTERS.length];

// Hue per letter, so A is always the same colour everywhere.
const HUES = [250, 170, 40, 330, 120, 200, 15, 290];
export const hueFor = (label) => HUES[LETTERS.indexOf(label) % HUES.length];

/**
 * Steps to draw, with what happens at each.
 * @param {string|null} pattern  null = free form
 * @param {Set<string>} recorded labels already recorded before `current`
 *                               (or before step 0 when idle)
 * @param {number} current       current step index, or -1 when idle
 * @returns {{step, label, isNew, status: 'done'|'now'|'next'}[]}
 */
export function planSteps(pattern, recorded, current) {
  const known = new Set(recorded);
  const out = [];
  const from = current < 0 ? 0 : current;
  let first, last;
  if (pattern) {
    // The current pass through the form.
    const round = Math.floor(from / pattern.length);
    first = round * pattern.length;
    last = first + pattern.length - 1;
  } else {
    // Free form: a sliding window around where you are.
    first = Math.max(0, from - 2);
    last = from + 3;
  }
  // Steps before `from` in this window are done; their labels are known.
  for (let s = first; s <= last; s++) {
    const label = labelAt(pattern, s);
    if (s < from) {
      out.push({ step: s, label, isNew: false, status: 'done' });
      continue;
    }
    const isNew = !known.has(label);
    known.add(label);
    out.push({ step: s, label, isNew, status: s === current ? 'now' : 'next' });
  }
  return out;
}
