// Route generation on a small made-up network (tests/fixtures/grid.mjs): a grid of tracks, a dead-end branch, an
// island next to the grid and an AI track reached across a gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoutes, routeCoords, routeStats, routeGaps, startNode, bridgeEdges, makeCost, haversine } from '../core/routing.js';
import { network, LON0, LAT0, DLON, DLAT } from './fixtures/grid.mjs';

// consecutive edges share a node, and each edge's line starts where the previous one ended
function assertContinuous(G, path) {
  let at = null, end = null;
  for (const { e, dir } of path) {
    const from = dir > 0 ? G.e.a[e] : G.e.b[e];
    if (at !== null) assert.equal(from, at, 'the route jumps between edges that do not meet');
    at = dir > 0 ? G.e.b[e] : G.e.a[e];
    const c = routeCoords(G, [{ e, dir }]);
    if (end) assert.ok(haversine(...end, ...c[0]) < 2, 'the line jumps between edges');
    end = c.at(-1);
  }
}

test('loops come back within the length range, continuous, and start and end at the start', () => {
  const { G, at } = network();
  const start = at(4, 4);
  const res = generateRoutes(G, start, { minLen: 6000, maxLen: 9000, climbs: 0, seed: 3 });
  assert.ok(res.length >= 2, `only ${res.length} routes`);
  for (const r of res) {
    assert.ok(r.fits);
    assert.ok(r.stats.len >= 6000 && r.stats.len <= 9000, `${r.stats.len} m is outside 6-9 km`);
    assertContinuous(G, r.path);
    const first = r.path[0], last = r.path.at(-1);
    assert.equal(first.dir > 0 ? G.e.a[first.e] : G.e.b[first.e], start);
    assert.equal(last.dir > 0 ? G.e.b[last.e] : G.e.a[last.e], start);
  }
});

test('no route in the range: the closest few come back marked as not fitting', () => {
  const { G, at } = network();
  const res = generateRoutes(G, at(4, 4), { minLen: 150000, maxLen: 160000, climbs: 0, tries: 20 });
  assert.ok(res.every((r) => !r.fits));
});

test('the start skips an island next to the tap and lands on the network a ride can use', () => {
  const { G, at, island } = network();
  const cost = makeCost(G, {});
  const s = startNode(G, LON0 - 0.1 * DLON, LAT0 - 0.1 * DLAT, cost, 20);
  assert.ok(!island.includes(s.node));
  assert.equal(s.node, at(0, 0));
  assert.ok(s.off < 100);
});

test('the start is on a mapped way, never on an AI track or a gap', () => {
  const { G } = network();
  const s = startNode(G, LON0 + 2.05 * DLON, LAT0 + 8.45 * DLAT, makeCost(G, {}), 20);    // tap by the AI track
  const cls = [];
  for (let i = G.off[s.node]; i < G.off[s.node + 1]; i++) cls.push(G.classes[G.e.cls[G.adjE[i]]]);
  assert.ok(cls.some((c) => c !== 'ai' && c !== 'gap'));
});

test('a dead-end branch is a bridge, the grid is not', () => {
  const { G, at, branchEnd } = network();
  const br = bridgeEdges(G);
  for (let i = G.off[branchEnd]; i < G.off[branchEnd + 1]; i++) assert.equal(br[G.adjE[i]], 1);
  for (let i = G.off[at(4, 4)]; i < G.off[at(4, 4) + 1]; i++) assert.equal(br[G.adjE[i]], 0);
});

test('stats count the AI tracks and the gaps a route crosses; the gaps can be drawn', () => {
  const { G, at } = network();
  const path = [];
  // grid (2,8) -> gap -> AI track -> AI track -> grid (6,8)
  let n = at(2, 8);
  for (let i = G.off[n]; i < G.off[n + 1]; i++) {
    const e = G.adjE[i];
    if (G.classes[G.e.cls[e]] === 'gap') { path.push({ e, dir: G.adjD[i] }); n = G.adjD[i] > 0 ? G.e.b[e] : G.e.a[e]; break; }
  }
  for (let k = 0; k < 2; k++) {
    for (let i = G.off[n]; i < G.off[n + 1]; i++) {
      const e = G.adjE[i];
      if (G.classes[G.e.cls[e]] === 'ai' && !path.some((x) => x.e === e)) { path.push({ e, dir: G.adjD[i] }); n = G.adjD[i] > 0 ? G.e.b[e] : G.e.a[e]; break; }
    }
  }
  assert.equal(n, at(6, 8));
  assertContinuous(G, path);
  const s = routeStats(G, path);
  assert.equal(s.gaps, 1);
  assert.ok(s.gapLen > 150 && s.gapLen < 250);
  assert.ok(s.ai > 0.8);
  assert.equal(routeGaps(G, path).length, 1);
});
