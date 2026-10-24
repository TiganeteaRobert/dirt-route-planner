// Elevation profile on a made-up straight line due north: 300 m flat, 150 m climbing at 40 %, 300 m flat, 150 m
// descending at 20 %, 200 m flat (1100 m). The smoothing (Gaussian of 30 m, grade over 50 m) brings a ramp's peak
// grade below its true value when the ramp is short: 150 m reads ~39 %, 100 m only ~35 %.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevationProfile, profileFrom, steepSections, gradeColor, gradeBands, GRADE_COLORS } from '../core/profile.js';
import { EARTH_R } from '../core/geo.js';

const LON = 23.5, LAT0 = 46.7, M_PER_DEG = EARTH_R * (Math.PI / 180);
const BREAKS = [[0, 500], [300, 500], [450, 560], [750, 560], [900, 530], [1100, 530]];    // [metres, elevation]

const heightAt = (s, breaks = BREAKS) => {
  for (let k = 1; k < breaks.length; k++) {
    const [s0, h0] = breaks[k - 1], [s1, h1] = breaks[k];
    if (s <= s1) return h0 + ((h1 - h0) * (s - s0)) / (s1 - s0);
  }
  return breaks.at(-1)[1];
};
const lineThrough = (breaks = BREAKS) => breaks.map(([s]) => [LON, LAT0 + s / M_PER_DEG]);
const fromLat = (lat) => (lat - LAT0) * M_PER_DEG;
const elevAt = async (lon, lat) => heightAt(fromLat(lat));
const near = (v, want, tol, what) => assert.ok(Math.abs(v - want) <= tol, `${what}: ${v}, expected ${want} ± ${tol}`);
const gradeNear = (p, s) => p.grade[p.dist.findIndex((d) => d >= s)];

test('climb and descent: totals, grades, the steep stretch', async () => {
  const p = await elevationProfile(lineThrough(), elevAt);
  assert.ok(p);
  assert.equal(p.pts.length, p.dist.length);
  assert.equal(p.elev.length, p.dist.length);
  assert.equal(p.grade.length, p.dist.length);
  assert.ok(Array.isArray(p.dist) && Array.isArray(p.elev) && Array.isArray(p.grade));
  assert.equal(p.dist[0], 0);
  near(p.length, 1100, 0.5, 'length');
  assert.ok(p.dist.every((d, i) => !i || d - p.dist[i - 1] <= 10), 'samples at most 10 m apart');
  near(p.up, 60, 1, 'up');
  near(p.down, 30, 1, 'down');
  near(p.min, 500, 0.5, 'min');
  near(p.max, 560, 0.5, 'max');
  near(p.maxUp, 40, 2, 'maxUp');
  near(p.maxDown, 20, 1.5, 'maxDown');
  assert.ok(p.grade.every((g) => Math.abs(g) < 45), 'nothing reaches 45 %');
  assert.ok(gradeNear(p, 375) > 35, 'mid-ramp climbs');
  assert.ok(gradeNear(p, 825) < -17, 'mid-descent goes down');
  near(gradeNear(p, 150), 0, 0.5, 'flat start');
  near(gradeNear(p, 600), 0, 0.5, 'flat between');

  const s30 = steepSections(p, 30);
  assert.equal(s30.length, 1, 'only the ramp is 30 % or more');
  const [ramp] = s30;
  assert.equal(ramp.dir, 1);
  near(ramp.max, 40, 2, 'ramp max');
  assert.ok(ramp.from >= 300 && ramp.to <= 450 && ramp.to - ramp.from >= 80, `ramp at ${ramp.from}-${ramp.to}`);
  assert.ok(p.dist[ramp.i0] >= ramp.from && p.dist[ramp.i1] <= ramp.to && ramp.i0 < ramp.i1);
  near(ramp.rise, 0.4 * (ramp.to - ramp.from), 6, 'ramp rise');

  const s15 = steepSections(p, 15);
  assert.equal(s15.length, 2);
  const [up, down] = s15;
  assert.equal(up.dir, 1);
  assert.equal(down.dir, -1);
  near(down.max, 20, 1.5, 'descent max');
  assert.ok(down.from >= 750 && down.to <= 900, `descent at ${down.from}-${down.to}`);
  near(down.rise, 0.2 * (down.to - down.from), 3, 'descent rise');
});

test('grades follow the direction of travel', async () => {
  const p = await elevationProfile(lineThrough().reverse(), elevAt);
  const s = steepSections(p, 30);
  assert.equal(s.length, 1);
  assert.equal(s[0].dir, -1, 'the ramp is a descent the other way');
  near(p.maxDown, 40, 2, 'maxDown');
  near(p.up, 30, 1, 'up');
  near(p.down, 60, 1, 'down');
});

