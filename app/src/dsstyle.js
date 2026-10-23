// Style for DirtScout's own map (the area pack): a topo base, the track/path overlay that can be coloured by each
// piece of evidence, hiking/MTB routes, Microsoft road detections, contours, protected areas, gates/peaks/springs and
// place names. Icons are drawn on a canvas at start-up (no sprite file needed offline).

export const COLOR_MODES = {
  risk: { name: 'Risk (DirtScout verdict)', legend: [['#00e676', 'likely fine'], ['#ffd600', 'uncertain or demanding'],
    ['#ff1744', 'doubtful or hard'], ['#d500f9', 'motors not allowed (OSM)'], ['#9e9e9e', 'not scored']],
    note: 'Combines the map type, Microsoft detections, GPS traces, routes, hiking/MTB scales, steepness and forest. '
      + 'Tap a track to see why. Starting weights: tell me where it is wrong and they get tuned.' },
  type: { name: 'Track type', legend: [['#ff9800', 'track (darker = rougher grade)'], ['#ff4081', 'path / bridleway'],
    ['#ea80fc', 'footway, cycleway, steps (no motors)'], ['#ffffff', 'minor road'], ['#ffd740', 'secondary'],
    ['#ffab40', 'primary'], ['#ff5252', 'trunk / motorway']] },
  det: { name: 'Seen from above (Microsoft)', legend: [['#9e9e9e', 'not detected'], ['#ffee58', 'partly'],
    ['#66bb6a', 'mostly'], ['#00e676', 'whole length']],
    note: 'Microsoft found these roads in Bing imagery (mostly 2020-2022). Not detected proves nothing: forest hides tracks.' },
  traces: { name: 'GPS traces (OSM)', legend: [['#9e9e9e', 'no points'], ['#ffee58', 'a few'], ['#66bb6a', 'some'],
    ['#00e5ff', 'many']], note: 'Public GPS trace points uploaded to OpenStreetMap, per 100 m of track.' },
  tree: { name: 'Forest around it', legend: [['#fff59d', 'open'], ['#9ccc65', 'half forest'], ['#43a047', 'mostly forest'],
    ['#1b5e20', 'deep forest']], note: 'ESA WorldCover 2021 tree cover within 30 m.' },
  grade: { name: 'Steepness (approx.)', legend: [['#4caf50', 'under 12 %'], ['#ffeb3b', '12-20 %'], ['#ff9800', '20-30 %'],
    ['#f44336', '30-40 %'], ['#8e0000', 'over 40 %'], ['#9e9e9e', 'too short to tell']],
    note: 'Steepest 100 m from a bare-earth 30 m elevation model. Good roads read up to ~10 % too steep, and short steep pitches do not show.' },
  age: { name: 'Last edited in OSM', legend: [['#9e9e9e', 'unknown'], ['#b0bec5', 'before 2014'], ['#90caf9', '2014-2018'],
    ['#42a5f5', '2019-2022'], ['#0d47a1', '2023 or later']] },
  access: { name: 'Motor access (OSM tags)', legend: [['#00e676', 'allowed'], ['#ffee58', 'destination only'],
    ['#ff9800', 'forestry / agricultural'], ['#f44336', 'no / private'], ['#e0e0e0', 'not tagged']] },
};

const ROUTABLE = ['has', 'det'];

