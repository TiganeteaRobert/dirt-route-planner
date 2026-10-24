// Route builder: the rider's own route through points tapped on the map. Each point holds on to the nearest way of the
// routing graph (anywhere along an edge, not only at junctions) and consecutive points are joined by the best path
// along the network. A path is a list of pieces {e, dir, t0, t1}: edge e ridden in direction dir (1 = from node a to
// b) from fraction t0 to t1 of its length (0 = node a, 1 = node b), so the first and last pieces can be parts of an
// edge. Where no way links the two points (many AI-found tracks are islands), a leg rides the network as far as it can
// and crosses the shortest gap straight: a piece {straight: true, from, to, len}, shown and counted as "no track known".
// X is the segment index of core/investigate.js buildIndex (decoded edge lines and their cumulative lengths).
// No DOM: the phone and the tests use the same code.
import { haversine, Heap } from './routing.js';
import { densify } from './geo.js';

const RAD = Math.PI / 180;
const CELL = 0.002;                 // the cell size of buildIndex (core/investigate.js)

// How the builder joins two points: the way a dirt rider would pick, but nothing is forbidden (the rider tapped where
// they want to go; red and closed ways only cost more). MIN_FACTOR is the lowest factor (the search's lower bound).
const FACTOR = { track: 0.85, path: 1, bridleway: 1, unclassified: 1, residential: 1.15, service: 1.1, living_street: 1.2,
  road: 1.05, tertiary: 1.2, secondary: 1.4, primary: 1.8, trunk: 2.5, detected: 0.95, ai: 1, gap: 1.6, mine: 0.8 };
const MIN_FACTOR = 0.8;

export function traceCost(G) {
  const cf = Float32Array.from(G.classes, (c) => FACTOR[c] ?? 1.2);
  const E = G.e;
  return (e) => E.len[e] * cf[E.cls[e]] * (E.risk[e] === 2 ? 1.6 : E.risk[e] === 1 ? 1.15 : 1)
    * (E.leg[e] === 2 ? 2 : E.leg[e] === 1 ? 1.2 : 1);
}

// Closest point of segment i of edge e to p: {d (m), pos (m along the edge), q [lon, lat]}; positions limited to
// [lo, hi] metres along the edge.
function project(X, e, i, p, kx, ky, lo = -Infinity, hi = Infinity) {
  const c = X.coords[e], cum = X.cum[e];
  const s0 = cum[i], s1 = cum[i + 1];
  if (s1 < lo || s0 > hi) return null;
  const ax = (c[i][0] - p[0]) * kx, ay = (c[i][1] - p[1]) * ky;
  const bx = (c[i + 1][0] - p[0]) * kx, by = (c[i + 1][1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
  const tlo = s1 > s0 ? (lo - s0) / (s1 - s0) : 0, thi = s1 > s0 ? (hi - s0) / (s1 - s0) : 1;
  t = Math.max(0, tlo, Math.min(1, thi, t));
  const pos = s0 + t * (s1 - s0);
  return { d: Math.hypot(ax + t * dx, ay + t * dy), pos,
    q: [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])] };
}

const snapOf = (X, e, r) => {
  const cum = X.cum[e], L = cum[cum.length - 1];
  return { e, t: L > 0 ? Math.min(1, Math.max(0, r.pos / L)) : 0, lon: r.q[0], lat: r.q[1], d: r.d };
};

/**
 * The nearest point of the network to (lon, lat) within maxDist metres: {e, t, lon, lat, d} or null.
 * skip(e) -> true leaves edge e out (e.g. ways the route may not use).
 */
export function snapToNetwork(G, X, lon, lat, maxDist = 300, skip = null) {
  const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
  const r = Math.ceil(maxDist / (CELL * Math.min(kx, ky)));
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  const p = [lon, lat];
  let best = null, be = -1;
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      const a = X.cells.get(x * 100000 + y);
      if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        const e = a[j];
        if (skip && skip(e)) continue;
        const res = project(X, e, a[j + 1], p, kx, ky);
        if (res.d <= maxDist && (!best || res.d < best.d)) { best = res; be = e; }
      }
    }
  }
  return best ? snapOf(X, be, best) : null;
}

