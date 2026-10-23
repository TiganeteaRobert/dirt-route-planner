// GPX / KML reading and GPX writing without a DOM, so the same code runs on the phone and in Node.
// Coordinates are [lon, lat, ele|null, timeMs|null].

const NS = '(?:[\\w-]+:)?';

function decode(s) {
  if (s == null) return null;
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return s.trim()
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Contents of each <tag>...</tag> (namespace prefixes allowed).
function blocks(text, tag) {
  const re = new RegExp(`<${NS}${tag}\\b[^>]*>([\\s\\S]*?)</${NS}${tag}>`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

function firstText(text, tag) {
  if (!text) return null;
  const m = text.match(new RegExp(`<${NS}${tag}\\b[^>]*>([\\s\\S]*?)</${NS}${tag}>`));
  return m ? decode(m[1]) : null;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : null;
}

// <trkpt lat lon>...</trkpt> or self-closing points, in order.
function gpxPoints(text, tag) {
  const re = new RegExp(`<${NS}${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${NS}${tag}>)`, 'g');
  const pts = [];
  for (const m of text.matchAll(re)) {
    const lat = parseFloat(attr(m[1], 'lat')), lon = parseFloat(attr(m[1], 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = parseFloat(firstText(m[2], 'ele'));
    const t = Date.parse(firstText(m[2], 'time') ?? '');
    pts.push({
      c: [lon, lat, Number.isFinite(ele) ? ele : null, Number.isFinite(t) ? t : null],
      name: m[2] ? firstText(m[2], 'name') : null,
    });
  }
  return pts;
}

// Name of a <trk>/<rte>: its own <name>, not one inside a point.
function ownName(block, pointTag) {
  const head = block.split(new RegExp(`<${NS}(?:${pointTag}|trkseg)\\b`))[0];
  return firstText(head, 'name');
}

export function parseGPX(text) {
  const meta = blocks(text, 'metadata')[0];
  const out = { name: meta ? firstText(meta, 'name') : null, lines: [], points: [] };
  for (const trk of blocks(text, 'trk')) {
    const name = ownName(trk, 'trkpt');
    const segs = blocks(trk, 'trkseg');
    for (const seg of segs.length ? segs : [trk]) {
      const coords = gpxPoints(seg, 'trkpt').map((p) => p.c);
      if (coords.length >= 2) out.lines.push({ name, kind: 'trk', coords });
    }
  }
  for (const rte of blocks(text, 'rte')) {
    const coords = gpxPoints(rte, 'rtept').map((p) => p.c);
    if (coords.length >= 2) out.lines.push({ name: ownName(rte, 'rtept'), kind: 'rte', coords });
  }
  for (const p of gpxPoints(text, 'wpt')) out.points.push({ name: p.name, coords: p.c });
  if (!out.name) out.name = out.lines.find((l) => l.name)?.name ?? null;
  return out;
}

function kmlCoords(s) {
  return s.trim().split(/\s+/).map((t) => t.split(',').map(Number))
    .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c) => [c[0], c[1], Number.isFinite(c[2]) ? c[2] : null, null]);
}

export function parseKML(text) {
  const doc = blocks(text, 'Document')[0] ?? text;
  const out = { name: firstText(doc.split(/<(?:[\w-]+:)?(?:Placemark|Folder)\b/)[0], 'name'), lines: [], points: [] };
  for (const pm of blocks(text, 'Placemark')) {
    const name = firstText(pm, 'name');
    for (const ls of blocks(pm, 'LineString')) {
      const coords = kmlCoords(firstText(ls, 'coordinates') ?? '');
      if (coords.length >= 2) out.lines.push({ name, kind: 'trk', coords });
    }
    for (const tr of blocks(pm, 'Track')) {             // gx:Track: <when> + <gx:coord>lon lat alt</gx:coord>
      const when = blocks(tr, 'when').map((w) => Date.parse(decode(w)));
      const coords = blocks(tr, 'coord').map((c, i) => {
        const [lon, lat, alt] = decode(c).split(/\s+/).map(Number);
        return [lon, lat, Number.isFinite(alt) ? alt : null, Number.isFinite(when[i]) ? when[i] : null];
      }).filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (coords.length >= 2) out.lines.push({ name, kind: 'trk', coords });
    }
    for (const pt of blocks(pm, 'Point')) {
      const c = kmlCoords(firstText(pt, 'coordinates') ?? '')[0];
      if (c) out.points.push({ name, coords: c });
    }
  }
  return out;
}

// Picks the parser from the file name or the content.
export function parseTrackFile(name, text) {
  const isKml = /\.kml$/i.test(name) || /<kml\b/i.test(text.slice(0, 2000));
  const r = isKml ? parseKML(text) : parseGPX(text);
  r.format = isKml ? 'kml' : 'gpx';
  return r;
}

// Parsed file -> GeoJSON FeatureCollection (elevation kept as the third coordinate when present).
export function toGeoJSON(parsed, props = {}) {
  const features = [];
  for (const l of parsed.lines) {
    features.push({
      type: 'Feature',
      properties: { ...props, name: l.name ?? parsed.name ?? '', kind: l.kind },
      geometry: { type: 'LineString', coordinates: l.coords.map((c) => (c[2] != null ? [c[0], c[1], c[2]] : [c[0], c[1]])) },
    });
  }
  for (const p of parsed.points) {
    features.push({
      type: 'Feature',
      properties: { ...props, name: p.name ?? '', kind: 'wpt' },
      geometry: { type: 'Point', coordinates: [p.coords[0], p.coords[1]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// segments: arrays of {lat, lon, ele?, t?} (t in ms). waypoints: {lat, lon, name}.
export function toGPX({ name = 'Track', segments = [], waypoints = [], creator = 'DirtScout' }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${esc(creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${esc(name)}</name></metadata>`,
  ];
  for (const w of waypoints) {
    out.push(`<wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}"><name>${esc(w.name ?? '')}</name></wpt>`);
  }
  out.push(`<trk><name>${esc(name)}</name>`);
  for (const seg of segments) {
    out.push('<trkseg>');
    for (const p of seg) {
      let s = `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
      if (p.ele != null && Number.isFinite(p.ele)) s += `<ele>${p.ele.toFixed(1)}</ele>`;
      if (p.t != null) s += `<time>${new Date(p.t).toISOString()}</time>`;
      out.push(s + '</trkpt>');
    }
    out.push('</trkseg>');
  }
  out.push('</trk>', '</gpx>', '');
  return out.join('\n');
}
