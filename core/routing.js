// M4 routing on the area pack's graph (pipeline/graph_pack.py): shortest paths with dirt-bike costs, loops within a
// length range with hill climbs, out-and-back rides, route statistics. No DOM: runs on the phone and in Node.
import { decodePolyline } from './polyline.js';

export const CLASSES = ['track', 'path', 'bridleway', 'unclassified', 'residential', 'service', 'living_street', 'road',
  'tertiary', 'secondary', 'primary', 'trunk', 'detected', 'ai', 'gap'];   // keep in step with pipeline/graph_pack.py
// Cost factor by class: a dirt-bike ride prefers tracks over tarmac, and busy roads least of all. Looked up by name,
// because each graph file carries its own class list (and the rider's roads add "mine"). A gap (a stretch the AI's
// tracks were joined across, nothing seen there) costs about twice a track: used when it closes a loop, not for fun.
const CLASS_FACTOR = { track: 0.8, path: 1.0, bridleway: 1.0, unclassified: 1.1, residential: 1.3, service: 1.2,
  living_street: 1.4, road: 1.15, tertiary: 1.5, secondary: 2.0, primary: 2.8, trunk: 4.0, detected: 0.9, ai: 0.85, gap: 1.6,
  mine: 0.75 };
const RISK_FACTOR = [1.0, 1.3, 4.0];
const PAVED_FACTOR = [1.0, 1.8, 1.15];          // unpaved, paved, unknown (when preferring dirt)
const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Point at `dist` metres from (lon, lat) on `bearing` degrees.
export function destination(lon, lat, bearing, dist) {
  const d = dist / R, b = bearing * RAD, f1 = lat * RAD, l1 = lon * RAD;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return [l2 / RAD, f2 / RAD];
}

