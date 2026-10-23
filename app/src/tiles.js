// Map tiles for MapLibre through two custom protocols:
//   offline://<source>/{z}/{x}/{y}  stored tile -> network (when allowed) -> upscaled stored parent (overzoom) -> empty
//   slope://{z}/{x}/{y}             slope classes computed on the phone from the elevation tiles
import { addProtocol } from 'maplibre-gl';
import { SOURCES, SLOPE_CLASSES } from './config.js';
import { settings } from './settings.js';
import * as db from './db.js';
import { fillTemplate, tileKey, terrariumElevation, lon2x, lat2y, y2lat, metersPerPixel } from '../../core/tilemath.js';

// ---- network state: a tiny circuit breaker so a dead connection in the mountains does not stall every tile ----
const net = { fails: 0, until: 0 };
export const networkAllowed = () => !settings.offlineOnly && navigator.onLine !== false && Date.now() >= net.until;
function netOk() { net.fails = 0; net.until = 0; }
function netFail() {
  net.fails++;
  if (net.fails >= 3) net.until = Date.now() + 30000;
}
window.addEventListener('online', netOk);

const withTimeout = (signal, ms) =>
  (AbortSignal.any && AbortSignal.timeout) ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal;

export function upstreamURL(src, z, x, y) {
  const s = SOURCES[src];
  let url = s.upstream;
  if (s.bing) {
    url = url.replace('{bing}', settings.bingHost === 'ecn' ? `ecn.t${(x + y) % 4}.tiles.virtualearth.net` : 'tiles.virtualearth.net');
  }
  return fillTemplate(url, z, x, y, s.subdomains);
}

export class HttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}

// One tile from its server: {buf, type, none, date}. none = Bing's "no imagery here" placeholder (a PNG instead of
// the usual JPEG); date = Bing's newest capture date in the tile (YYMM), exposed to pages by its CORS headers.
export async function fetchTile(src, z, x, y, signal) {
  const resp = await fetch(upstreamURL(src, z, x, y), { mode: 'cors', credentials: 'omit', signal });
  if (!resp.ok) throw new HttpError(resp.status);
  const s = SOURCES[src];
  const type = resp.headers.get('content-type') || '';
  const buf = await resp.arrayBuffer();
  return {
    buf, type,
    none: !!s.bing && type.includes('png'),
    date: s.bing ? resp.headers.get('x-ve-tilemeta-capturedatemaxyymm') : null,
  };
}

const emptyTile = () => createImageBitmap(new ImageData(1, 1));

// The nearest stored ancestor, cropped and scaled up to a full tile (up to 6 levels: 4 px blown up to 256).
// drawImage with a source rectangle filters with the parent's pixels just outside the crop, so neighbouring
// children meet without seams.
async function overzoom(src, z, x, y) {
  for (let dz = 1; dz <= Math.min(z, 6); dz++) {
    const pz = z - dz, px = x >> dz, py = y >> dz;
    const rec = await db.getTile(tileKey(src, pz, px, py));
    if (!rec?.b) continue;
    const size = 256 >> dz;
    const sx = (x - (px << dz)) * size, sy = (y - (py << dz)) * size;
    try {
      const bmp = await createImageBitmap(rec.b);
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, sx, sy, size, size, 0, 0, 256, 256);
      bmp.close();
      return c.transferToImageBitmap();
    } catch {
      return null;
    }
  }
  return null;
}

function inArea(z, x, y) {
  const [w, s, e, n] = settings.area;
  const lon = ((x + 0.5) / 2 ** z) * 360 - 180, lat = y2lat(y + 0.5, z);
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

const TILE_RE = /^offline:\/\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)/;

