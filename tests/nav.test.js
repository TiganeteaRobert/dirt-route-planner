// Riding a route (core/nav.js): where the rider is on loops and out-and-backs, the turns at junctions (a turn, a fork,
// straight over a crossing), the turn-back of an out-and-back, and the climb left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGraph } from '../core/routing.js';
import { haversine } from '../core/geo.js';
import { buildIndex } from '../core/investigate.js';
import { encodePolyline } from '../core/polyline.js';
import { prepareRoute, locate, pointAt, sliceRoute, bearingAt, routeTurns, nextTurn, climbIndex, climbLeft, roundDist, turnAngle } from '../core/nav.js';
import { network, LON0, LAT0, DLON, DLAT, CLASSES } from './fixtures/grid.mjs';

const ll = (x, y) => [LON0 + x * DLON, LAT0 + y * DLAT];
const line = (...xy) => xy.map(([x, y]) => ll(x, y));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('a route knows its length, its points and its pieces', () => {
  const R = prepareRoute(line([0, 0], [4, 0], [4, 2]));
  near(R.len, 3000, 15, 'length');
  assert.equal(R.closed, false);
  assert.ok(haversine(pointAt(R, 2000), ll(4, 0)) < 15);
  assert.ok(haversine(pointAt(R, 2500), ll(4, 1)) < 15);
  near(bearingAt(R, 500), 90, 1, 'heads east');
  near(bearingAt(R, 2500), 0, 1, 'then north');
  const s = sliceRoute(R, 1000, 2500);
  assert.ok(haversine(s[0], ll(2, 0)) < 15 && haversine(s.at(-1), ll(4, 1)) < 15);
  assert.ok(s.some((p) => haversine(p, ll(4, 0)) < 1), 'the corner is in the piece');
  assert.equal(turnAngle(350, 10), 20);
  assert.equal(turnAngle(10, 350), -20);
});

test('on a loop, the start is the start (not the end) and the end is found from near the end', () => {
  const R = prepareRoute(line([0, 0], [4, 0], [4, 4], [0, 4], [0, 0]));
  assert.equal(R.closed, true);
  const at0 = locate(R, ll(0, 0.01), { prev: 0 });
  assert.ok(at0.along < 20, `${at0.along}`);
  const atEnd = locate(R, ll(0, 0.01), { prev: R.len - 60 });
  assert.ok(atEnd.along > R.len - 20, `${atEnd.along}`);
  // 30 m beside the line
  const off = locate(R, ll(2, 0.06), { prev: 900 });
  near(off.d, 30, 2, 'off the line');
  near(off.along, 1000, 5, 'along');
});

test('on an out-and-back, the way the rider heads picks the leg', () => {
  const R = prepareRoute(line([0, 0], [4, 0], [0, 0]));
  const out = locate(R, ll(3, 0), { prev: 1450, heading: 90 });
  near(out.along, 1500, 5, 'going out');
  const back = locate(R, ll(3, 0), { prev: 2450, heading: 270 });
  near(back.along, 2500, 5, 'coming back');
  // no heading: the nearest place ahead of the last one
  const fromPrev = locate(R, ll(3, 0), { prev: 2400 });
  near(fromPrev.along, 2500, 5, 'from prev');
  // it turns back at the far end
  const turns = routeTurns(R);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, 'uturn');
  near(turns[0].along, 2000, 25, 'turn-back');
});

test('a rider who joins the route elsewhere is found there', () => {
  const R = prepareRoute(line([0, 0], [8, 0]));
  const r = locate(R, ll(6, 0.02), { prev: 200 });
  near(r.along, 3000, 5);
});

test('turns at junctions: a turn, nothing straight over a crossing', () => {
  const { G } = network();
  const X = buildIndex(G);
  // east along y = 2 over three crossings, left (north) at x = 4, right (east) at y = 5
  const R = prepareRoute(line([0, 2], [4, 2], [4, 5], [6, 5]));
  const turns = routeTurns(R, G, X);
  assert.deepEqual(turns.map((t) => t.kind), ['left', 'right']);
  near(turns[0].along, 2000, 3, 'left at (4, 2)');
  near(turns[1].along, 3500, 3, 'right at (4, 5)');
  assert.equal(nextTurn(turns, 0).kind, 'left');
  assert.equal(nextTurn(turns, 2000).kind, 'right', 'a turn just passed is done');
  assert.equal(nextTurn(turns, 3600), null);
});

test('a fork where both ways run on: keep left / keep right', () => {
  // A -> B, then two ways on: to C (left, ~17 degrees) and to D (right)
  const P = { A: [0, 0], B: [0, 1], C: [-0.3, 2], D: [0.3, 2] };
  const names = Object.keys(P);
  const lon = names.map((k) => Math.round(ll(...P[k])[0] * 1e6)), lat = names.map((k) => Math.round(ll(...P[k])[1] * 1e6));
  const E = [['A', 'B'], ['B', 'C'], ['B', 'D']];
  const cols = { a: [], b: [], len: [], cls: [], risk: [], lvl: [], leg: [], ex: [], g: [], gdir: [], up: [], dn: [], tree: [], det: [], tt: [], pav: [] };
  const geom = [];
  for (const [a, b] of E) {
    const c = [ll(...P[a]), ll(...P[b])];
    cols.a.push(names.indexOf(a)); cols.b.push(names.indexOf(b)); cols.len.push(haversine(c[0], c[1])); cols.cls.push(0);
    for (const k of ['risk', 'lvl', 'leg', 'ex', 'g', 'gdir', 'up', 'dn', 'tree', 'det', 'tt', 'pav']) cols[k].push(0);
    geom.push(encodePolyline(c));
  }
  const G = loadGraph({ classes: CLASSES, nodes: { lon, lat }, edges: cols, ids: E.map((_, i) => `f${i}`), names: E.map(() => ''), geom });
  const X = buildIndex(G);
  assert.deepEqual(routeTurns(prepareRoute(line(P.A, P.B, P.C)), G, X).map((t) => t.kind), ['keep-left']);
  assert.deepEqual(routeTurns(prepareRoute(line(P.A, P.B, P.D)), G, X).map((t) => t.kind), ['keep-right']);
});

test('the climb left goes down as the rider climbs', () => {
  const prof = { dist: Float64Array.from([0, 100, 200, 300, 400]), elev: Float64Array.from([500, 520, 510, 540, 540]) };
  const up = climbIndex(prof);
  assert.equal(climbLeft(prof, up, 0), 50);
  assert.equal(climbLeft(prof, up, 50), 40);
  assert.equal(climbLeft(prof, up, 250), 15);
  assert.equal(climbLeft(prof, up, 400), 0);
  assert.equal(roundDist(37), 40);
  assert.equal(roundDist(430), 450);
  assert.equal(roundDist(1260), 1300);
});
