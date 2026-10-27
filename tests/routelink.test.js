// Send to phone (core/routelink.js): a route's points or line survive the link, broken or hostile links are refused,
// long lines are simplified until they fit a QR code, and routeFromPoints (core/builder.js) rides the same way as the
// route builder's legs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRoute, decodeRoute, simplify, lineForLink } from '../core/routelink.js';
import { routeFromPoints, traceCost, snapToNetwork, leg, piecesCoords } from '../core/builder.js';
import { buildIndex } from '../core/investigate.js';
import { haversine, lineLength } from '../core/geo.js';
import { network, LON0, LAT0, DLON, DLAT } from './fixtures/grid.mjs';

const ll = (x, y) => [LON0 + x * DLON, LAT0 + y * DLAT];

test("a route's points, loop and avoided places come back from the link", () => {
  const pts = [ll(0, 0), ll(3, 1), ll(2, 4)], avoid = [ll(1.5, 2)];
  const v = encodeRoute({ name: 'Vârtop loop ✓', len: 12345.6, pts, closed: true, avoid });
  assert.match(v, /^[A-Za-z0-9_-]+$/, 'only characters that need no escaping in a URL');
  const r = decodeRoute(v);
  assert.equal(r.kind, 'b');
  assert.equal(r.name, 'Vârtop loop ✓');
  assert.equal(r.closed, true);
  assert.equal(r.len, 12346);
  assert.equal(r.pts.length, 3);
  r.pts.forEach((p, i) => assert.ok(haversine(p, pts[i]) < 1.5));
  assert.ok(haversine(r.avoid[0], avoid[0]) < 1.5);
  // 20 points: a short link, an easy QR code
  const many = Array.from({ length: 20 }, (_, i) => ll(i * 0.4, Math.sin(i) * 3));
  assert.ok(encodeRoute({ name: 'A 35 km loop', len: 35000, pts: many, closed: true }).length < 400);
});

test('a line comes back as a line', () => {
  const line = [ll(0, 0), ll(0.5, 0.2), ll(1, 1)];
  const r = decodeRoute(encodeRoute({ name: 'track', len: 800, line }));
  assert.equal(r.kind, 'l');
  assert.equal(r.line.length, 3);
});

test('broken and hostile links are refused', () => {
  assert.equal(decodeRoute(''), null);
  assert.equal(decodeRoute('not-a-route'), null);
  assert.equal(decodeRoute(encodeRoute({ name: 'x', pts: [ll(0, 0)] })), null, 'one point is no route');
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeRoute(b64({ v: 2, k: 'b', p: '_p~iF~ps|U_ulLnnqC' })), null, 'unknown version');
  assert.equal(decodeRoute(b64({ v: 1, k: 'b', p: '<script>' })), null, 'not a polyline');
  assert.equal(decodeRoute(b64({ v: 1, k: 'b', p: '_p~iF~ps|U_ulLnnqC', a: 5 })), null, 'avoid not a polyline');
  const r = decodeRoute(b64({ v: 1, k: 'b', p: '_p~iF~ps|U_ulLnnqC', n: 'x'.repeat(500) }));
  assert.equal(r.name.length, 80, 'long names are cut');
  assert.equal(decodeRoute('A'.repeat(30000)), null, 'too long');
});

test('long lines are simplified until the link fits a QR code', () => {
  const line = [];
  for (let i = 0; i <= 6000; i++) line.push([23.3 + i * 0.00005, 46.6 + Math.sin(i / 40) * 0.003]);
  const s = simplify(line, 3);
  assert.ok(s.length < line.length / 4, `${s.length} of ${line.length} points`);
  assert.ok(Math.abs(lineLength(s) - lineLength(line)) / lineLength(line) < 0.01, 'about as long');
  const l = lineForLink('a winding track', line);
  assert.ok(l.value.length <= 1800 && l.points > 50, `${l.value.length} characters, ${l.points} points, within ${l.tol} m`);
});

test('a route from its points rides the same way as the builder', () => {
  const { G } = network();
  const X = buildIndex(G);
  const pts = [ll(0.3, 2), ll(4, 5.6), ll(6, 1)];
  const r = routeFromPoints(G, X, pts, true);
  const cost = traceCost(G);
  const S = pts.map((p) => snapToNetwork(G, X, ...p, 200));
  const ref = [];
  for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const c = piecesCoords(X, leg(G, S[a], S[b], cost));
    for (let i = ref.length ? 1 : 0; i < c.length; i++) ref.push(c[i]);
  }
  assert.ok(Math.abs(lineLength(r.coords) - lineLength(ref)) < 1);
  assert.ok(Math.abs(r.stats.len - lineLength(ref)) < 5);
  assert.ok(haversine(r.coords[0], r.coords.at(-1)) < 1, 'a loop');
  // avoiding the stretch the route rides from (0.3, 2) eastwards: the route goes around it
  const around = routeFromPoints(G, X, pts, true, [ll(0.6, 2)]);
  assert.equal(around.avoided.size, 1);
  assert.ok(!around.coords.some((c) => haversine(c, ll(0.6, 2)) < 5), 'not over the avoided stretch');
  assert.equal(routeFromPoints(G, X, [ll(30, 30), ll(31, 31)]), null, 'nowhere near the network');
});
