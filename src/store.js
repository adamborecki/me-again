/* ===========================================================
   store.js
   Keeps the current session's takes on this device (IndexedDB) so a reload
   doesn't lose them. Best effort: if storage is unavailable (private
   browsing, blocked), every call quietly does nothing. iOS Safari may clear
   a site's storage after ~7 days without a visit, so Export (WAV files) is
   the durable copy.
   =========================================================== */

const DB_NAME = 'me-again';
const STORE = 'takes';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { console.warn('Take storage unavailable', err); return null; });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => d && new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  })).catch((err) => { console.warn('Take storage failed', err); return null; });
}

export function saveTake(label, buffer, order) {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  return tx('readwrite', (s) => s.put({ label, order, sampleRate: buffer.sampleRate, channels, savedAt: Date.now() }, label));
}

export function clearTakes() {
  return tx('readwrite', (s) => s.clear());
}

// Resolves to [{ label, order, sampleRate, channels, savedAt }] in recording order.
export async function loadTakes() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).filter((t) => t && t.channels && t.channels.length)
    .sort((a, b) => a.order - b.order);
}

// Rebuild an AudioBuffer (no AudioContext needed).
export function toAudioBuffer(take) {
  const buf = new AudioBuffer({
    length: take.channels[0].length,
    sampleRate: take.sampleRate,
    numberOfChannels: take.channels.length,
  });
  take.channels.forEach((data, c) => buf.copyToChannel(data, c));
  return buf;
}
