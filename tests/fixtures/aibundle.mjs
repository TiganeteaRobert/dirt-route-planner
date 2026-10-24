// A small AI bundle in the pipeline/ai_bundle.py format, for tests: a tiny graph near Marisel with two 'ai' edges and
// their map tiles (ai_tiles.pmtiles, made by make_ai_tiles.py from the same lines), encrypted with a test passphrase
// (never the owner's).
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { encodePolyline } from '../../core/polyline.js';
import { normPass } from '../../core/aicrypt.js';

export const TEST_PASS = 'Test Pass 2468';

// node, edge columns and two AI tracks: a road A-B, a track B-C, AI lines C-D and D-E off the end of the track, and a
// gap E-F the AI tracks were joined across.
const NODES = [[23.0880, 46.6700], [23.0920, 46.6705], [23.0950, 46.6720], [23.0975, 46.6740], [23.1000, 46.6748],
  [23.1012, 46.6760]];
const EDGES = [
  { a: 0, b: 1, cls: 3, len: 310, risk: 0, ex: 80, pav: 1 },
  { a: 1, b: 2, cls: 0, len: 290, risk: 1, ex: 60, pav: 0 },
  { a: 2, b: 3, cls: 13, len: 300, risk: 1, ex: 55, pav: 0, aic: 82, id: 'ai0' },
  { a: 3, b: 4, cls: 13, len: 210, risk: 1, ex: 45, pav: 0, aic: 41, id: 'ai1' },
  { a: 4, b: 5, cls: 14, len: 160, risk: 1, ex: 30, pav: 0, aic: 41, id: 'gap0' },
];
const CLASSES = ['track', 'path', 'bridleway', 'unclassified', 'residential', 'service', 'living_street', 'road', 'tertiary',
  'secondary', 'primary', 'trunk', 'detected', 'ai', 'gap'];

export function bundleData() {
  const cols = Object.fromEntries(['a', 'b', 'len', 'cls', 'risk', 'lvl', 'leg', 'ex', 'g', 'gdir', 'up', 'dn', 'tree', 'det', 'tt', 'pav', 'aic']
    .map((k) => [k, EDGES.map((e) => e[k] ?? (k === 'g' ? -1 : 0))]));
  const geom = EDGES.map((e) => [NODES[e.a], NODES[e.b]]);
  const graph = {
    version: 1, classes: CLASSES,
    nodes: { lon: NODES.map((n) => Math.round(n[0] * 1e6)), lat: NODES.map((n) => Math.round(n[1] * 1e6)) },
    edges: cols, ids: EDGES.map((e, i) => e.id ?? `w${i}:0`), names: EDGES.map(() => ''), geom: geom.map((c) => encodePolyline(c)),
  };
  const ai = EDGES.filter((e) => e.cls === 13);
  const hist = Array.from({ length: 14 }, (_, k) => {
    const t = Math.round((0.3 + 0.05 * k) * 100) / 100;
    const s = ai.filter((e) => e.aic / 100 >= t - 1e-9);
    return [t, s.length, Math.round(s.reduce((m, e) => m + e.len, 0) / 1000)];
  });
  const meta = { v: 2, version: '2026-10-23.test01', built: 1792780000, base: null, stats: { lines: 2, km: 1 }, hist };
  return { meta, graph, line: geom[2] };
}

// The encrypted file as bytes (iterations kept low: the count travels in the header).
export function makeBundle(pass = TEST_PASS, iterations = 2000) {
  const { meta, graph } = bundleData();
  const m = Buffer.from(JSON.stringify(meta)), g = gzipSync(Buffer.from(JSON.stringify(graph)));
  const t = readFileSync(new URL('./ai_tiles.pmtiles', import.meta.url));
  const lens = Buffer.alloc(12);
  lens.writeUInt32BE(m.length, 0); lens.writeUInt32BE(g.length, 4); lens.writeUInt32BE(t.length, 8);
  const plain = Buffer.concat([Buffer.from('DSB2'), lens, m, g, t]);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(normPass(pass), salt, iterations, 32, 'sha256');
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const it = Buffer.alloc(4);
  it.writeUInt32BE(iterations);
  return Buffer.concat([Buffer.from('DSAI'), Buffer.from([1]), salt, iv, it, body]);
}
