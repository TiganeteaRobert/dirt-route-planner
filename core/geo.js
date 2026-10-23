// Small geodesy helpers on [lon, lat] pairs. No DOM.

export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, degrees clockwise from north.
export function bearing(a, b) {
  const f1 = a[1] * RAD, f2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

export function bboxOf(coords, box = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (const c of coords) {
    if (c[0] < box[0]) box[0] = c[0];
    if (c[1] < box[1]) box[1] = c[1];
    if (c[0] > box[2]) box[2] = c[0];
    if (c[1] > box[3]) box[3] = c[1];
  }
  return box;
}

export function bboxIntersect(a, b) {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

export const inBBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

// Grows a box by `m` metres on every side.
export function bboxBuffer(b, m) {
  const dLat = m / (EARTH_R * RAD);
  const dLon = dLat / Math.cos(((b[1] + b[3]) / 2) * RAD);
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

// Points along a line, at most `step` metres apart (the vertices are kept).
export function densify(coords, step) {
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) {
      const a = coords[i - 1], b = coords[i];
      const n = Math.floor(haversine(a, b) / step);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    out.push(coords[i]);
  }
  return out;
}

// Closed ring approximating a circle of `r` metres (for GPS accuracy circles).
export function circleRing([lon, lat], r, n = 48) {
  const dLat = r / (EARTH_R * RAD), dLon = dLat / Math.cos(lat * RAD);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

export function bboxSizeKm(b) {
  const midLat = (b[1] + b[3]) / 2;
  return {
    w: haversine([b[0], midLat], [b[2], midLat]) / 1000,
    h: haversine([b[0], b[1]], [b[0], b[3]]) / 1000,
  };
}
