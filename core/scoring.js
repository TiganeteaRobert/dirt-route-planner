// M3 scoring: does a way physically exist (0-1), can a dirt bike ride it, may motors use it - and why. Shared by the
// pipeline (colours in the area pack) and the phone (the explanation in the track card, later routing), no DOM.
// Starting weights from the plan (HANDOFF section 12), to be tuned with the rider's feedback.
//
// Input: edge properties as in the area pack's "tracks" layer (class, tt, smooth, sac, mtb, vis, acc, det, tp, tn,
// tree, g50, g100, gall, routes, src, ver, yr, len; aic = the AI's score 0-1 for class "ai" and "gap" (a stretch the
// AI tracks were joined across), the owner's private layer) plus optional extras {tet: overlap share 0-1 with TET/ACT
// tracks}. The owner picks how sure the AI must be with the app's slider, so those classes are yellow (unknown) at
// best and red only when hard to ride, whatever their score.

const ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MINOR = new Set(['unclassified', 'residential', 'living_street', 'service', 'road']);
const NO_MOTORS = new Set(['footway', 'cycleway', 'steps', 'pedestrian']);
const SAC_T3 = new Set(['demanding_mountain_hiking', 'alpine_hiking', 'demanding_alpine_hiking', 'difficult_alpine_hiking']);
const BAD_SMOOTH = new Set(['horrible', 'very_horrible', 'impassable']);
const BAD_VIS = new Set(['bad', 'horrible', 'no']);
const BANNED = new Set(['no', 'private', 'military']);
const RESTRICTED = new Set(['forestry', 'agricultural', 'agricultural;forestry', 'forestry;agricultural', 'delivery']);

export const CLASS_NAMES = ['green', 'yellow', 'red'];

