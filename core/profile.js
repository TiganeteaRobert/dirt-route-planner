// Elevation profile along a route: the elevation model sampled every few metres, smoothed over ~30 m, the grade at
// every sample, the steep stretches, and the grade colours the chart (app/src/chart.js) and the map share. No DOM.
// The model (FABDEM) is ~30 m: short steep pitches do not show, and real grades can be steeper than these numbers.
import { densify, haversine } from './geo.js';

export const GRADE_COLORS = { green: '#43a047', yellow: '#fdd835', orange: '#fb8c00', red: '#e53935' };

const SIGMA = 30;              // m: Gaussian smoothing of the elevation, about the model's own resolution
const WINDOW = 50;             // m: each sample's grade is taken over this distance, centred on it
const MERGE_GAP = 20;          // m: steep stretches closer than this (same direction) count as one

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * coords: [[lon, lat], ...]. elevAt: async (lon, lat) => metres | null. Samples every `step` m (the vertices are kept).
 * Null when under 80 % of the samples have an elevation (no tiles there) or the line has no length.
 */
export async function elevationProfile(coords, elevAt, { step = 10 } = {}) {
  if (!coords || coords.length < 2) return null;
  const pts = densify(coords, step);
  const n = pts.length;
  const dist = new Float64Array(n), elev = new Float64Array(n);
  let ok = 0;
  for (let i = 0; i < n; i++) {
    if (i) dist[i] = dist[i - 1] + haversine(pts[i - 1], pts[i]);
    const v = await elevAt(pts[i][0], pts[i][1]);
    if (v != null && Number.isFinite(v)) { elev[i] = v; ok++; } else elev[i] = NaN;
  }
  if (ok < 0.8 * n || !(dist[n - 1] > 0)) return null;
  if (ok < n) fillGaps(dist, elev);
  return profileFrom(dist, elev, pts);
}

// Missing samples: straight between the valid neighbours (by distance); before the first and after the last valid
// sample, the nearest valid value.
function fillGaps(dist, elev) {
  const n = elev.length;
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && Number.isNaN(elev[i])) continue;
    for (let k = prev + 1; k < i; k++) {
      if (prev < 0) elev[k] = elev[i];
      else if (i === n) elev[k] = elev[prev];
      else {
        const span = dist[i] - dist[prev];
        elev[k] = elev[prev] + (span > 0 ? (dist[k] - dist[prev]) / span : 0) * (elev[i] - elev[prev]);
      }
    }
    prev = i;
  }
}

/**
 * dist: metres from the start (non-decreasing), elev: raw metres, one per sample; pts: their [lon, lat] (kept for the
 * caller, e.g. to show a sample on the map). Returns {pts, dist, elev (smoothed), grade (%, + = climbing in the
 * route's direction), up, down (metres, both positive), min, max, length, maxUp, maxDown (steepest descent, positive)}.
 */
export function profileFrom(dist, elev, pts = null) {
  const n = dist.length;
  if (!n) return null;
  const sm = smooth(dist, elev);
  let up = 0, down = 0;
  for (let i = 1; i < n; i++) {
    const d = sm[i] - sm[i - 1];
    if (d > 0) up += d; else down -= d;
  }
  const grade = Array.from(grades(dist, sm), r1);
  const e = Array.from(sm, r1);
  let min = Infinity, max = -Infinity, maxUp = 0, maxDown = 0;
  for (let i = 0; i < n; i++) {
    if (e[i] < min) min = e[i];
    if (e[i] > max) max = e[i];
    if (grade[i] > maxUp) maxUp = grade[i];
    if (-grade[i] > maxDown) maxDown = -grade[i];
  }
  const d = Array.from(dist, r1);
  return { pts, dist: d, elev: e, grade, up: r1(up), down: r1(down), min, max, length: d[n - 1], maxUp, maxDown };
}

// Gaussian of SIGMA metres, as samples at the median spacing; the ends are held.
function smooth(dist, elev) {
  const n = dist.length;
  const out = Float64Array.from(elev);
  if (n < 3) return out;
  const gaps = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) gaps[i - 1] = dist[i] - dist[i - 1];
  gaps.sort();
  let spacing = gaps[gaps.length >> 1];
  if (!(spacing > 0)) spacing = (dist[n - 1] - dist[0]) / (n - 1);      // mostly repeated points
  if (!(spacing > 0)) return out;
  const s = SIGMA / spacing, r = Math.ceil(3 * s);
  const w = new Float64Array(2 * r + 1);
  let ws = 0;
  for (let j = -r; j <= r; j++) ws += (w[j + r] = Math.exp(-(j * j) / (2 * s * s)));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += w[j + r] * elev[Math.min(n - 1, Math.max(0, i + j))];
    out[i] = acc / ws;
  }
  return out;
}

