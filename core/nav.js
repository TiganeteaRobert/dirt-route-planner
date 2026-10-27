// Riding a route (no DOM): where the rider is on the line, the turns a rider has to take where the route meets other
// ways, and what is left (distance, climb). The phone's navigation (app/src/nav.js) and the tests use the same code.
import { haversine, bearing } from './geo.js';

const RAD = Math.PI / 180;
const CELL = 0.002;                        // the line's grid cells: the same cells as core/investigate.js buildIndex
const cellKey = (x, y) => x * 100000 + y;

// from -> to, folded into (-180, 180]: + = to the right
export function turnAngle(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * A route ready to ride: {coords, cum (metres from the start at each vertex), len, closed (ends where it starts),
 * cells (grid cell -> its segments)}. Repeated points are dropped.
 */
export function prepareRoute(coords) {
  const c = [];
  for (const p of coords) if (!c.length || haversine(c[c.length - 1], p) > 0.3) c.push([p[0], p[1]]);
  const n = c.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversine(c[i - 1], c[i]);
  const cells = new Map();
  for (let i = 0; i < n - 1; i++) {
    const x0 = Math.floor(Math.min(c[i][0], c[i + 1][0]) / CELL), x1 = Math.floor(Math.max(c[i][0], c[i + 1][0]) / CELL);
    const y0 = Math.floor(Math.min(c[i][1], c[i + 1][1]) / CELL), y1 = Math.floor(Math.max(c[i][1], c[i + 1][1]) / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = cellKey(x, y);
        let a = cells.get(k);
        if (!a) cells.set(k, (a = []));
        a.push(i);
      }
    }
  }
  return { coords: c, cum, len: n ? cum[n - 1] : 0, closed: n > 2 && haversine(c[0], c[n - 1]) < 50, cells };
}

// The vertex index i with cum[i] <= s < cum[i + 1].
function segAt(R, s) {
  const { cum } = R;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m; else hi = m;
  }
  return lo;
}

// The point s metres along the route.
export function pointAt(R, s) {
  const c = R.coords;
  if (c.length < 2 || s <= 0) return c[0];
  if (s >= R.len) return c[c.length - 1];
  const i = segAt(R, s);
  const span = R.cum[i + 1] - R.cum[i];
  const t = span > 0 ? (s - R.cum[i]) / span : 0;
  return [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])];
}

// The way the route heads at s (over the next `span` metres; the last ones near the end).
export function bearingAt(R, s, span = 25) {
  const a = Math.min(s, R.len - span);
  return bearing(pointAt(R, Math.max(0, a)), pointAt(R, Math.max(0, a) + span));
}

// The line from a to b metres along the route.
export function sliceRoute(R, a, b) {
  a = Math.max(0, a);
  b = Math.min(R.len, b);
  if (!(b > a) || R.coords.length < 2) return [];
  const i0 = segAt(R, a), i1 = segAt(R, b);
  const out = [pointAt(R, a)];
  for (let i = i0 + 1; i <= i1; i++) out.push(R.coords[i]);
  out.push(pointAt(R, b));
  return out;
}

// Nearest point of segment i to p (flat metres around p): {d, along, i}.
function project(R, i, p, kx, ky) {
  const a = R.coords[i], b = R.coords[i + 1];
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), along: R.cum[i] + t * (R.cum[i + 1] - R.cum[i]), i };
}

/**
 * Where p [lon, lat] is on the route: {along (metres from the start), d (metres off the line), q (the nearest point
 * of the line)}. prev = the last along (null before the ride starts): a loop or an out-and-back passes some places
 * twice, so the search stays from `back` metres behind prev to `ahead` metres past it, and prefers the stretch that
 * runs the way the rider heads (heading in degrees; null when not moving). Only when nothing there is near does the
 * whole line count (the rider took a short cut, or joins the route somewhere else).
 */
