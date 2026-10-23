// M6: a batch of rides across the riding area -> a folder of GPX files, index.csv and batch.json (same shape as the
// pack's samples.json, so the app can list it). Start points are spread over villages, towns and parking places;
// lengths, climbs and shapes vary; every route must differ from all others (edge overlap under 30 %).
//   node tools/batch.mjs [count=100] [outDir=private/batch-<date>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph, nearestNode, generateRoutes, routeCoords, haversine } from '../core/routing.js';
import { encodePolyline } from '../core/polyline.js';
import { toGPX } from '../core/gpx.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AREA = join(ROOT, 'data', 'area');
const count = +(process.argv[2] ?? 100);
const out = process.argv[3] ?? join(ROOT, 'private', `batch-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(out, { recursive: true });

const G = loadGraph(JSON.parse(readFileSync(join(AREA, 'graph.json'), 'utf8')));
const points = JSON.parse(readFileSync(join(AREA, 'osm_points.geojson'), 'utf8')).features;
const starts = points
  .filter((f) => ['place=village', 'place=town', 'place=hamlet', 'amenity=parking'].includes(f.properties.kind))
  .map((f) => ({ name: f.properties.name || (f.properties.kind === 'amenity=parking' ? 'parking' : 'hamlet'),
    kind: f.properties.kind, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
  .filter((s) => s.kind !== 'amenity=parking' || s.name !== 'parking' || true);

// spread: farthest-point order over all candidate starts
const order = [starts[0]];
const minD = starts.map((s) => haversine(s.lon, s.lat, order[0].lon, order[0].lat));
while (order.length < Math.min(starts.length, count * 3)) {
  let bi = -1, bd = -1;
  for (let i = 0; i < starts.length; i++) if (minD[i] > bd) { bd = minD[i]; bi = i; }
  if (bd <= 0) break;
  order.push(starts[bi]);
  for (let i = 0; i < starts.length; i++) minD[i] = Math.min(minD[i], haversine(starts[i].lon, starts[i].lat, starts[bi].lon, starts[bi].lat));
}

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const LENGTHS = [4, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 50];
const chosen = [];
const sets = [];
const jaccard = (a, b) => { let i = 0; for (const e of a) if (b.has(e)) i++; return i / (a.size + b.size - i || 1); };
for (const s of order) {
  if (chosen.length >= count) break;
  const start = nearestNode(G, s.lon, s.lat);
  if (haversine(s.lon, s.lat, G.lon[start], G.lat[start]) > 1500) continue;
  const length = LENGTHS[Math.floor(rnd() * LENGTHS.length)] * 1000;
  const plan = { length, climbs: Math.floor(rnd() * 4), shape: rnd() < 0.85 ? 'loop' : 'out-back', minClimbGrade: rnd() < 0.5 ? 15 : 20 };
  const routes = generateRoutes(G, start, { ...plan, seed: chosen.length + 1, count: 3 });
  const r = routes.find((x) => { const set = new Set(x.path.map((p) => p.e)); return sets.every((o) => jaccard(o, set) < 0.3); });
  if (!r) continue;
  sets.push(new Set(r.path.map((p) => p.e)));
  const st = r.stats;
  const coords = routeCoords(G, r.path);
  const id = `b${String(chosen.length + 1).padStart(3, '0')}`;
  const name = `${s.name}: ${(st.len / 1000).toFixed(0)} km ${plan.shape === 'loop' ? 'loop' : 'out and back'}${st.climbs.length ? `, ${st.climbs.length} climb${st.climbs.length > 1 ? 's' : ''}` : ''}`;
  writeFileSync(join(out, `${id}.gpx`), toGPX({ name, segments: [coords.map(([lon, lat]) => ({ lon, lat }))] }));
  chosen.push({
    id, name, village: s.name, start: [G.lon[start], G.lat[start]], plan,
    stats: { len: Math.round(st.len), up: Math.round(st.up), climbs: st.climbs.length, maxUp: Math.round(st.maxUp),
      green: +st.green.toFixed(2), yellow: +st.yellow.toFixed(2), red: +st.red.toFixed(2), dirt: +st.dirt.toFixed(2) },
    poly: encodePolyline(coords),
  });
  if (chosen.length % 10 === 0) console.log(`${chosen.length} routes`);
}
const csv = ['id,name,start_lat,start_lon,km,up_m,climbs,steepest_pct,dirt_pct,green_pct,yellow_pct,red_pct',
  ...chosen.map((c) => [c.id, `"${c.name.replace(/"/g, "'")}"`, c.start[1].toFixed(5), c.start[0].toFixed(5), (c.stats.len / 1000).toFixed(1),
    c.stats.up, c.stats.climbs, c.stats.maxUp, Math.round(c.stats.dirt * 100), Math.round(c.stats.green * 100),
    Math.round(c.stats.yellow * 100), Math.round(c.stats.red * 100)].join(','))];
writeFileSync(join(out, 'index.csv'), csv.join('\n'));
writeFileSync(join(out, 'batch.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), samples: chosen }));
console.log(`${chosen.length} routes -> ${out}`);