// Signed grade (%) over a WINDOW m window centred on each sample, slid inside the route near its ends (the whole
// route when it is shorter). The window's ends are interpolated between samples.
function grades(dist, elev) {
  const n = dist.length, g = new Float64Array(n);
  const d0 = dist[0], L = dist[n - 1] - d0;
  if (!(L > 0)) return g;
  const w = Math.min(WINDOW, L);
  const at = (j, x) => {
    const span = dist[j + 1] - dist[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (x - dist[j]) / span)) : 0;
    return elev[j] + t * (elev[j + 1] - elev[j]);
  };
  let ja = 0, jb = 0;                     // segments holding the window's ends (both only move forward)
  for (let i = 0; i < n; i++) {
    const a = Math.min(Math.max(dist[i] - w / 2, d0), d0 + L - w), b = a + w;
    while (ja < n - 2 && dist[ja + 1] < a) ja++;
    while (jb < n - 2 && dist[jb + 1] < b) jb++;
    g[i] = ((at(jb, b) - at(ja, a)) / w) * 100;
  }
  return g;
}

/**
 * Stretches where |grade| >= minAbs %: runs in the same direction less than 20 m apart are joined (a crest between a
 * steep climb and a steep descent keeps them apart), and stretches shorter than minLen m dropped. from / to are where
 * the grade crosses minAbs (interpolated between samples). Each {from, to, i0, i1 (first and last sample inside),
 * max (steepest |grade|, %), dir (1 = climb, -1 = descent: the sign of the mean grade), rise (metres up or down)}.
 */
export function steepSections(profile, minAbs, minLen = 30) {
  const { dist, elev, grade } = profile;
  const n = grade.length, runs = [];
  // where |grade| crosses minAbs between samples k and k + 1
  const cross = (k) => {
    const ga = Math.abs(grade[k]), gb = Math.abs(grade[k + 1]);
    const t = gb !== ga ? Math.min(1, Math.max(0, (minAbs - ga) / (gb - ga))) : 0.5;
    return { d: dist[k] + t * (dist[k + 1] - dist[k]), e: elev[k] + t * (elev[k + 1] - elev[k]) };
  };
  for (let i = 0; i < n; i++) {
    if (!(Math.abs(grade[i]) >= minAbs)) continue;
    const dir = grade[i] > 0 ? 1 : -1;
    let j = i;
    while (j + 1 < n && Math.abs(grade[j + 1]) >= minAbs && (grade[j + 1] > 0 ? 1 : -1) === dir) j++;
    const s = i > 0 ? cross(i - 1) : { d: dist[0], e: elev[0] };
    const t = j < n - 1 ? cross(j) : { d: dist[n - 1], e: elev[n - 1] };
    const last = runs.at(-1);
    if (last && last.dir === dir && s.d - last.to < MERGE_GAP) Object.assign(last, { i1: j, to: t.d, e1: t.e });
    else runs.push({ i0: i, i1: j, from: s.d, to: t.d, e0: s.e, e1: t.e, dir });
    i = j;
  }
  return runs.filter((r) => r.to - r.from >= minLen).map((r) => {
    let sum = 0, max = 0;
    for (let k = r.i0; k <= r.i1; k++) { sum += grade[k]; max = Math.max(max, Math.abs(grade[k])); }
    const dir = sum >= 0 ? 1 : -1;
    return { from: r1(r.from), to: r1(r.to), i0: r.i0, i1: r.i1, max, dir, rise: r1(Math.abs(r.e1 - r.e0)) };
  });
}

// Colour of a grade: green under 15 %, yellow 15-25 %, orange 25 % up to redAt, red at or above redAt (no orange
// band when redAt is 25 or less).
export function gradeColor(absGrade, redAt = 45) {
  const g = Math.abs(absGrade);
  if (g >= redAt) return GRADE_COLORS.red;
  if (g >= 25) return GRADE_COLORS.orange;
  if (g >= 15) return GRADE_COLORS.yellow;
  return GRADE_COLORS.green;
}

// Legend for gradeColor: [[colour, label], ...].
export function gradeBands(redAt = 45) {
  const { green, yellow, orange, red } = GRADE_COLORS;
  if (redAt <= 15) return [[green, `< ${redAt} %`], [red, `> ${redAt} %`]];
  if (redAt <= 25) return [[green, '< 15 %'], [yellow, `15-${redAt} %`], [red, `> ${redAt} %`]];
  return [[green, '< 15 %'], [yellow, '15-25 %'], [orange, `25-${redAt} %`], [red, `> ${redAt} %`]];
}
