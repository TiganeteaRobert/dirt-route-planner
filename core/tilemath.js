// Web Mercator tile math. Shared by the phone app and the Node pipeline, so no DOM here.

export const TILE_SIZE = 256;

export const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;

export const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

export const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;

export const y2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

// Bing tile key: one digit per zoom level, x bit + 2 * y bit.
export function quadkey(x, y, z) {
  let q = '';
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0);
  }
  return q;
}

const clampTile = (v, z) => Math.max(0, Math.min(2 ** z - 1, v));

// Inclusive tile index range covering a [west, south, east, north] box.
export function tileRange([w, s, e, n], z) {
  return {
    x0: clampTile(Math.floor(lon2x(w, z)), z), x1: clampTile(Math.floor(lon2x(e, z)), z),
    y0: clampTile(Math.floor(lat2y(n, z)), z), y1: clampTile(Math.floor(lat2y(s, z)), z),
  };
}

export const rangeCount = (r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

// [west, south, east, north] of one tile.
export const tileBounds = (z, x, y) => [x2lon(x, z), y2lat(y + 1, z), x2lon(x + 1, z), y2lat(y, z)];

export const metersPerPixel = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

export const terrariumElevation = (r, g, b) => r * 256 + g + b / 256 - 32768;

// Fills {z} {x} {y} {quadkey} and {s} (a subdomain picked from `subdomains` by tile) in a URL template.
export function fillTemplate(template, z, x, y, subdomains = null) {
  let url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (url.includes('{quadkey}')) url = url.replace('{quadkey}', quadkey(x, y, z));
  if (subdomains && url.includes('{s}')) url = url.replace('{s}', subdomains[(x + y) % subdomains.length]);
  return url;
}

export const tileKey = (src, z, x, y) => `${src}/${z}/${x}/${y}`;

export function parseTileKey(key) {
  const [src, z, x, y] = key.split('/');
  return { src, z: +z, x: +x, y: +y };
}
