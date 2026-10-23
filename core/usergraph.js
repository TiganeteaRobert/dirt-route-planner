// The rider's own roads (drawn on the map, or rides marked as roads) added to the pack's routing graph before it is
// loaded: each road becomes an edge of class "mine" (green: the rider vouches for it). Its ends join the network at
// the nearest node within 30 m, else at the nearest point of an edge within 30 m (that edge is split there).
// Works on the graph JSON (pipeline/graph_pack.py format); no DOM.
import { decodePolyline, encodePolyline } from './polyline.js';
import { haversine } from './routing.js';

const SNAP_NODE = 30, SNAP_EDGE = 30;
const RAD = Math.PI / 180;

function project(p, a, b) {
  const kx = Math.cos(p[1] * RAD);
  const ax = (a[0] - p[0]) * kx, ay = a[1] - p[1], bx = (b[0] - p[0]) * kx, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return { t, q: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
}

const lineLen = (c) => c.slice(1).reduce((s, p, i) => s + haversine(c[i][0], c[i][1], p[0], p[1]), 0);

/**
 * The AI bundle's graph with only the AI-found edges the model is at least `min` (0-1) sure of (column aic = 100 x its
 * confidence); every other edge stays. Returns the input itself when nothing is left out.
 */
export function filterAiEdges(json, min) {
  const ai = json.classes.indexOf('ai');
  const aic = json.edges.aic;
  if (ai < 0 || !aic) return json;
  const keep = [];
  for (let e = 0; e < json.edges.cls.length; e++) if (json.edges.cls[e] !== ai || aic[e] >= min * 100 - 1e-9) keep.push(e);
  if (keep.length === json.edges.cls.length) return json;
  const pick = (arr) => keep.map((e) => arr[e]);
  return { ...json, edges: Object.fromEntries(Object.entries(json.edges).map(([k, v]) => [k, pick(v)])),
    ids: pick(json.ids), names: pick(json.names), geom: pick(json.geom) };
}

/**
 * json: the graph JSON; roads: [{id, name, coords: [[lon, lat]...], g, gdir, up, dn}].
 * Returns a new JSON object (the input is not changed) and how each road joined: [{id, start, end}] with
 * 'node' | 'split' | 'free'.
 */
export function augmentGraph(json, roads) {
  if (!roads.length) return { json, joins: [] };
  const E = json.edges;
  const cols = Object.fromEntries(Object.entries(E).map(([k, v]) => [k, v.slice()]));
  const lon = json.nodes.lon.slice(), lat = json.nodes.lat.slice();
  const ids = json.ids.slice(), names = json.names.slice(), geom = json.geom.slice();
  const classes = json.classes.includes('mine') ? json.classes : [...json.classes, 'mine'];
  const MINE = classes.indexOf('mine');
  const decoded = new Map();
  const coordsOf = (e) => { if (!decoded.has(e)) decoded.set(e, decodePolyline(geom[e])); return decoded.get(e); };
  const addNode = (p) => { lon.push(Math.round(p[0] * 1e6)); lat.push(Math.round(p[1] * 1e6)); return lon.length - 1; };
  const nodeLL = (n) => [lon[n] / 1e6, lat[n] / 1e6];

  // nearest node, else split the nearest edge; returns {node, how}
  function join(p) {
    let bn = -1, bd = Infinity;
    for (let n = 0; n < lon.length; n++) {
      const d = haversine(p[0], p[1], lon[n] / 1e6, lat[n] / 1e6);
      if (d < bd) { bd = d; bn = n; }
    }
    if (bd <= SNAP_NODE) return { node: bn, how: 'node' };
    let best = null;
    for (let e = 0; e < cols.a.length; e++) {
      const a = nodeLL(cols.a[e]), b = nodeLL(cols.b[e]);
      // cheap test on the end nodes (an edge rarely bends more than ~1 km away from them) before decoding it
      const pad = 0.0006, far = 0.012;
      if (p[0] < Math.min(a[0], b[0]) - far || p[0] > Math.max(a[0], b[0]) + far
        || p[1] < Math.min(a[1], b[1]) - far || p[1] > Math.max(a[1], b[1]) + far) continue;
      const c = coordsOf(e);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of c) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      if (p[0] < minX - pad || p[0] > maxX + pad || p[1] < minY - pad || p[1] > maxY + pad) continue;
      for (let i = 0; i < c.length - 1; i++) {
        const { t, q } = project(p, c[i], c[i + 1]);
        const d = haversine(p[0], p[1], q[0], q[1]);
        if (d < (best?.d ?? SNAP_EDGE)) best = { e, i, t, q, d };
      }
    }
    if (!best) return { node: addNode(p), how: 'free' };
    // split edge best.e at q: the edge keeps a -> new node; a new edge goes new node -> b
    const { e, i, q } = best;
    const c = coordsOf(e);
    const first = [...c.slice(0, i + 1), q], second = [q, ...c.slice(i + 1)];
    const n = addNode(q);
    const share = lineLen(first) / Math.max(1e-6, lineLen(c));
    for (const k of Object.keys(cols)) cols[k].push(cols[k][e]);
    const e2 = cols.a.length - 1;
    cols.b[e] = n;
    cols.a[e2] = n;
    cols.len[e2] = Math.round(cols.len[e] * (1 - share) * 10) / 10;
    cols.len[e] = Math.round(cols.len[e] * share * 10) / 10;
    for (const k of ['up', 'dn']) { cols[k][e2] = Math.round(cols[k][e] * (1 - share)); cols[k][e] = Math.round(cols[k][e] * share); }
    geom[e] = encodePolyline(first);
    geom.push(encodePolyline(second));
    decoded.set(e, first);
    decoded.set(e2, second);
    ids.push(`${ids[e]}+`);
    names.push(names[e]);
    return { node: n, how: 'split' };
  }

  const joins = [];
  for (const r of roads) {
    if (!r.coords || r.coords.length < 2) continue;
    const s = join(r.coords[0]);
    const t = join(r.coords[r.coords.length - 1]);
    const c = [nodeLL(s.node), ...r.coords, nodeLL(t.node)];
    const add = { a: s.node, b: t.node, len: Math.round(lineLen(c) * 10) / 10, cls: MINE, risk: 0, lvl: 0, leg: 0, ex: 100,
      g: r.g ?? -1, gdir: r.gdir ?? 0, up: Math.round(r.up ?? 0), dn: Math.round(r.dn ?? 0), tree: 0, det: 0, tt: 0, pav: 0 };
    for (const k of Object.keys(cols)) cols[k].push(add[k] ?? 0);
    geom.push(encodePolyline(c));
    ids.push(`u:${r.id}`);
    names.push(r.name ?? '');
    joins.push({ id: r.id, start: s.how, end: t.how });
  }
  return { json: { ...json, classes, nodes: { lon, lat }, edges: cols, ids, names, geom }, joins };
}