export function locate(R, p, { prev = null, heading = null, back = 100, ahead = 800, near = 40 } = {}) {
  const n = R.coords.length;
  if (n < 2) return n ? { along: 0, d: haversine(p, R.coords[0]), q: R.coords[0] } : null;
  const kx = 111320 * Math.cos(p[1] * RAD), ky = 110540;
  const search = (lo, hi, fromPrev) => {
    let best = null, bs = Infinity;
    for (let i = lo > 0 ? segAt(R, lo) : 0; i < n - 1 && R.cum[i] <= hi; i++) {
      const r = project(R, i, p, kx, ky);
      let s = r.d;
      if (heading != null && Math.abs(turnAngle(heading, bearing(R.coords[i], R.coords[i + 1]))) > 100) s += 30;
      if (fromPrev && r.along < prev) s += (prev - r.along) * 0.2;      // going on beats going back
      if (s < bs) { bs = s; best = r; }
    }
    return best;
  };
  let r = prev != null ? search(prev - back, prev + ahead, true) : null;
  if (!r || r.d > near) {
    const g = search(-Infinity, Infinity, false);
    if (!r || g.d + 15 < r.d) r = g;
  }
  return { along: r.along, d: r.d, q: pointAt(R, r.along) };
}

// ---------------------------------------------------------------- turns

export const TURN_TEXT = {
  left: 'Turn left', right: 'Turn right', 'slight-left': 'Bear left', 'slight-right': 'Bear right',
  'sharp-left': 'Sharp left', 'sharp-right': 'Sharp right', 'keep-left': 'Keep left', 'keep-right': 'Keep right',
  uturn: 'Turn around',
};

const kindOf = (a) => {
  const side = a < 0 ? 'left' : 'right', x = Math.abs(a);
  return x > 150 ? 'uturn' : x >= 110 ? `sharp-${side}` : x >= 40 ? side : `slight-${side}`;
};

// The point `dist` metres along a line from its first point.
function walk(c, dist) {
  let left = dist;
  for (let i = 1; i < c.length; i++) {
    const d = haversine(c[i - 1], c[i]);
    if (d >= left) {
      const t = d > 0 ? left / d : 0;
      return [c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1])];
    }
    left -= d;
  }
  return c[c.length - 1];
}

/**
 * The turns of a route: where it passes a junction of the network and does not simply go on the way that runs
 * straight on (a turn of 40 degrees or more, or a fork where another way runs about as straight: keep left / right),
 * and where it turns back on itself (out and back). G = core/routing.js loadGraph, X = core/investigate.js
 * buildIndex (both null: only the turn-backs). Gaps (class "gap": nothing seen there) are no way to take.
 * Each {along, angle (degrees, + = right), kind (see TURN_TEXT), at [lon, lat]}, in riding order.
 */
export function routeTurns(R, G = null, X = null, { near = 15, span = 25, minTurn = 40 } = {}) {
  const out = [];
  if (R.len < 2 * span) return out;
  if (G && X) {
    const gap = G.classes.indexOf('gap');
    // nodes where three or more ways meet, in or next to the cells the route passes
    const keys = new Set();
    for (const k of R.cells.keys()) {
      const x = Math.floor(k / 100000), y = k - x * 100000;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.add(cellKey(x + dx, y + dy));
    }
    const seen = new Set();
    for (const k of keys) {
      const a = X.cells.get(k);
      if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        for (const v of [G.e.a[a[j]], G.e.b[a[j]]]) {
          if (seen.has(v)) continue;
          seen.add(v);
          if (G.off[v + 1] - G.off[v] < 3) continue;
          for (const s of passes(R, [G.lon[v], G.lat[v]], near)) {
            const t = junctionTurn(R, G, X, v, s, span, minTurn, gap);
            if (t) out.push(t);
          }
        }
      }
    }
  }
  // turn-backs: the way out runs back along the way in
  for (let s = span; s <= R.len - span; s += 5) {
    const a = turnAngle(bearing(pointAt(R, s - span), pointAt(R, s)), bearing(pointAt(R, s), pointAt(R, s + span)));
    if (Math.abs(a) <= 150) continue;
    // the sharpest point of this turn-back
    let best = s, ba = Math.abs(a);
    for (let u = s + 2; u <= Math.min(R.len - span, s + 40); u += 2) {
      const b = Math.abs(turnAngle(bearing(pointAt(R, u - span), pointAt(R, u)), bearing(pointAt(R, u), pointAt(R, u + span))));
      if (b > ba) { ba = b; best = u; }
    }
    out.push({ along: best, angle: 180, kind: 'uturn', at: pointAt(R, best) });
    s = best + 40;
  }
  // one instruction per place: the stronger one
  out.sort((a, b) => a.along - b.along);
  const merged = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (last && t.along - last.along < 20) {
      if (Math.abs(t.angle) > Math.abs(last.angle)) merged[merged.length - 1] = t;
    } else merged.push(t);
  }
  return merged;
}

