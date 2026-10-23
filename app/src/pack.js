// The area pack: DirtScout's own map + evidence (area.pmtiles, vector), bare-earth elevation (dem.pmtiles, FABDEM
// terrarium) and the routing graph (graph.json). Built on the PC (pipeline/) and served next to the app.
// Installed = the files saved in IndexedDB, so everything in them works in airplane mode; not installed = read from
// the server (HTTP ranges for the .pmtiles).
import { PMTiles, Protocol } from 'pmtiles';
import { addProtocol } from 'maplibre-gl';
import * as db from './db.js';

export const PACK_BASE = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'pack/';
export const PACK_FILES = { area: 'area.pmtiles', dem: 'dem.pmtiles', graph: 'graph.json', samples: 'samples.json' };
const TILE_PACKS = ['area', 'dem'];

const protocol = new Protocol({ metadata: true });
export const packs = { area: null, dem: null };       // PMTiles instances
export const installed = {};                            // name -> {version, bytes, saved}
const jsonCache = {};

// pmtiles Source: the installed Blob, or byte ranges from the server.
class PackSource {
  constructor(name, blob) {
    this.name = name;
    this.blob = blob;
    this.url = PACK_BASE + PACK_FILES[name];
  }

  getKey() { return this.name; }

  async getBytes(offset, length, signal) {
    if (this.blob) return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
    if (navigator.onLine === false) throw new Error('area pack not installed and no network');
    const r = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal, cache: 'no-store' });
    if (r.status === 206) return { data: await r.arrayBuffer(), etag: r.headers.get('etag') ?? undefined };
    if (r.status === 200) return { data: (await r.arrayBuffer()).slice(offset, offset + length) };
    throw new Error(`area pack ${this.name}: HTTP ${r.status}`);
  }
}

function setPack(name, blob) {
  if (!TILE_PACKS.includes(name)) return null;
  const p = new PMTiles(new PackSource(name, blob));
  packs[name] = p;
  protocol.add(p);
  return p;
}

export async function initPacks() {
  addProtocol('pmtiles', protocol.tile);
  for (const name of Object.keys(PACK_FILES)) {
    let rec = null;
    try { rec = await db.get('packs', name); } catch { /* no store yet */ }
    setPack(name, rec?.blob ?? null);
    if (rec) installed[name] = { version: rec.version, bytes: rec.bytes, saved: rec.saved };
  }
}

export const packInstalled = () => Object.keys(PACK_FILES).every((n) => installed[n]);

// pack.json on the server: {version, files: {area: {bytes}, ...}, ...}; null when offline.
export async function fetchManifest() {
  if (navigator.onLine === false) return null;
  try {
    const r = await fetch(`${PACK_BASE}pack.json`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Downloads one pack file completely and keeps it on the phone. onProgress(bytesSoFar, total).
export async function install(name, version, onProgress, signal) {
  const r = await fetch(PACK_BASE + PACK_FILES[name], { cache: 'no-store', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  const rec = { blob, version, bytes: blob.size, saved: Date.now() };
  await db.put('packs', rec, name);
  installed[name] = { version, bytes: blob.size, saved: rec.saved };
  setPack(name, blob);
  delete jsonCache[name];
}

export async function uninstall(name) {
  await db.del('packs', name);
  delete installed[name];
  setPack(name, null);
  delete jsonCache[name];
}

// Raw tile bytes from a pack (used for the elevation tiles), or null.
export async function packTile(name, z, x, y, signal) {
  try {
    const r = await packs[name]?.getZxy(z, x, y, signal);
    return r?.data ?? null;
  } catch {
    return null;
  }
}

// A JSON file of the pack (graph, samples): from the phone when installed, else from the server; null when neither.
export async function loadPackJson(name) {
  if (jsonCache[name]) return jsonCache[name];
  try {
    const rec = await db.get('packs', name);
    if (!rec && navigator.onLine === false) return null;
    const text = rec ? await rec.blob.text() : await (await fetch(PACK_BASE + PACK_FILES[name], { cache: 'no-store' })).text();
    jsonCache[name] = JSON.parse(text);
    return jsonCache[name];
  } catch {
    return null;
  }
}

export const loadGraphJson = () => loadPackJson('graph');

// Vector tiles kept on the phone as a Blob (the owner's AI tracks) under pmtiles://<name>.
class BlobSource {
  constructor(name, blob) { this.name = name; this.blob = blob; }
  getKey() { return this.name; }
  async getBytes(offset, length) { return { data: await this.blob.slice(offset, offset + length).arrayBuffer() }; }
}

export function addBlobTiles(name, blob) {
  protocol.tiles.delete(name);
  protocol.add(new PMTiles(new BlobSource(name, blob)));
}

export function removeBlobTiles(name) {
  protocol.tiles.delete(name);
}
