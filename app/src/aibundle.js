// The owner's private layer: tracks DirtScout's own model found in Esri imagery that no map has, and a routing graph
// that includes them (pipeline/ai_bundle.py). pack/ai.enc sits next to the public pack, encrypted; the passphrase opens
// it once, then the decrypted bundle stays on the phone (IndexedDB 'packs' / 'ai') and works offline.
import * as db from './db.js';
import { PACK_BASE } from './pack.js';
import { decryptBundle, normPass, WrongPassphrase } from '../../core/aicrypt.js';

export const AI_FILE = 'ai.enc';

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

// Downloads and opens the bundle; keeps it (and the passphrase, for one-tap updates) on the phone. Returns the bundle.
export async function unlock(pass, onProgress) {
  const buf = await fetchBundle(onProgress);
  let res;
  try {
    res = await decryptBundle(buf, pass);
  } catch (e) {
    if (e instanceof WrongPassphrase) throw new Error('wrong passphrase');
    throw e;
  }
  const { text, data } = res;
  await db.put('packs', { blob: new Blob([text], { type: 'application/json' }), version: data.version, bytes: text.length,
    saved: Date.now(), pass: normPass(pass) }, 'ai');
  return data;
}

// Same file again with the saved passphrase (after a new one was published).
export async function update(onProgress) {
  const rec = await db.get('packs', 'ai');
  if (!rec?.pass) throw new Error('unlock it first');
  return unlock(rec.pass, onProgress);
}

export async function loadStored() {
  try {
    const rec = await db.get('packs', 'ai');
    return rec ? JSON.parse(await rec.blob.text()) : null;
  } catch {
    return null;
  }
}

export const removeStored = () => db.del('packs', 'ai');
