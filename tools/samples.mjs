// Sample rides for review (M4 acceptance, before the batch of 100): loops from villages spread around Cluj, mixed
// lengths and climbs -> data/area/samples.json (shown in the app under Plan; pack.py ships it with the area pack).
//   node tools/samples.mjs [count=10]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadGraph, nearestNode, generateRoutes, routeCoords, haversine } from '../core/routing.js';
import { encodePolyline } from '../core/polyline.js';

const AREA = new URL('../data/area/', import.meta.url);
const count = +(process.argv[2] ?? 10);
const G = loadGraph(JSON.parse(readFileSync(new URL('graph.json', AREA), 'utf8')));
const points = JSON.parse(readFileSync(new URL('osm_points.geojson', AREA), 'utf8')).features;
const CLUJ = [23.59, 46.77];

const villages = points
  .filter((f) => f.properties.kind === 'place=village' && f.properties.name)
  .map((f) => ({ name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
  .map((v) => ({ ...v, d: haversine(CLUJ[0], CLUJ[1], v.lon, v.lat) }))
  .filter((v) => v.d > 6000 && v.d < 40000);

// farthest-point picking, so the samples cover different valleys
const picked = [villages.reduce((a, b) => (a.d < b.d ? a : b))];
while (picked.length < count * 2 && picked.length < villages.length) {
  let best = null, bd = -1;
  for (const v of villages) {
    if (picked.includes(v)) continue;
    const d = Math.min(...picked.map((p) => haversine(p.lon, p.lat, v.lon, v.lat)));
    if (d > bd) { bd = d; best = v; }
  }
  picked.push(best);
}

const PLANS = [
  { length: 5000, climbs: 1 }, { length: 8000, climbs: 2 }, { length: 12000, climbs: 2 }, { length: 6000, climbs: 1 },
  { length: 20000, climbs: 3 }, { length: 10000, climbs: 1 }, { length: 15000, climbs: 2 }, { length: 4000, climbs: 1 },
  { length: 30000, climbs: 3 }, { length: 25000, climbs: 2 },
];
const samples = [];
for (const v of picked) {
  if (samples.length >= count) break;
  const plan = PLANS[samples.length % PLANS.length];
  const start = nearestNode(G, v.lon, v.lat);
  if (haversine(v.lon, v.lat, G.lon[start], G.lat[start]) > 1500) continue;
  const [r] = generateRoutes(G, start, { ...plan, minClimbGrade: 15, seed: samples.length + 1, count: 1 });
  if (!r) continue;
  const s = r.stats;
  const coords = routeCoords(G, r.path);
  samples.push({
    id: `s${samples.length + 1}`, name: `${v.name}: ${(s.len / 1000).toFixed(0)} km loop`, village: v.name,
    start: [G.lon[start], G.lat[start]], plan,
    stats: { len: Math.round(s.len), up: Math.round(s.up), climbs: s.climbs.length, maxUp: Math.round(s.maxUp),
      green: +s.green.toFixed(2), yellow: +s.yellow.toFixed(2), red: +s.red.toFixed(2), dirt: +s.dirt.toFixed(2) },
    poly: encodePolyline(coords),
  });
  console.log(`${samples.at(-1).name.padEnd(34)} up ${String(Math.round(s.up)).padStart(4)} m  climbs ${s.climbs.length}  dirt ${Math.round(s.dirt * 100)}%  green ${Math.round(s.green * 100)}%  yellow ${Math.round(s.yellow * 100)}%`);
}
writeFileSync(new URL('samples.json', AREA), JSON.stringify({ built: new Date().toISOString().slice(0, 10), samples }));
console.log(`${samples.length} samples -> data/area/samples.json`);
