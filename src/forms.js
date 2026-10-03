/* ===========================================================
   forms.js
   The musical forms you can pick, plus the helpers that turn a form into
   the plan the UI draws (which sections get recorded vs replayed, where
   you are, what's next).
   =========================================================== */

/* A pattern is a list of section labels ("tokens"): a letter, upper or
   lower case, plus any number of ticks (primes). Every distinct token is its
   own take: A, a and A' are each recorded once, and a token that comes back
   replays its take. So rounded binary ||: A :||: B A' :|| plays as
   A A B A' B A': record A, replay A, record B, record A', replay B, replay A'.
   `shown` is how the form is written (with repeat signs) when that differs
   from the played-out order. */

export const DEFAULT_CUSTOM = "A A B A'";

// "aabA’ b" -> ["a", "a", "b", "A'", "b"]. Ticks may be ' ’ ′ (iPhone types ’)
// and ″ counts as two. Anything else is ignored. Max 32 sections.
export function parsePattern(text) {
  const norm = String(text || '').replace(/[’′‘`´]/g, "'").replace(/″/g, "''");
  return (norm.match(/[A-Za-z]'*/g) || []).slice(0, 32);
}

// Tidy display of typed text: "aabA’" -> "a a b A'".
export const cleanPattern = (text) => parsePattern(text).join(' ');

const p = parsePattern;
export const FORMS = [
  { id: 'free',    name: 'Free',           pattern: null,              blurb: 'A new section every time, forever' },
  { id: 'simple',  name: 'Sections',       pattern: p('ABCD'),         blurb: 'Four new sections' },
  { id: 'ternary', name: 'Ternary',        pattern: p('ABA'),          blurb: 'Statement, contrast, return' },
  { id: 'rbinary', name: 'Rounded binary', pattern: p("A A B A' B A'"), shown: "||: A :||: B A' :||", blurb: 'Both halves repeated; A comes back varied' },
  { id: 'song',    name: 'Song form',      pattern: p('AABA'),         blurb: '32-bar song form' },
  { id: 'rondo',   name: 'Rondo 5',        pattern: p('ABACA'),        blurb: '5-part rondo' },
  { id: 'rondo7',  name: 'Rondo 7',        pattern: p('ABACABA'),      blurb: '7-part rondo' },
  { id: 'rondoD',  name: 'Rondo 7 · new D', pattern: p('ABACADA'),     blurb: 'Rondo with three episodes' },
  { id: 'custom',  name: 'Custom',         pattern: [],                blurb: "Type your own: upper/lower case, ticks (A')" },
];

// Letter case for the presets: capitals for sections (A B A'), lower case
// for phrases (a b a'). Custom patterns keep whatever case was typed.
export const toCase = (label, lower) => (lower ? label[0].toLowerCase() + label.slice(1) : label);

// The pattern for a form id (custom uses the typed text). null = free.
export function patternFor(id, customText, lower = false) {
  const f = FORMS.find((x) => x.id === id) || FORMS[0];
  if (f.id === 'custom') {
    const typed = parsePattern(customText);
    return typed.length ? typed : parsePattern(DEFAULT_CUSTOM);
  }
  return f.pattern && f.pattern.map((t) => toCase(t, lower));
}

// How a form is written (repeat signs and all), in the chosen case.
export function shownFor(f, lower = false) {
  if (!f.shown) return null;
  return lower ? f.shown.replace(/[A-Z]/g, (c) => c.toLowerCase()) : f.shown;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Free form (pattern null) makes up letters; `lower` picks their case.
export const labelAt = (pattern, step, lower = false) =>
  pattern ? pattern[step % pattern.length] : toCase(LETTERS[step % LETTERS.length], lower);

// Hue per letter family, so A, a and A' all share A's colour.
const HUES = [250, 170, 40, 330, 120, 200, 15, 290];
export const hueFor = (label) => HUES[LETTERS.indexOf(String(label)[0].toUpperCase()) % HUES.length];

/**
 * Steps to draw, with what happens at each.
 * @param {string|null} pattern  null = free form
 * @param {Set<string>} recorded labels already recorded before `current`
 *                               (or before step 0 when idle)
 * @param {number} current       current step index, or -1 when idle
 * @param {boolean} lower      free form only: make up lower-case letters
 * @returns {{step, label, isNew, status: 'done'|'now'|'next'}[]}
 */
export function planSteps(pattern, recorded, current, lower = false) {
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
    const label = labelAt(pattern, s, lower);
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