// The nearest point to (lon, lat) on the stretches a path rides (a tap on the route line inserts a point there).
export function snapToPieces(X, pieces, lon, lat) {
  const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
  const p = [lon, lat];
  let best = null, be = -1;
  for (const pc of pieces) {
    if (pc.straight) continue;
    const cum = X.cum[pc.e], L = cum[cum.length - 1];
    const lo = Math.min(pc.t0, pc.t1) * L, hi = Math.max(pc.t0, pc.t1) * L;
    for (let i = 0; i < cum.length - 1; i++) {
      const res = project(X, pc.e, i, p, kx, ky, lo, hi);
      if (res && (!best || res.d < best.d)) { best = res; be = pc.e; }
    }
  }
  return best ? snapOf(X, be, best) : null;
}

// Reused search arrays (a generation stamp marks the entries of the current search): no 1-2 MB of new arrays for
// every leg while a point is dragged.
function buffers(G) {
  if (!G.builderBuf || G.builderBuf.stamp.length !== G.N) {
    G.builderBuf = { gen: 0, stamp: new Uint32Array(G.N), done: new Uint32Array(G.N), dist: new Float64Array(G.N),
      prevE: new Int32Array(G.N), prevD: new Int8Array(G.N) };
  }
  return G.builderBuf;
}

/**
 * The best path from snapped point A to snapped point B under cost(e) (metres-like, at least MIN_FACTOR x length; a
 * part of an edge costs its share): pieces [{e, dir, t0, t1}] in riding order, [] when A and B are the same place,
 * null when B cannot be reached.
 */
export function pathBetween(G, A, B, cost) {
  if (A.e === B.e && Math.abs(A.t - B.t) < 1e-9) return [];
  const E = G.e;
  let bestCost = Infinity, best = null;
  if (A.e === B.e) {                              // straight along the shared edge
    const c = cost(A.e);
    if (c < Infinity) {
      bestCost = c * Math.abs(B.t - A.t);
      best = [{ e: A.e, dir: B.t > A.t ? 1 : -1, t0: A.t, t1: B.t }];
    }
  }
  const P = buffers(G);
  const gen = ++P.gen;
  const get = (n) => (P.stamp[n] === gen ? P.dist[n] : Infinity);
  const set = (n, d, e, dir) => { P.stamp[n] = gen; P.dist[n] = d; P.prevE[n] = e; P.prevD[n] = dir; };
  const h = (n) => haversine(G.lon[n], G.lat[n], B.lon, B.lat) * MIN_FACTOR;
  const heap = new Heap();
  // leave A along its edge: towards node a (dir -1) or node b (dir 1); prevE -1 marks these first nodes
  const ca = cost(A.e);
  if (ca < Infinity) {
    for (const [n, c, dir] of [[E.a[A.e], ca * A.t, -1], [E.b[A.e], ca * (1 - A.t), 1]]) {
      if (c < get(n)) { set(n, c, -1, dir); heap.push(c + h(n), n); }
    }
  }
  // reach B along its edge: from node a riding forwards, or from node b riding backwards
  const cb = cost(B.e);
  const ta = E.a[B.e], tb = E.b[B.e];
  const toB = cb < Infinity ? [cb * B.t, cb * (1 - B.t)] : [Infinity, Infinity];
  let endNode = -1, endDir = 0;
  while (heap.size && heap.k[0] < bestCost) {
    const n = heap.pop();
    if (P.done[n] === gen) continue;
    P.done[n] = gen;
    const dn = P.dist[n];
    if (n === ta && dn + toB[0] < bestCost) { bestCost = dn + toB[0]; endNode = n; endDir = 1; }
    if (n === tb && dn + toB[1] < bestCost) { bestCost = dn + toB[1]; endNode = n; endDir = -1; }
    for (let i = G.off[n]; i < G.off[n + 1]; i++) {
      const e = G.adjE[i], dir = G.adjD[i];
      const c = cost(e);
      if (c === Infinity) continue;
      const m = dir > 0 ? E.b[e] : E.a[e];
      const nd = dn + c;
      if (nd < get(m)) { set(m, nd, e, dir); heap.push(nd + h(m), m); }
    }
  }
  if (endNode < 0) return best;
  const pieces = [endDir > 0 ? { e: B.e, dir: 1, t0: 0, t1: B.t } : { e: B.e, dir: -1, t0: 1, t1: B.t }];
  let n = endNode;
  for (let guard = 0; P.prevE[n] !== -1 && guard < G.N; guard++) {
    const e = P.prevE[n], dir = P.prevD[n];
    pieces.push({ e, dir, t0: dir > 0 ? 0 : 1, t1: dir > 0 ? 1 : 0 });
    n = dir > 0 ? E.a[e] : E.b[e];
  }
  const out = P.prevD[n];                          // how the path left A's edge
  pieces.push({ e: A.e, dir: out, t0: A.t, t1: out > 0 ? 1 : 0 });
  return pieces.reverse().filter((p) => Math.abs(p.t1 - p.t0) > 1e-9);
}