test('a short ramp reads gentler than it is (smoothing over ~30 m)', async () => {
  const breaks = [[0, 500], [300, 500], [400, 540], [700, 540]];
  const p = await elevationProfile(lineThrough(breaks), async (lon, lat) => heightAt(fromLat(lat), breaks));
  near(p.maxUp, 35, 2, '100 m at 40 %');
  near(p.up, 40, 1, 'up');
});

test('missing elevations: isolated gaps are interpolated, too many give null', async () => {
  const full = await elevationProfile(lineThrough(), elevAt);
  let k = 0;
  const holes = await elevationProfile(lineThrough(), async (lon, lat) => (k++ % 17 === 5 ? null : elevAt(lon, lat)));
  assert.ok(holes, 'a few missing samples still give a profile');
  assert.equal(holes.dist.length, full.dist.length);
  near(Math.max(...holes.elev.map((e, i) => Math.abs(e - full.elev[i]))), 0, 0.3, 'largest difference');
  near(holes.up, 60, 1, 'up');

  const n = full.dist.length;
  let j = 0;
  const ends = await elevationProfile(lineThrough(), async (lon, lat) => {
    const i = j++;
    return i < 3 || i >= n - 2 ? null : elevAt(lon, lat);
  });
  near(ends.elev[0], 500, 0.1, 'start: the nearest valid sample');
  near(ends.elev.at(-1), 530, 0.1, 'end: the nearest valid sample');

  let m = 0;
  const thirty = async (lon, lat) => (m++ % 10 < 3 ? null : elevAt(lon, lat));       // 30 % missing
  assert.equal(await elevationProfile(lineThrough(), thirty), null);
  assert.equal(await elevationProfile(lineThrough(), async () => NaN), null);
  assert.equal(await elevationProfile(lineThrough(), async () => null), null);
  assert.equal(await elevationProfile([[LON, LAT0], [LON, LAT0]], elevAt), null, 'no length');
});

test('a route shorter than the grade window uses all of it', () => {
  const p = profileFrom([0, 20], [100, 104]);
  assert.deepEqual(p.grade, [20, 20]);
  assert.equal(p.length, 20);
  assert.equal(p.pts, null);
  const q = profileFrom([0, 10, 20, 30, 40], [100, 102, 104, 106, 108]);
  assert.equal(new Set(q.grade).size, 1, 'one window for every sample');
  assert.ok(q.grade[0] > 0);
});

test('steep stretches: short gaps in the same direction join, a crest splits', () => {
  const at = (grade) => ({ dist: grade.map((_, i) => i * 10), elev: grade.map(() => 0), grade });
  const c = 35, d = -35;
  // one sample under 30 % between two runs: ~10 m apart -> one stretch
  const joined = steepSections(at([0, 0, c, c, c, 25, c, c, c, 0, 0]), 30);
  assert.equal(joined.length, 1);
  assert.deepEqual([joined[0].i0, joined[0].i1, joined[0].dir, joined[0].max], [2, 8, 1, 35]);
  near(joined[0].from, 18.6, 0.1, 'from: where the grade passes 30 %');
  near(joined[0].to, 81.4, 0.1, 'to');
  // three samples under 30 %: ~30 m apart -> two stretches
  assert.equal(steepSections(at([0, c, c, c, c, 25, 25, 25, c, c, c, c, 0]), 30).length, 2);
  // a climb straight into a descent: two stretches, one each way
  const crest = steepSections(at([0, c, c, c, c, 10, d, d, d, d, 0]), 30);
  assert.deepEqual(crest.map((s) => s.dir), [1, -1]);
  // a lone steep sample is shorter than minLen
  assert.equal(steepSections(at([0, 0, 0, c, 0, 0, 0]), 30).length, 0);
  assert.equal(steepSections(at([0, 0, 0, c, 0, 0, 0]), 30, 0).length, 1);
});

test('grade colours and their legend', () => {
  const { green, yellow, orange, red } = GRADE_COLORS;
  assert.deepEqual([0, 14.9, 15, 24.9, 25, 44.9, 45, 80].map((g) => gradeColor(g, 45)),
    [green, green, yellow, yellow, orange, orange, red, red]);
  assert.equal(gradeColor(-30, 45), orange, 'descents by their size');
  assert.equal(gradeColor(34.9, 35), orange);
  assert.equal(gradeColor(35, 35), red);
  assert.deepEqual([14, 15, 24.9, 25, 40].map((g) => gradeColor(g, 25)), [green, yellow, yellow, red, red]);
  for (let g = 0; g <= 100; g += 0.5) assert.notEqual(gradeColor(g, 25), orange, 'no orange when red starts at 25 %');
  assert.deepEqual(gradeBands(45), [[green, '< 15 %'], [yellow, '15-25 %'], [orange, '25-45 %'], [red, '> 45 %']]);
  assert.deepEqual(gradeBands(35).map((b) => b[1]), ['< 15 %', '15-25 %', '25-35 %', '> 35 %']);
  assert.deepEqual(gradeBands(25), [[green, '< 15 %'], [yellow, '15-25 %'], [red, '> 25 %']]);
});