async function offlineTile(params, abort) {
  const m = TILE_RE.exec(params.url);
  if (!m) throw new Error(`bad tile url ${params.url}`);
  const src = m[1], z = +m[2], x = +m[3], y = +m[4];
  const s = SOURCES[src];
  const key = tileKey(src, z, x, y);
  const rec = await db.getTile(key);
  if (rec?.b) return { data: await rec.b.arrayBuffer() };
  if (!rec && networkAllowed()) {
    try {
      const t = await fetchTile(src, z, x, y, withTimeout(abort.signal, 10000));
      netOk();
      const keep = settings.saveBrowse && s.offline && inArea(z, x, y);
      if (keep) {
        db.putTiles([{ key, b: t.none ? null : new Blob([t.buf], { type: t.type }), n: t.none ? 0 : t.buf.byteLength, d: t.date }])
          .catch(() => {});
      }
      if (!t.none) return { data: t.buf };
    } catch (e) {
      if (abort.signal.aborted) throw e;
      if (!(e instanceof HttpError)) netFail();
    }
  }
  if (s.kind === 'dem') throw new Error(`elevation tile ${z}/${x}/${y} not stored`);
  return { data: (await overzoom(src, z, x, y)) ?? (await emptyTile()) };
}

// ---- elevation tiles decoded to metres (shared by slope shading and the elevation readout) ----
const demCache = new Map();          // 'z/x/y' -> Promise<Float32Array | null>
const DEM_CACHE_MAX = 48;

async function demBlob(z, x, y, signal) {
  const rec = await db.getTile(tileKey('dem', z, x, y));
  if (rec?.b) return rec.b;
  if (rec || !networkAllowed()) return null;
  try {
    const t = await fetchTile('dem', z, x, y, withTimeout(signal ?? new AbortController().signal, 10000));
    netOk();
    return new Blob([t.buf], { type: t.type });
  } catch (e) {
    if (!(e instanceof HttpError) && !signal?.aborted) netFail();
    return null;
  }
}