function mtbLevel(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Steepest grade we trust most: 100 m, else 50 m, else the whole (short) piece.
export const gradeOf = (p) => p.g100 ?? p.g50 ?? p.gall ?? null;

export function scoreEdge(p, extras = {}) {
  const reasons = [];
  const add = (code, text, d = 0) => reasons.push({ code, text, d });
  const cls = p.class;

  // ---- exists ----
  let exists;
  if (ROADS.has(cls)) { exists = 0.95; add('road', 'mapped as a public road', 0.95); }
  else if (MINOR.has(cls)) { exists = 0.6; add('minor', 'mapped as a minor road / street', 0.6); }
  else if (cls === 'track') { exists = 0.5; add('track', 'mapped as a track', 0.5); }
  else if (cls === 'detected') { exists = 0.55; add('detected', 'seen from above by Microsoft in Bing imagery, not in OSM', 0.55); }
  else if (cls === 'ai') {
    exists = 0.35 + 0.25 * Math.min(1, p.aic ?? 0.5);
    add('ai', `found by DirtScout's AI in satellite imagery (${Math.round((p.aic ?? 0.5) * 100)} % sure), on no map`, Math.round(exists * 100) / 100);
  }
  else if (cls === 'gap') {
    exists = 0.3;
    add('gap', 'a gap the AI-found tracks were joined across: nothing was seen here (forest canopy?), so the track may not go through', 0.3);
  }
  else { exists = 0.35; add('path', `mapped as a ${cls ?? 'way'}`, 0.35); }

  if (p.src && /survey|gps|gnss/i.test(p.src)) { exists += 0.1; add('survey', 'mapped from a ground survey or GPS', 0.1); }
  if ((p.ver ?? 0) >= 3) { exists += 0.05; add('edits', `edited ${p.ver} times in OSM`, 0.05); }
  if (p.det != null && cls !== 'detected' && cls !== 'ai' && cls !== 'gap') {
    if (p.det >= 0.7) { exists += 0.25; add('det', `seen from above along ${Math.round(p.det * 100)} % of it`, 0.25); }
    else if (p.det >= 0.3) { exists += 0.1; add('det', `seen from above along ${Math.round(p.det * 100)} % of it`, 0.1); }
  }
  const density = p.tp != null && p.len ? p.tp / Math.max(0.1, p.len / 100) : 0;
  if ((p.tn ?? 0) >= 3 || density >= 5) { exists += 0.2; add('traces', `${p.tp} public GPS points on it${p.tn ? ` (${p.tn} traces)` : ''}`, 0.2); }
  else if ((p.tn ?? 0) >= 1 || density >= 1) { exists += 0.1; add('traces', `${p.tp} public GPS points on it`, 0.1); }
  const routes = String(p.routes ?? '');
  if (routes.includes('mtb')) { exists += 0.1; add('mtb', 'part of a marked MTB route', 0.1); }
  else if (routes.includes('hiking') || routes.includes('foot')) { exists += 0.05; add('hiking', 'part of a marked hiking route', 0.05); }
  if ((extras.tet ?? 0) >= 0.7) { exists += 0.3; add('tet', 'on your TET / ACT track', 0.3); }
  exists = Math.min(1, exists);

  // ---- rideable: worst condition wins ----
  let level = 0;                       // 0 fine, 1 caution (yellow), 2 hard (red)
  const rate = (l, code, text) => { if (l > level) level = l; add(code, text, l === 2 ? 'red' : 'yellow'); };
  if (NO_MOTORS.has(cls)) rate(2, 'nomotor', `a ${cls}: not for motor vehicles`);
  if (p.tt >= 4) rate(1, 'grade45', `track grade ${p.tt} (rough)`);
  if (p.smooth && BAD_SMOOTH.has(p.smooth)) rate(2, 'smooth', `smoothness "${p.smooth}"`);
  if (p.sac && SAC_T3.has(p.sac)) rate(2, 'sac', 'hiking scale T3 or harder: hikers only');
  else if (p.sac === 'mountain_hiking') rate(1, 'sac', 'hiking scale T2 (mountain path)');
  const mtb = mtbLevel(p.mtb);
  if (mtb != null && mtb >= 4) rate(2, 'mtb', `MTB scale ${p.mtb}`);
  else if (mtb != null && mtb >= 3) rate(1, 'mtb', `MTB scale ${p.mtb}`);
  const g = gradeOf(p);
  if (g != null && g > 35) rate(2, 'steep', `very steep: about ${Math.round(g)} % (approx.)`);
  else if (g != null && g > 25) rate(1, 'steep', `steep: about ${Math.round(g)} % (approx.)`);
  if ((p.tree ?? 0) >= 0.8 && (cls === 'path' || cls === 'bridleway') && g != null && g > 20) {
    rate(2, 'foreststeep', 'steep path in deep forest');
  }
  if (p.vis && BAD_VIS.has(p.vis)) rate(2, 'vis', `trail visibility "${p.vis}"`);
  if (p.tt && p.tt <= 2 && level === 0) add('easy', `track grade ${p.tt} (good surface)`, 0);

  // ---- legal ----
  let legal = 'ok';
  if (p.acc && BANNED.has(p.acc)) { legal = 'no'; add('access', `motor access "${p.acc}" in OSM`, 'legal'); }
  else if (p.acc && RESTRICTED.has(p.acc)) { legal = 'restricted'; add('access', `motor access "${p.acc}" in OSM`, 'legal'); }
  if (p.prot) add('protected', 'inside a protected area: check the rules', 'legal');
  if (cls === 'detected') add('unknown', 'not in OSM: name, surface and access unknown', 'legal');
  if (cls === 'ai') add('unknown', 'on no map: surface and access unknown; it could be private, a field edge or a ditch', 'legal');
  if (cls === 'gap') add('unknown', 'on no map and not seen: check it on the ground', 'legal');

  // ---- class ----
  let cls3;
  if (cls === 'ai' || cls === 'gap') cls3 = level === 2 ? 2 : 1;
  else if (exists < 0.5 || level === 2) cls3 = 2;
  else if (exists < 0.75 || level === 1) cls3 = 1;
  else cls3 = 0;
  return { exists: Math.round(exists * 100) / 100, level, legal, cls: cls3, name: CLASS_NAMES[cls3], reasons };
}
