// The route builder's core on the made-up grid (tests/fixtures/grid.mjs): taps snap onto the nearest way anywhere along
// it, legs follow the network between two such points (parts of edges at both ends), and a tap on the line finds its
// place on the stretches the leg rides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine } from '../core/routing.js';
import { buildIndex } from '../core/investigate.js';
import { traceCost, snapToNetwork, snapToPieces, pathBetween, leg, piecesCoords, piecesStats, sumStats, pointsForLine } from '../core/builder.js';
import { network, LON0, LAT0, DLON, DLAT } from './fixtures/grid.mjs';

const ll = (x, y) => [LON0 + x * DLON, LAT0 + y * DLAT];
const setup = (opts) => {
  const net = network(opts);
  return { ...net, X: buildIndex(net.G) };
};
const snap = ({ G, X }, x, y, max = 300) => snapToNetwork(G, X, ...ll(x, y), max);

// each piece starts where the last one ended, on the same node
function assertChained(G, pieces) {
  for (let k = 1; k < pieces.length; k++) {
    const p = pieces[k - 1], q = pieces[k];
    const endNode = p.t1 === 1 ? G.e.b[p.e] : p.t1 === 0 ? G.e.a[p.e] : -1;
    const startNode = q.t0 === 0 ? G.e.a[q.e] : q.t0 === 1 ? G.e.b[q.e] : -2;
    assert.equal(endNode, startNode, `piece ${k - 1} -> ${k} does not meet at a node`);
  }
}

test('a tap snaps onto the nearest way, anywhere along it', () => {
  const s = setup();
  const p = snap(s, 2.5, 3.08);                 // 40 m north of the middle of the edge (2,3)-(3,3)
  assert.ok(p);
  assert.ok(Math.abs(p.d - 40) < 2, `${p.d}`);
  assert.ok(Math.abs(p.t - 0.5) < 0.01, `${p.t}`);
  assert.ok(haversine(p.lon, p.lat, ...ll(2.5, 3)) < 1);
  assert.equal(snap(s, 4.5, 4.5, 100), null, 'nothing within 100 m of the middle of a grid cell');
});

test('a leg between two taps follows the network, with parts of edges at both ends', () => {
  const s = setup();
  const A = snap(s, 1.3, 2), B = snap(s, 4, 5.6);
  const pieces = pathBetween(s.G, A, B, traceCost(s.G));
  assert.ok(pieces && pieces.length >= 3);
  assertChained(s.G, pieces);
  assert.equal(pieces[0].e, A.e);
  assert.ok(Math.abs(pieces[0].t0 - A.t) < 1e-9);
  assert.equal(pieces.at(-1).e, B.e);
  assert.ok(Math.abs(pieces.at(-1).t1 - B.t) < 1e-9);
  const st = piecesStats(s.G, pieces);
  // on a grid the shortest way is the Manhattan distance: 2.7 cells east + 3.6 cells north, 500 m each
  assert.ok(Math.abs(st.len - (2.7 + 3.6) * 500) < 15, `${st.len}`);
  const c = piecesCoords(s.X, pieces);
  assert.ok(haversine(...c[0], A.lon, A.lat) < 1 && haversine(...c.at(-1), B.lon, B.lat) < 1);
  for (let i = 1; i < c.length; i++) assert.ok(haversine(...c[i - 1], ...c[i]) <= 501, 'no jump in the line');
});

test('two taps on the same way: one piece, either direction; the same spot twice: nothing to ride', () => {
  const s = setup();
  const A = snap(s, 3.2, 1), B = snap(s, 3.7, 1);
  const fwd = pathBetween(s.G, A, B, traceCost(s.G));
  assert.equal(fwd.length, 1);
  assert.ok(Math.abs(piecesStats(s.G, fwd).len - 250) < 3);
  const back = pathBetween(s.G, B, A, traceCost(s.G));
  assert.equal(back.length, 1);
  assert.equal(back[0].dir, -fwd[0].dir);
  assert.deepEqual(pathBetween(s.G, A, A, traceCost(s.G)), []);
});

test('an island cannot be reached; red ways can (they only cost more)', () => {
  const s = setup({ riskOf: () => 2 });                 // everything red
  const island = snapToNetwork(s.G, s.X, ...ll(-0.5, -0.12), 50);
  assert.ok(island);
  assert.equal(pathBetween(s.G, snap(s, 1.5, 1), island, traceCost(s.G)), null);
  const p = pathBetween(s.G, snap(s, 1.5, 1), snap(s, 6.5, 7), traceCost(s.G));
  assert.ok(p && p.length > 2);
});

test('a leg to an island rides the network to the nearest place and crosses the gap straight', () => {
  const s = setup();
  const A = snap(s, 1.5, 1), B = snapToNetwork(s.G, s.X, ...ll(-0.6, -0.12), 50);
  const pieces = leg(s.G, A, B, traceCost(s.G));
  const straight = pieces.filter((p) => p.straight);
  assert.equal(straight.length, 1);
  // the gap is from the grid's corner (0, 0) to the island's end at (-0.12, -0.12): 60 m each way
  assert.ok(Math.abs(straight[0].len - Math.hypot(60, 60)) < 3, `${straight[0].len}`);
  const c = piecesCoords(s.X, pieces);
  assert.ok(haversine(...c[0], A.lon, A.lat) < 1 && haversine(...c.at(-1), B.lon, B.lat) < 1);
  for (let i = 1; i < c.length; i++) assert.ok(haversine(...c[i - 1], ...c[i]) <= 501, 'no jump but the marked one');
  const st = piecesStats(s.G, pieces);
  assert.equal(st.offs, 1);
  assert.ok(Math.abs(st.off - straight[0].len) < 1e-6);
  // and back: from the island to the grid
  const back = leg(s.G, B, A, traceCost(s.G));
  assert.equal(back.filter((p) => p.straight).length, 1);
});

