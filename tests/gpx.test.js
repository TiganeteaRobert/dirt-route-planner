import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGPX, parseKML, parseTrackFile, toGeoJSON, toGPX } from '../core/gpx.js';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="Wikiloc" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name><![CDATA[Valea Ierii loop]]></name></metadata>
  <wpt lat="46.60" lon="23.30"><name>Spring &amp; rest</name></wpt>
  <trk><name>Day 1</name>
    <trkseg>
      <trkpt lat="46.6000" lon="23.3000"><ele>650.5</ele><time>2025-06-01T08:00:00Z</time><name>pt</name></trkpt>
      <trkpt lon='23.3010' lat='46.6005'><ele>655</ele></trkpt>
      <trkpt lat="46.6010" lon="23.3020"/>
    </trkseg>
    <trkseg><trkpt lat="1" lon="2"/></trkseg>
  </trk>
  <rte><name>Planned</name><rtept lat="46.5" lon="23.1"/><rtept lat="46.51" lon="23.11"/></rte>
</gpx>`;

test('GPX: tracks, segments, routes, waypoints, CDATA and entities', () => {
  const r = parseGPX(GPX);
  assert.equal(r.name, 'Valea Ierii loop');
  assert.equal(r.lines.length, 2);                       // the one-point segment is dropped
  assert.equal(r.lines[0].name, 'Day 1');
  assert.deepEqual(r.lines[0].coords[0], [23.3, 46.6, 650.5, Date.parse('2025-06-01T08:00:00Z')]);
  assert.deepEqual(r.lines[0].coords[1], [23.301, 46.6005, 655, null]);
  assert.deepEqual(r.lines[0].coords[2], [23.302, 46.601, null, null]);
  assert.equal(r.lines[1].kind, 'rte');
  assert.equal(r.lines[1].name, 'Planned');
  assert.equal(r.points[0].name, 'Spring & rest');
});

test('GPX with a namespace prefix', () => {
  const r = parseGPX('<gpx:gpx><gpx:trk><gpx:trkseg><gpx:trkpt lat="1" lon="2"/><gpx:trkpt lat="1.1" lon="2.1"/></gpx:trkseg></gpx:trk></gpx:gpx>');
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].coords.length, 2);
});

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Export</name>
<Placemark><name>Ridge</name><LineString><coordinates>
 23.1,46.5,700 23.2,46.6,710
 23.3,46.7
</coordinates></LineString></Placemark>
<Placemark><name>Ride</name><gx:Track><when>2025-06-01T08:00:00Z</when><when>2025-06-01T08:00:05Z</when>
<gx:coord>23.1 46.5 700</gx:coord><gx:coord>23.11 46.51 702</gx:coord></gx:Track></Placemark>
<Placemark><name>Gate</name><Point><coordinates>23.15,46.55,0</coordinates></Point></Placemark>
</Document></kml>`;

test('KML: LineString, gx:Track and Point', () => {
  const r = parseKML(KML);
  assert.equal(r.name, 'Export');
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines[0].coords[2], [23.3, 46.7, null, null]);
  assert.equal(r.lines[1].coords[1][3], Date.parse('2025-06-01T08:00:05Z'));
  assert.equal(r.points[0].name, 'Gate');
  assert.equal(parseTrackFile('x.kml', KML).format, 'kml');
  assert.equal(parseTrackFile('x.gpx', GPX).format, 'gpx');
});

test('GeoJSON conversion', () => {
  const fc = toGeoJSON(parseGPX(GPX), { trackId: 't1' });
  assert.equal(fc.features.length, 3);
  assert.equal(fc.features[0].geometry.type, 'LineString');
  assert.deepEqual(fc.features[0].geometry.coordinates[2], [23.302, 46.601]);
  assert.equal(fc.features[2].properties.trackId, 't1');
});

test('GPX writer round trip', () => {
  const t0 = Date.parse('2026-10-23T10:00:00Z');
  const gpx = toGPX({
    name: 'Ride <1> & co', segments: [[{ lat: 46.6, lon: 23.3, ele: 650, t: t0 }, { lat: 46.601, lon: 23.301, t: t0 + 5000 }]],
    waypoints: [{ lat: 46.6, lon: 23.3, name: 'start' }],
  });
  const r = parseGPX(gpx);
  assert.equal(r.name, 'Ride <1> & co');
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0].coords[0], [23.3, 46.6, 650, t0]);
  assert.equal(r.lines[0].coords[1][3], t0 + 5000);
  assert.equal(r.points[0].name, 'start');
});