function bearingDeg(lon1, lat1, lon2, lat2) {
  const f1 = lat1 * RAD, f2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function loadGraph(json) {
  const N = json.nodes.lon.length;
  const E = json.edges;
  const M = E.a.length;
  const lon = Float64Array.from(json.nodes.lon, (v) => v / 1e6);
  const lat = Float64Array.from(json.nodes.lat, (v) => v / 1e6);
  const off = new Int32Array(N + 1);
  for (let e = 0; e < M; e++) { off[E.a[e] + 1]++; off[E.b[e] + 1]++; }
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const fill = off.slice(0, N);
  const adjE = new Int32Array(2 * M), adjD = new Int8Array(2 * M);
  for (let e = 0; e < M; e++) {
    adjE[fill[E.a[e]]] = e; adjD[fill[E.a[e]]++] = 1;
    adjE[fill[E.b[e]]] = e; adjD[fill[E.b[e]]++] = -1;
  }
  const col = (k, T = Float32Array) => T.from(E[k]);
  const classes = json.classes ?? CLASSES;
  return {
    N, M, lon, lat, off, adjE, adjD, classes, classFactor: Float32Array.from(classes, (c) => CLASS_FACTOR[c] ?? 1.2),
    e: {
      a: Int32Array.from(E.a), b: Int32Array.from(E.b), len: col('len'), cls: col('cls', Int8Array), risk: col('risk', Int8Array),
      lvl: col('lvl', Int8Array), leg: col('leg', Int8Array), ex: col('ex', Int8Array), g: col('g'), gdir: col('gdir', Int8Array),
      up: col('up'), dn: col('dn'), tree: col('tree', Int8Array), det: col('det', Int8Array), tt: col('tt', Int8Array),
      pav: E.pav ? Int8Array.from(E.pav) : new Int8Array(M).fill(2),
    },
    ids: json.ids, names: json.names, geom: json.geom, cache: new Map(),
  };
}

// Edge geometry in travel direction.
export function edgeCoords(G, e, dir) {
  let c = G.cache.get(e);
  if (!c) {
    c = decodePolyline(G.geom[e]);
    if (G.cache.size > 4000) G.cache.clear();
    G.cache.set(e, c);
  }
  return dir > 0 ? c : [...c].reverse();
}

// Uphill grade (%) of an edge when ridden in `dir`, or 0 when its steepest stretch goes down that way.
export function uphillGrade(G, e, dir) {
  const g = G.e.g[e];
  return g > 0 && G.e.gdir[e] * dir > 0 ? g : 0;
}

export function makeCost(G, opts = {}, used = null) {
  const { avoidRed = true, allowNoAccess = false, climbs = 0, minClimbGrade = 15, preferDirt = true, reuse = 4 } = opts;
  const E = G.e;
  return (e, dir) => {
    if (E.leg[e] === 2 && !allowNoAccess) return Infinity;
    if (E.risk[e] === 2 && avoidRed) return Infinity;
    let f = RISK_FACTOR[E.risk[e]] * G.classFactor[E.cls[e]];
    if (preferDirt) f *= PAVED_FACTOR[E.pav[e]];
    if (E.leg[e] === 1) f *= 2;
    if (climbs > 0 && uphillGrade(G, e, dir) >= minClimbGrade) f *= 0.55;
    if (used) {
      const u = used.get(e);
      if (u) f *= 1 + reuse * u;
    }
    return E.len[e] * f;
  };
}

// ---- A* shortest path ----
export class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// Path from node s to node t: [{e, dir}] or null. cost(e, dir) -> metres-like cost (>= 0.85 x length).
export function shortestPath(G, s, t, cost, minFactor = 0.85) {
  if (s === t) return [];
  const dist = new Float64Array(G.N).fill(Infinity);
  const prevE = new Int32Array(G.N).fill(-1);
  const prevD = new Int8Array(G.N);
  const done = new Uint8Array(G.N);
  const tl = G.lon[t], tt = G.lat[t];
  const h = (n) => haversine(G.lon[n], G.lat[n], tl, tt) * minFactor;
  const heap = new Heap();
  dist[s] = 0;
  heap.push(h(s), s);
  while (heap.size) {
    const n = heap.pop();
    if (done[n]) continue;
    done[n] = 1;
    if (n === t) break;
    for (let i = G.off[n]; i < G.off[n + 1]; i++) {
      const e = G.adjE[i], dir = G.adjD[i];
      const c = cost(e, dir);
      if (c === Infinity) continue;
      const m = dir > 0 ? G.e.b[e] : G.e.a[e];
      const nd = dist[n] + c;
      if (nd < dist[m]) {
        dist[m] = nd; prevE[m] = e; prevD[m] = dir;
        heap.push(nd + h(m), m);
      }
    }
  }
  if (!done[t]) return null;
  const path = [];
  for (let n = t; n !== s;) {
    const e = prevE[n], dir = prevD[n];
    path.push({ e, dir });
    n = dir > 0 ? G.e.a[e] : G.e.b[e];
  }
  return path.reverse();
}

// Nodes reachable from `start` over edges the cost allows (for snapping waypoints into the same network).
export function reachable(G, start, cost) {
  const seen = new Uint8Array(G.N);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const n = stack.pop();
    for (let i = G.off[n]; i < G.off[n + 1]; i++) {
      const e = G.adjE[i], dir = G.adjD[i];
      if (cost(e, dir) === Infinity) continue;
      const m = dir > 0 ? G.e.b[e] : G.e.a[e];
      if (!seen[m]) { seen[m] = 1; stack.push(m); }
    }
  }
  return seen;
}

// Nodes reachable from `start` as a list (the work grows with the part of the network found, not with the graph).
function component(G, start, cost) {
  const seen = new Uint8Array(G.N);
  const out = [start];
  seen[start] = 1;
  for (let k = 0; k < out.length; k++) {
    const n = out[k];
    for (let i = G.off[n]; i < G.off[n + 1]; i++) {
      const e = G.adjE[i], dir = G.adjD[i];
      if (cost(e, dir) === Infinity) continue;
      const m = dir > 0 ? G.e.b[e] : G.e.a[e];
      if (!seen[m]) { seen[m] = 1; out.push(m); }
    }
  }
  return out;
}

