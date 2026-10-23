import { test } from 'node:test';
import assert from 'node:assert/strict';
import { augmentGraph } from '../core/usergraph.js';
import { encodePolyline } from '../core/polyline.js';
import { loadGraph, shortestPath, makeCost } from '../core/routing.js';

// A tiny network: A(0) -- B(1) along a 1 km east-west road, C(2) a dead end 600 m north of B.
const pts = [[23.0, 46.5], [23.013, 46.5], [23.013, 46.5054]];
const json = {
  version: 1, classes: ['track', 'path', 'bridleway', 'unclassified', 'residential', 'service', 'living_street', 'road', 'tertiary', 'secondary', 'primary', 'trunk', 'detected'],
  nodes: { lon: pts.map((p) => Math.round(p[0] * 1e6)), lat: pts.map((p) => Math.round(p[1] * 1e6)) },
  edges: { a: [0, 1], b: [1, 2], len: [1000, 600], cls: [0, 0], risk: [0, 0], lvl: [0, 0], leg: [0, 0], ex: [80, 80], g: [5, 5],
    gdir: [1, 1], up: [10, 20], dn: [0, 0], tree: [0, 0], det: [100, 100], tt: [0, 0], pav: [0, 0] },
  ids: ['1:0', '2:0'], names: ['', ''], geom: [encodePolyline([pts[0], pts[1]]), encodePolyline([pts[1], pts[2]])],
};

test('a drawn road joins at a node and by splitting an edge, and becomes routable', () => {
  // from the middle of A-B (split) north to near C (node within 30 m)
  const road = { id: 'd1', name: 'my shortcut', coords: [[23.0065, 46.50005], [23.008, 46.503], [23.0129, 46.5053]] };
  const { json: j2, joins } = augmentGraph(json, [road]);
  assert.deepEqual(joins, [{ id: 'd1', start: 'split', end: 'node' }]);
  assert.equal(j2.edges.a.length, 4);                 // 2 + the split remainder + the new road
  assert.ok(j2.classes.includes('mine'));
  assert.equal(json.edges.a.length, 2, 'input left alone');
  const G = loadGraph(j2);
  const path = shortestPath(G, 0, 2, makeCost(G, {}));
  assert.ok(path.some((s) => G.ids[s.e] === 'u:d1'), 'route uses the drawn road');
  const total = path.reduce((s, x) => s + G.e.len[x.e], 0);
  assert.ok(total < 1600, `shortcut is shorter than A-B-C (${total})`);
});

test('a road far from everything stays free (its own nodes)', () => {
  const { joins } = augmentGraph(json, [{ id: 'x', coords: [[23.5, 46.9], [23.51, 46.9]] }]);
  assert.deepEqual(joins, [{ id: 'x', start: 'free', end: 'free' }]);
});