// Where the route passes within `near` metres of p: the along of the closest point of each pass.
function passes(R, p, near) {
  const kx = 111320 * Math.cos(p[1] * RAD), ky = 110540;
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  const segs = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) for (const i of R.cells.get(cellKey(cx + dx, cy + dy)) ?? []) segs.add(i);
  }
  const hits = [];
  for (const i of segs) {
    const r = project(R, i, p, kx, ky);
    if (r.d <= near) hits.push(r);
  }
  hits.sort((a, b) => a.along - b.along);
  const out = [];
  let group = null;
  for (const r of hits) {
    if (group && r.along - group.last < 60) {
      group.last = r.along;
      if (r.d < group.d) { group.d = r.d; group.along = r.along; }
    } else {
      if (group) out.push(group.along);
      group = { along: r.along, last: r.along, d: r.d };
    }
  }
  if (group) out.push(group.along);
  return out;
}

function junctionTurn(R, G, X, v, s, span, minTurn, gap) {
  if (s < 8 || s > R.len - 8) return null;                    // the start and the end are no turns
  const inB = bearing(pointAt(R, Math.max(0, s - span)), pointAt(R, s));
  const outB = bearing(pointAt(R, s), pointAt(R, Math.min(R.len, s + span)));
  const turn = turnAngle(inB, outB);
  // the ways out of the node: the bearing to a point 20 m along each
  const node = [G.lon[v], G.lat[v]];
  const ways = [];
  for (let k = G.off[v]; k < G.off[v + 1]; k++) {
    const e = G.adjE[k];
    if (G.e.cls[e] === gap) continue;
    const c = X.coords[e];
    const line = G.adjD[k] > 0 ? c : c.slice().reverse();
    ways.push(bearing(node, walk(line, Math.min(20, X.cum[e][X.cum[e].length - 1] * 0.5))));
  }
  if (ways.length < 3) return null;
  // the way the route leaves on, and the way it came in on
  const nearest = (b, skip) => {
    let best = -1, bd = Infinity;
    ways.forEach((w, k) => {
      if (k === skip) return;
      const d = Math.abs(turnAngle(b, w));
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  };
  const kOut = nearest(outB, -1);
  const kIn = nearest((inB + 180) % 360, kOut);
  const others = ways.filter((_, k) => k !== kOut && k !== kIn).map((w) => turnAngle(inB, w));
  if (!others.length) return null;
  const at = pointAt(R, s);
  if (Math.abs(turn) >= minTurn) return { along: s, angle: turn, kind: kindOf(turn), at };
  // nearly straight on: an instruction only when another way runs about as straight
  const rival = others.filter((o) => Math.abs(o) < minTurn).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
  if (rival == null) return null;
  return { along: s, angle: turn, kind: turn <= rival ? 'keep-left' : 'keep-right', at };
}

// The first turn more than `pass` metres ahead of along (null when none is left).
export function nextTurn(turns, along, pass = 8) {
  for (const t of turns) if (t.along > along + pass) return t;
  return null;
}

// ---------------------------------------------------------------- climb left

// Metres climbed from the start up to each sample of an elevation profile (core/profile.js).
export function climbIndex(profile) {
  const { elev } = profile, n = elev.length;
  const up = new Float64Array(n);
  for (let i = 1; i < n; i++) up[i] = up[i - 1] + Math.max(0, elev[i] - elev[i - 1]);
  return up;
}

// Metres still to climb from `along` to the end.
export function climbLeft(profile, up, along) {
  const { dist } = profile, n = dist.length;
  if (!n) return 0;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (dist[m] <= along) lo = m; else hi = m;
  }
  const t = dist[hi] > dist[lo] ? Math.min(1, Math.max(0, (along - dist[lo]) / (dist[hi] - dist[lo]))) : 0;
  return Math.max(0, up[n - 1] - (up[lo] + t * (up[hi] - up[lo])));
}

// Distance shown to the next turn: 10 m steps under 100 m, 50 m steps under 1 km, then 0.1 km.
export function roundDist(m) {
  if (m < 100) return Math.max(0, Math.round(m / 10) * 10);
  if (m < 1000) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}