// Connected parts of the network (cached on G): id per node, and each part's nodes (nodes[start[c]] .. start[c + 1]).
export function components(G) {
  if (G.parts) return G.parts;
  const parent = new Int32Array(G.N);
  for (let i = 0; i < G.N; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < G.M; e++) {
    const ra = find(G.e.a[e]), rb = find(G.e.b[e]);
    if (ra !== rb) parent[ra] = rb;
  }
  const id = new Int32Array(G.N).fill(-1), root = new Int32Array(G.N).fill(-1);
  let n = 0;
  for (let i = 0; i < G.N; i++) {
    const r = find(i);
    if (root[r] < 0) root[r] = n++;
    id[i] = root[r];
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < G.N; i++) start[id[i] + 1]++;
  for (let c = 0; c < n; c++) start[c + 1] += start[c];
  const fill = start.slice(0, n), nodes = new Int32Array(G.N);
  for (let i = 0; i < G.N; i++) nodes[fill[id[i]]++] = i;
  G.parts = { id, start, nodes };
  return G.parts;
}

// A snapped point at node n (on any edge that touches it).
function atNode(G, n) {
  const i = G.off[n], e = G.adjE[i];
  return { e, t: G.adjD[i] > 0 ? 0 : 1, lon: G.lon[n], lat: G.lat[n], d: 0 };
}

// The closest pair of nodes between two parts of the network [from part a, from part b] (brute force over the
// smaller part's 64 nodes nearest to the other side, against all of the larger part).
function closestNodes(G, pa, pb, nearA, nearB) {
  const { start, nodes } = components(G);
  const list = (c) => nodes.subarray(start[c], start[c + 1]);
  let A = list(pa), B = list(pb), flip = false;
  if (A.length > B.length) { [A, B] = [B, A]; flip = true; }
  const toward = flip ? nearA : nearB;
  const kx = Math.cos(toward[1] * RAD);
  const d2 = (n, p) => ((G.lon[n] - p[0]) * kx) ** 2 + (G.lat[n] - p[1]) ** 2;
  let small = Array.from(A);
  if (small.length > 64) small = small.sort((x, y) => d2(x, toward) - d2(y, toward)).slice(0, 64);
  let best = null, bd = Infinity;
  for (const u of small) {
    const p = [G.lon[u], G.lat[u]];
    for (const v of B) {
      const d = d2(v, p);
      if (d < bd) { bd = d; best = [u, v]; }
    }
  }
  return flip ? [best[1], best[0]] : best;
}

// The largest part of the network (where most rides go).
function mainPart(G) {
  const { start } = components(G);
  if (G.mainPart == null) {
    let best = 0;
    for (let c = 1; c < start.length - 1; c++) if (start[c + 1] - start[c] > start[best + 1] - start[best]) best = c;
    G.mainPart = best;
  }
  return G.mainPart;
}

const nodeDist = (G, [u, v]) => haversine(G.lon[u], G.lat[u], G.lon[v], G.lat[v]);
const straight = (G, u, v) => {
  const from = [G.lon[u], G.lat[u]], to = [G.lon[v], G.lat[v]];
  return { straight: true, from, to, len: haversine(from[0], from[1], to[0], to[1]) };
};