// Where a ride starts: the nearest node on a mapped way (where the car can wait: not an AI track or a gap) from
// which a ride can go far (at least `minNodes` nodes reachable under `cost`, not an island). {node, off: metres away}.
export function startNode(G, lon, lat, cost, minNodes = 300) {
  const skip = ['ai', 'gap'].map((c) => G.classes.indexOf(c));
  const mapped = new Uint8Array(G.N);
  for (let e = 0; e < G.M; e++) {
    if (skip.includes(G.e.cls[e]) || cost(e, 1) === Infinity) continue;
    mapped[G.e.a[e]] = 1;
    mapped[G.e.b[e]] = 1;
  }
  const kx = Math.cos(lat * RAD);
  const ids = [], d2 = [];
  for (let i = 0; i < G.N; i++) {
    if (!mapped[i]) continue;
    const dx = (G.lon[i] - lon) * kx, dy = G.lat[i] - lat;
    ids.push(i);
    d2.push(dx * dx + dy * dy);
  }
  const order = ids.map((_, k) => k).sort((a, b) => d2[a] - d2[b]);
  const island = new Uint8Array(G.N);
  let node = -1, tried = 0;
  for (const k of order) {
    const n = ids[k];
    if (island[n]) continue;
    const c = component(G, n, cost);
    if (c.length >= minNodes) { node = n; break; }
    for (const m of c) island[m] = 1;
    if (++tried >= 200) break;
  }
  if (node < 0 && order.length) node = ids[order[0]];       // only islands nearby: the nearest
  if (node < 0) return null;
  return { node, off: haversine(lon, lat, G.lon[node], G.lat[node]) };
}

// Edges that are the only link between two parts of the network (bridges, in graph terms): a ride that crosses one
// has to come back the same way. Only edges with allowed[e] count. Iterative DFS (Tarjan); edges are told apart by
// id, so two parallel edges are no bridges.
export function bridgeEdges(G, allowed = null) {
  const { N, off, adjE, adjD } = G;
  const tin = new Int32Array(N).fill(-1), low = new Int32Array(N);
  const isBridge = new Uint8Array(G.M);
  const stN = new Int32Array(N), stI = new Int32Array(N), stE = new Int32Array(N);
  let timer = 0;
  for (let r = 0; r < N; r++) {
    if (tin[r] !== -1) continue;
    let sp = 0;
    stN[0] = r; stI[0] = off[r]; stE[0] = -1;
    tin[r] = low[r] = timer++;
    while (sp >= 0) {
      const v = stN[sp];
      if (stI[sp] < off[v + 1]) {
        const i = stI[sp]++;
        const e = adjE[i];
        if (e === stE[sp] || (allowed && !allowed[e])) continue;
        const w = adjD[i] > 0 ? G.e.b[e] : G.e.a[e];
        if (tin[w] === -1) {
          tin[w] = low[w] = timer++;
          sp++;
          stN[sp] = w; stI[sp] = off[w]; stE[sp] = e;
        } else if (tin[w] < low[v]) low[v] = tin[w];
      } else {
        const pe = stE[sp];
        sp--;
        if (sp >= 0) {
          const p = stN[sp];
          if (low[v] < low[p]) low[p] = low[v];
          if (low[v] > tin[p]) isBridge[pe] = 1;
        }
      }
    }
  }
  return isBridge;
}

