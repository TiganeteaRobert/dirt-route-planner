import { readFileSync } from 'node:fs';
import { loadGraph, nearestNode, makeCost, reachable, haversine } from '../core/routing.js';
const G = loadGraph(JSON.parse(readFileSync(new URL('../data/area/graph.json', import.meta.url), 'utf8')));
for (const [name, lon, lat, R] of [['Marisel', 23.12, 46.66, 1540], ['Baisoara', 23.47, 46.58, 7700]]) {
  const s = nearestNode(G, lon, lat);
  const cost = makeCost(G, { avoidRed: true });
  const mask = reachable(G, s, cost);
  const E = G.e;
  const stat = { near: 0, g15: 0, g15dir: 0, g15len: 0, red: 0, ok: 0 };
  for (let e = 0; e < G.M; e++) {
    const d = haversine(G.lon[s], G.lat[s], G.lon[E.a[e]], G.lat[E.a[e]]);
    if (d > R) continue;
    stat.near++;
    if (E.g[e] < 15) continue;
    stat.g15++;
    if (!E.gdir[e]) continue;
    stat.g15dir++;
    if (E.len[e] < 60) continue;
    stat.g15len++;
    if (cost(e, E.gdir[e]) === Infinity) { stat.red++; continue; }
    stat.ok++;
  }
  console.log(name, JSON.stringify(stat), 'reachable nodes', mask.reduce((a, b) => a + b, 0));
}
