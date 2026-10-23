// Which tiles a download covers: a box, or a corridor along a track. Also size estimates. No DOM.
import { tileRange, rangeCount, metersPerPixel, TILE_SIZE } from './tilemath.js';
import { densify, bboxBuffer, bboxIntersect, inBBox } from './geo.js';

// Tiles of a box at one zoom, as a lazy list ordered row by row.
export function bboxTiles(bbox, z) {
  const r = tileRange(bbox, z);
  return {
    count: rangeCount(r),
    *[Symbol.iterator]() {
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) yield [x, y];
    },
  };
}

// Tiles within `buffer` metres of a line (approximated by the boxes of circles along it), clipped to `clip`.
// Returns [x, y] pairs sorted by row, then column.
export function corridorTiles(coords, buffer, z, clip = null) {
  const lat0 = coords.length ? coords[0][1] : 45;
  const tileM = metersPerPixel(lat0, z) * TILE_SIZE;
  const pts = densify(coords, Math.max(5, Math.min(buffer, tileM) / 2));
  const seen = new Set();
  const out = [];
  for (const p of pts) {
    let box = bboxBuffer([p[0], p[1], p[0], p[1]], buffer);
    if (clip) {
      if (!inBBox(p, bboxBuffer(clip, buffer))) continue;
      box = bboxIntersect(box, clip);
      if (!box) continue;
    }
    const r = tileRange(box, z);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const k = y * 4194304 + x;           // unique up to z22
        if (!seen.has(k)) { seen.add(k); out.push([x, y]); }
      }
    }
  }
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return out;
}

// Per-zoom tile lists for an area spec: {type: 'bbox', bbox} or {type: 'corridor', lines: [[lon,lat]...][], buffer}.
export function areaTiles(area, z, clip = null) {
  if (area.type === 'bbox') {
    const box = clip ? bboxIntersect(area.bbox, clip) : area.bbox;
    return box ? bboxTiles(box, z) : { count: 0, [Symbol.iterator]: function* () {} };
  }
  const seen = new Set();
  const list = [];
  for (const line of area.lines) {
    for (const t of corridorTiles(line, area.buffer, z, clip)) {
      const k = t[1] * 4194304 + t[0];
      if (!seen.has(k)) { seen.add(k); list.push(t); }
    }
  }
  list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { count: list.length, [Symbol.iterator]: () => list[Symbol.iterator]() };
}

// Tile counts per zoom for a job and a byte estimate from per-source average tile sizes (bytes).
export function estimate(area, zmin, zmax, avgBytes, clip = null) {
  const perZoom = [];
  let tiles = 0;
  for (let z = zmin; z <= zmax; z++) {
    const n = areaTiles(area, z, clip).count;
    perZoom.push({ z, n });
    tiles += n;
  }
  return { perZoom, tiles, bytes: tiles * avgBytes };
}
