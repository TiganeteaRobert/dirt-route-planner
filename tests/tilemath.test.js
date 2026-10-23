import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quadkey, tileRange, rangeCount, lon2x, x2lon, lat2y, y2lat, terrariumElevation, fillTemplate, tileBounds }
  from '../core/tilemath.js';
import { corridorTiles, estimate } from '../core/area.js';
import { haversine, lineLength } from '../core/geo.js';

const AREA = [22.85, 46.28, 23.80, 46.82];

test('quadkey matches Bing for a Cluj tile (checked against the live server)', () => {
  assert.equal(quadkey(37062, 23111, 16), '1203202013000332');
  assert.equal(quadkey(0, 0, 1), '0');
  assert.equal(quadkey(1, 1, 1), '3');
});

test('tile counts for the riding area match the handoff table', () => {
  const want = { 12: 120, 13: 437, 14: 1665, 15: 6336, 16: 25056, 17: 99589, 18: 397089 };
  for (const [z, n] of Object.entries(want)) assert.equal(rangeCount(tileRange(AREA, +z)), n, `z${z}`);
});

test('lon/lat <-> tile coordinates round trip', () => {
  for (const z of [3, 12, 18]) {
    assert.ok(Math.abs(x2lon(lon2x(23.59, z), z) - 23.59) < 1e-9);
    assert.ok(Math.abs(y2lat(lat2y(46.77, z), z) - 46.77) < 1e-9);
  }
  const [w, s, e, n] = tileBounds(16, 37062, 23111);
  assert.ok(w < 23.59 && e > 23.59 && s < 46.77 && n > 46.77);
});

test('terrarium decoding', () => {
  assert.equal(terrariumElevation(128, 0, 0), 0);
  assert.equal(terrariumElevation(130, 100, 128), 2 * 256 + 100 + 0.5);
});

test('URL templates: z/x/y order, quadkey and subdomains', () => {
  assert.equal(fillTemplate('https://e/tile/{z}/{y}/{x}', 16, 37062, 23111), 'https://e/tile/16/23111/37062');
  assert.equal(fillTemplate('https://b/a{quadkey}.jpg', 16, 37062, 23111), 'https://b/a1203202013000332.jpg');
  assert.equal(fillTemplate('https://{s}.t/{z}', 1, 1, 0, ['a', 'b']), 'https://b.t/1');
});

test('corridor along a 4 km track at z18 with 300 m buffer is a few hundred tiles', () => {
  const line = [[23.40, 46.60], [23.4523, 46.60]];                  // ~4 km east-west
  assert.ok(Math.abs(lineLength(line) - 4000) < 50);
  const n = corridorTiles(line, 300, 18, AREA).length;
  assert.ok(n > 250 && n < 600, `got ${n}`);
  const z16 = corridorTiles(line, 300, 16, AREA).length;
  assert.ok(z16 > 15 && z16 < 80, `z16 got ${z16}`);
});

test('corridor is clipped to the riding area', () => {
  const outside = [[21.0, 45.0], [21.05, 45.0]];
  assert.equal(corridorTiles(outside, 300, 16, AREA).length, 0);
});

test('estimate sums per-zoom counts', () => {
  const e = estimate({ type: 'bbox', bbox: AREA }, 12, 14, 20000);
  assert.equal(e.tiles, 120 + 437 + 1665);
  assert.equal(e.bytes, e.tiles * 20000);
});

test('haversine: 1 degree of latitude is about 111 km', () => {
  assert.ok(Math.abs(haversine([23, 46], [23, 47]) - 111195) < 100);
});
