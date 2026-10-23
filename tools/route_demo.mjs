import { readFileSync } from 'node:fs';
import { loadGraph, nearestNode, generateRoutes, routeCoords } from '../core/routing.js';
const t0 = performance.now();
const G = loadGraph(JSON.parse(readFileSync(new URL('../data/area/graph.json', import.meta.url), 'utf8')));
console.log(`graph ${G.N} nodes ${G.M} edges loaded in ${(performance.now() - t0).toFixed(0)} ms`);
for (const [name, lon, lat, opts] of [
  ['Marisel village 4 km climbs', 23.105, 46.675, { length: 4000, climbs: 2, minClimbGrade: 15 }],
  ['Baisoara 8 km 2 climbs', 23.47, 46.58, { length: 8000, climbs: 2, minClimbGrade: 18 }],
  ['Gilau 10 km', 23.38, 46.75, { length: 10000, climbs: 1 }],
  ['Baisoara 20 km', 23.47, 46.58, { length: 20000, climbs: 3, minClimbGrade: 18 }],
  ['Belis out-back 8 km', 23.04, 46.66, { length: 8000, shape: 'out-back' }],
]) {
  const t1 = performance.now();
  const start = nearestNode(G, lon, lat);
  const routes = generateRoutes(G, start, opts);
  console.log(`\n${name}: ${routes.length} routes in ${(performance.now() - t1).toFixed(0)} ms`);
  for (const r of routes) {
    const s = r.stats;
    console.log(`  ${(s.len / 1000).toFixed(1)} km  dirt ${(s.dirt * 100).toFixed(0)}%  up ${s.up.toFixed(0)} m  climbs ${s.climbs.length} (max ${s.maxUp.toFixed(0)}%)  green ${(s.green * 100).toFixed(0)}% yellow ${(s.yellow * 100).toFixed(0)}% red ${(s.red * 100).toFixed(0)}%  reused ${(s.reused * 100).toFixed(0)}%  score ${r.score.toFixed(2)}  pts ${routeCoords(G, r.path).length}`);
  }
}