/**
 * One leg from snapped point A to B: pieces along the network, or - when no way links them - the network as far as
 * it goes, with straight pieces across the shortest gaps: straight from A's part to B's part, or, when neither is on
 * the main network and that is shorter, from A's part to the main network and from there to B's part. Never null.
 */
export function leg(G, A, B, cost) {
  const p = pathBetween(G, A, B, cost);
  if (p) return p;
  const { id } = components(G);
  const pa = id[G.e.a[A.e]], pb = id[G.e.a[B.e]], M = mainPart(G);
  const near = [[A.lon, A.lat], [B.lon, B.lat]];
  const direct = closestNodes(G, pa, pb, ...near);
  let hops = [direct];
  if (pa !== M && pb !== M) {
    const toMain = closestNodes(G, pa, M, ...near), fromMain = closestNodes(G, M, pb, ...near);
    if (nodeDist(G, toMain) + nodeDist(G, fromMain) < nodeDist(G, direct)) hops = [toMain, fromMain];
  }
  // A -> (network) -> u0 ~ v0 -> (network) -> u1 ~ v1 -> (network) -> B
  const out = [];
  let at = A;
  for (const [u, v] of hops) {
    out.push(...(pathBetween(G, at, atNode(G, u), cost) ?? []), straight(G, u, v));
    at = atNode(G, v);
  }
  out.push(...(pathBetween(G, at, B, cost) ?? []));
  return out;
}

// Edge e's line between fractions f0 < f1 of its length.
function cut(X, e, f0, f1) {
  const c = X.coords[e], cum = X.cum[e], L = cum[cum.length - 1];
  const s0 = f0 * L, s1 = f1 * L;
  const at = (s) => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const seg = cum[i + 1] - cum[i], t = seg > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / seg)) : 0;
    return [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])];
  };
  const out = [at(s0)];
  for (let i = 1; i < c.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(c[i]);
  out.push(at(s1));
  return out;
}

// The line of one piece, in riding order.
export function pieceCoords(X, p) {
  if (p.straight) return [p.from, p.to];
  const c = cut(X, p.e, Math.min(p.t0, p.t1), Math.max(p.t0, p.t1));
  return p.t1 < p.t0 ? c.reverse() : c;
}

// The line of a path: [[lon, lat], ...].
export function piecesCoords(X, pieces) {
  const out = [];
  for (const p of pieces) {
    const c = pieceCoords(X, p);
    for (let i = out.length ? 1 : 0; i < c.length; i++) out.push(c[i]);
  }
  return out;
}

// What a path rides, in metres: {len, risk [green, yellow, red], legal [ok, restricted, no], dirt, ai, gapLen, gaps,
// off, offs (straight stretches where no track is known: they count as red)}.
export function piecesStats(G, pieces) {
  const E = G.e;
  const AI = G.classes.indexOf('ai'), GAP = G.classes.indexOf('gap');
  const s = { len: 0, risk: [0, 0, 0], legal: [0, 0, 0], dirt: 0, ai: 0, gapLen: 0, gaps: 0, off: 0, offs: 0 };
  for (const p of pieces) {
    if (p.straight) {
      s.len += p.len; s.risk[2] += p.len; s.legal[0] += p.len; s.off += p.len; s.offs++;
      continue;
    }
    const l = E.len[p.e] * Math.abs(p.t1 - p.t0);
    s.len += l;
    s.risk[E.risk[p.e]] += l;
    s.legal[E.leg[p.e]] += l;
    if (E.pav[p.e] === 0) s.dirt += l;
    if (E.cls[p.e] === AI) s.ai += l;
    else if (E.cls[p.e] === GAP) { s.gapLen += l; s.gaps++; }
  }
  return s;
}

// Several stats objects added up.
export function sumStats(list) {
  const s = { len: 0, risk: [0, 0, 0], legal: [0, 0, 0], dirt: 0, ai: 0, gapLen: 0, gaps: 0, off: 0, offs: 0 };
  for (const x of list) {
    for (const k of ['len', 'dirt', 'ai', 'gapLen', 'gaps', 'off', 'offs']) s[k] += x[k];
    for (let i = 0; i < 3; i++) { s.risk[i] += x.risk[i]; s.legal[i] += x.legal[i]; }
  }
  return s;
}