test('a tap on the route line lands on the stretch the leg rides, not on the unused part of an edge', () => {
  const s = setup();
  const A = snap(s, 2.4, 3), B = snap(s, 2.8, 5);         // A on edge (2,3)-(3,3); the leg leaves it eastwards
  const pieces = pathBetween(s.G, A, B, traceCost(s.G));
  const first = pieces[0];
  // a tap at (2.1, 3): on A's edge, but on the part the leg does not ride (west of A)
  const p = snapToPieces(s.X, pieces, ...ll(2.1, 3.02));
  assert.ok(p);
  const lo = Math.min(first.t0, first.t1), hi = Math.max(first.t0, first.t1);
  if (p.e === first.e) assert.ok(p.t >= lo - 1e-9 && p.t <= hi + 1e-9, 'snapped onto the unused part');
  const q = snapToPieces(s.X, pieces, ...ll(3.05, 4.2));  // next to the leg going north on x = 3
  assert.ok(q.d < 40);
});

test('AI tracks and gaps count in the stats, legs add up', () => {
  const s = setup();
  const byClass = (c) => [...s.G.e.cls.keys()].filter((e) => s.G.classes[s.G.e.cls[e]] === c);
  const [gap] = byClass('gap'), [ai] = byClass('ai');
  const st = piecesStats(s.G, [{ e: gap, dir: 1, t0: 0, t1: 1 }, { e: ai, dir: 1, t0: 0, t1: 0.5 }]);
  assert.equal(st.gaps, 1);
  assert.ok(Math.abs(st.gapLen - s.G.e.len[gap]) < 1e-6);
  assert.ok(Math.abs(st.ai - s.G.e.len[ai] / 2) < 1e-3);
  const both = sumStats([st, st]);
  assert.equal(both.gaps, 2);
  assert.ok(Math.abs(both.len - 2 * st.len) < 1e-6);
  assert.ok(Math.abs(both.risk[0] + both.risk[1] + both.risk[2] - 2 * st.len) < 1e-6);
});

test('points along a given line: the builder rides the same line again, a loop comes back closed', () => {
  const s = setup();
  const cost = traceCost(s.G);
  const legOf = (A, B) => { const pieces = leg(s.G, A, B, cost); return { pieces, coords: piecesCoords(s.X, pieces) }; };
  // a loop that does not take the shortest ways: east along y = 1, north on x = 7, west on y = 6, back south on x = 1
  const loop = [[1, 1], [7, 1], [7, 6], [1, 6], [1, 1]].map(([x, y]) => ll(x, y));
  const r = pointsForLine(s.G, s.X, loop, legOf);
  assert.ok(r && r.closed, 'a loop');
  assert.ok(r.pts.length >= 4 && r.pts.length < 40, `${r.pts.length} points`);
  const legs = r.pts.map((A, i) => legOf(A, r.pts[(i + 1) % r.pts.length]));
  const total = legs.reduce((m, l) => m + piecesStats(s.G, l.pieces).len, 0);
  assert.ok(Math.abs(total - 22 * 500) < 30, `the same length again: ${Math.round(total)} m`);
  // every leg stays on the given line
  const ref = [];
  for (let k = 0; k < loop.length - 1; k++) {
    for (let t = 0; t <= 50; t++) ref.push([loop[k][0] + ((loop[k + 1][0] - loop[k][0]) * t) / 50, loop[k][1] + ((loop[k + 1][1] - loop[k][1]) * t) / 50]);
  }
  for (const l of legs) {
    for (const p of l.coords) {
      const d = Math.min(...ref.map((q) => haversine(p[0], p[1], q[0], q[1])));
      assert.ok(d < 40, `a leg leaves the line by ${Math.round(d)} m`);
    }
  }
  // a line that rides up the dead-end branch east of the grid and back: the branch is not skipped
  const spur = [[5, 2], [8, 2], [8, 4], [11, 4], [8, 4], [8, 6], [5, 6]].map(([x, y]) => ll(x, y));
  const r2 = pointsForLine(s.G, s.X, spur, legOf);
  const legs2 = r2.pts.slice(0, -1).map((A, i) => legOf(A, r2.pts[i + 1]));
  const total2 = legs2.reduce((m, l) => m + piecesStats(s.G, l.pieces).len, 0);
  assert.ok(Math.abs(total2 - 16 * 500) < 30, `up the branch and back: ${Math.round(total2)} m of ${16 * 500}`);
  // an open line is not closed; a line far from every way gives nothing
  assert.equal(pointsForLine(s.G, s.X, [ll(1, 1), ll(5, 1)], legOf).closed, false);
  assert.equal(pointsForLine(s.G, s.X, [ll(20, 20), ll(25, 20)], legOf), null);
});

