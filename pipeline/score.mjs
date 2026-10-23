// Step 7b: score every edge with core/scoring.js (the same code the phone uses) -> data/area/edge_scores.json
// {edge id: [exists x100, class 0/1/2, rideable level 0/1/2, legal 0 ok / 1 restricted / 2 no]} for build_tiles.py.
//   node pipeline/score.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scoreEdge } from '../core/scoring.js';

// DS_AI=1: the private graph with the AI-found tracks (data/ai/)
const AREA = fileURLToPath(new URL(process.env.DS_AI ? '../data/ai/' : '../data/area/', import.meta.url));
const motorAccess = (p) => p.motorcycle ?? p.motor_vehicle ?? p.vehicle ?? p.access ?? null;

// The edge as the area pack's "tracks" layer describes it (keep in step with build_tiles.py tracks_layer).
export function tileProps(p) {
  const tt = String(p.tracktype ?? '');
  return {
    class: p.highway.replace('_link', ''), tt: /^grade\d/.test(tt) ? +tt[5] : null, smooth: p.smoothness, sac: p.sac_scale,
    mtb: p['mtb:scale'], vis: p.trail_visibility, acc: motorAccess(p), len: p.len, det: p.det, tp: p.tp, tn: p.tn,
    tree: p.tree, g50: p.g50, g100: p.g100, gall: p.gall, prot: p.prot ? 1 : null, routes: p.routes, ver: p.version,
    src: p.source, aic: p.aic,
  };
}

const fc = JSON.parse(readFileSync(join(AREA, 'edges_evidence.geojson'), 'utf8'));
const out = {};
const km = [0, 0, 0];
const legalKm = { restricted: 0, no: 0 };
for (const f of fc.features) {
  const p = f.properties;
  const s = scoreEdge(tileProps(p));
  out[p.id] = [Math.round(s.exists * 100), s.cls, s.level, s.legal === 'no' ? 2 : s.legal === 'restricted' ? 1 : 0];
  if (['track', 'path', 'bridleway'].includes(p.highway)) {
    km[s.cls] += p.len / 1000;
    if (s.legal !== 'ok') legalKm[s.legal] += p.len / 1000;
  }
}
writeFileSync(join(AREA, 'edge_scores.json'), JSON.stringify(out));
console.log(`scored ${fc.features.length} edges; tracks+paths: green ${km[0].toFixed(0)} km, yellow ${km[1].toFixed(0)} km, `
  + `red ${km[2].toFixed(0)} km; legal flags: restricted ${legalKm.restricted.toFixed(0)} km, no ${legalKm.no.toFixed(0)} km`);
