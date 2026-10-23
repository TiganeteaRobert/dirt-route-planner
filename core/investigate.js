// M5: investigate a track (any GPX) against the area pack: map-match it to the routing graph, judge every stretch,
// build its elevation profile (climbs and steep descents with km markers), and look for ways around the red
// stretches. No DOM: the phone and the PC tools use the same code.
import { decodePolyline } from './polyline.js';
import { haversine, shortestPath, makeCost, routeStats, routeCoords } from './routing.js';
import { densify } from './geo.js';

const CELL = 0.002;                       // index cell, degrees (~150 x 220 m here)
const RAD = Math.PI / 180;

// Grid index of every graph segment, plus decoded edge coordinates and cumulative lengths.
export function buildIndex(G) {
  const coords = new Array(G.M);
  const cum = new Array(G.M);
  const cells = new Map();
  for (let e = 0; e < G.M; e++) {
    const c = decodePolyline(G.geom[e]);
    coords[e] = c;
    const cl = new Float64Array(c.length);
    for (let i = 1; i < c.length; i++) cl[i] = cl[i - 1] + haversine(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    cum[e] = cl;
    for (let i = 0; i < c.length - 1; i++) {
      const x0 = Math.floor(Math.min(c[i][0], c[i + 1][0]) / CELL), x1 = Math.floor(Math.max(c[i][0], c[i + 1][0]) / CELL);
      const y0 = Math.floor(Math.min(c[i][1], c[i + 1][1]) / CELL), y1 = Math.floor(Math.max(c[i][1], c[i + 1][1]) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = x * 100000 + y;
          let a = cells.get(k);
          if (!a) cells.set(k, (a = []));
          a.push(e, i);
        }
      }
    }
  }
  return { coords, cum, cells };
}

const bearing = (a, b) => {
  const f1 = a[1] * RAD, f2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  return (Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) / RAD + 360) % 360;
};
const lineDiff = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };   // undirected

// Nearest graph segment to each point (within maxDist m), preferring segments that run the same way as the track.
// Returns per point {e, i, t, d} or null.
function matchPoints(G, X, pts, maxDist) {
  const kx = 111320 * Math.cos(pts[0][1] * RAD), ky = 110540;
  const out = new Array(pts.length);
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const h = bearing(pts[Math.max(0, k - 1)], pts[Math.min(pts.length - 1, k + 1)]);
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    let best = null, bc = Infinity;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const a = X.cells.get(x * 100000 + y);
        if (!a) continue;
        for (let j = 0; j < a.length; j += 2) {
          const e = a[j], i = a[j + 1];
          const c = X.coords[e];
          const ax = (c[i][0] - p[0]) * kx, ay = (c[i][1] - p[1]) * ky;
          const bx = (c[i + 1][0] - p[0]) * kx, by = (c[i + 1][1] - p[1]) * ky;
          const dx = bx - ax, dy = by - ay;
          const L2 = dx * dx + dy * dy;
          let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const qx = ax + t * dx, qy = ay + t * dy;
          const d = Math.hypot(qx, qy);
          if (d > maxDist) continue;
          const dh = lineDiff(h, bearing(c[i], c[i + 1]));
          if (dh > 50 && d > 8) continue;                 // a way crossing the track only claims points right on it
          const cost = d + 0.2 * dh;
          if (cost < bc) { bc = cost; best = { e, i, t, d }; }
        }
      }
    }
    out[k] = best;
  }
  return out;
}

// A track that leaves the network can still pass within 30 m of nearby ways (the branches of a serpentine, a parallel
// road). Real riding moves smoothly along the network: 10 m on the ground cannot jump 100 m along a way, or from one
// way to another that does not touch it. Short runs that only fit by such jumps are taken off the network.
function unmatchJumps(G, X, matches, dist) {
  const E = G.e;
  const n = matches.length;
  const pos = matches.map((m) => (m ? X.cum[m.e][m.i] + m.t * (X.cum[m.e][m.i + 1] - X.cum[m.e][m.i]) : 0));
  const jump = new Uint8Array(n);
  for (let k = 1; k < n; k++) {
    const m0 = matches[k - 1], m1 = matches[k];
    if (!m0 || !m1) continue;
    const step = dist[k] - dist[k - 1];
    if (m0.e === m1.e) {
      if (Math.abs(pos[k] - pos[k - 1]) > 3 * step + 25) jump[k] = 1;
      continue;
    }
    const a0 = E.a[m0.e], b0 = E.b[m0.e], a1 = E.a[m1.e], b1 = E.b[m1.e];
    const shared = a0 === a1 || a0 === b1 ? a0 : b0 === a1 || b0 === b1 ? b0 : -1;
    if (shared < 0) { jump[k] = 1; continue; }
    const len0 = X.cum[m0.e].at(-1), len1 = X.cum[m1.e].at(-1);
    const d0 = shared === a0 ? pos[k - 1] : len0 - pos[k - 1];          // distance from each match to the shared node
    const d1 = shared === a1 ? pos[k] : len1 - pos[k];
    if (d0 + d1 > 3 * step + 25) jump[k] = 1;
  }
  let start = 0;
  for (let k = 1; k <= n; k++) {
    const boundary = k === n || jump[k] || !matches[k] !== !matches[k - 1];
    if (!boundary) continue;
    const runLen = dist[k - 1] - dist[start];
    if (matches[start] && runLen < 200 && ((start > 0 && jump[start]) || (k < n && jump[k]))) {
      for (let j = start; j < k; j++) matches[j] = null;
    }
    start = k;
  }
}

