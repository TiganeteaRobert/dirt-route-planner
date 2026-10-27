// The map: style with every source, layer switching, the riding-area outline, tracks, the live recording, the route
// being ridden and the position marker. The area pack adds DirtScout's own vector map (source "ds"). Base "none" =
// no base map, only the overlays (on a light ground).
import { Map as MLMap, NavigationControl, ScaleControl, Marker } from 'maplibre-gl';
import { SOURCES, DS_BASE } from './config.js';
import { settings, saveSettings } from './settings.js';
import { networkAllowed } from './tiles.js';
import { installed } from './pack.js';
import { topoBaseLayers, overlayLayers, aiLayers, labelLayers, trackColor, addIcons, DS_TRACK_LAYERS, AI_TRACKS, AI_GAPS } from './dsstyle.js';
import { circleRing } from '../../core/geo.js';

const RASTER_BASES = Object.keys(SOURCES).filter((id) => SOURCES[id].kind === 'base');
const NET_OVERLAYS = Object.keys(SOURCES).filter((id) => SOURCES[id].kind === 'overlay');
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const APP_BASE = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');

// Overlay switch -> the layers it shows.
export const DS_OVERLAYS = {
  'ds-tracks': ['ds-tracks-casing', 'ds-tracks', 'ds-tracks-dash', 'ds-tracks-dot', 'ds-selected'],
  'ds-unmapped': ['ds-det-casing', 'ds-tracks-det'],
  'ds-ai': ['ds-ai-casing', 'ds-tracks-ai', 'ds-tracks-gap', 'ds-ai-selected'],
  'ds-detections': ['ds-detections'],
  'ds-routes': ['ds-routes'],
  'ds-contours': ['ds-contours', 'ds-contour-labels'],
  'ds-protected': ['ds-protected'],
  'ds-pois': ['ds-pois'],
  'ds-places': ['ds-places'],
};

const expand = (s) => (s.subdomains ? s.subdomains.map((d) => s.upstream.replace('{s}', d)) : [s.upstream]);

export const areaFeature = ([w, s, e, n]) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
});

