// Google encoded polylines (precision 1e-5), as written by pipeline/graph_pack.py. Returns [[lon, lat], ...].
export function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / f, lat / f]);
  }
  return out;
}

export function encodePolyline(coords, precision = 5) {
  const f = 10 ** precision;
  let out = '', plat = 0, plon = 0;
  for (const [lon, lat] of coords) {
    const ilat = Math.round(lat * f), ilon = Math.round(lon * f);
    for (let d of [ilat - plat, ilon - plon]) {
      d = d < 0 ? ~(d << 1) : d << 1;
      while (d >= 0x20) { out += String.fromCharCode((0x20 | (d & 0x1f)) + 63); d >>= 5; }
      out += String.fromCharCode(d + 63);
    }
    plat = ilat; plon = ilon;
  }
  return out;
}
