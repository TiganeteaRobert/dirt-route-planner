import { readFileSync } from 'node:fs';
import { loadGraph, nearestNode, generateRoutes } from '../core/routing.js';
const G = loadGraph(JSON.parse(readFileSync(new URL('../data/area/graph.json', import.meta.url), 'utf8')));
const start = nearestNode(G, 23.47, 46.58);
for (const tol of [0.15, 0.3]) {
  for (const seed of [1, 2, 3]) {
    const res = generateRoutes(G, start, { length: 8000, climbs: 2, minClimbGrade: 15, seed, tolerance: tol, count: 8, debug: true });
    console.log(`tol ${tol} seed ${seed}:`, res.map((r) => `${(r.stats.len / 1000).toFixed(1)}km c${r.stats.climbs.length} s${r.score.toFixed(2)}`).join(' | '));
  }
}