export function trackColor(mode) {
  const grey = '#9e9e9e';
  switch (mode) {
    case 'risk':
      return ['case', ['==', ['get', 'leg'], 2], '#d500f9',
        ['match', ['coalesce', ['get', 'risk'], -1], 0, '#00e676', 1, '#ffd600', 2, '#ff1744', '#9e9e9e']];
    case 'det':
      return ['case', ROUTABLE, ['interpolate', ['linear'], ['get', 'det'], 0, grey, 0.2, '#ffee58', 0.6, '#66bb6a', 1, '#00e676'], '#616161'];
    case 'traces':
      return ['case', ROUTABLE, ['interpolate', ['linear'],
        ['/', ['get', 'tp'], ['max', 0.1, ['/', ['get', 'len'], 100]]], 0, grey, 0.3, '#ffee58', 2, '#66bb6a', 10, '#00e5ff'], '#616161'];
    case 'tree':
      return ['case', ROUTABLE, ['interpolate', ['linear'], ['get', 'tree'], 0, '#fff59d', 0.5, '#9ccc65', 0.8, '#43a047', 1, '#1b5e20'], '#616161'];
    case 'grade':
      return ['case', ['any', ['has', 'g100'], ['has', 'g50'], ['has', 'gall']],
        ['step', ['coalesce', ['get', 'g100'], ['get', 'g50'], ['get', 'gall']], '#4caf50', 12, '#ffeb3b', 20, '#ff9800', 30, '#f44336', 40, '#8e0000'],
        grey];
    case 'age':
      return ['step', ['coalesce', ['get', 'yr'], 0], grey, 2000, '#b0bec5', 2014, '#90caf9', 2019, '#42a5f5', 2023, '#0d47a1'];
    case 'access':
      return ['match', ['coalesce', ['get', 'acc'], ''],
        ['yes', 'permissive', 'designated', 'official'], '#00e676',
        ['destination', 'customers', 'delivery'], '#ffee58',
        ['forestry', 'agricultural', 'agricultural;forestry', 'forestry;agricultural'], '#ff9800',
        ['no', 'private', 'military'], '#f44336', '#e0e0e0'];
    default:
      return ['match', ['get', 'class'],
        ['motorway', 'trunk'], '#ff5252', 'primary', '#ffab40', 'secondary', '#ffd740', 'tertiary', '#ffffff',
        ['unclassified', 'residential', 'living_street', 'service', 'road', 'raceway'], '#eeeeee',
        'track', ['match', ['coalesce', ['get', 'tt'], 0], 1, '#ffd180', 2, '#ffb74d', 3, '#ff9800', 4, '#ef6c00', 5, '#bf360c', '#ff9800'],
        ['path', 'bridleway'], '#ff4081',
        ['footway', 'cycleway', 'steps', 'pedestrian'], '#ea80fc', '#cccccc'];
  }
}

const widthFactor = ['match', ['get', 'class'], ['motorway', 'trunk'], 1.6, 'primary', 1.45, 'secondary', 1.3,
  ['tertiary', 'track'], 1.15, ['path', 'bridleway'], 1, ['footway', 'cycleway', 'steps', 'pedestrian'], 0.75, 1];
const lineWidth = (k = 1) => ['interpolate', ['linear'], ['zoom'],
  10, ['*', 0.7 * k, widthFactor], 13, ['*', 1.8 * k, widthFactor], 15, ['*', 3 * k, widthFactor], 18, ['*', 7 * k, widthFactor]];

const DOTTED = ['in', ['get', 'class'], ['literal', ['path', 'bridleway', 'footway', 'cycleway', 'steps', 'pedestrian']]];
const DASHED = ['all', ['==', ['get', 'class'], 'track'], ['!', ['in', ['coalesce', ['get', 'tt'], 0], ['literal', [1, 2]]]]];

// Layers under the raster bases (only visible with the DirtScout topo base).
export function topoBaseLayers() {
  return [
    { id: 'topo-landcover', type: 'fill', source: 'ds', 'source-layer': 'landcover', layout: { visibility: 'none' },
      paint: { 'fill-color': ['match', ['get', 'class'], 'forest', '#b5d29f', 'scrub', '#cfe1b4', 'grass', '#e2ecc6',
        'farm', '#efecd0', 'rock', '#dedad2', 'quarry', '#d6d0c6', 'wetland', '#d3e6e3', '#e6ead8'] } },
    { id: 'topo-landuse', type: 'fill', source: 'ds', 'source-layer': 'landuse', layout: { visibility: 'none' },
      paint: { 'fill-color': ['match', ['get', 'class'], 'residential', '#e9ddd2', 'park', '#cde6b8', '#e1d9e3'] } },
    { id: 'topo-water', type: 'fill', source: 'ds', 'source-layer': 'water', layout: { visibility: 'none' },
      paint: { 'fill-color': '#9ac8e8' } },
    { id: 'topo-waterways', type: 'line', source: 'ds', 'source-layer': 'waterways', layout: { visibility: 'none' },
      paint: { 'line-color': '#5c9fd6', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'class'], 'river', 1.2, 0.4],
        15, ['match', ['get', 'class'], 'river', 4, 1.4]] } },
  ];
}