export function nearestNode(G, lon, lat, mask = null) {
  let best = -1, bd = Infinity;
  const kx = Math.cos(lat * RAD);
  for (let i = 0; i < G.N; i++) {
    if (mask && !mask[i]) continue;
    const dx = (G.lon[i] - lon) * kx, dy = G.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---- statistics of a route ----
export function routeStats(G, path, { minClimbGrade = 15 } = {}) {
  const E = G.e;
  let len = 0, up = 0, dn = 0, maxUp = 0, maxDown = 0, reused = 0, dirt = 0, ai = 0, gapLen = 0, gaps = 0;
  const AI = G.classes.indexOf('ai'), GAP = G.classes.indexOf('gap');
  const byRisk = [0, 0, 0], byLegal = [0, 0, 0];
  const seen = new Map();
  const climbs = [];
  let climb = null;
  let pos = 0;
  for (const { e, dir } of path) {
    const l = E.len[e];
    len += l;
    up += dir > 0 ? E.up[e] : E.dn[e];
    dn += dir > 0 ? E.dn[e] : E.up[e];
    byRisk[E.risk[e]] += l;
    byLegal[E.leg[e]] += l;
    if (E.pav[e] === 0) dirt += l;
    if (E.cls[e] === AI) ai += l;
    else if (E.cls[e] === GAP) { gapLen += l; gaps++; }
    const ug = uphillGrade(G, e, dir);
    const g = E.g[e] > 0 ? E.g[e] : 0;
    if (ug > maxUp) maxUp = ug;
    if (g > 0 && ug === 0 && g > maxDown) maxDown = g;
    if (ug >= minClimbGrade) {
      if (climb) { climb.len += l; climb.grade = Math.max(climb.grade, ug); }
      else climb = { at: pos, len: l, grade: ug };
    } else if (climb) {
      climbs.push(climb); climb = null;
    }
    if (seen.has(e)) reused += l;
    seen.set(e, (seen.get(e) ?? 0) + 1);
    pos += l;
  }
  if (climb) climbs.push(climb);
  const share = (x) => (len ? x / len : 0);
  return {
    len, up, dn, maxUp, maxDown, climbs: climbs.filter((c) => c.len >= 80),
    green: share(byRisk[0]), yellow: share(byRisk[1]), red: share(byRisk[2]),
    restricted: share(byLegal[1]), noAccess: share(byLegal[2]), reused: share(reused), dirt: share(dirt), edges: seen.size,
    ai: share(ai), gapLen, gaps,
  };
}

// The stretches of a route across gaps (joined AI tracks, nothing seen there), each as coordinates.
export function routeGaps(G, path) {
  const GAP = G.classes.indexOf('gap');
  return GAP < 0 ? [] : path.filter((x) => G.e.cls[x.e] === GAP).map((x) => edgeCoords(G, x.e, x.dir));
}

export function routeCoords(G, path) {
  const out = [];
  for (const { e, dir } of path) {
    const c = edgeCoords(G, e, dir);
    out.push(...(out.length ? c.slice(1) : c));
  }
  return out;
}

// Deterministic random numbers (so a seed gives the same set of routes).
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const jaccard = (a, b) => {
  let inter = 0;
  for (const e of a) if (b.has(e)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

// Steep stretches near the start that a route can climb: [{e, dir (uphill), from (bottom node), to (top node), w}].
function climbCandidates(G, start, maxDist, o, cost, mask) {
  const out = [];
  const E = G.e;
  for (let e = 0; e < G.M; e++) {
    if (E.g[e] < o.minClimbGrade || E.len[e] < 80 || !E.gdir[e]) continue;
    const dir = E.gdir[e];
    if (cost(e, dir) === Infinity) continue;
    const from = dir > 0 ? E.a[e] : E.b[e], to = dir > 0 ? E.b[e] : E.a[e];
    if (!mask[from]) continue;
    if (haversine(G.lon[start], G.lat[start], G.lon[from], G.lat[from]) > maxDist) continue;
    out.push({ e, dir, from, to, w: E.g[e] * Math.min(E.len[e], 400) });
  }
  return out;
}

function pickWeighted(items, rnd) {
  let sum = 0;
  for (const it of items) sum += it.w;
  let r = rnd() * sum;
  for (const it of items) if ((r -= it.w) <= 0) return it;
  return items[items.length - 1];
}

// One route through a list of stops; a stop is a node, or a climb {from, to, e, dir} ridden uphill.
function routeThrough(G, stops, o) {
  const used = new Map();
  const cost = makeCost(G, o, used);
  const path = [];
  let at = stops[0];
  for (let i = 1; i < stops.length; i++) {
    const st = stops[i];
    const target = typeof st === 'number' ? st : st.from;
    const leg = shortestPath(G, at, target, cost);
    if (!leg) return null;
    for (const x of leg) { path.push(x); used.set(x.e, (used.get(x.e) ?? 0) + 1); }
    if (typeof st === 'number') at = st;
    else {
      path.push({ e: st.e, dir: st.dir });
      used.set(st.e, (used.get(st.e) ?? 0) + 1);
      at = st.to;
    }
  }
  return path;
}

// Loops and out-and-back rides from `start` (a node), best first: {path, stats, score, fits}. fits = the length is in
// the range; when no route is, the closest few come back with fits false.
// opts: minLen + maxLen (m; else length and tolerance 0.15), shape ('loop' | 'out-back'), climbs (wanted count),
// minClimbGrade, avoidRed, maxYellow (0-1), allowNoAccess, preferDirt (true), count (5), tries (80), seed.
// Two kinds of tries: geometric (a triangle of waypoints around the start) and, when climbs are wanted, climb-seeded
// (real steep stretches near the start, each ridden uphill, plus a far waypoint to reach the length). Waypoints sit
// where a ride can pass through (no dead-end branch it would have to ride back out of).
export function generateRoutes(G, start, opts = {}) {
  const o = { length: 4000, tolerance: 0.15, shape: 'loop', climbs: 0, minClimbGrade: 15, avoidRed: true, maxYellow: 1,
    allowNoAccess: false, preferDirt: true, count: 5, tries: 80, seed: 1, ...opts };
  if (o.minLen != null && o.maxLen != null) {
    o.length = (o.minLen + o.maxLen) / 2;
    o.tolerance = Math.max(0.03, (o.maxLen - o.minLen) / (o.minLen + o.maxLen));
  }
  const lo = o.minLen ?? o.length * (1 - o.tolerance), hi = o.maxLen ?? o.length * (1 + o.tolerance);
  const rnd = mulberry32(o.seed);
  const base = makeCost(G, o);
  const mask = reachable(G, start, base);
  const allowed = new Uint8Array(G.M);
  for (let e = 0; e < G.M; e++) allowed[e] = base(e, 1) === Infinity ? 0 : 1;
  const bridge = bridgeEdges(G, allowed);
  const through = new Uint8Array(G.N);
  let nThrough = 0;
  for (let e = 0; e < G.M; e++) {
    if (!allowed[e] || bridge[e]) continue;
    for (const n of [G.e.a[e], G.e.b[e]]) if (mask[n] && !through[n]) { through[n] = 1; nThrough++; }
  }
  const wmask = nThrough >= 50 ? through : mask;
  const s0 = [G.lon[start], G.lat[start]];
  const cands = o.climbs > 0 ? climbCandidates(G, start, o.length / 3, o, base, mask) : [];
  const found = [];
  // Climb rides may come back down the way they went up, so their reuse penalty is light.
  const tryStops = (stops, reuse = 4) => {
    const oo = { ...o, reuse };
    let path = routeThrough(G, stops, oo);
    if (path && o.shape === 'out-back') {
      const last = stops.at(-1);
      const back = routeThrough(G, [typeof last === 'number' ? last : last.to, start], oo);
      path = back ? [...path, ...back] : null;
    }
    return path && path.length ? { path, stats: routeStats(G, path, o) } : null;
  };
  const err = (r) => Math.abs(r.stats.len / o.length - 1);
  const fits = (r) => r && Math.abs(r.stats.len / o.length - 1) <= o.tolerance;
  for (let t = 0; t < o.tries; t++) {
    const seeded = cands.length > 0 && t % 3 !== 2;
    const theta = rnd() * 360;
    let best = null;
    if (seeded) {
      // climbs in compass order around the start, so the ride makes a loop through them
      const pool = [...cands];
      let climbs = [];
      for (let k = 0; k < Math.min(o.climbs, 3) && pool.length; k++) {
        const c = pickWeighted(pool, rnd);
        climbs.push(c);
        for (let q = pool.length - 1; q >= 0; q--) {
          if (haversine(G.lon[pool[q].from], G.lat[pool[q].from], G.lon[c.from], G.lat[c.from]) < 400) pool.splice(q, 1);
        }
      }
      const rot = rnd() * 360;
      const ang = (c) => (bearingDeg(s0[0], s0[1], G.lon[c.from], G.lat[c.from]) - rot + 360) % 360;
      climbs.sort((a, b) => ang(a) - ang(b));
      while (climbs.length) {
        const plain = tryStops(o.shape === 'loop' ? [start, ...climbs, start] : [start, ...climbs], 1);
        if (!plain) break;
        if (plain.stats.len > o.length * (1 + o.tolerance)) {
          // too long: drop the climb farthest from the start and try again
          let far = 0, fd = -1;
          climbs.forEach((c, k) => {
            const d = haversine(s0[0], s0[1], G.lon[c.from], G.lat[c.from]);
            if (d > fd) { fd = d; far = k; }
          });
          climbs = climbs.filter((_, k) => k !== far);
          continue;
        }
        best = plain;
        if (fits(plain)) break;
        // too short: one more waypoint, tried at a few bearings and distances; keep the best fit
        const missing = o.length - plain.stats.len;
        for (let b = 0; b < 3 && !fits(best); b++) {
          const away = (theta + b * 120) % 360;
          let scale = Math.max(250, missing / 2.6);
          for (let attempt = 0; attempt < 3; attempt++) {
            const w = nearestNode(G, ...destination(s0[0], s0[1], away, scale), wmask);
            const r = tryStops(o.shape === 'loop' ? [start, ...climbs, w, start] : [start, ...climbs, w], 1);
            if (!r) break;
            if (err(r) < err(best)) best = r;
            if (fits(r)) break;
            scale *= Math.max(0.3, Math.min(3, missing / Math.max(50, r.stats.len - plain.stats.len)));
          }
        }
        break;
      }
    } else {
      let scale = o.shape === 'loop' ? o.length / (3 * 1.45) : o.length / (2 * 1.35);
      for (let attempt = 0; attempt < 4; attempt++) {
        let stops;
        if (o.shape === 'loop') {
          const w1 = destination(s0[0], s0[1], theta, scale);
          const w2 = destination(s0[0], s0[1], theta + 60 + (rnd() - 0.5) * 30, scale);
          stops = [start, nearestNode(G, ...w1, wmask), nearestNode(G, ...w2, wmask), start];
        } else {
          stops = [start, nearestNode(G, ...destination(s0[0], s0[1], theta, scale), wmask)];
        }
        const r = tryStops(stops);
        if (!r) break;
        best = r;
        if (fits(r)) break;
        scale /= Math.max(0.3, Math.min(3, r.stats.len / o.length));
      }
    }
    if (!best) continue;
    const st = best.stats;
    if (Math.abs(st.len / o.length - 1) > o.tolerance * 1.5) continue;
    if (st.yellow > o.maxYellow) continue;
    const lack = Math.max(0, o.climbs - st.climbs.length);
    best.score = Math.abs(st.len / o.length - 1) * 4 + st.yellow * 1.0 + st.red * 6 + st.reused * 2.5 + lack * 1.2
      + st.restricted * 1.5 + (o.preferDirt ? (1 - st.dirt) * 0.8 : 0) - Math.min(st.climbs.length, o.climbs) * 0.15
      + (st.len ? (st.gapLen / st.len) * 3 : 0);
    best.fits = st.len >= lo && st.len <= hi;
    best.set = new Set(best.path.map((x) => x.e));
    found.push(best);
  }
  // in the range first; a loop that rides more than a third of itself twice is nearly an out-and-back: shown only to
  // make up three routes
  const backtrack = (r) => (o.shape === 'loop' && r.stats.reused > 0.33 ? 1 : 0);
  found.sort((a, b) => (b.fits - a.fits) || backtrack(a) - backtrack(b) || a.score - b.score);
  const picked = [];
  for (const r of found) {
    if (picked.length && picked[0].fits && !r.fits) break;          // routes in the range only, when there are any
    if (picked.length >= 3 && backtrack(r) > backtrack(picked[0])) break;
    if (picked.every((p) => jaccard(p.set, r.set) < 0.3)) picked.push(r);
    if (picked.length >= (picked[0].fits ? o.count : Math.min(o.count, 3))) break;
  }
  return picked.map(({ path, stats, score, fits }) => ({ path, stats, score, fits }));
}
