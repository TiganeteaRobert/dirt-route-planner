// App constants: the riding area and the map sources (Appendix A of the plan, checked from the PC on 2026-10-23:
// every source answers with Access-Control-Allow-Origin: *).

export const APP_NAME = 'DirtScout';

// [west, south, east, north]: Lake Belis-Fantanele (west) to Cluj-Napoca (NE) and Aiud (SE). Editable in Settings.
export const DEFAULT_AREA = [22.85, 46.28, 23.80, 46.82];

// offline: true = may be downloaded to the phone (user's decision D2 for the Microsoft and Esri imagery).
// Online-only sources are volunteer-run OSM servers whose policies forbid bulk or offline download.
export const SOURCES = {
  'ms-earth': {
    name: 'Microsoft Earth', short: 'Microsoft', kind: 'base', offline: true, bing: true,
    upstream: 'https://{bing}/tiles/a{quadkey}.jpg?g=45', minzoom: 1, maxzoom: 19, avgKB: 18,
    attribution: '© Microsoft (Bing Maps) imagery',
  },
  'ms-hybrid': {
    name: 'Microsoft Hybrid (with labels)', short: 'MS Hybrid', kind: 'base', offline: true, bing: true,
    upstream: 'https://{bing}/tiles/h{quadkey}.jpg?g=45', minzoom: 1, maxzoom: 19, avgKB: 21,
    attribution: '© Microsoft (Bing Maps) imagery',
  },
  'esri-imagery': {
    name: 'Esri World Imagery', short: 'Esri', kind: 'base', offline: true,
    upstream: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minzoom: 1, maxzoom: 18, avgKB: 20,
    attribution: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  osm: {
    name: 'OpenStreetMap', short: 'OSM', kind: 'base', offline: false,
    upstream: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  opentopomap: {
    name: 'OpenTopoMap', short: 'OpenTopo', kind: 'base', offline: false,
    upstream: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], maxzoom: 17,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  },
  cyclosm: {
    name: 'CyclOSM', short: 'CyclOSM', kind: 'base', offline: false,
    upstream: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'],
    maxzoom: 20, attribution: '© OpenStreetMap contributors | CyclOSM',
  },
  'wmt-mtb': {
    name: 'Waymarked MTB routes', kind: 'overlay', offline: false,
    upstream: 'https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png', maxzoom: 18,
    attribution: '© waymarkedtrails.org, © OpenStreetMap contributors',
  },
  'wmt-hiking': {
    name: 'Waymarked hiking routes', kind: 'overlay', offline: false,
    upstream: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', maxzoom: 18,
    attribution: '© waymarkedtrails.org, © OpenStreetMap contributors',
  },
  'osm-gps': {
    name: 'OSM public GPS traces', kind: 'overlay', offline: false,
    upstream: 'https://gps.tile.openstreetmap.org/lines/{z}/{x}/{y}.png', maxzoom: 20,
    attribution: '© OpenStreetMap contributors',
  },
  dem: {
    name: 'Elevation (hillshade + slope)', short: 'Elevation', kind: 'dem', offline: true,
    upstream: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', minzoom: 0, maxzoom: 12,
    downloadZoom: [8, 12], avgKB: 100,
    attribution: 'Elevation: FABDEM V1-2 © Univ. of Bristol (CC BY-NC-SA 4.0) in the area pack; Terrain Tiles (Mapzen/Tilezen) elsewhere',
  },
};

export const OFFLINE_SOURCES = Object.keys(SOURCES).filter((id) => SOURCES[id].offline);

// DirtScout's own map, drawn from the area pack (OSM data + evidence; see pipeline/).
export const DS_BASE = { id: 'ds-topo', name: 'DirtScout topo (area pack)' };

// Area-pack overlays: [id, name, slider label].
export const DS_OVERLAY_LIST = [
  ['ds-tracks', 'Tracks & paths (DirtScout)', 'Opacity'],
  ['ds-unmapped', 'Roads seen from above, not in OSM', 'Opacity'],
  ['ds-pois', 'Gates, fords, peaks, springs, huts', null],
  ['ds-places', 'Place names', null],
  ['ds-routes', 'Hiking / MTB routes (OSM)', 'Opacity'],
  ['ds-detections', 'Microsoft road detections', 'Opacity'],
  ['ds-contours', 'Contour lines (20 m)', 'Opacity'],
  ['ds-protected', 'Protected areas', null],
];

// Overlays drawn from data the app computes or holds (not tile servers).
export const LOCAL_OVERLAYS = {
  area: { name: 'Riding area outline' },
  hillshade: { name: 'Hillshade', needs: 'dem' },
  slope: { name: 'Slope shading', needs: 'dem', legend: true },
};

// Slope classes in degrees (DEM ~25-30 m: short steep pitches are smoothed away, so treat these as lower bounds).
export const SLOPE_CLASSES = [
  { min: 15, color: [255, 221, 0, 150], label: '15-25° (27-47%)' },
  { min: 25, color: [255, 136, 0, 175], label: '25-35° (47-70%)' },
  { min: 35, color: [225, 0, 0, 200], label: 'over 35° (70%+)' },
];

export const TRACK_COLORS = ['#00e5ff', '#ff3df2', '#7cff4f', '#ffd400', '#b388ff', '#ff5252', '#ffffff'];
export const TET_COLOR = '#ff9100';
