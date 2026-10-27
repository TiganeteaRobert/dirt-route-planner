// The owner's private layer: tracks DirtScout's own model found in Esri imagery that no map has, and a routing graph
// that includes them (pipeline/ai_bundle.py). pack/ai.enc sits next to the public pack, encrypted; the passphrase opens
// it once, then its parts stay on the phone (IndexedDB 'packs': 'ai' = meta + passphrase, 'ai-tiles' = the map's
// vector tiles, 'ai-graph' = the gzipped graph, read only when a route is planned) and work offline.
import * as db from './db.js';
import { PACK_BASE } from './pack.js';
import { decryptBundle, gunzipJson, normPass, WrongPassphrase } from '../../core/aicrypt.js';

export const AI_FILE = 'ai.enc';
// What the phone keeps: 2 = map tiles + graph; 3 = the same, from a graph with every junction in its own place and
// the gaps joined (a format-2 graph shared junction ids between far-apart places: its routes jumped across the map);
// 4 = the same for the area widened west (2026-10-27). A stored file of another format is fetched again with the saved
// passphrase (main.js, refreshAi).
export const AI_FORMAT = 4;
const KEYS = ['ai', 'ai-tiles', 'ai-graph'];
let graphCache = null;

async function fetchBundle(onProgress) {
  if (navigator.onLine === false) throw new Error('no network: the AI file downloads once, then works offline');
  let r;
  try {
    r = await fetch(PACK_BASE + AI_FILE, { cache: 'no-store' });
  } catch {
    throw new Error('no network: the AI file downloads once, then works offline');
  }
  if (r.status === 404) throw new Error('there is no AI file on the server yet');
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress?.(got, total);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// Downloads and opens the bundle; keeps it (and the passphrase, for one-tap updates) on the phone.
// Returns {meta, tiles: Blob}.
export async function unlock(pass, onProgress) {
  const buf = await fetchBundle(onProgress);
  let b;
  try {
    b = await decryptBundle(buf, pass);
  } catch (e) {
    if (e instanceof WrongPassphrase) throw new Error('wrong passphrase');
    throw e;
  }
  const saved = Date.now();
  const tiles = new Blob([b.tiles], { type: 'application/octet-stream' });
  await db.put('packs', { blob: tiles, version: b.meta.version, bytes: tiles.size, saved }, 'ai-tiles');
  await db.put('packs', { blob: new Blob([b.graphGz]), version: b.meta.version, bytes: b.graphGz.byteLength, saved }, 'ai-graph');
  await db.put('packs', { format: AI_FORMAT, meta: b.meta, version: b.meta.version, saved, pass: normPass(pass) }, 'ai');
  graphCache = null;
  return { meta: b.meta, tiles };
}

// The same file again with the saved passphrase (after a new one was published, or to move to a new format).
export async function update(onProgress) {
  const rec = await db.get('packs', 'ai');
  if (!rec?.pass) throw new Error('unlock it first');
  return unlock(rec.pass, onProgress);
}

// {meta, tiles: Blob} when unlocked; {stale: true} when an older format is stored (update() replaces it); else null.
export async function loadStored() {
  try {
    const rec = await db.get('packs', 'ai');
    if (!rec) return null;
    const t = rec.format === AI_FORMAT ? await db.get('packs', 'ai-tiles') : null;
    return t ? { meta: rec.meta, tiles: t.blob } : { stale: true };
  } catch {
    return null;
  }
}

// The routing graph with the AI tracks, read and kept in memory the first time a route needs it.
export async function loadAiGraph() {
  if (graphCache) return graphCache;
  const rec = await db.get('packs', 'ai-graph');
  if (!rec) return null;
  graphCache = await gunzipJson(rec.blob);
  return graphCache;
}

export async function removeStored() {
  graphCache = null;
  for (const k of KEYS) await db.del('packs', k);
}