// How far (m) each point of `pts` is from the polyline `ref` (both [[lon, lat], ...]).
function distances(pts, ref) {
  const kx = 111320 * Math.cos(ref[0][1] * RAD), ky = 110540;
  const r = densify(ref, 15);
  return pts.map((p) => {
    let best = Infinity;
    for (const q of r) {
      const d = ((p[0] - q[0]) * kx) ** 2 + ((p[1] - q[1]) * ky) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  });
}

// Largest distance (m) from the samples of `line` to the polyline `ref`.
const strays = (line, ref) => Math.max(0, ...distances(densify(line, 25), ref));

/**
 * Builder points that ride along a given line again (a generated route, a saved one, a track): a point every `every`
 * metres held on to the network within `snap` m, and more where the builder's own way between two points differs from
 * the line - strays more than `tol` m from it, misses a part of it by as much (a dead-end spur the line rides up and
 * back), or is 1 % longer or shorter - split where the line is farthest from that way (else in the middle), again and
 * again, at most `max` extra points.
 * legOf(A, B) -> {pieces, coords} (the caller's memoized leg). Returns {pts, closed} (a loop's end point left out)
 * or null when the line's ends are nowhere near the network.
 */
export function pointsForLine(G, X, coords, legOf, { every = 4000, snap = 40, tol = 25, max = 120 } = {}) {
  const line = densify(coords.map((c) => [c[0], c[1]]), 20);
  const n = line.length;
  if (n < 2) return null;
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + haversine(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  const total = dist[n - 1];
  const at = (d) => {                                      // first sample at or past d metres
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (dist[m] < d) lo = m + 1; else hi = m; }
    return lo;
  };
  const snapped = new Map();
  const point = (k) => {
    if (!snapped.has(k)) snapped.set(k, snapToNetwork(G, X, line[k][0], line[k][1], k === 0 || k === n - 1 ? 150 : snap));
    return snapped.get(k);
  };
  if (!point(0) || !point(n - 1)) return null;
  // a sample near k (between lo and hi) that holds on to the network
  const near = (k, lo, hi) => {
    for (let off = 0; off < 15; off++) {
      for (const c of [k - off, k + off]) if (c > lo && c < hi && point(c)) return c;
    }
    return -1;
  };
  let budget = max;
  const between = (i, j, depth) => {
    if (budget <= 0 || j - i < 3 || depth > 12) return [];
    const L = legOf(point(i), point(j)), part = line.slice(i, j + 1);
    let len = 0;
    for (let k = 1; k < L.coords.length; k++) len += haversine(L.coords[k - 1][0], L.coords[k - 1][1], L.coords[k][0], L.coords[k][1]);
    const want = dist[j] - dist[i];
    // how far each sample of the line is from that way (no way at all: both points on the same spot, the line goes
    // somewhere and comes back - measured from that spot)
    const off = L.coords.length > 1 ? distances(part, L.coords) : part.map((p) => haversine(p[0], p[1], part[0][0], part[0][1]));
    const far = off.indexOf(Math.max(...off));
    if (Math.abs(len - want) <= Math.max(20, 0.01 * want) && off[far] <= tol && (L.coords.length < 2 || strays(L.coords, part) <= tol)) return [];
    // the next point where the way leaves the line most (the tip of a spur it skips), else halfway
    const m = near(off[far] > tol && far > 0 && far < part.length - 1 ? i + far : at((dist[i] + dist[j]) / 2), i, j);
    if (m < 0) return [];
    budget--;
    return [...between(i, m, depth + 1), m, ...between(m, j, depth + 1)];
  };
  const marks = [0];
  for (let d = every; d < total - every / 2; d += every) {
    const k = near(at(d), marks.at(-1), n - 1);
    if (k > 0) marks.push(k);
  }
  marks.push(n - 1);
  const keep = [0];
  for (let k = 1; k < marks.length; k++) keep.push(...between(marks[k - 1], marks[k], 0), marks[k]);
  const closed = total > 200 && haversine(line[0][0], line[0][1], line[n - 1][0], line[n - 1][1]) < 30;
  if (closed) keep.pop();                                   // a loop ends where it started: point 1 closes it
  return { pts: keep.map(point), closed };
}