async function decodeDem(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Float32Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = terrariumElevation(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  bmp.close();
  return out;
}

export function demTile(z, x, y, signal) {
  const k = `${z}/${x}/${y}`;
  let p = demCache.get(k);
  if (p) {                                // refresh LRU position
    demCache.delete(k); demCache.set(k, p);
    return p;
  }
  p = demBlob(z, x, y, signal).then((b) => (b ? decodeDem(b) : null)).catch(() => null);
  demCache.set(k, p);
  p.then((v) => { if (!v) demCache.delete(k); });
  while (demCache.size > DEM_CACHE_MAX) demCache.delete(demCache.keys().next().value);
  return p;
}

// Ground elevation (m) at a point from the z12 elevation tiles (about 26 m pixels here), or null.
export async function elevationAt(lon, lat) {
  const z = 12;
  const fx = lon2x(lon, z), fy = lat2y(lat, z);
  const x = Math.floor(fx), y = Math.floor(fy);
  const dem = await demTile(z, x, y);
  if (!dem) return null;
  const px = Math.min(255, Math.floor((fx - x) * 256)), py = Math.min(255, Math.floor((fy - y) * 256));
  return dem[py * 256 + px];
}

// ---- slope: degrees per elevation pixel (z <= 12), sampled smoothly for the closer zooms ----
const DEM_MAX_Z = 12;
const slopeCache = new Map();        // 'z/x/y' -> Promise<Float32Array | null>

// Slope in degrees on a 258 x 258 grid: the tile plus one ring from its neighbours, so both the differences and
// the later smoothing reach across tile edges. Elevation is padded by two rings from the neighbouring tiles
// (extrapolated where a neighbour or a corner is missing).
export const SLOPE_W = 258;

function slopeGrid(dem, nb, z, y) {
  const W = 260;
  const P = new Float32Array(W * W);
  const at = (j, i) => (j + 2) * W + i + 2;              // j, i in -2..257
  for (let j = 0; j < 256; j++) P.set(dem.subarray(j * 256, j * 256 + 256), at(j, 0));
  for (let i = 0; i < 256; i++) {
    for (const [j, src, row] of [[-2, nb.n, 254], [-1, nb.n, 255], [256, nb.s, 0], [257, nb.s, 1]]) {
      if (src) P[at(j, i)] = src[row * 256 + i];
    }
    if (!nb.n) { P[at(-1, i)] = 2 * dem[i] - dem[256 + i]; P[at(-2, i)] = 2 * P[at(-1, i)] - dem[i]; }
    if (!nb.s) {
      P[at(256, i)] = 2 * dem[255 * 256 + i] - dem[254 * 256 + i];
      P[at(257, i)] = 2 * P[at(256, i)] - dem[255 * 256 + i];
    }
  }
  for (let j = -2; j < 258; j++) {
    const inside = j >= 0 && j < 256;
    for (const [i, src, col] of [[-2, nb.w, 254], [-1, nb.w, 255], [256, nb.e, 0], [257, nb.e, 1]]) {
      if (src && inside) P[at(j, i)] = src[j * 256 + col];
    }
    if (!nb.w || !inside) { P[at(j, -1)] = 2 * P[at(j, 0)] - P[at(j, 1)]; P[at(j, -2)] = 2 * P[at(j, -1)] - P[at(j, 0)]; }
    if (!nb.e || !inside) { P[at(j, 256)] = 2 * P[at(j, 255)] - P[at(j, 254)]; P[at(j, 257)] = 2 * P[at(j, 256)] - P[at(j, 255)]; }
  }
  const cell2 = 2 * metersPerPixel(y2lat(y + 0.5, z), z);
  const out = new Float32Array(SLOPE_W * SLOPE_W);
  const deg = 180 / Math.PI;
  for (let j = -1; j < 257; j++) {
    for (let i = -1; i < 257; i++) {
      const c = at(j, i);
      const gx = (P[c + 1] - P[c - 1]) / cell2;
      const gy = (P[c + W] - P[c - W]) / cell2;
      out[(j + 1) * SLOPE_W + i + 1] = Math.atan(Math.hypot(gx, gy)) * deg;
    }
  }
  return out;
}

async function slopeFromDem(z, x, y, signal) {
  const dem = await demTile(z, x, y, signal);
  if (!dem) return null;
  const n = 2 ** z;
  const [nN, nS, nW, nE] = await Promise.all([
    y > 0 ? demTile(z, x, y - 1, signal) : null,
    y < n - 1 ? demTile(z, x, y + 1, signal) : null,
    demTile(z, (x - 1 + n) % n, y, signal),
    demTile(z, (x + 1) % n, y, signal),
  ]);
  return slopeGrid(dem, { n: nN, s: nS, w: nW, e: nE }, z, y);
}

function slopeAt(z, x, y, signal) {
  const k = `${z}/${x}/${y}`;
  let p = slopeCache.get(k);
  if (!p) {
    p = slopeFromDem(z, x, y, signal).catch(() => null);
    slopeCache.set(k, p);
    p.then((v) => { if (!v) slopeCache.delete(k); });
    while (slopeCache.size > DEM_CACHE_MAX) slopeCache.delete(slopeCache.keys().next().value);
  }
  return p;
}

const SLOPE_RE = /^slope:\/\/(\d+)\/(\d+)\/(\d+)/;

// Above z12 the tile is a window of the z12 slope grid, sampled bilinearly, so class edges come out smooth
// instead of 26 m blocks (same data, cleaner drawing).
async function slopeTile(params, abort) {
  const m = SLOPE_RE.exec(params.url);
  const z = +m[1], x = +m[2], y = +m[3];
  const dz = Math.max(0, z - DEM_MAX_Z);
  const pz = z - dz, px = x >> dz, py = y >> dz;
  const grid = await slopeAt(pz, px, py, abort.signal);
  if (!grid) return { data: await emptyTile() };
  const size = 256 / (1 << dz);
  const ox = (x - (px << dz)) * size, oy = (y - (py << dz)) * size;
  const img = new ImageData(256, 256);
  const d = img.data;
  const G = SLOPE_W;
  for (let j = 0; j < 256; j++) {
    const fy = oy + (j + 0.5) * (size / 256) - 0.5 + 1;     // +1: the grid starts one ring outside the tile
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let i = 0; i < 256; i++) {
      const fx = ox + (i + 0.5) * (size / 256) - 0.5 + 1;
      const x0 = Math.floor(fx), tx = fx - x0;
      const r0 = y0 * G + x0, r1 = r0 + G;
      const s = (grid[r0] * (1 - tx) + grid[r0 + 1] * tx) * (1 - ty) + (grid[r1] * (1 - tx) + grid[r1 + 1] * tx) * ty;
      let c = null;
      for (const cl of SLOPE_CLASSES) if (s >= cl.min) c = cl.color;
      if (c) {
        const o = (j * 256 + i) * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
      }
    }
  }
  return { data: await createImageBitmap(img) };
}

export function registerProtocols() {
  addProtocol('offline', offlineTile);
  addProtocol('slope', slopeTile);
}