// Overlay layers above the bases, hillshade and slope.
export function overlayLayers() {
  const layers = [];
  layers.push(
    { id: 'ds-protected', type: 'line', source: 'ds', 'source-layer': 'protected', layout: { visibility: 'none' },
      paint: { 'line-color': '#2e7d32', 'line-width': 2.5, 'line-dasharray': [4, 2], 'line-opacity': 0.9 } },
    { id: 'ds-contours', type: 'line', source: 'ds', 'source-layer': 'contours', layout: { visibility: 'none' },
      paint: { 'line-color': '#8d6e4a', 'line-width': ['case', ['has', 'idx'], 1.1, 0.5], 'line-opacity': 0.6 } },
    { id: 'ds-contour-labels', type: 'symbol', source: 'ds', 'source-layer': 'contours', minzoom: 13, filter: ['has', 'idx'],
      layout: { visibility: 'none', 'symbol-placement': 'line', 'text-field': ['to-string', ['get', 'ele']],
        'text-font': ['noto-regular'], 'text-size': 10.5, 'symbol-spacing': 400 },
      paint: { 'text-color': '#6d4c2f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 } },
    { id: 'ds-routes', type: 'line', source: 'ds', 'source-layer': 'routes', layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': ['match', ['get', 'route'], 'mtb', '#aa00ff', 'bicycle', '#2962ff', 'horse', '#795548', '#d50000'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 6], 'line-opacity': 0.55 } },
    { id: 'ds-detections', type: 'line', source: 'ds', 'source-layer': 'detections', layout: { visibility: 'none' },
      paint: { 'line-color': '#00e5ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 3], 'line-opacity': 0.85 } },
    { id: 'ds-tracks-casing', type: 'line', source: 'ds', 'source-layer': 'tracks', minzoom: 10,
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#000000', 'line-opacity': 0.5, 'line-width': lineWidth(1.9) } },
    { id: 'ds-tracks', type: 'line', source: 'ds', 'source-layer': 'tracks', minzoom: 10, filter: ['all', ['!', DOTTED], ['!', DASHED]],
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': trackColor('type'), 'line-width': lineWidth() } },
    { id: 'ds-tracks-dash', type: 'line', source: 'ds', 'source-layer': 'tracks', minzoom: 10, filter: DASHED,
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': trackColor('type'), 'line-width': lineWidth(), 'line-dasharray': [3, 1.2] } },
    { id: 'ds-tracks-dot', type: 'line', source: 'ds', 'source-layer': 'tracks', minzoom: 10, filter: DOTTED,
      layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': trackColor('type'), 'line-width': lineWidth(), 'line-dasharray': [0.6, 1.6] } },
    { id: 'ds-selected', type: 'line', source: 'ds', 'source-layer': 'tracks', filter: ['==', ['get', 'id'], '__none__'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#00b0ff', 'line-width': lineWidth(2.6), 'line-opacity': 0.75 } },
  );
  return layers;
}

const PEAK_TEXT = ['concat', ['coalesce', ['get', 'name'], ''],
  ['case', ['has', 'ele'], ['concat', ' ', ['to-string', ['get', 'ele']], ' m'], '']];

// Point layers that go on top of everything (after the user's own tracks).
export function labelLayers() {
  return [
    { id: 'ds-pois', type: 'symbol', source: 'ds', 'source-layer': 'pois', layout: {
      visibility: 'none', 'icon-image': ['concat', 'poi-', poiCategory()], 'icon-allow-overlap': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.75, 16, 1.1],
      'text-field': ['step', ['zoom'], ['case', ['==', ['get', 'kind'], 'peak'], PEAK_TEXT, ''],
        15, ['case', ['==', ['get', 'kind'], 'peak'], PEAK_TEXT, ['coalesce', ['get', 'name'], '']]],
      'text-font': ['noto-italic'], 'text-size': 11.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.4 } },
    { id: 'ds-places', type: 'symbol', source: 'ds', 'source-layer': 'places', layout: {
      visibility: 'none', 'text-field': ['get', 'name'], 'text-font': ['noto-medium'],
      'text-size': ['match', ['get', 'class'], 'city', 17, 'town', 15, 'village', 13, 'suburb', 12.5, 11.5],
      'symbol-sort-key': ['match', ['get', 'class'], 'city', 1, 'town', 2, 'village', 3, 4], 'text-padding': 4 },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.6 } },
  ];
}

// POI properties: class = the OSM key (barrier, ford, natural, amenity, tourism, mountain_pass, waterway), kind = value.
function poiCategory() {
  return ['case',
    ['==', ['get', 'class'], 'barrier'], 'barrier',
    ['==', ['get', 'class'], 'ford'], 'ford',
    ['==', ['get', 'class'], 'mountain_pass'], 'saddle',
    ['match', ['get', 'kind'],
      'peak', 'peak', 'saddle', 'saddle', ['spring', 'drinking_water'], 'water', ['shelter', 'alpine_hut', 'wilderness_hut'], 'hut',
      'viewpoint', 'view', ['camp_site', 'picnic_site'], 'camp', 'fuel', 'fuel', 'parking', 'parking',
      'cave_entrance', 'cave', ['waterfall', 'dam', 'weir'], 'falls', 'hunting_stand', 'stand', 'dot']];
}

// The icons, drawn once: [name, draw(ctx, s)] on a 2x canvas.
const ICONS = {
  barrier: (c, s) => { disc(c, s, '#d50000'); c.fillStyle = '#fff'; c.fillRect(s * 0.22, s * 0.42, s * 0.56, s * 0.16); },
  ford: (c, s) => { disc(c, s, '#0277bd'); wave(c, s); },
  peak: (c, s) => { tri(c, s, '#4e342e'); },
  saddle: (c, s) => { disc(c, s, '#6d4c41'); c.fillStyle = '#fff'; c.fillRect(s * 0.3, s * 0.45, s * 0.4, s * 0.1); },
  water: (c, s) => { disc(c, s, '#039be5'); c.fillStyle = '#fff'; c.beginPath(); c.arc(s / 2, s * 0.56, s * 0.15, 0, 7); c.fill(); },
  hut: (c, s) => { disc(c, s, '#795548'); c.fillStyle = '#fff'; c.beginPath(); c.moveTo(s * 0.25, s * 0.52); c.lineTo(s / 2, s * 0.28); c.lineTo(s * 0.75, s * 0.52); c.lineTo(s * 0.68, s * 0.52); c.lineTo(s * 0.68, s * 0.72); c.lineTo(s * 0.32, s * 0.72); c.lineTo(s * 0.32, s * 0.52); c.fill(); },
  view: (c, s) => { disc(c, s, '#ff6f00'); c.fillStyle = '#fff'; c.beginPath(); c.arc(s / 2, s / 2, s * 0.13, 0, 7); c.fill(); },
  camp: (c, s) => { disc(c, s, '#2e7d32'); c.fillStyle = '#fff'; c.beginPath(); c.moveTo(s * 0.28, s * 0.7); c.lineTo(s / 2, s * 0.3); c.lineTo(s * 0.72, s * 0.7); c.fill(); },
  fuel: (c, s) => { disc(c, s, '#6a1b9a'); c.fillStyle = '#fff'; c.fillRect(s * 0.36, s * 0.3, s * 0.22, s * 0.42); },
  parking: (c, s) => { disc(c, s, '#1565c0'); c.fillStyle = '#fff'; c.fillRect(s * 0.38, s * 0.3, s * 0.08, s * 0.42); c.fillRect(s * 0.38, s * 0.3, s * 0.24, s * 0.2); },
  cave: (c, s) => { disc(c, s, '#212121'); c.fillStyle = '#fff'; c.beginPath(); c.arc(s / 2, s * 0.62, s * 0.18, Math.PI, 0); c.fill(); },
  falls: (c, s) => { disc(c, s, '#0288d1'); c.fillStyle = '#fff'; c.fillRect(s * 0.44, s * 0.28, s * 0.12, s * 0.44); },
  stand: (c, s) => { disc(c, s, '#8d6e63'); },
  dot: (c, s) => { disc(c, s, '#607d8b'); },
};

function disc(c, s, color) {
  c.beginPath(); c.arc(s / 2, s / 2, s * 0.42, 0, 7); c.fillStyle = color; c.fill();
  c.lineWidth = s * 0.08; c.strokeStyle = '#fff'; c.stroke();
}
function tri(c, s, color) {
  c.beginPath(); c.moveTo(s / 2, s * 0.12); c.lineTo(s * 0.9, s * 0.84); c.lineTo(s * 0.1, s * 0.84); c.closePath();
  c.fillStyle = color; c.fill(); c.lineWidth = s * 0.07; c.strokeStyle = '#fff'; c.stroke();
}
function wave(c, s) {
  c.strokeStyle = '#fff'; c.lineWidth = s * 0.08; c.beginPath();
  for (let i = 0; i <= 12; i++) {
    const x = s * (0.25 + (0.5 * i) / 12), y = s * (0.5 + 0.08 * Math.sin((i / 12) * Math.PI * 3));
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke();
}

export function addIcons(map) {
  const s = 40;
  for (const [name, draw] of Object.entries(ICONS)) {
    const cv = new OffscreenCanvas(s, s);
    const ctx = cv.getContext('2d');
    draw(ctx, s);
    if (!map.hasImage(`poi-${name}`)) map.addImage(`poi-${name}`, ctx.getImageData(0, 0, s, s), { pixelRatio: 2 });
  }
}

export const DS_TRACK_LAYERS = ['ds-tracks', 'ds-tracks-dash', 'ds-tracks-dot'];