// Runs of points on the same edge; a run shorter than `minRun` points between two runs of one edge is absorbed.
function runsOf(matches, minRun = 3) {
  const runs = [];
  for (let k = 0; k < matches.length; k++) {
    const e = matches[k] ? matches[k].e : -1;
    const last = runs.at(-1);
    if (last && last.e === e) last.end = k;
    else runs.push({ e, start: k, end: k });
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r < runs.length - 1; r++) {
      const a = runs[r - 1], b = runs[r], c = runs[r + 1];
      if (b.end - b.start + 1 < minRun && a.e === c.e) {
        a.end = c.end;
        runs.splice(r, 2);
        r--;
      }
    }
  }
  return runs;
}

function smooth(v, sigma) {
  if (sigma <= 0 || v.length < 3) return v.slice();
  const r = Math.ceil(sigma * 3), w = [];
  for (let i = -r; i <= r; i++) w.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0, ws = 0;
    for (let j = -r; j <= r; j++) {
      const k = Math.min(v.length - 1, Math.max(0, i + j));
      s += v[k] * w[j + r]; ws += w[j + r];
    }
    out[i] = s / ws;
  }
  return out;
}

// Climbs or descents: stretches whose 50 m grade stays beyond `min` %, at least 50 m long.
function steepStretches(dist, elev, min, sign) {
  const out = [];
  let cur = null;
  for (let i = 0; i < dist.length; i++) {
    let j = i;
    while (j < dist.length - 1 && dist[j] - dist[i] < 50) j++;
    const g = dist[j] > dist[i] ? ((elev[j] - elev[i]) / (dist[j] - dist[i])) * 100 * sign : 0;
    if (g >= min) {
      if (!cur) cur = { from: dist[i], to: dist[j], max: g, rise: 0 };
      cur.to = Math.max(cur.to, dist[j]);
      cur.max = Math.max(cur.max, g);
    } else if (cur && dist[i] > cur.to) {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  for (const s of out) {
    const i0 = dist.findIndex((d) => d >= s.from), i1 = dist.findIndex((d) => d >= s.to);
    s.rise = Math.abs(elev[i1 < 0 ? elev.length - 1 : i1] - elev[i0]);
    s.avg = (s.rise / Math.max(1, s.to - s.from)) * 100;
  }
  return out.filter((s) => s.to - s.from >= 50);
}

/**
 * coords: [[lon, lat], ...] of the track. elevAt: async (lon, lat) => metres | null (optional).
 * Returns {length, segments, stretches, profile, verdict, alternatives}.
 */
export async function investigate(G, X, coords, { elevAt = null, minClimb = 15, maxDist = 30 } = {}) {
  const pts = densify(coords.map((c) => [c[0], c[1]]), 10);
  const dist = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) dist[i] = dist[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  const matches = matchPoints(G, X, pts, maxDist);
  unmatchJumps(G, X, matches, dist);
  const runs = runsOf(matches);

  // --- stretches with their verdicts
  const E = G.e;
  const segments = runs.map((r) => {
    const from = dist[r.start], to = dist[r.end];
    if (r.e < 0) return { from, to, len: to - from, e: null, risk: 2, why: 'not on any mapped way', start: r.start, end: r.end };
    const pa = matches[r.start], pb = matches[r.end];
    const posA = X.cum[r.e][pa.i] + pa.t * (X.cum[r.e][pa.i + 1] - X.cum[r.e][pa.i]);
    const posB = X.cum[r.e][pb.i] + pb.t * (X.cum[r.e][pb.i + 1] - X.cum[r.e][pb.i]);
    const dir = posB >= posA ? 1 : -1;
    const g = E.g[r.e];
    const uphill = g > 0 && E.gdir[r.e] * dir > 0;
    return {
      from, to, len: to - from, e: r.e, dir, cls: G.classes[E.cls[r.e]], name: G.names[r.e] || '', id: G.ids[r.e],
      risk: E.risk[r.e], legal: E.leg[r.e], exists: E.ex[r.e], grade: g > 0 ? g : null, uphill, det: E.det[r.e], tree: E.tree[r.e],
      start: r.start, end: r.end,
    };
  });

  // --- elevation profile along the track itself
  let profile = null;
  if (elevAt) {
    const raw = new Float64Array(pts.length);
    let ok = 0;
    for (let i = 0; i < pts.length; i++) {
      const v = await elevAt(pts[i][0], pts[i][1]);
      raw[i] = v ?? NaN;
      if (v != null) ok++;
    }
    if (ok > pts.length * 0.8) {
      for (let i = 0; i < raw.length; i++) if (!Number.isFinite(raw[i])) raw[i] = i ? raw[i - 1] : raw.find(Number.isFinite);
      const elev = smooth(raw, 3);              // ~30 m: same smoothing as the pack's grades
      let up = 0, down = 0;
      for (let i = 1; i < elev.length; i++) { const d = elev[i] - elev[i - 1]; if (d > 0) up += d; else down -= d; }
      profile = {
        dist: Array.from(dist, (d) => Math.round(d)), elev: Array.from(elev, (v) => Math.round(v * 10) / 10), up, down,
        min: Math.min(...elev), max: Math.max(...elev),
        climbs: steepStretches(dist, elev, minClimb, 1), descents: steepStretches(dist, elev, minClimb + 5, -1),
      };
    }
  }

  // --- merged risky stretches (red, or not mapped), and legal problems
  const stretches = [];
  for (const s of segments) {
    const bad = s.risk === 2 && (s.e === null ? s.len >= 40 : true);
    if (!bad && !(s.legal === 2)) continue;
    const kind = s.e === null ? 'unmapped' : s.risk === 2 ? 'red' : 'legal';
    const last = stretches.at(-1);
    if (last && last.kind === kind && s.from - last.to < 150) { last.to = s.to; last.parts.push(s); }
    else stretches.push({ kind, from: s.from, to: s.to, parts: [s] });
  }

  // --- ways around each red / unmapped stretch: from the mapped way before it to the mapped way after it
  const alternatives = [];
  const cost = makeCost(G, { avoidRed: true });
  for (const st of stretches.filter((x) => x.kind !== 'legal')) {
    const before = [...segments].reverse().find((s) => s.e !== null && s.to <= st.from + 1 && s.risk < 2);
    const after = segments.find((s) => s.e !== null && s.from >= st.to - 1 && s.risk < 2);
    if (!before || !after) continue;
    const a = before.dir > 0 ? E.b[before.e] : E.a[before.e];
    const b = after.dir > 0 ? E.a[after.e] : E.b[after.e];
    if (a === b) continue;
    const path = shortestPath(G, a, b, cost);
    if (!path || !path.length) continue;
    const stats = routeStats(G, path, { minClimbGrade: minClimb });
    const original = after.from - before.to;
    alternatives.push({ fromKm: before.to / 1000, toKm: after.from / 1000, original, stats, extra: stats.len - original,
      coords: routeCoords(G, path) });
  }

  const total = dist[dist.length - 1] || 0;
  const share = (pred) => segments.filter(pred).reduce((s, x) => s + x.len, 0) / Math.max(1, total);
  const unmapped = share((s) => s.e === null);
  const red = share((s) => s.e !== null && s.risk === 2);
  const yellow = share((s) => s.e !== null && s.risk === 1);
  const steep = profile ? Math.max(0, ...profile.climbs.map((c) => c.max), ...profile.descents.map((c) => c.max)) : 0;
  const verdict = red > 0.02 || unmapped > 0.05 || stretches.some((s) => s.kind !== 'legal' && s.to - s.from > 150) ? 'red'
    : yellow > 0.3 || steep > 30 || stretches.length ? 'yellow' : 'green';
  return {
    length: total, points: pts, dist: Array.from(dist), segments, stretches, profile, alternatives,
    shares: { green: share((s) => s.e !== null && s.risk === 0), yellow, red, unmapped,
      legalNo: share((s) => s.legal === 2) },
    verdict,
  };
}
