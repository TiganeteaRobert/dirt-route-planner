// A small made-up network for the routing tests: a 9 x 9 grid of tracks 500 m apart, a dead-end branch east of it,
// an island 60 m from its south-west corner (a way joined to nothing) and an AI track north of it, reached across a
// gap at one end and joined directly at the other. riskOf(a, b, cls) sets an edge's risk class (default: tracks
// green, the rest yellow).
import { loadGraph, haversine } from '../../core/routing.js';
import { encodePolyline } from '../../core/polyline.js';

export const CLASSES = ['track', 'path', 'bridleway', 'unclassified', 'residential', 'service', 'living_street', 'road', 'tertiary',
  'secondary', 'primary', 'trunk', 'detected', 'ai', 'gap'];
export const LON0 = 23.30, LAT0 = 46.60, DLON = 500 / 76500, DLAT = 500 / 111200;

export function network({ riskOf = null } = {}) {
  const lon = [], lat = [], E = [];
  const node = (x, y) => { lon.push(LON0 + x * DLON); lat.push(LAT0 + y * DLAT); return lon.length - 1; };
  const id = [];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) id.push(node(x, y));
  const at = (x, y) => id[y * 9 + x];
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    if (x < 8) E.push([at(x, y), at(x + 1, y), 'track']);
    if (y < 8) E.push([at(x, y), at(x, y + 1), 'track']);
  }
  // a dead-end branch east of the grid: 3 edges
  let prev = at(8, 4);
  for (let k = 1; k <= 3; k++) { const n = node(8 + k, 4); E.push([prev, n, 'track']); prev = n; }
  const branchEnd = prev;
  // an island 60 m from the grid's corner (0, 0): two nodes joined to nothing else
  const i1 = node(-0.12, -0.12), i2 = node(-0.8, -0.12);
  E.push([i1, i2, 'unclassified']);
  // an AI track north of the grid, joined to it by a gap at one end and directly at the other
  const a1 = node(2, 8.4), a2 = node(6, 8.4);
  E.push([at(2, 8), a1, 'gap'], [a1, a2, 'ai'], [a2, at(6, 8), 'ai']);
  const json = {
    version: 1, classes: CLASSES, nodes: { lon: lon.map((v) => Math.round(v * 1e6)), lat: lat.map((v) => Math.round(v * 1e6)) },
    edges: { a: [], b: [], len: [], cls: [], risk: [], lvl: [], leg: [], ex: [], g: [], gdir: [], up: [], dn: [], tree: [], det: [], tt: [], pav: [], aic: [] },
    ids: [], names: [], geom: [],
  };
  E.forEach(([a, b, cls], k) => {
    const c = [[lon[a], lat[a]], [lon[b], lat[b]]];
    const cols = json.edges;
    cols.a.push(a); cols.b.push(b); cols.len.push(Math.round(haversine(...c[0], ...c[1]) * 10) / 10);
    cols.cls.push(CLASSES.indexOf(cls)); cols.risk.push(riskOf?.(a, b, cls) ?? (cls === 'track' ? 0 : 1));
    for (const k2 of ['lvl', 'leg', 'gdir', 'up', 'dn', 'tree', 'det', 'tt', 'pav']) cols[k2].push(0);
    cols.ex.push(60); cols.g.push(-1); cols.aic.push(cls === 'ai' || cls === 'gap' ? 70 : 0);
    json.ids.push(`e${k}`); json.names.push(''); json.geom.push(encodePolyline(c));
  });
  return { G: loadGraph(json), at, branchEnd, island: [i1, i2] };
}
