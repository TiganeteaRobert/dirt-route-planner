// Builds private/test/baisoara-test.gpx: a generated loop with GPS noise and one invented cross-country shortcut.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadGraph, nearestNode, generateRoutes, routeCoords, haversine } from '../core/routing.js';
import { toGPX } from '../core/gpx.js';
const G = loadGraph(JSON.parse(readFileSync(new URL('../data/area/graph.json', import.meta.url), 'utf8')));
const r = generateRoutes(G, nearestNode(G, 23.47, 46.58), { length: 8000, climbs: 1, seed: 7 })[0];
let c = routeCoords(G, r.path);
// shortcut: replace the part between 30 % and 40 % of the points by a straight line
const i0 = Math.floor(c.length * 0.3), i1 = Math.floor(c.length * 0.4);
const a = c[i0], b = c[i1];
const n = Math.max(2, Math.round(haversine(a[0], a[1], b[0], b[1]) / 15));
const straight = Array.from({ length: n }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
c = [...c.slice(0, i0), ...straight, ...c.slice(i1)];
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
const noisy = c.map(([lon, lat]) => ({ lon: lon + rnd() * 0.00008, lat: lat + rnd() * 0.00006 }));
writeFileSync(new URL('../private/test/baisoara-test.gpx', import.meta.url), toGPX({ name: 'Baisoara test loop', segments: [noisy] }));
console.log(`test track: ${c.length} points, shortcut ${Math.round(haversine(a[0], a[1], b[0], b[1]))} m straight`);
