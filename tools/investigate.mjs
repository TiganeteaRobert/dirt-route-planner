// M5 on the PC: investigate a GPX against the area pack and write a report folder.
//   node tools/investigate.mjs <track.gpx|.kml> [outDir]
// Writes: report.json (everything), report.md (summary with km markers), alt-<n>.gpx (ways around red stretches),
// flags.json (boxes of the stretches to look at on imagery: python tools/imagery_crops.py <outDir>).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../core/routing.js';
import { buildIndex, investigate } from '../core/investigate.js';
import { parseTrackFile, toGPX } from '../core/gpx.js';
import { demSampler } from './demsampler.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AREA = join(ROOT, 'data', 'area');
const [, , gpxPath, outArg] = process.argv;
if (!gpxPath) { console.error('usage: node tools/investigate.mjs <track.gpx> [outDir]'); process.exit(2); }
const name = basename(gpxPath).replace(/\.(gpx|kml)$/i, '');
const out = resolve(outArg ?? join(ROOT, 'private', 'reports', name));
mkdirSync(out, { recursive: true });

const t0 = Date.now();
const G = loadGraph(JSON.parse(readFileSync(join(AREA, 'graph.json'), 'utf8')));
const X = buildIndex(G);
const parsed = parseTrackFile(gpxPath, readFileSync(gpxPath, 'utf8'));
const coords = parsed.lines.flatMap((l) => l.coords.map((c) => [c[0], c[1]]));
if (coords.length < 2) { console.error('no track in the file'); process.exit(1); }
const res = await investigate(G, X, coords, { elevAt: demSampler(join(AREA, 'dem.pmtiles')) });
const km = (m) => (m / 1000).toFixed(2);
const pct = (x) => `${Math.round(x * 100)} %`;

const lines = [
  `# Investigation: ${parsed.name ?? name}`, '',
  `**Verdict: ${res.verdict.toUpperCase()}** · ${km(res.length)} km · green ${pct(res.shares.green)}, yellow ${pct(res.shares.yellow)}, `
  + `red ${pct(res.shares.red)}, not on any mapped way ${pct(res.shares.unmapped)}`
  + (res.shares.legalNo ? `, closed to motors in OSM ${pct(res.shares.legalNo)}` : ''), '',
];
if (res.profile) {
  const p = res.profile;
  lines.push(`Elevation ${Math.round(p.min)}-${Math.round(p.max)} m, up ${Math.round(p.up)} m, down ${Math.round(p.down)} m (FABDEM, 30 m smoothing).`, '');
  if (p.climbs.length) lines.push('## Climbs (15 %+ over 50 m)', ...p.climbs.map((c) => `- km ${km(c.from)}-${km(c.to)}: ${Math.round(c.to - c.from)} m, avg ${Math.round(c.avg)} %, max ${Math.round(c.max)} %`), '');
  if (p.descents.length) lines.push('## Steep descents (20 %+)', ...p.descents.map((c) => `- km ${km(c.from)}-${km(c.to)}: max ${Math.round(c.max)} %`), '');
}
if (res.stretches.length) {
  lines.push('## Risky stretches');
  for (const s of res.stretches) {
    const why = [...new Set(s.parts.map((x) => (x.e === null ? 'not on any mapped way' : `${x.cls}${x.name ? ` "${x.name}"` : ''}, exists ${x.exists} %, seen from above ${x.det} %, forest ${x.tree} %${x.grade ? `, ~${Math.round(x.grade)} %` : ''}${x.legal === 2 ? ', closed to motors' : ''}`)))];
    lines.push(`- km ${km(s.from)}-${km(s.to)} (${s.kind}): ${why.join('; ')}`);
  }
  lines.push('');
}
if (res.alternatives.length) {
  lines.push('## Ways around');
  res.alternatives.forEach((a, i) => {
    lines.push(`- alt-${i + 1}.gpx: km ${a.fromKm.toFixed(2)}-${a.toKm.toFixed(2)}, ${km(a.stats.len)} km instead of ${km(a.original)} km `
      + `(${a.extra >= 0 ? '+' : ''}${Math.round(a.extra)} m), up ${Math.round(a.stats.up)} m, green ${pct(a.stats.green)}`);
    writeFileSync(join(out, `alt-${i + 1}.gpx`), toGPX({ name: `${name} alternative ${i + 1}`, segments: [a.coords.map(([lon, lat]) => ({ lon, lat }))] }));
  });
  lines.push('');
}
lines.push('Grades come from a 30 m bare-earth model and miss short pitches; "not on any mapped way" means more than 30 m from every OSM way in the pack.');
writeFileSync(join(out, 'report.md'), lines.join('\n'));
const flags = res.stretches.map((s, i) => {
  const ptsIn = res.points.filter((_, k) => k >= s.parts[0].start && k <= s.parts.at(-1).end);
  const lons = ptsIn.map((p) => p[0]), lats = ptsIn.map((p) => p[1]);
  return { n: i + 1, kind: s.kind, fromKm: s.from / 1000, toKm: s.to / 1000, bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] };
});
writeFileSync(join(out, 'flags.json'), JSON.stringify({ track: coords, flags, alternatives: res.alternatives.map((a) => a.coords) }));
const slim = { ...res, points: undefined, profile: res.profile && { ...res.profile, dist: undefined, elev: undefined } };
writeFileSync(join(out, 'report.json'), JSON.stringify(slim, null, 1));
console.log(lines.join('\n'));
console.log(`\nreport in ${out} (${Date.now() - t0} ms)`);