function buildStyle() {
  const sources = {};
  const layers = [{ id: 'background', type: 'background', paint: { 'background-color': '#3a3f36' } }];
  sources.ds = { type: 'vector', url: 'pmtiles://area' };
  layers.push(...topoBaseLayers());
  for (const id of RASTER_BASES) {
    const s = SOURCES[id];
    sources[id] = {
      type: 'raster', tileSize: 256, minzoom: s.minzoom ?? 0, maxzoom: s.maxzoom, attribution: s.attribution,
      tiles: s.offline ? [`offline://${id}/{z}/{x}/{y}`] : expand(s),
    };
    layers.push({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150 } });
  }
  sources.dem = {
    type: 'raster-dem', encoding: 'terrarium', tileSize: 256, minzoom: 0, maxzoom: SOURCES.dem.maxzoom,
    tiles: ['offline://dem/{z}/{x}/{y}'], attribution: SOURCES.dem.attribution,
  };
  // the same elevation for the 3D terrain (app/src/terrain3d.js): MapLibre wants its own source for it
  sources.terrain = { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, minzoom: 0, maxzoom: SOURCES.dem.maxzoom,
    tiles: ['offline://dem/{z}/{x}/{y}'] };
  layers.push({
    id: 'hillshade', type: 'hillshade', source: 'dem', layout: { visibility: 'none' },
    paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#ffffff' },
  });
  sources.slope = { type: 'raster', tileSize: 256, minzoom: 9, maxzoom: 15, tiles: ['slope://{z}/{x}/{y}'] };
  layers.push({ id: 'slope', type: 'raster', source: 'slope', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } });
  for (const id of NET_OVERLAYS) {
    const s = SOURCES[id];
    sources[id] = { type: 'raster', tileSize: 256, maxzoom: s.maxzoom, attribution: s.attribution, tiles: expand(s) };
    layers.push({ id, type: 'raster', source: id, layout: { visibility: 'none' } });
  }
  layers.push(...overlayLayers());
  sources.area = { type: 'geojson', data: areaFeature(settings.area) };
  layers.push({
    id: 'area', type: 'line', source: 'area',
    paint: { 'line-color': '#ff3b30', 'line-width': 2.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
  });
  sources.tracks = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    {
      id: 'tracks-casing', type: 'line', source: 'tracks', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 7, 'line-opacity': 0.55 },
    },
    {
      id: 'tracks-line', type: 'line', source: 'tracks',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!', ['get', 'tet']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
    },
    {
      id: 'tracks-tet', type: 'line', source: 'tracks',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['get', 'tet']],
      layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-dasharray': [2, 1] },
    },
    {
      id: 'tracks-wpt', type: 'circle', source: 'tracks', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000000', 'circle-stroke-width': 2 },
    },
  );
  sources.draw = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'draw-casing', type: 'line', source: 'draw', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 9, 'line-opacity': 0.6 } },
    { id: 'draw-line', type: 'line', source: 'draw', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 5 } },
    { id: 'draw-pts', type: 'circle', source: 'draw', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': ['case', ['==', ['get', 'snap'], 1], 8, 6], 'circle-color': ['case', ['==', ['get', 'snap'], 1], '#00e676', '#ffffff'],
        'circle-stroke-color': '#000000', 'circle-stroke-width': 2.5 } },
  );
  sources.inv = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'inv-casing', type: 'line', source: 'inv', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#000000', 'line-opacity': 0.6, 'line-width': 10 } },
    { id: 'inv-line', type: 'line', source: 'inv', filter: ['!=', ['get', 'alt'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 6 } },
    { id: 'inv-alt', type: 'line', source: 'inv', filter: ['==', ['get', 'alt'], 1], layout: { 'line-join': 'round' },
      paint: { 'line-color': '#00e5ff', 'line-width': 5, 'line-dasharray': [1.5, 1] } },
  );
  sources.plan = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'plan-casing', type: 'line', source: 'plan', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'gap'], 1]],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sel'] },
      paint: { 'line-color': '#000000', 'line-opacity': 0.6, 'line-width': ['case', ['==', ['get', 'sel'], 1], 11, 6] } },
    { id: 'plan-line', type: 'line', source: 'plan', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'gap'], 1]],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sel'] },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'sel'], 1], 7, 3.5],
        'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.75] } },
    // the selected route's gaps (joined AI tracks, nothing seen there): white dashes over the line
    { id: 'plan-gap', type: 'line', source: 'plan', filter: ['==', ['get', 'gap'], 1],
      paint: { 'line-color': '#ffffff', 'line-width': 3.5, 'line-dasharray': [1, 1.2] } },
    { id: 'plan-start', type: 'circle', source: 'plan', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 9, 'circle-color': '#ffffff', 'circle-stroke-color': '#000000', 'circle-stroke-width': 4 } },
  );
  // Make my own route (app/src/builder.js): the legs (kind 'way'), white dashes over gaps, red dashes where no track
  // is known (straight across), and the dot that follows the elevation chart
  sources.build = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'build-casing', type: 'line', source: 'build', filter: ['==', ['get', 'kind'], 'way'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-opacity': 0.55, 'line-width': 11 } },
    { id: 'build-line', type: 'line', source: 'build', filter: ['==', ['get', 'kind'], 'way'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff6d00', 'line-width': 6 } },
    { id: 'build-off', type: 'line', source: 'build', filter: ['==', ['get', 'kind'], 'off'],
      paint: { 'line-color': '#ff1744', 'line-width': 5, 'line-dasharray': [1.4, 1] } },
    { id: 'build-gap', type: 'line', source: 'build', filter: ['==', ['get', 'kind'], 'gap'],
      paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [1, 1.2] } },
    // stretches the rider marked "avoid": the route goes around them
    { id: 'build-blocked', type: 'line', source: 'build', filter: ['==', ['get', 'kind'], 'blocked'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#d50000', 'line-width': 9, 'line-opacity': 0.75, 'line-dasharray': [0.6, 0.9] } },
  );
  // while an elevation chart is open: every stretch at or above the red grade, drawn red over the route
  sources.steep = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'steep-casing', type: 'line', source: 'steep', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#000000', 'line-width': 10, 'line-opacity': 0.6 } },
    { id: 'steep-line', type: 'line', source: 'steep', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#e53935', 'line-width': 6 } },
  );
  // the route being ridden (app/src/nav.js): the part ridden (grey), the part ahead with its steep stretches, the way
  // to the start or back to the route (dashes), the next turn and the start
  sources.nav = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'nav-done', type: 'line', source: 'nav', filter: ['==', ['get', 'kind'], 'done'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7a7f78', 'line-width': 6, 'line-opacity': 0.8 } },
    { id: 'nav-casing', type: 'line', source: 'nav', filter: ['==', ['get', 'kind'], 'ahead'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 13, 'line-opacity': 0.65 } },
    { id: 'nav-line', type: 'line', source: 'nav', filter: ['==', ['get', 'kind'], 'ahead'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00e5ff', 'line-width': 8 } },
    { id: 'nav-steep', type: 'line', source: 'nav', filter: ['==', ['get', 'kind'], 'steep'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e53935', 'line-width': 8 } },
    { id: 'nav-link', type: 'line', source: 'nav', filter: ['==', ['get', 'kind'], 'link'],
      layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-dasharray': [1, 1.5] } },
    { id: 'nav-pts', type: 'circle', source: 'nav', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': ['case', ['==', ['get', 'kind'], 'start'], 10, 8],
        'circle-color': ['case', ['==', ['get', 'kind'], 'start'], '#00c853', '#ffffff'],
        'circle-stroke-color': '#000000', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } },
  );
  sources.cursor = { type: 'geojson', data: EMPTY_FC };
  sources.rec = { type: 'geojson', data: EMPTY_FC };
  layers.push({
    id: 'rec', type: 'line', source: 'rec', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ff1744', 'line-width': 5 },
  });
  layers.push(...labelLayers());
  sources.me = { type: 'geojson', data: EMPTY_FC };
  layers.push(
    { id: 'me-acc', type: 'fill', source: 'me', paint: { 'fill-color': '#2196f3', 'fill-opacity': 0.15 } },
    { id: 'me-acc-line', type: 'line', source: 'me', paint: { 'line-color': '#2196f3', 'line-width': 1.5, 'line-opacity': 0.6 } },
    // the steep stretch under a finger on an elevation chart (the dot itself is a marker: above the route's points)
    { id: 'cursor-steep-casing', type: 'line', source: 'cursor', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 13, 'line-opacity': 0.7 } },
    { id: 'cursor-steep', type: 'line', source: 'cursor', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 8 } },
  );
  // the sky above the horizon when the map is tilted (riding in 3D, the desktop's 3D terrain)
  const sky = { 'sky-color': '#8fbbe6', 'horizon-color': '#dbe7f0', 'fog-color': '#e6ece6', 'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.9, 'atmosphere-blend': 0 };
  return { version: 8, glyphs: `${APP_BASE}fonts/{fontstack}/{range}.pbf`, sources, layers, sky };
}

// A PC or a laptop (a mouse): the 3D terrain is offered there only.
export const isDesktop = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

export function createMap(container) {
  const [w, s, e, n] = settings.area;
  const v = settings.view;
  const map = new MLMap({
    container,
    style: buildStyle(),
    center: v?.center ?? [(w + e) / 2, (s + n) / 2],
    zoom: v?.zoom ?? 9,
    bearing: v?.bearing ?? 0,
    maxPitch: 0,
    attributionControl: { compact: true },
    fadeDuration: 100,
  });
  map.touchPitch?.disable();
  map.addControl(new NavigationControl({ visualizePitch: isDesktop() }), 'top-right');
  map.addControl(new ScaleControl({ unit: settings.units === 'imperial' ? 'imperial' : 'metric', maxWidth: 120 }), 'bottom-left');
  // Tile errors (offline, nothing stored) are expected out here: keep them out of the console's error list.
  map.on('error', (ev) => {
    if (ev.sourceId || ev.tile) console.debug('tile', ev.sourceId, ev.error?.message);
    else console.warn('map:', ev.error?.message ?? ev);
  });
  map.on('style.load', () => addIcons(map));
  let t = null;
  map.on('moveend', () => {
    if (document.body.classList.contains('navigating')) return;     // riding: the camera moves every second
    clearTimeout(t);
    t = setTimeout(() => {
      const c = map.getCenter();
      settings.view = { center: [+c.lng.toFixed(6), +c.lat.toFixed(6)], zoom: +map.getZoom().toFixed(2), bearing: +map.getBearing().toFixed(1) };
      saveSettings();
    }, 400);
  });
  return map;
}

const vis = (map, id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');

// The area pack can be used when it is installed, or (not installed) while there is network.
export const packUsable = () => !!installed.area || networkAllowed();

// The base actually shown: online-only bases fall back to Microsoft Earth while there is no network.
export function effectiveBase() {
  const b = settings.base;
  if (b === 'none') return b;
  if (b === DS_BASE.id) return packUsable() ? b : 'ms-earth';
  if (!SOURCES[b]) return 'ms-earth';
  return SOURCES[b].offline || networkAllowed() ? b : 'ms-earth';
}

export function applyLayers(map) {
  const base = effectiveBase();
  const topo = base === DS_BASE.id;
  const light = topo || base === 'none';                  // a light ground: white casings, dark labels
  for (const id of RASTER_BASES) vis(map, id, id === base);
  for (const l of topoBaseLayers()) vis(map, l.id, topo);
  map.setPaintProperty('background', 'background-color', topo ? '#eef0e4' : light ? '#e4e7de' : '#3a3f36');
  const ov = settings.overlays;
  // the 3D terrain on a map without imagery: shaded, or the relief does not show
  const shade3d = !!map.getTerrain?.() && (topo || base === 'none');
  for (const id of ['hillshade', 'slope', 'area', ...NET_OVERLAYS]) {
    const o = ov[id] ?? { on: false, opacity: 1 };
    const online = SOURCES[id]?.offline === false;
    vis(map, id, (o.on || (id === 'hillshade' && shade3d)) && (!online || networkAllowed()));
  }
  map.setPaintProperty('hillshade', 'hillshade-exaggeration', Math.max(0.05, ov.hillshade.opacity));
  map.setPaintProperty('slope', 'raster-opacity', ov.slope.opacity);
  map.setPaintProperty('area', 'line-opacity', ov.area.opacity);
  for (const id of NET_OVERLAYS) map.setPaintProperty(id, 'raster-opacity', ov[id]?.opacity ?? 0.9);

  // DirtScout overlays (on the topo base the tracks, places and peaks are part of the map)
  const usable = packUsable();
  for (const [id, layers] of Object.entries(DS_OVERLAYS)) {
    const o = ov[id] ?? { on: false, opacity: 1 };
    // the AI layer is the owner's own file on the phone: it shows with or without the area pack
    const on = id === 'ds-ai' ? o.on : usable && (o.on || (topo && ['ds-tracks', 'ds-unmapped', 'ds-places', 'ds-pois', 'ds-contours'].includes(id)));
    for (const l of layers) vis(map, l, on);
  }
  const color = trackColor(settings.colorBy);
  for (const l of DS_TRACK_LAYERS) {
    if (!map.getLayer(l)) continue;                                  // the AI layer exists only when unlocked
    map.setPaintProperty(l, 'line-color', color);
    const o = l === 'ds-tracks-det' ? ov['ds-unmapped'] : l === 'ds-tracks-ai' || l === 'ds-tracks-gap' ? ov['ds-ai'] : ov['ds-tracks'];
    map.setPaintProperty(l, 'line-opacity', o?.opacity ?? 1);
  }
  map.setPaintProperty('ds-det-casing', 'line-color', light ? '#ffffff' : '#000000');
  if (map.getLayer('ds-ai-casing')) {
    map.setPaintProperty('ds-ai-casing', 'line-color', light ? '#ffffff' : '#000000');
    const aiFilter = ['>=', ['coalesce', ['get', 'aic'], 0], settings.aiMin ?? 0.4];
    for (const l of ['ds-ai-casing', 'ds-tracks-ai']) map.setFilter(l, ['all', AI_TRACKS, aiFilter]);
    if (map.getLayer('ds-tracks-gap')) map.setFilter('ds-tracks-gap', ['all', AI_GAPS, aiFilter]);
  }
  map.setPaintProperty('ds-tracks-casing', 'line-color', light ? '#ffffff' : '#000000');
  map.setPaintProperty('ds-tracks-casing', 'line-opacity', (light ? 0.9 : 0.5) * (ov['ds-tracks']?.opacity ?? 1));
  map.setPaintProperty('ds-detections', 'line-opacity', ov['ds-detections']?.opacity ?? 0.85);
  map.setPaintProperty('ds-routes', 'line-opacity', ov['ds-routes']?.opacity ?? 0.55);
  map.setPaintProperty('ds-contours', 'line-color', light ? '#8d6e4a' : '#ffffff');
  map.setPaintProperty('ds-contours', 'line-opacity', (light ? 0.6 : 0.4) * (ov['ds-contours']?.opacity ?? 1));
  for (const l of ['ds-places', 'ds-pois']) {
    map.setPaintProperty(l, 'text-color', light ? '#1b1b1b' : '#ffffff');
    map.setPaintProperty(l, 'text-halo-color', light ? '#ffffff' : '#000000');
  }
}

export function setDraw(map, coords, snapped) {
  const features = coords.map((c, i) => ({ type: 'Feature', properties: { snap: snapped[i] ? 1 : 0 }, geometry: { type: 'Point', coordinates: c } }));
  if (coords.length > 1) features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  map.getSource('draw')?.setData({ type: 'FeatureCollection', features });
}

export function setInvestigation(map, fc) {
  map.getSource('inv')?.setData(fc);
}

export function setPlan(map, fc) {
  map.getSource('plan')?.setData(fc);
}

// The route being ridden (app/src/nav.js); null clears it.
export function setNav(map, fc) {
  map.getSource('nav')?.setData(fc ?? EMPTY_FC);
}

export function setBuild(map, fc) {
  map.getSource('build')?.setData(fc ?? EMPTY_FC);
}

// The steep stretches of the route whose chart is open ([[[lon, lat], ...], ...]; null clears them).
export function setSteep(map, lines) {
  map.getSource('steep')?.setData(lines?.length
    ? { type: 'FeatureCollection', features: lines.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) }
    : EMPTY_FC);
}

// The dot that follows a finger on an elevation chart: p [lon, lat] (null hides it), in the grade's colour, with a
// label above it; the steep stretch it is on ([[lon, lat], ...]) is drawn in the same colour.
let cursor = null;
export function setCursor(map, p, { color = '#ffffff', label = '', steep = null } = {}) {
  map.getSource('cursor')?.setData(steep?.length > 1
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { color }, geometry: { type: 'LineString', coordinates: steep } }] }
    : EMPTY_FC);
  if (!p) { cursor?.remove(); cursor = null; return; }
  if (!cursor) {
    const el = document.createElement('div');
    el.className = 'map-cursor';
    el.innerHTML = '<div class="map-cursor-label"></div><div class="map-cursor-dot"></div>';
    cursor = new Marker({ element: el }).setLngLat([p[0], p[1]]).addTo(map);
  }
  const el = cursor.getElement();
  el.querySelector('.map-cursor-dot').style.background = color;
  el.querySelector('.map-cursor-label').textContent = label;
  el.querySelector('.map-cursor-label').hidden = !label;
  cursor.setLngLat([p[0], p[1]]);
}

export function setSelected(map, id) {
  map.setFilter('ds-selected', ['==', ['get', 'id'], id ?? '__none__']);
  if (map.getLayer('ds-ai-selected')) map.setFilter('ds-ai-selected', ['==', ['get', 'id'], id ?? '__none__']);
}

// Adds (or removes) the AI-found tracks: source pmtiles://ai (registered by pack.addBlobTiles) and its layers, under
// the riding-area outline. Re-adding after an update drops the old tiles from the map's cache.
export function setAiTiles(map, on) {
  for (const l of aiLayers()) if (map.getLayer(l.id)) map.removeLayer(l.id);
  if (map.getSource('ai')) map.removeSource('ai');
  if (!on) return;
  map.addSource('ai', { type: 'vector', url: 'pmtiles://ai' });
  for (const l of aiLayers()) map.addLayer(l, 'area');
}

export function setArea(map, bbox) {
  map.getSource('area')?.setData(areaFeature(bbox));
}

export function setTracks(map, fc) {
  map.getSource('tracks')?.setData(fc);
}

export function setRecLine(map, points) {
  const coords = points.map((p) => [p.lon, p.lat]);
  map.getSource('rec')?.setData(coords.length >= 2
    ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
    : EMPTY_FC);
}

// After the area pack is installed or removed: reload its source so tiles come from the new place.
export function reloadPack(map) {
  map.getSource('ds')?.setUrl?.('pmtiles://area');
  map.getSource('dem')?.setTiles?.(['offline://dem/{z}/{x}/{y}']);
  map.getSource('terrain')?.setTiles?.(['offline://dem/{z}/{x}/{y}']);
  map.getSource('slope')?.setTiles?.(['slope://{z}/{x}/{y}']);
}

// Position marker: a dot with a heading arrow (when moving) and the accuracy circle. While riding a route it is a big
// arrow that always points the way the rider goes (setNav), lying flat on the map when the map is tilted.
export class MeMarker {
  constructor(map) {
    this.map = map;
    this.el = document.createElement('div');
    this.el.className = 'me';
    this.el.innerHTML = '<div class="me-arrow"></div><div class="me-dot"></div><div class="me-nav"><svg viewBox="0 0 40 40" aria-hidden="true">'
      + '<path d="M20 3 35 35 20 27 5 35Z" fill="#1e88e5" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg></div>';
    this.marker = new Marker({ element: this.el, rotationAlignment: 'map', pitchAlignment: 'map' });
    this.shown = false;
    this.navHeading = null;
  }

  update(f) {
    const ll = [f.lon, f.lat];
    this.marker.setLngLat(ll);
    if (!this.shown) { this.marker.addTo(this.map); this.shown = true; }
    const moving = f.heading != null && Number.isFinite(f.heading) && (f.speed ?? 0) > 1;
    this.el.classList.toggle('moving', moving);
    if (this.navHeading != null) this.marker.setRotation(this.navHeading);
    else if (moving) this.marker.setRotation(f.heading);
    this.map.getSource('me')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleRing(ll, f.acc)] } });
  }

  // riding a route: the arrow points `deg` (null: back to the dot)
  setNav(deg) {
    this.navHeading = deg;
    this.el.classList.toggle('nav', deg != null);
    if (deg != null) this.marker.setRotation(deg);
  }

  hide() {
    if (this.shown) { this.marker.remove(); this.shown = false; }
    this.map.getSource('me')?.setData(EMPTY_FC);
  }
}
