// A route in a link (Send to phone: a QR code on the PC, scanned by the phone). No DOM, no server: the route travels in
// the link's #fragment, which the browser never sends to the web server.
// Kind "b": the route builder's points (the phone rebuilds the route on its own copy of the network, so the link stays
// short enough for a QR code). Kind "l": a line that is not on the network, simplified.
// v1 = base64url of JSON {v: 1, k: 'b' | 'l', n: name, p: polyline (points or line), c: 1 = loop, a: polyline of the
// avoided places, L: length in metres}. Links come from anywhere: decodeRoute checks everything and caps the sizes.
import { encodePolyline, decodePolyline } from './polyline.js';
import { haversine } from './geo.js';

export const LINK_KEY = 'route';
const MAX_POINTS = 300, MAX_LINE = 4000, MAX_NAME = 80;
const POLY = /^[\x3f-\x7e]*$/;

const toB64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/**
 * route: {name, len, pts ([[lon, lat], ...]: the builder's points), closed, avoid ([[lon, lat], ...])} or
 * {name, len, line ([[lon, lat], ...])}. Returns the fragment's value.
 */
export function encodeRoute({ name, len = 0, pts = null, closed = false, avoid = [], line = null }) {
  const o = { v: 1, k: pts ? 'b' : 'l', n: String(name ?? 'Route').slice(0, MAX_NAME), p: encodePolyline(pts ?? line), L: Math.round(len) };
  if (pts && closed) o.c = 1;
  if (pts && avoid?.length) o.a = encodePolyline(avoid);
  return toB64(JSON.stringify(o));
}

const okLL = ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 85;

// The route in a fragment value, or null when it is not a valid route link.
export function decodeRoute(value) {
  let o;
  try {
    if (typeof value !== 'string' || value.length > 20000) return null;
    o = JSON.parse(fromB64(value));
  } catch {
    return null;
  }
  if (!o || o.v !== 1 || (o.k !== 'b' && o.k !== 'l') || typeof o.p !== 'string' || !POLY.test(o.p)) return null;
  if (o.a != null && (typeof o.a !== 'string' || !POLY.test(o.a))) return null;
  const coords = decodePolyline(o.p);
  if (coords.length < 2 || coords.length > (o.k === 'b' ? MAX_POINTS : MAX_LINE) || !coords.every(okLL)) return null;
  const avoid = o.a ? decodePolyline(o.a) : [];
  if (avoid.length > MAX_POINTS || !avoid.every(okLL)) return null;
  const name = (typeof o.n === 'string' && o.n.trim() ? o.n.trim() : 'Route').slice(0, MAX_NAME);
  const len = Number.isFinite(o.L) && o.L > 0 ? o.L : 0;
  return o.k === 'b' ? { kind: 'b', name, len, pts: coords, closed: o.c === 1, avoid } : { kind: 'l', name, len, line: coords };
}

// Douglas-Peucker in metres: the fewest points that stay within `tol` metres of the line.
export function simplify(coords, tol) {
  if (coords.length < 3) return coords.slice();
  const lat0 = coords[0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const P = coords.map(([x, y]) => [x * kx, y * ky]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = P[a], [bx, by] = P[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2)) : 0;
      const d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy);
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}

// A line short enough for a QR code: simplified more and more until its link fits in `max` characters.
export function lineForLink(name, line, max = 1800) {
  let len = 0;
  for (let i = 1; i < line.length; i++) len += haversine(line[i - 1], line[i]);
  for (const tol of [3, 6, 10, 15, 25, 40]) {
    const s = simplify(line, tol);
    const v = encodeRoute({ name, len, line: s });
    if (v.length <= max) return { value: v, tol, points: s.length };
  }
  return { value: encodeRoute({ name, len, line: simplify(line, 40) }), tol: 40, points: null };
}
