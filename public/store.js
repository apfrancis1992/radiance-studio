/* store.js -- the takes this browser made, in IndexedDB.
 *
 * A take is the wav and everything that made it: the words, the description, the length, the
 * denoiser's settings, and the seed the server answers with in `X-Seed`. The seed is the reason the
 * history is worth keeping -- the same seed, words and length give the same song again on the same
 * deployment, so a take you liked is one click from reproducible and a take you did not can be
 * rerolled with everything else held fixed.
 *
 * The audio is kept as a Blob in the same record, which is why there is an eviction pass: stereo
 * 44.1 kHz 16-bit is about 10.4 MB a minute, so a six minute song is 63 MB.
 */

const NAME = 'radiance-studio';
const TAKES = 'takes';
const VERSION = 1;

/** Take records older than this many, or heavier in total, are dropped oldest first (a starred
 *  take is never dropped). */
export const KEEP_TAKES = 24;
export const KEEP_BYTES = 400 * 1024 * 1024;

export function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TAKES)) db.createObjectStore(TAKES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is open in another tab'));
  });
}

function ask(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const store = (db, mode) => db.transaction(TAKES, mode).objectStore(TAKES);

/** Newest first. The blobs come along: the list is small, and every row of the list needs its
 *  size and its download link. */
export async function takes(db) {
  const all = await ask(store(db, 'readonly').getAll());
  return all.sort((a, b) => b.ts - a.ts);
}

export const put = (db, take) => ask(store(db, 'readwrite').put(take));
export const remove = (db, id) => ask(store(db, 'readwrite').delete(id));
export const wipe = (db) => ask(store(db, 'readwrite').clear());

/** Keep the newest KEEP_TAKES takes, and no more than KEEP_BYTES of audio between them. */
export async function evict(db) {
  const list = await takes(db);
  const doomed = [];
  let bytes = 0, count = 0;
  for (const t of list) {
    if (t.starred) continue;
    if (count >= KEEP_TAKES || bytes + (t.bytes || 0) > KEEP_BYTES) doomed.push(t.id);
    else { count += 1; bytes += t.bytes || 0; }
  }
  for (const id of doomed) await remove(db, id);
  return doomed.length;
}

/** Roughly what the browser says this origin is holding. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: used, quota } = await navigator.storage.estimate();
  return { used, quota };
}
