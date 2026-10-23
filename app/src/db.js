// IndexedDB: stored tiles, tracks, ride recordings and download jobs.
//   tiles      'src/z/x/y' -> {b: Blob | null (no imagery there), n: bytes, t: saved ms, d: imagery date YYMM | null}
//   tilestats  src -> {count, bytes}
//   tracks     {id, name, kind, color, visible, fc, stats, ...}
//   recpoints  [r, i] -> {r, i, t, lat, lon, ele, acc, spd}
//   jobs       {id, ...download job}
//   packs      'area' | 'dem' -> {blob, version, bytes, saved} (the installed area pack)

const DB_NAME = 'dirtscout';
const DB_VERSION = 2;
let dbp = null;

export function openDB() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
        if (!db.objectStoreNames.contains('tilestats')) db.createObjectStore('tilestats');
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('recpoints')) db.createObjectStore('recpoints', { keyPath: ['r', 'i'] });
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs');          // v2: area pack files
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

const prom = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
});

export const prefixRange = (p) => IDBKeyRange.bound(p, p + '￿');

export async function get(store, key) {
  const db = await openDB();
  return prom(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
  return done(tx);
}

export async function del(store, keyOrRange) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(keyOrRange);
  return done(tx);
}

export async function getAll(store, range) {
  const db = await openDB();
  return prom(db.transaction(store).objectStore(store).getAll(range));
}

// ---- tiles ----

export const getTile = (key) => get('tiles', key);

// Stores tiles ({key, b, n, d}) and keeps the per-source counters right (a key already stored is not counted twice).
export async function putTiles(recs) {
  if (!recs.length) return;
  const db = await openDB();
  const tx = db.transaction(['tiles', 'tilestats'], 'readwrite');
  const ts = tx.objectStore('tiles'), ss = tx.objectStore('tilestats');
  const add = new Map();
  let pending = recs.length;
  const now = Date.now();
  for (const r of recs) {
    const src = r.key.slice(0, r.key.indexOf('/'));
    const k = ts.getKey(r.key);
    k.onsuccess = () => {
      if (k.result === undefined) {
        const a = add.get(src) ?? { count: 0, bytes: 0 };
        a.count++; a.bytes += r.n;
        add.set(src, a);
      }
      ts.put({ b: r.b, n: r.n, t: now, d: r.d ?? null }, r.key);
      if (--pending === 0) {
        for (const [s, a] of add) {
          const g = ss.get(s);
          g.onsuccess = () => {
            const cur = g.result ?? { count: 0, bytes: 0 };
            ss.put({ count: cur.count + a.count, bytes: cur.bytes + a.bytes }, s);
          };
        }
      }
    };
  }
  return done(tx);
}

// Keys already stored for one source and zoom.
export async function storedKeys(src, z) {
  const db = await openDB();
  const keys = await prom(db.transaction('tiles').objectStore('tiles').getAllKeys(prefixRange(`${src}/${z}/`)));
  return new Set(keys);
}

export async function tileStats() {
  const db = await openDB();
  const store = db.transaction('tilestats').objectStore('tilestats');
  const [keys, vals] = await Promise.all([prom(store.getAllKeys()), prom(store.getAll())]);
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

// Deletes every stored tile of a source.
export async function deleteSourceTiles(src) {
  const db = await openDB();
  const tx = db.transaction(['tiles', 'tilestats'], 'readwrite');
  tx.objectStore('tiles').delete(prefixRange(`${src}/`));
  tx.objectStore('tilestats').delete(src);
  return done(tx);
}

// Deletes the given keys of one source (an area) and subtracts them from the counters.
export async function deleteTileKeys(src, keys) {
  const db = await openDB();
  const tx = db.transaction(['tiles', 'tilestats'], 'readwrite');
  const ts = tx.objectStore('tiles'), ss = tx.objectStore('tilestats');
  let count = 0, bytes = 0, pending = keys.length;
  if (!pending) return;
  for (const key of keys) {
    const g = ts.get(key);
    g.onsuccess = () => {
      if (g.result) { count++; bytes += g.result.n; ts.delete(key); }
      if (--pending === 0) {
        const s = ss.get(src);
        s.onsuccess = () => {
          const cur = s.result ?? { count: 0, bytes: 0 };
          ss.put({ count: Math.max(0, cur.count - count), bytes: Math.max(0, cur.bytes - bytes) }, src);
        };
      }
    };
  }
  await done(tx);
  return { count, bytes };
}

// Recounts a source's counters by walking its tiles (slow; for repairs).
export async function recountSource(src) {
  const db = await openDB();
  const tx = db.transaction(['tiles', 'tilestats'], 'readwrite');
  let count = 0, bytes = 0;
  const cur = tx.objectStore('tiles').openCursor(prefixRange(`${src}/`));
  cur.onsuccess = () => {
    const c = cur.result;
    if (c) { count++; bytes += c.value.n; c.continue(); }
    else tx.objectStore('tilestats').put({ count, bytes }, src);
  };
  await done(tx);
  return { count, bytes };
}

// ---- ride recording points ----

export async function addRecPoint(p) {
  const db = await openDB();
  const tx = db.transaction('recpoints', 'readwrite');
  tx.objectStore('recpoints').put(p);
  return done(tx);
}

export async function recPoints(r) {
  return getAll('recpoints', IDBKeyRange.bound([r, 0], [r, Infinity]));
}

export const deleteRecPoints = (r) => del('recpoints', IDBKeyRange.bound([r, 0], [r, Infinity]));
