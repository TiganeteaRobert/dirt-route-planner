// Prints point-by-point matches of a track between two km marks (debugging the map matcher).
import { readFileSync } from 'node:fs';
import { loadGraph, haversine } from '../core/routing.js';
import { buildIndex } from '../core/investigate.js';
import * as inv from '../core/investigate.js';
import { parseTrackFile } from '../core/gpx.js';
import { densify } from '../core/geo.js';
const [, , file, fromKm, toKm] = process.argv;
const G = loadGraph(JSON.parse(readFileSync(new URL('../data/area/graph.json', import.meta.url), 'utf8')));
const X = buildIndex(G);
const p = parseTrackFile(file, readFileSync(file, 'utf8'));
const pts = densify(p.lines.flatMap((l) => l.coords.map((c) => [c[0], c[1]])), 10);
const res = await inv.investigate(G, X, pts, {});
let d = 0;
for (let i = 0; i < pts.length; i++) {
  if (i) d += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  if (d / 1000 < +fromKm || d / 1000 > +toKm) continue;
  const seg = res.segments.find((s) => i >= s.start && i <= s.end);
  console.log(`${(d / 1000).toFixed(3)} km  seg e=${seg?.e ?? '-'} ${seg?.e != null ? G.ids[seg.e] : 'UNMAPPED'}`);
}
