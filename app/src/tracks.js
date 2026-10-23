// Tracks on the phone: imported GPX/KML (Wikiloc, TET, ACT, own rides) and recordings. TET/ACT files stay on the
// device only - their terms forbid sharing them - so nothing here ever uploads a track.
import * as db from './db.js';
import { TRACK_COLORS, TET_COLOR } from './config.js';
import { parseTrackFile, toGeoJSON, toGPX } from '../../core/gpx.js';
import { lineLength, bboxOf } from '../../core/geo.js';

const isTetName = (s) => /\b(TET|ACT)\b/.test(s ?? '') || /trans ?euro ?trail|adventure country/i.test(s ?? '');

function statsOf(fc) {
  let length = 0, lines = 0, points = 0;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of fc.features) {
    if (f.geometry.type === 'LineString') {
      lines++;
      length += lineLength(f.geometry.coordinates);
      bboxOf(f.geometry.coordinates, box);
    } else {
      points++;
      bboxOf([f.geometry.coordinates], box);
    }
  }
  return { length, lines, points, bbox: Number.isFinite(box[0]) ? box : null };
}

export async function listTracks() {
  return (await db.getAll('tracks')).sort((a, b) => b.created - a.created);
}

async function nextColor() {
  const used = (await db.getAll('tracks')).length;
  return TRACK_COLORS[used % TRACK_COLORS.length];
}

// Imports files; returns {added: [tracks], failed: [{name, error}]}. markTet forces the TET/ACT style.
export async function importFiles(files, { markTet = false } = {}) {
  const added = [], failed = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const parsed = parseTrackFile(file.name, text);
      if (!parsed.lines.length && !parsed.points.length) throw new Error('no tracks or points found');
      const tet = markTet || isTetName(file.name) || isTetName(parsed.name);
      const id = `trk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const fc = toGeoJSON(parsed);
      const track = {
        id, name: parsed.name || file.name.replace(/\.(gpx|kml)$/i, ''), file: file.name,
        kind: tet ? 'tet' : 'import', color: tet ? TET_COLOR : await nextColor(), visible: true,
        created: Date.now(), fc, stats: statsOf(fc),
      };
      await db.put('tracks', track);
      added.push(track);
    } catch (e) {
      failed.push({ name: file.name, error: e.message });
    }
  }
  return { added, failed };
}

// Saves a finished recording as a track.
export async function saveRecording(rec, name) {
  const coords = rec.points.map((p) => (p.ele != null ? [p.lon, p.lat, p.ele] : [p.lon, p.lat]));
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name, kind: 'trk' }, geometry: { type: 'LineString', coordinates: coords } }] };
  const track = {
    id: rec.id, name, kind: 'recording', color: '#ff1744', visible: true, created: rec.started, ended: rec.ended,
    fc, stats: { ...statsOf(fc), ...rec.stats }, points: rec.points.map(({ t, lat, lon, ele }) => ({ t, lat, lon, ele })),
  };
  await db.put('tracks', track);
  await db.deleteRecPoints(rec.id);
  return track;
}

// Saves a road the rider drew on the map (kind 'drawn'); it joins the routing network (network: true).
export async function saveDrawn(name, coords, stats) {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name, kind: 'trk' }, geometry: { type: 'LineString', coordinates: coords } }] };
  const track = {
    id: `draw-${Date.now().toString(36)}`, name, kind: 'drawn', color: '#ffffff', visible: true, created: Date.now(), network: true,
    fc, stats: { ...statsOf(fc), ...stats },
  };
  await db.put('tracks', track);
  return track;
}

// Saves a generated route as a track (kind 'planned').
export async function savePlanned(name, coords, stats, opts, color) {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name, kind: 'trk' }, geometry: { type: 'LineString', coordinates: coords } }] };
  const track = {
    id: `plan-${Date.now().toString(36)}`, name, kind: 'planned', color: color ?? '#00e5ff', visible: true, created: Date.now(),
    fc, stats: { ...statsOf(fc), up: stats.up, dn: stats.dn, climbs: stats.climbs.length, green: stats.green, yellow: stats.yellow, red: stats.red }, plan: opts,
  };
  await db.put('tracks', track);
  return track;
}

export async function updateTrack(id, patch) {
  const t = await db.get('tracks', id);
  if (!t) return null;
  Object.assign(t, patch);
  if (patch.name) for (const f of t.fc.features) if (f.geometry.type === 'LineString' && t.kind === 'recording') f.properties.name = patch.name;
  await db.put('tracks', t);
  return t;
}

export const deleteTrack = (id) => db.del('tracks', id);

// All visible tracks as one FeatureCollection for the map, with the colour and style per feature.
export function mapData(tracks) {
  const features = [];
  for (const t of tracks) {
    if (!t.visible) continue;
    for (const f of t.fc.features) {
      features.push({ ...f, properties: { ...f.properties, trackId: t.id, color: t.color, tet: t.kind === 'tet' } });
    }
  }
  return { type: 'FeatureCollection', features };
}

// The lines of a track, for corridor downloads.
export const trackLines = (t) => t.fc.features.filter((f) => f.geometry.type === 'LineString').map((f) => f.geometry.coordinates);

export function exportGPX(t) {
  if (t.points) {
    return toGPX({ name: t.name, segments: [t.points] });
  }
  const segments = trackLines(t).map((line) => line.map((c) => ({ lon: c[0], lat: c[1], ele: c[2] ?? null })));
  const waypoints = t.fc.features.filter((f) => f.geometry.type === 'Point')
    .map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], name: f.properties.name }));
  return toGPX({ name: t.name, segments, waypoints });
}

// Shares the GPX through Android's share sheet when possible, else downloads it.
export async function shareGPX(t) {
  const name = `${(t.name || 'track').replace(/[^\w\- ]+/g, '').trim() || 'track'}.gpx`;
  const file = new File([exportGPX(t)], name, { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: t.name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'downloaded';
}
