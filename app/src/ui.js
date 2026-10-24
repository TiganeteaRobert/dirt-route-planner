// Panels (one bottom sheet at a time), the toolbar, status pills and toasts.
import { SOURCES, LOCAL_OVERLAYS, SLOPE_CLASSES, OFFLINE_SOURCES, APP_NAME, DS_BASE, DS_OVERLAY_LIST } from './config.js';
import { settings, saveSettings, defaultArea } from './settings.js';
import { applyLayers, setArea, effectiveBase, setRecLine, setSelected, reloadPack, packUsable, setPlan, setInvestigation, setDraw, setAiTiles, setCursor, setSteep } from './mapview.js';
import { initBuilder, startBuilder, builderClick, renderRoute, builderActive, leave as leaveBuilder, panelShown } from './builder.js';
import { profileSection, fitInView } from './profileview.js';
import { elevationProfile } from '../../core/profile.js';
import { unlock as aiUnlock, update as aiUpdate, removeStored as aiRemove, loadAiGraph } from './aibundle.js';
import { augmentGraph, filterAiEdges } from '../../core/usergraph.js';
import { buildIndex, investigate } from '../../core/investigate.js';
import { COLOR_MODES, DS_TRACK_LAYERS } from './dsstyle.js';
import { scoreEdge } from '../../core/scoring.js';
import { installed as packInstalled, fetchManifest, install as installPack, uninstall as uninstallPack, loadGraphJson, loadPackJson, PACK_FILES, addBlobTiles, removeBlobTiles } from './pack.js';
import { decodePolyline } from '../../core/polyline.js';
import { loadGraph, generateRoutes, routeCoords, routeGaps, startNode, makeCost, haversine } from '../../core/routing.js';
import { densify, lineLength } from '../../core/geo.js';
import { followTrack } from './livewire.js';
import { downloader, estimateJob, sourceZooms } from './downloads.js';
import * as db from './db.js';
import { gps, recorder } from './gps.js';
import * as wake from './wakelock.js';
import { importFiles, updateTrack, deleteTrack, shareGPX, trackLines, saveRecording, savePlanned, saveDrawn } from './tracks.js';
import { upstreamURL, networkAllowed, elevationAt, clearDemCaches } from './tiles.js';
import { h, fill, fmtDist, fmtSpeed, fmtElev, fmtBytes, fmtInt, fmtDuration } from './format.js';
import { metersPerPixel, lon2x, lat2y, tileKey } from '../../core/tilemath.js';
import { bboxIntersect, bboxSizeKm } from '../../core/geo.js';
import { areaTiles } from '../../core/area.js';

let app = null;
let current = null;
const $ = (id) => document.getElementById(id);
const NET_OVERLAYS = Object.keys(SOURCES).filter((id) => SOURCES[id].kind === 'overlay');
const BASES = Object.keys(SOURCES).filter((id) => SOURCES[id].kind === 'base');

const PANELS = {
  layers: ['Layers', renderLayers],
  downloads: ['Offline maps', renderDownloads],
  tracks: ['Tracks', renderTracks],
  record: ['Ride', renderRecord],
  plan: ['Plan a ride', renderPlan],
  inv: ['Investigate', renderInvestigation],
  route: ['Your route', renderRoute],
  profile: ['Elevation', renderProfile],
  more: ['More', renderMore],
  info: ['Track info', renderInfo],
};

// ---------------------------------------------------------------- sheet, toast, status

// Panels with an elevation chart get a shorter sheet (more map shows above it, where the chart's dot goes).
const SHORT = new Set(['route', 'profile']);

export function openPanel(name) {
  current = name;
  $('sheet').hidden = false;
  $('sheet').classList.toggle('short', SHORT.has(name));
  panelShown(name);
  $('sheet-title').textContent = PANELS[name][0];
  $('sheet-body').scrollTop = 0;
  for (const b of document.querySelectorAll('#toolbar [data-sheet]')) b.classList.toggle('active', b.dataset.sheet === name);
  rerender();
}

export function closePanel() {
  if (current === 'info') { setSelected(app.map, null); app.selected = null; }
  setCursor(app.map, null);
  setSteep(app.map, null);
  panelShown(null);
  current = null;
  $('sheet').hidden = true;
  for (const b of document.querySelectorAll('#toolbar [data-sheet]')) b.classList.remove('active');
}

let renderSeq = 0;
export async function rerender() {
  if (!current) return;
  const seq = ++renderSeq;
  const name = current;
  const nodes = await PANELS[name][1]();
  if (seq !== renderSeq || current !== name) return;
  const body = $('sheet-body');
  const top = body.scrollTop;
  fill(body, ...nodes);
  body.scrollTop = top;
}

let toastTimer = null;
export function toast(msg, { action = null, onAction = null, ms = 4000 } = {}) {
  const el = $('toast');
  fill(el, 
    h('span', { class: 'grow' }, msg),
    action ? h('button', { class: 'toast-btn', onclick: () => { el.hidden = true; onAction?.(); } }, action) : null,
  );
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 9000) : ms);
}

function updateStatus() {
  const g = $('st-gps');
  if (!gps.on) { g.textContent = 'GPS off'; g.className = 'pill'; }
  else if (gps.error && !gps.last) { g.textContent = gps.error; g.className = 'pill pill-warn'; }
  else if (!gps.last) { g.textContent = 'Finding GPS…'; g.className = 'pill pill-warn'; }
  else { g.textContent = `GPS ±${Math.round(gps.last.acc)} m`; g.className = `pill ${gps.last.acc > 30 ? 'pill-warn' : 'pill-ok'}`; }
  const r = $('st-rec');
  r.hidden = !recorder.on;
  if (recorder.on) {
    const rec = recorder.rec;
    r.textContent = `● ${fmtDuration(Date.now() - rec.started)} · ${fmtDist(rec.dist)} · ${fmtSpeed(gps.last?.speed)}`;
  }
  const n = $('st-net');
  const off = settings.offlineOnly || navigator.onLine === false;
  n.hidden = !off;
  n.textContent = settings.offlineOnly ? 'Offline mode' : 'No network';
  const d = $('st-dl');
  const j = downloader.job;
  d.hidden = !j;
  if (j) d.textContent = `⬇ ${j.progress.total ? Math.floor((100 * j.progress.done) / j.progress.total) : 0}%`;
  const loc = $('btn-locate');
  loc.classList.toggle('active', gps.on);
  loc.classList.toggle('follow', gps.on && app.follow);
  loc.querySelector('span').textContent = gps.on ? (app.follow ? 'Following' : 'Locate') : 'Locate';
  const rb = $('btn-record');
  rb.classList.toggle('recording', recorder.on);
  rb.querySelector('span').textContent = recorder.on ? 'Recording' : 'Record';
}

// ---------------------------------------------------------------- small building blocks

const toggleRow = (label, on, onChange, extra = null) => h('label', { class: 'row' },
  h('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked) }),
  h('span', { class: 'grow' }, label), extra);

const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);

const areaLat = () => (settings.area[1] + settings.area[3]) / 2;
const mpp = (z) => {
  const m = metersPerPixel(areaLat(), z);
  return m >= 10 ? Math.round(m) : m >= 1 ? m.toFixed(1) : m.toFixed(2);
};

// ---------------------------------------------------------------- Layers

async function renderLayers() {
  const out = [h('h3', {}, 'Base map')];
  const online = networkAllowed();
  out.push(h('label', { class: `row${packUsable() ? '' : ' dim'}` },
    h('input', {
      type: 'radio', name: 'base', checked: settings.base === DS_BASE.id,
      onchange: () => { settings.base = DS_BASE.id; saveSettings(); applyLayers(app.map); rerender(); },
    }),
    h('span', { class: 'grow' }, DS_BASE.name),
    h('span', { class: `badge${packInstalled.area ? ' ok' : ' online'}` }, packInstalled.area ? 'on phone' : 'online until installed')));
  for (const id of BASES) {
    const s = SOURCES[id];
    const st = app.stats[id];
    const badge = s.offline ? (st?.count ? `${fmtInt(st.count)} tiles saved` : 'can go offline') : 'online only';
    out.push(h('label', { class: `row${!s.offline && !online ? ' dim' : ''}` },
      h('input', {
        type: 'radio', name: 'base', checked: settings.base === id,
        onchange: () => { settings.base = id; saveSettings(); applyLayers(app.map); rerender(); },
      }),
      h('span', { class: 'grow' }, s.name),
      h('span', { class: `badge${s.offline ? (st?.count ? ' ok' : '') : ' online'}` }, badge)));
  }
  if (effectiveBase() !== settings.base) out.push(h('p', { class: 'note warn' }, 'No network: showing Microsoft Earth instead.'));

  out.push(h('h3', {}, 'DirtScout map (area pack)'));
  if (!packInstalled.area) {
    out.push(h('p', { class: 'note' }, online
      ? 'Loaded from the internet now. Install the area pack in Offline to use it with no network.'
      : 'Install the area pack (Offline) to see the DirtScout map with no network.'));
  }
  for (const [id, name, sliderLabel] of DS_OVERLAY_LIST) {
    if (id === 'ds-ai' && !app.ai?.meta) continue;
    const o = settings.overlays[id];
    out.push(h('div', { class: 'block' },
      h('label', { class: `row${packUsable() || id === 'ds-ai' ? '' : ' dim'}` },
        h('input', { type: 'checkbox', checked: o.on, onchange: (e) => {
          o.on = e.target.checked; saveSettings(); applyLayers(app.map);
          rerender();
        } }),
        h('span', { class: 'grow' }, name)),
      o.on && sliderLabel ? h('label', { class: 'slider' }, h('span', {}, sliderLabel),
        h('input', {
          type: 'range', min: 0.1, max: 1, step: 0.05, value: o.opacity,
          oninput: (e) => { o.opacity = +e.target.value; applyLayers(app.map); }, onchange: () => saveSettings(),
        })) : null,
      id === 'ds-tracks' && o.on ? colorByControl() : null,
      id === 'ds-ai' && o.on ? aiSlider() : null,
    ));
  }

  out.push(h('h3', {}, 'Overlays'));
  const items = [
    ['area', LOCAL_OVERLAYS.area.name, 'Opacity'],
    ['hillshade', LOCAL_OVERLAYS.hillshade.name, 'Strength'],
    ['slope', LOCAL_OVERLAYS.slope.name, 'Opacity'],
    ...NET_OVERLAYS.map((id) => [id, SOURCES[id].name, 'Opacity']),
  ];
  for (const [id, name, sliderLabel] of items) {
    const o = settings.overlays[id];
    const isNet = SOURCES[id]?.offline === false;
    const needsDem = LOCAL_OVERLAYS[id]?.needs === 'dem';
    out.push(h('div', { class: 'block' },
      h('label', { class: `row${isNet && !online ? ' dim' : ''}` },
        h('input', { type: 'checkbox', checked: o.on, onchange: (e) => { o.on = e.target.checked; saveSettings(); applyLayers(app.map); rerender(); } }),
        h('span', { class: 'grow' }, name),
        isNet ? h('span', { class: 'badge online' }, 'online only') : null),
      o.on ? h('label', { class: 'slider' }, h('span', {}, sliderLabel),
        h('input', {
          type: 'range', min: 0.05, max: 1, step: 0.05, value: o.opacity,
          oninput: (e) => { o.opacity = +e.target.value; applyLayers(app.map); }, onchange: () => saveSettings(),
        })) : null,
      id === 'slope' && o.on ? h('div', { class: 'legend' },
        SLOPE_CLASSES.map((c) => h('span', { class: 'legend-item' },
          h('i', { style: `background:rgba(${c.color[0]},${c.color[1]},${c.color[2]},${c.color[3] / 255})` }), c.label)),
        h('p', { class: 'note' }, 'From a ~30 m elevation model: short steep pitches (10-20 m) do not show. A clear map does not prove a climb is rideable.')) : null,
      needsDem && o.on && !app.stats.dem?.count ? h('p', { class: 'note' }, 'Uses the elevation tiles: download "Elevation" in Offline maps to see this without network.') : null,
    ));
  }
  out.push(h('p', { class: 'note' }, 'Coming with the area pack: DirtScout track map from OSM data, Microsoft road detections, routes coloured by risk.'));
  return out;
}

// How many AI-found tracks (and km) score at least `min` (the bundle's table, in the slider's steps).
function aiShown(min) {
  const row = (app.ai?.meta?.hist ?? []).find((r) => Math.abs(r[0] - min) < 1e-6);
  return { n: row?.[1] ?? 0, km: row?.[2] ?? 0 };
}

// The AI layer's sensitivity: tracks the model drew less clearly than this are hidden and left out of routes.
function aiSlider() {
  const text = (min) => {
    const s = aiShown(min);
    return [`AI score at least ${Math.round(min * 100)} %`, `${fmtInt(s.n)} tracks, ${fmtInt(s.km)} km shown. Lower catches more tracks, `
      + 'and more field edges, forest edges and other lines that are not tracks; 40 % showed about 4 in 5 real tracks in a test.'];
  };
  const [a, b] = text(settings.aiMin);
  const label = h('span', {}, a);
  const note = h('p', { class: 'note' }, b);
  return h('div', { class: 'indent' },
    h('label', { class: 'slider' }, label,
      h('input', {
        type: 'range', min: 0.3, max: 0.95, step: 0.05, value: settings.aiMin, id: 'ai-min',
        oninput: (e) => {
          settings.aiMin = +e.target.value;
          applyLayers(app.map);
          [label.textContent, note.textContent] = text(settings.aiMin);
        },
        onchange: () => { saveSettings(); app.graph = null; app.graphIndex = null; },      // routes follow on next use
      })),
    note);
}

function colorByControl() {
  const mode = COLOR_MODES[settings.colorBy] ?? COLOR_MODES.type;
  return h('div', { class: 'indent' },
    h('label', { class: 'row' }, h('span', { class: 'grow' }, 'Colour by'),
      h('select', { onchange: (e) => { settings.colorBy = e.target.value; saveSettings(); applyLayers(app.map); rerender(); } },
        Object.entries(COLOR_MODES).map(([k, m]) => h('option', { value: k, selected: settings.colorBy === k }, m.name)))),
    h('div', { class: 'legend' }, mode.legend.map(([c, label]) => h('span', { class: 'legend-item' }, h('i', { style: `background:${c}` }), label))),
    mode.note ? h('p', { class: 'note' }, mode.note) : null,
    h('p', { class: 'note' }, 'Tap a track on the map to see everything known about it.'));
}

// ---------------------------------------------------------------- Track info (tap on the map)

const CLASS_NAMES = { track: 'Track', path: 'Path', bridleway: 'Bridleway', footway: 'Footway (no motors)', cycleway: 'Cycleway',
  steps: 'Steps', unclassified: 'Minor road', residential: 'Village street', service: 'Service road', tertiary: 'Tertiary road',
  secondary: 'Secondary road', primary: 'Primary road', trunk: 'Trunk road', motorway: 'Motorway', living_street: 'Living street',
  detected: 'Road seen from above (not in OSM)', ai: 'Track the AI found (on no map)',
  gap: 'Gap between AI-found tracks (nothing seen)', mine: 'Your road' };
const SAC = { hiking: 'T1 hiking', mountain_hiking: 'T2 mountain hiking', demanding_mountain_hiking: 'T3 demanding',
  alpine_hiking: 'T4 alpine', demanding_alpine_hiking: 'T5 demanding alpine', difficult_alpine_hiking: 'T6 difficult alpine' };

const kv = (k, v) => (v == null || v === '' ? null : h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, String(v))));

function renderInfo() {
  const f = app.selected;
  if (!f) return [h('p', { class: 'note' }, 'Tap a track, path or point on the map.')];
  const p = f.properties;
  if (f.layer?.id === 'ds-pois') {
    return [
      h('h3', {}, `${(p.kind ?? '').replace(/_/g, ' ')}${p.class === 'barrier' ? ' (barrier)' : ''}`),
      kv('Name', p.name), kv('Elevation', p.ele != null ? fmtElev(p.ele) : null),
      p.id ? h('a', { class: 'btn', href: `https://www.openstreetmap.org/node/${p.id}`, target: '_blank', rel: 'noopener' }, 'Open in OpenStreetMap') : null,
    ];
  }
  const grade = p.g100 ?? p.g50 ?? p.gall;
  const gradeWin = p.g100 != null ? '100 m' : p.g50 != null ? '50 m' : 'the whole piece';
  const way = String(p.id ?? '').split(':')[0];
  const per100 = p.tp != null && p.len ? p.tp / Math.max(0.1, p.len / 100) : null;
  const out = [
    h('h3', {}, `${CLASS_NAMES[p.class] ?? p.class}${p.tt ? ` · grade ${p.tt}` : ''}${p.name ? ` · ${p.name}` : ''}`),
    kv('This piece', p.len != null ? `${fmtDist(p.len)} (between junctions)` : null),
    kv('Ref', p.ref), kv('Surface', p.surf), kv('Smoothness', p.smooth), kv('Hiking scale', SAC[p.sac] ?? p.sac),
    kv('MTB scale', p.mtb), kv('Trail visibility', p.vis), kv('4WD only', p.fwd), kv('Motor access', p.acc ?? 'not tagged'),
    kv('Gates / barriers on it', p.bar), kv('Ford', p.ford ? 'yes' : null), kv('Bridge', p.bridge ? 'yes' : null),
    p.class === 'ai' ? kv('AI score', p.aic != null ? `${Math.round(p.aic * 100)} % (how clearly the AI saw it, and how much it looks like a track rather than a field or forest edge)` : null) : null,
    p.class === 'gap' ? kv('AI score', p.aic != null ? `${Math.round(p.aic * 100)} % (the lower of the tracks it joins)` : null) : null,
    p.class === 'ai' ? kv('Land along it', [p.grass ? `${Math.round(p.grass * 100)} % grassland` : null,
      p.crop ? `${Math.round(p.crop * 100)} % fields` : null].filter(Boolean).join(', ')) : null,
  ];
  if (p.det != null) {
    const s = scoreEdge(p);
    const verdict = { green: 'Likely fine', yellow: 'Uncertain or demanding', red: 'Doubtful or hard' }[s.name];
    out.splice(1, 0, h('div', { class: `verdict v-${s.name}` },
      h('strong', {}, verdict),
      h('span', {}, ` · exists ${Math.round(s.exists * 100)} %${s.legal === 'no' ? ' · motors not allowed (OSM)' : s.legal === 'restricted' ? ' · motor access restricted' : ''}`)),
    h('ul', { class: 'reasons' }, s.reasons.map((r) => h('li', { class: `r-${typeof r.d === 'number' ? (r.d > 0 ? 'plus' : 'zero') : r.d}` },
      r.text, typeof r.d === 'number' && r.d > 0 ? ` (+${Math.round(r.d * 100)})` : ''))));
    out.push(h('h3', {}, 'Evidence'),
      kv('Seen from above', `${Math.round(p.det * 100)} % of it near a Microsoft road detection`),
      kv('GPS traces (OSM)', `${p.tp} points${p.tn ? `, ${p.tn} traces` : ''}${per100 != null ? ` (${per100.toFixed(1)} per 100 m)` : ''}`),
      kv('Forest around it', `${Math.round((p.tree ?? 0) * 100)} % tree cover`),
      kv('Steepest', grade != null ? `about ${Math.round(grade)} % over ${gradeWin}` : null),
      kv('Climb along the drawn line', p.up != null ? `up ${Math.round(p.up)} m, down ${Math.round(p.dn)} m` : null),
      kv('Protected area', p.prot ? 'yes' : null), kv('On marked routes', p.routes),
      kv('OSM edits', [p.ver ? `version ${p.ver}` : null, p.yr ? `last edited ${p.yr}` : null, p.src ? `source: ${p.src}` : null].filter(Boolean).join(', ')),
      h('p', { class: 'note' }, 'Grades come from a 30 m elevation model: a short steep pitch can hide inside a gentle number.'));
  }
  if (p.class === 'detected' || p.class === 'ai' || p.class === 'gap') {
    out.push(h('p', { class: 'note' }, p.class === 'gap'
      ? 'An AI-found track ends here and another track or road carries on nearby, in the direction it was heading. '
        + 'The AI saw nothing in between (forest canopy often hides a track), so routes may cross this gap, drawn dotted. '
        + 'The track may not go through: look at the imagery, and turn back if it does not.'
      : p.class === 'ai'
      ? 'DirtScout\'s own AI found this line in Esri satellite imagery, and no map has it. It is most likely a farm or '
        + 'forest track, but it can be a field edge, a ditch, a fence line or private land, and its surface and access are '
        + 'unknown. Check it on the imagery before riding. Private: only on your phone, from your own file.'
      : 'Microsoft\'s AI found this road in Bing imagery (mostly 2020-2022); nobody has mapped it '
      + 'in OpenStreetMap, so its surface, name and access are unknown. Check it on the imagery. If you ride it, you can add it '
      + 'to OpenStreetMap so every map gets it.'));
    const c = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0];
    const [lon, lat] = c[Math.floor(c.length / 2)];
    out.push(h('a', { class: 'btn', href: `https://www.openstreetmap.org/edit#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}`, target: '_blank', rel: 'noopener' }, 'Add it in OpenStreetMap'));
  } else if (way) out.push(h('a', { class: 'btn', href: `https://www.openstreetmap.org/way/${way}`, target: '_blank', rel: 'noopener' }, 'Open in OpenStreetMap'));
  return out;
}

function onMapClick(e) {
  if (app.build) { builderClick(e); return; }
  if (app.draw) { addDrawPoint(e); return; }
  if (app.planPick) {
    app.planPick = false;
    app.plan.start = [e.lngLat.lng, e.lngLat.lat];
    app.plan.startMode = 'tap';
    app.plan.results = [];
    keepPlan();
    drawPlan();
    openPanel('plan');
    return;
  }
  const pad = 14;
  const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const layers = ['ds-pois', ...DS_TRACK_LAYERS].filter((l) => app.map.getLayer(l) && app.map.getLayoutProperty(l, 'visibility') === 'visible');
  const hits = layers.length ? app.map.queryRenderedFeatures(box, { layers }) : [];
  if (!hits.length) {
    if (current === 'info') closePanel();
    return;
  }
  const poi = hits.find((f) => f.layer.id === 'ds-pois');
  const routable = hits.find((f) => f.properties.det != null);
  const f = poi ?? routable ?? hits[0];
  app.selected = f;
  setSelected(app.map, f.layer.id === 'ds-pois' ? null : f.properties.id);
  openPanel('info');
}

// ---------------------------------------------------------------- Investigate a track (M5)

const RISK_COLORS = ['#00e676', '#ffd600', '#ff1744'];
const UNMAPPED = '#e040fb';

// The unlocked AI bundle carries a whole route network with its tracks (and the gaps joining them): routes and
// Investigate use it unless Plan's switch is off (hiding the layer on the map does not change routes).
const aiRouting = () => !!app.ai?.meta && settings.plan.useAi !== false;

async function ensureGraph() {
  if (!app.graph) {
    const aiGraph = aiRouting() ? await loadAiGraph() : null;
    const json = aiGraph ? filterAiEdges(aiGraph, settings.aiMin ?? 0.4) : await loadGraphJson();
    if (!json) throw new Error('the route network is not on this phone: install the area pack (Offline) or go online');
    const roads = app.tracks.filter((t) => t.network).flatMap((t) => trackLines(t).map((coords, k) => ({
      id: `${t.id}#${k}`, name: t.name, coords: coords.map((c) => [c[0], c[1]]),
      g: t.stats?.g100 ?? -1, gdir: t.stats?.gdir ?? 0, up: t.stats?.up ?? 0, dn: t.stats?.dn ?? 0,
    })));
    app.graph = loadGraph(roads.length ? augmentGraph(json, roads).json : json);
    app.graphIndex = null;
  }
  if (!app.graphIndex) app.graphIndex = buildIndex(app.graph);
  return app.graph;
}

async function runInvestigation(t) {
  app.inv = { track: t, busy: true, result: null };
  openPanel('inv');
  try {
    const G = await ensureGraph();
    const coords = trackLines(t).flat();
    const res = await investigate(G, app.graphIndex, coords, { elevAt: elevationAt });
    app.inv.result = res;
    const P = res.points;
    const features = res.segments.map((s) => ({
      type: 'Feature', properties: { color: s.e === null ? UNMAPPED : RISK_COLORS[s.risk] },
      geometry: { type: 'LineString', coordinates: P.slice(s.start, s.end + 2) },
    })).filter((f) => f.geometry.coordinates.length > 1);
    for (const a of res.alternatives) features.push({ type: 'Feature', properties: { alt: 1 }, geometry: { type: 'LineString', coordinates: a.coords } });
    setInvestigation(app.map, { type: 'FeatureCollection', features });
    fitCoords(P);
    const inv = app.inv;
    inv.prof = (await elevationProfile(res.points, elevationAt)) ?? false;      // the chart, once the map shows the result
  } catch (e) {
    toast(`Cannot investigate: ${e.message}`, { ms: 7000 });
  } finally {
    if (app.inv) app.inv.busy = false;                // (cleared from the map meanwhile: nothing to update)
    rerender();
  }
}

function flyToKm(km) {
  const r = app.inv?.result;
  if (!r) return;
  const i = r.dist.findIndex((d) => d >= km * 1000);
  const p = r.points[Math.max(0, i)];
  app.map.flyTo({ center: p, zoom: Math.max(app.map.getZoom(), 15.5), duration: 700 });
}

function renderInvestigation() {
  const inv = app.inv;
  if (!inv) return [h('p', { class: 'note' }, 'Open Tracks and tap Investigate on a track.')];
  if (inv.busy) return [h('p', { class: 'note' }, `Checking "${inv.track.name}" against the area pack…`)];
  const r = inv.result;
  if (!r) return [h('p', { class: 'note' }, 'No result.')];
  const km = (m) => (m / 1000).toFixed(2);
  const pct = (x) => `${Math.round(x * 100)} %`;
  const head = { green: 'Looks fine', yellow: 'Some doubts', red: 'Risky' }[r.verdict];
  const out = [
    h('h3', {}, inv.track.name),
    h('div', { class: `verdict v-${r.verdict}` }, h('strong', {}, head),
      h('span', {}, ` · ${fmtDist(r.length)}${r.profile ? ` · up ${fmtElev(r.profile.up)}` : ''}`)),
    h('div', { class: 'riskbar' }, h('i', { style: `width:${r.shares.green * 100}%;background:#00c853` }),
      h('i', { style: `width:${r.shares.yellow * 100}%;background:#ffd600` }), h('i', { style: `width:${r.shares.red * 100}%;background:#ff1744` }),
      h('i', { style: `width:${r.shares.unmapped * 100}%;background:${UNMAPPED}` })),
    h('div', { class: 'note' }, `green ${pct(r.shares.green)} · yellow ${pct(r.shares.yellow)} · red ${pct(r.shares.red)} · not on any mapped way ${pct(r.shares.unmapped)}`
      + (r.shares.legalNo ? ` · closed to motors ${pct(r.shares.legalNo)}` : '')),
    ...(inv.prof ? [h('h3', {}, 'Elevation'), ...profileSection(app.map, inv.prof)] : []),
  ];
  const item = (from, to, text, cls = '') => h('button', { class: `row find ${cls}`, onclick: () => { flyToKm(from / 1000); } },
    h('span', { class: 'km' }, `km ${km(from)}–${km(to)}`), h('span', { class: 'grow' }, text));
  if (r.stretches.length) {
    out.push(h('h3', {}, 'Risky stretches'));
    for (const s of r.stretches) {
      const why = [...new Set(s.parts.map((x) => (x.e === null ? 'not on any mapped way'
        : `${x.cls === 'ai' ? 'a track the AI found' : x.cls}${x.name ? ` "${x.name}"` : ''}${x.legal === 2 ? ', closed to motors' : ''}${x.grade ? `, about ${Math.round(x.grade)} %` : ''}`)))];
      out.push(item(s.from, s.to, why.join('; '), `k-${s.kind}`));
    }
  }
  if (r.profile?.climbs.length) {
    out.push(h('h3', {}, 'Climbs (15 %+)'));
    for (const c of r.profile.climbs) out.push(item(c.from, c.to, `${Math.round(c.to - c.from)} m, average ${Math.round(c.avg)} %, steepest ${Math.round(c.max)} %`));
  }
  if (r.profile?.descents.length) {
    out.push(h('h3', {}, 'Steep descents (20 %+)'));
    for (const c of r.profile.descents) out.push(item(c.from, c.to, `steepest ${Math.round(c.max)} %`));
  }
  if (r.alternatives.length) {
    out.push(h('h3', {}, 'Ways around (cyan dashes)'));
    r.alternatives.forEach((a, i) => out.push(h('div', { class: 'card' },
      h('div', {}, `km ${a.fromKm.toFixed(2)}–${a.toKm.toFixed(2)}: ${fmtDist(a.stats.len)} instead of ${fmtDist(a.original)} `
        + `(${a.extra >= 0 ? '+' : ''}${fmtDist(Math.abs(a.extra))}), green ${pct(a.stats.green)}`),
      h('div', { class: 'row-btns' },
        btn('Show', () => { fitCoords(a.coords); closePanel(); }),
        btn('Save', async () => {
          const t = await savePlanned(`${inv.track.name} - way around ${i + 1}`, a.coords, a.stats, { around: inv.track.id }, '#00e5ff');
          await app.refreshTracks();
          toast('Saved in Tracks', { action: 'GPX', onAction: () => shareGPX(t) });
        })))));
  }
  out.push(h('p', { class: 'note' }, 'Checked against OSM, Microsoft detections, GPS traces, forest and bare-earth elevation (30 m). '
    + 'A track drawn more than 30 m from every mapped way counts as not mapped. Short steep pitches do not show. '
    + 'Ask Claude on the PC for an imagery check of the red stretches.'));
  out.push(btn('Clear from the map', () => { setInvestigation(app.map, { type: 'FeatureCollection', features: [] }); app.inv = null; closePanel(); }));
  return out;
}

// ---------------------------------------------------------------- Draw a road

// The drawing: taps (shown as dots) and the parts between them (straight, or following the imagery).
const drawCoords = (d) => (d.taps.length ? [d.taps[0].p, ...d.parts.flat()] : []);

function startDraw() {
  if (builderActive()) { leaveBuilder(); if (builderActive()) return; }
  app.draw = { taps: [], parts: [], busy: false };
  closePanel();
  $('drawbar').hidden = false;
  updateDrawBar();
  toast('Tap where the road starts, then where it bends or ends: the line follows the track in the imagery. Taps near a mapped track snap onto it (green).', { ms: 7000 });
}

function updateDrawBar(msg = null) {
  const d = app.draw;
  const coords = drawCoords(d);
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  $('drawbar-text').textContent = msg ?? (d.taps.length ? `${d.taps.length} taps · ${fmtDist(len)}` : 'Tap where the road starts');
  $('draw-save').disabled = d.busy || coords.length < 2;
  $('draw-undo').disabled = d.busy || !d.taps.length;
  setDraw(app.map, coords, []);
  app.map.getSource('draw') && setDrawTaps();
}

function setDrawTaps() {
  const d = app.draw;
  const coords = drawCoords(d);
  const features = d.taps.map((t) => ({ type: 'Feature', properties: { snap: t.snapped ? 1 : 0 }, geometry: { type: 'Point', coordinates: t.p } }));
  if (coords.length > 1) features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  app.map.getSource('draw').setData({ type: 'FeatureCollection', features });
}

// Imagery to follow: the base on screen when it is imagery, else Microsoft Earth.
const followSource = () => (['ms-earth', 'esri-imagery'].includes(effectiveBase()) ? effectiveBase() : 'ms-earth');

// A tap near a rendered track (DirtScout or yours) snaps to the closest point on it.
function snapPoint(e) {
  const map = app.map;
  const pad = 20;
  const layers = [...DS_TRACK_LAYERS, 'tracks-line', 'tracks-tet'].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  const feats = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers });
  let best = null, bd = pad;
  for (const f of feats) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = map.project(line[i]), b = map.project(line[i + 1]);
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((e.point.x - a.x) * dx + (e.point.y - a.y) * dy) / L2)) : 0;
        const px = a.x + t * dx, py = a.y + t * dy;
        const d = Math.hypot(e.point.x - px, e.point.y - py);
        if (d < bd) { bd = d; best = map.unproject([px, py]); }
      }
    }
  }
  return best ? [best.lng, best.lat] : null;
}

async function addDrawPoint(e) {
  const d = app.draw;
  if (d.busy) return;
  const snapped = snapPoint(e);
  const p = snapped ?? [e.lngLat.lng, e.lngLat.lat];
  if (!d.taps.length) {
    d.taps.push({ p, snapped: !!snapped });
    updateDrawBar();
    return;
  }
  const from = d.taps.at(-1).p;
  let part = [p];
  if ($('draw-follow').checked) {
    d.busy = true;
    updateDrawBar('Following the track in the imagery…');
    try {
      const path = await followTrack(followSource(), from, p);
      if (path && path.length > 1) part = [...path.slice(1, -1), p];
      else toast('No clear line to follow there: drawn straight. Add a tap in between to help.', { ms: 4000 });
    } catch (err) {
      console.warn('follow', err);
    } finally {
      d.busy = false;
    }
    if (app.draw !== d) return;                      // cancelled meanwhile
  }
  d.taps.push({ p, snapped: !!snapped });
  d.parts.push(part);
  updateDrawBar();
}

function endDraw() {
  app.draw = null;
  $('drawbar').hidden = true;
  setDraw(app.map, [], []);
}

function undoDraw() {
  const d = app.draw;
  if (!d || d.busy || !d.taps.length) return;
  d.taps.pop();
  d.parts.pop();
  updateDrawBar();
}

// Elevation along the drawn road: climb, descent and the steepest 100 m (same smoothing as the pack).
async function drawnProfile(coords) {
  const pts = densify(coords, 10);
  const el = [];
  for (const p of pts) el.push(await elevationAt(p[0], p[1]));
  if (el.some((v) => v == null)) return {};
  const sm = el.map((_, i) => { let s = 0, n = 0; for (let k = -3; k <= 3; k++) { const v = el[i + k]; if (v != null) { s += v; n++; } } return s / n; });
  let up = 0, dn = 0, g100 = 0, gdir = 0;
  for (let i = 1; i < sm.length; i++) { const d = sm[i] - sm[i - 1]; if (d > 0) up += d; else dn -= d; }
  for (let i = 0; i + 10 < sm.length; i++) {
    const g = ((sm[i + 10] - sm[i]) / 100) * 100;
    if (Math.abs(g) > g100) { g100 = Math.abs(g); gdir = g >= 0 ? 1 : -1; }
  }
  return { up: Math.round(up), dn: Math.round(dn), g100: Math.round(g100 * 10) / 10, gdir };
}

async function saveDraw() {
  const d = app.draw;
  const coords = d ? drawCoords(d) : [];
  if (!d || d.busy || coords.length < 2) return;
  const name = prompt('Name of this road', `My road ${new Date().toLocaleDateString()}`);
  if (name === null) return;
  endDraw();
  const stats = await drawnProfile(coords);
  const t = await saveDrawn(name.trim() || 'My road', coords, stats);
  await app.refreshTracks();
  app.graph = null;
  toast(`Saved "${t.name}": Plan and Investigate now use it.`, { action: 'GPX', onAction: () => shareGPX(t) });
}

// ---------------------------------------------------------------- Plan a ride (M4)

const PLAN_COLORS = ['#00e5ff', '#ff3df2', '#ffd400', '#7cff4f', '#ff9100'];

function planStart() {
  const p = app.plan;
  if (p.startMode === 'gps' && gps.last) return [gps.last.lon, gps.last.lat];
  if (p.startMode === 'tap' && p.start) return p.start;
  const c = app.map.getCenter();
  return [c.lng, c.lat];
}

// The plan's choices that last (settings.plan): length range, AI tracks, how the start is picked and the tapped spot.
function keepPlan() {
  const p = app.plan;
  Object.assign(settings.plan, { kmMin: p.kmMin, kmMax: p.kmMax, startMode: p.startMode, start: p.start });
  saveSettings();
}

function drawPlan() {
  const p = app.plan;
  const features = p.results.map((r, i) => ({
    type: 'Feature', properties: { color: PLAN_COLORS[i % PLAN_COLORS.length], sel: i === p.sel ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: r.coords },
  }));
  for (const g of p.results[p.sel]?.gaps ?? []) features.push({ type: 'Feature', properties: { gap: 1 }, geometry: { type: 'LineString', coordinates: g } });
  const s = p.results.length ? p.results[0].coords[0] : (p.startMode === 'tap' && p.start ? p.start : null);
  if (s) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: s } });
  setPlan(app.map, { type: 'FeatureCollection', features });
}

function fitCoords(coords) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
  app.map.fitBounds([[w, s], [e, n]], { padding: { top: 60, bottom: Math.round(innerHeight * 0.5), left: 30, right: 60 }, maxZoom: 16, duration: 500 });
}

async function generatePlan() {
  const p = app.plan;
  if (p.busy) return;
  p.busy = true;
  rerender();
  try {
    const G = await ensureGraph();
    const [lon, lat] = planStart();
    await new Promise((r) => setTimeout(r, 30));           // let the "working" state paint
    const opts = { minLen: p.kmMin * 1000, maxLen: p.kmMax * 1000, shape: p.shape, climbs: p.climbs, minClimbGrade: p.minClimbGrade,
      avoidRed: p.avoidRed, preferDirt: p.preferDirt, allowNoAccess: p.allowNoAccess, seed: p.seed };
    // the start: the nearest mapped way where the car can wait (not an AI track), joined to the wider network
    const s = startNode(G, lon, lat, makeCost(G, opts));
    if (!s || s.off > 3000) throw new Error(`the start is ${s ? fmtDist(s.off) : 'far'} from the nearest mapped way (outside the riding area?)`);
    const res = generateRoutes(G, s.node, opts);
    p.results = res.map((r) => ({ ...r, coords: routeCoords(G, r.path), gaps: routeGaps(G, r.path) }));
    p.startOff = s.off;
    p.sel = 0;
    p.seed += 1;
    drawPlan();
    if (p.results.length) fitCoords(p.results[0].coords);
    if (!p.results.length) toast('No route from here: try another length, fewer climbs, or allow red tracks.', { ms: 6000 });
    else if (!p.results[0].fits) toast(`No ${p.kmMin}-${p.kmMax} km ${p.shape === 'loop' ? 'loop' : 'ride'} from here: showing the closest. Try a wider range or another start.`, { ms: 7000 });
  } catch (e) {
    toast(`Cannot plan: ${e.message}`, { ms: 7000 });
  } finally {
    p.busy = false;
    rerender();
  }
}

function seg(options, value, onPick) {
  return h('div', { class: 'seg' }, options.map(([v, label]) =>
    h('button', { class: `btn small${v === value ? ' on' : ''}`, onclick: () => onPick(v) }, label)));
}

// Two knobs on one track: a range from lo to hi, at least `gap` apart. onInput(lo, hi) while dragging, onChange after.
function rangeSlider({ min, max, step = 1, lo, hi, gap = 1, label, onInput, onChange }) {
  const fillBar = h('i');
  const a = h('input', { type: 'range', min, max, step, value: lo, 'aria-label': `${label}: from` });
  const b = h('input', { type: 'range', min, max, step, value: hi, 'aria-label': `${label}: to` });
  const paint = () => {
    const pct = (v) => ((v - min) / (max - min)) * 100;
    fillBar.style.left = `${pct(+a.value)}%`;
    fillBar.style.right = `${100 - pct(+b.value)}%`;
    a.style.zIndex = +a.value > (min + max) / 2 ? 3 : 1;     // when the knobs meet, the one that can still move is on top
  };
  a.addEventListener('input', () => { if (+a.value > +b.value - gap) a.value = +b.value - gap; paint(); onInput(+a.value, +b.value); });
  b.addEventListener('input', () => { if (+b.value < +a.value + gap) b.value = +a.value + gap; paint(); onInput(+a.value, +b.value); });
  for (const x of [a, b]) x.addEventListener('change', () => onChange(+a.value, +b.value));
  paint();
  return h('div', { class: 'range2' }, h('div', { class: 'range2-track' }, fillBar), a, b);
}

function renderPlan() {
  const p = app.plan;
  const set = (k) => (v) => { p[k] = v; rerender(); };
  const startLabel = p.startMode === 'gps' ? (gps.last ? 'my position' : 'my position (waiting for GPS)')
    : p.startMode === 'tap' ? (p.start ? `${p.start[1].toFixed(4)}, ${p.start[0].toFixed(4)}` : 'tap the map where you leave the car') : 'the map centre';
  const lenText = () => `Length: ${p.kmMin}-${p.kmMax} km`;
  const out = [
    btn('Make my own route', () => { if (app.draw) endDraw(); startBuilder(); }, 'big'),
    h('p', { class: 'note' }, 'Tap points on the map: each holds on to the nearest track and the route follows the tracks between them. '
      + 'Drag a point to move it, tap the line to add one, tap point 1 to come back to the start.'),
    h('h3', {}, 'Or let DirtScout make loops'),
    h('div', { class: 'label' }, `Start: ${startLabel}`),
    seg([['gps', 'My position'], ['centre', 'Map centre'], ['tap', 'Tap the map']], p.startMode, (v) => {
      p.startMode = v;
      keepPlan();
      if (v === 'gps' && !gps.on) locate();
      if (v === 'tap') { app.planPick = true; closePanel(); toast('Tap the map where you leave the car.'); return; }
      rerender();
    }),
    p.startMode === 'tap' && p.start ? h('button', { class: 'btn small', onclick: () => { app.planPick = true; closePanel(); toast('Tap the map where you leave the car.'); } }, 'Move the start') : null,
    h('div', { class: 'label', id: 'plan-len' }, lenText()),
    rangeSlider({
      min: 2, max: 100, lo: p.kmMin, hi: p.kmMax, label: 'Length in km',
      onInput: (lo, hi) => { p.kmMin = lo; p.kmMax = hi; const l = $('plan-len'); if (l) l.textContent = lenText(); },
      onChange: () => keepPlan(),
    }),
    app.ai?.meta ? toggleRow(`Use the tracks the AI found (score at least ${Math.round((settings.aiMin ?? 0.4) * 100)} %, set in Layers)`,
      settings.plan.useAi !== false, (v) => { settings.plan.useAi = v; saveSettings(); app.graph = null; app.graphIndex = null; rerender(); }) : null,
    app.ai?.meta && settings.plan.useAi !== false ? h('p', { class: 'note' }, 'Where an AI track stops short of another track or road it points at, '
      + 'routes may cross the gap: drawn with white dashes on the route. Nothing was seen there, so check those spots on the imagery.') : null,
    seg([['loop', 'Loop'], ['out-back', 'Out and back']], p.shape, set('shape')),
    h('div', { class: 'label' }, 'Hill climbs'),
    seg([[0, 'None'], [1, '1'], [2, '2'], [3, '3']], p.climbs, set('climbs')),
    p.climbs ? h('div', { class: 'row', style: 'border:0' }, h('span', { class: 'grow' }, 'steeper than'),
      seg([[12, '12 %'], [15, '15 %'], [20, '20 %'], [25, '25 %']], p.minClimbGrade, set('minClimbGrade'))) : null,
    toggleRow('Avoid red (doubtful or hard) tracks', p.avoidRed, (v) => { p.avoidRed = v; }),
    toggleRow('Prefer dirt over tarmac', p.preferDirt, (v) => { p.preferDirt = v; }),
    toggleRow('Allow ways closed to motors in OSM', p.allowNoAccess, (v) => { p.allowNoAccess = v; }),
    btn(p.busy ? 'Working…' : p.results.length ? 'Generate different routes' : 'Generate routes', generatePlan, 'primary big'),
    h('p', { class: 'note' }, 'Routes use the area pack: the risk colours, steepness (approximate), dirt vs tarmac and access tags. '
      + 'Check each one on the imagery before riding.'),
  ];
  if (p.results.length && p.startMode !== 'centre' && (p.startOff ?? 0) > 150) {
    out.push(h('p', { class: 'note' }, `The routes start on the nearest mapped way, ${fmtDist(p.startOff)} from your start.`));
  }
  if (p.results.length && !p.results[0].fits) {
    out.push(h('p', { class: 'note warn' }, `No ${p.kmMin}-${p.kmMax} km route from here: these are the closest.`));
  }
  p.results.forEach((r, i) => {
    const s = r.stats;
    const color = PLAN_COLORS[i % PLAN_COLORS.length];
    const pct = (x) => `${Math.round(x * 100)} %`;
    out.push(h('div', { class: `card plan-card${i === p.sel ? ' sel' : ''}`, style: `--c:${color}`,
      onclick: (e) => { if (e.target.closest('button')) return; p.sel = i; drawPlan(); fitCoords(r.coords); rerender(); } },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, `Route ${i + 1}: ${fmtDist(s.len)}`),
      h('span', { class: 'muted' }, `↑ ${fmtElev(s.up)}`)),
    h('div', { class: 'note' }, [
      `${s.climbs.length} climb${s.climbs.length === 1 ? '' : 's'}${s.climbs.length ? ` (steepest about ${Math.round(Math.max(...s.climbs.map((c) => c.grade)))} %)` : ''}`,
      `${pct(s.dirt)} dirt`, s.reused > 0.05 ? `${pct(s.reused)} ridden twice` : null,
      s.restricted > 0 ? `${pct(s.restricted)} restricted access` : null,
      s.ai > 0 ? `${pct(s.ai)} on AI-found tracks` : null,
    ].filter(Boolean).join(' · ')),
    s.gaps ? h('div', { class: 'note flag' }, `${s.gaps} gap${s.gaps === 1 ? '' : 's'} where nothing was seen (${fmtDist(s.gapLen)}): white dashes, check them`) : null,
    h('div', { class: 'riskbar' }, h('i', { style: `width:${s.green * 100}%;background:#00c853` }),
      h('i', { style: `width:${s.yellow * 100}%;background:#ffd600` }), h('i', { style: `width:${s.red * 100}%;background:#ff1744` })),
    h('div', { class: 'note' }, `green ${pct(s.green)} · yellow ${pct(s.yellow)} · red ${pct(s.red)}`),
    h('div', { class: 'row-btns' },
      btn('Show', () => { p.sel = i; drawPlan(); fitCoords(r.coords); closePanel(); }),
      btn('Profile', () => editRoute(`Route ${i + 1}`, r.coords)),
      btn('Save', async () => {
        const d = new Date();
        const name = `Plan ${fmtDist(s.len)} ${d.toLocaleDateString()} #${i + 1}`;
        const t = await savePlanned(name, r.coords, s, { kmMin: p.kmMin, kmMax: p.kmMax, shape: p.shape, climbs: p.climbs, ai: aiRouting() }, color);
        await app.refreshTracks();
        toast(`Saved "${name}" in Tracks`, { action: 'GPX', onAction: () => shareGPX(t) });
      }, 'primary'),
      btn('GPX', async () => {
        const t = { name: `DirtScout ${fmtDist(s.len)} route`, fc: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }] } };
        const res = await shareGPX(t);
        if (res === 'downloaded') toast('GPX saved to Downloads');
      }))));
  });
  if (p.results.length) out.push(btn('Clear the routes', () => { p.results = []; drawPlan(); rerender(); }));
  out.push(h('h3', {}, 'Sample rides for your review'), h('div', { id: 'samples' }, h('p', { class: 'note' }, 'Loading…')));
  loadSamples();
  return out;
}

async function loadSamples() {
  const box = $('samples');
  const data = await loadPackJson('samples');
  if (!box) return;
  if (!data?.samples?.length) { fill(box, h('p', { class: 'note' }, 'Not available yet: install the area pack (Offline).')); return; }
  const pct = (x) => `${Math.round(x * 100)} %`;
  fill(box, h('p', { class: 'note' }, 'Ten loops from villages around Cluj, made by the generator. Tell Claude which look right and which do not: '
    + 'that tunes the risk colours and the route costs before the batch of 100.'),
  data.samples.map((smp) => {
    const s = smp.stats;
    const show = () => {
      const coords = decodePolyline(smp.poly);
      app.plan.results = [{ coords, stats: { len: s.len, up: s.up, climbs: Array(s.climbs).fill({ grade: s.maxUp }), dirt: s.dirt, green: s.green, yellow: s.yellow, red: s.red, reused: 0, restricted: 0 } }];
      app.plan.sel = 0;
      drawPlan();
      fitCoords(coords);
      return coords;
    };
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, smp.name), h('span', { class: 'muted' }, `up ${fmtElev(s.up)}`)),
      h('div', { class: 'note' }, `${s.climbs} climb${s.climbs === 1 ? '' : 's'}${s.climbs ? ` (steepest about ${s.maxUp} %)` : ''} · ${pct(s.dirt)} dirt · green ${pct(s.green)}, yellow ${pct(s.yellow)}, red ${pct(s.red)}`),
      h('div', { class: 'row-btns' },
        btn('Show', () => { show(); closePanel(); }),
        btn('Save', async () => {
          const coords = decodePolyline(smp.poly);
          const t = await savePlanned(`Sample ${smp.name}`, coords, { up: s.up, dn: s.up, climbs: Array(s.climbs).fill(0), green: s.green, yellow: s.yellow, red: s.red }, { sample: smp.id }, '#00e5ff');
          await app.refreshTracks();
          toast(`Saved "${t.name}" in Tracks`);
        })));
  }));
}

// ---------------------------------------------------------------- Offline maps (downloads)

const JOB_STATUS = { queued: 'Waiting', running: 'Downloading', paused: 'Paused', done: 'Done', 'done-errors': 'Done with errors', cancelled: 'Cancelled' };

function jobArea(f) {
  if (f.areaType === 'screen') {
    const b = app.map.getBounds();
    const box = bboxIntersect([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], settings.area);
    return box ? { type: 'bbox', bbox: box, label: 'screen area' } : null;
  }
  if (f.areaType === 'track') {
    const t = app.tracks.find((x) => x.id === f.trackId);
    const lines = t ? trackLines(t) : [];
    return lines.length ? { type: 'corridor', lines, buffer: f.buffer, label: `${f.buffer} m around "${t.name}"` } : null;
  }
  return { type: 'bbox', bbox: [...settings.area], label: 'whole riding area' };
}

function jobCard(j) {
  const live = downloader.job?.id === j.id ? downloader.job : j;
  const p = live.progress;
  const pct = p.total ? Math.floor((100 * p.done) / p.total) : 0;
  const fetched = p.stored + p.none + p.failed;
  const secs = live.status === 'running' && live.started ? (Date.now() - live.started) / 1000 : 0;
  const rate = secs > 3 ? fetched / secs : 0;
  const bits = [`${fmtInt(p.done)} / ${fmtInt(p.total)} tiles`, `${fmtBytes(p.bytes)} saved`];
  if (p.skipped) bits.push(`${fmtInt(p.skipped)} were already saved`);
  if (p.none) bits.push(`${fmtInt(p.none)} without imagery`);
  if (rate > 0) bits.push(`${rate.toFixed(1)} tiles/s, about ${fmtDuration(((p.total - p.done) / rate) * 1000)} left`);
  const running = live.status === 'running' || live.status === 'queued';
  return h('div', { class: `card job ${live.status}` },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, j.name), h('span', { class: 'badge' }, JOB_STATUS[live.status] ?? live.status)),
    h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` })),
    h('div', { class: 'note' }, bits.join(' · ')),
    Object.entries(p.errors ?? {}).map(([src, msg]) => h('div', { class: 'note warn' }, `${SOURCES[src]?.name ?? src}: ${msg}`)),
    h('div', { class: 'row-btns' },
      running ? btn('Pause', () => downloader.pause(j.id)) : null,
      !running && live.status !== 'done' ? btn(live.status === 'done-errors' ? 'Retry failed' : 'Resume', () => downloader.resume(j.id), 'primary') : null,
      !running ? btn('Delete these tiles', () => deleteJobTiles(j)) : null,
      btn(running ? 'Cancel' : 'Remove from list', async () => {
        if (running && !confirm('Cancel this download? Tiles saved so far stay on the phone.')) return;
        await downloader.remove(j.id);
      }),
    ));
}

async function deleteJobTiles(j) {
  if (!confirm(`Delete the tiles of "${j.name}" from this phone? Tiles shared with other downloads go too.`)) return;
  let n = 0, bytes = 0;
  for (const src of j.sources) {
    const [z0, z1] = sourceZooms(src, j.zmin, j.zmax);
    for (let z = z0; z <= z1; z++) {
      const keys = [];
      for (const [x, y] of areaTiles(j.area, z, settings.area)) keys.push(tileKey(src, z, x, y));
      const r = await db.deleteTileKeys(src, keys);
      if (r) { n += r.count; bytes += r.bytes; }
    }
  }
  await downloader.remove(j.id);
  toast(`Deleted ${fmtInt(n)} tiles (${fmtBytes(bytes)})`);
  rerender();
}

async function renderJobs() {
  const jobs = (await downloader.jobs()).reverse();
  return jobs.length ? jobs.map(jobCard) : [h('p', { class: 'note' }, 'No downloads yet. Start with the whole area below.')];
}

function presetWholeArea() {
  Object.assign(app.dlForm, { sources: ['ms-earth', 'dem'], areaType: 'bbox', zmin: 10, zmax: 16 });
  rerender();
}

function presetCorridor(trackId = null) {
  const t = trackId ?? app.tracks.find((x) => trackLines(x).length)?.id ?? null;
  Object.assign(app.dlForm, { sources: ['ms-earth'], areaType: 'track', trackId: t, zmin: 17, zmax: 18, buffer: app.dlForm.buffer || 300 });
  rerender();
}

function newDownloadForm() {
  const f = app.dlForm;
  const est = h('div', { class: 'estimate' });
  const startBtn = btn('Start download', () => startDownload(), 'primary big');
  const refresh = () => {
    const area = jobArea(f);
    if (!f.sources.length || !area) {
      fill(est, !f.sources.length ? 'Pick at least one map.' : f.areaType === 'track' ? 'Pick a track (import one in Tracks).' : 'The screen is outside the riding area.');
      startBtn.disabled = true;
      return;
    }
    const e = estimateJob({ sources: f.sources, area, zmin: f.zmin, zmax: f.zmax }, app.stats);
    fill(est, 
      h('strong', {}, `${fmtInt(e.tiles)} tiles ≈ ${fmtBytes(e.bytes)}`),
      ...e.rows.map((r) => h('div', { class: 'note' }, `${SOURCES[r.src].name}: z${r.z0}-${r.z1}, ${fmtInt(r.tiles)} tiles ≈ ${fmtBytes(r.bytes)}`)),
      e.bytes > 3 * 1024 ** 3 ? h('div', { class: 'note warn' }, 'That is a lot: use high zooms only along tracks.') : null,
    );
    startBtn.disabled = e.tiles === 0;
  };
  const zoomSel = (key) => h('select', {
    onchange: (e) => {
      f[key] = +e.target.value;
      if (f.zmin > f.zmax) { if (key === 'zmin') f.zmax = f.zmin; else f.zmin = f.zmax; rerender(); return; }
      refresh();
    },
  }, Array.from({ length: 12 }, (_, i) => i + 8).map((z) => h('option', { value: z, selected: f[key] === z }, `z${z} · ${mpp(z)} m/px`)));
  const lineTracks = app.tracks.filter((t) => trackLines(t).length);
  const areaRadio = (value, label) => h('label', { class: 'row' },
    h('input', { type: 'radio', name: 'dl-area', checked: f.areaType === value, onchange: () => { f.areaType = value; rerender(); } }),
    h('span', { class: 'grow' }, label));
  const nodes = [
    h('div', { class: 'row-btns' },
      btn('Whole area overview', presetWholeArea),
      btn('Track corridor (detail)', () => presetCorridor())),
    h('p', { class: 'note' }, 'Overview: Microsoft Earth z10-16 (1.6 m/px) for the whole area plus elevation, about 0.6-0.8 GB. Detail: z17-18 (0.4 m/px) only along a track.'),
    h('div', { class: 'label' }, 'Maps'),
    ...OFFLINE_SOURCES.map((id) => toggleRow(SOURCES[id].name, f.sources.includes(id), (on) => {
      f.sources = on ? [...new Set([...f.sources, id])] : f.sources.filter((s) => s !== id);
      refresh();
    }, id === 'dem' ? h('span', { class: 'badge' }, 'z8-12') : null)),
    h('div', { class: 'label' }, 'Area'),
    areaRadio('bbox', 'Whole riding area'),
    areaRadio('screen', 'What is on screen now'),
    areaRadio('track', 'Along a track'),
    f.areaType === 'track' ? h('div', { class: 'indent' },
      lineTracks.length ? h('select', { onchange: (e) => { f.trackId = e.target.value; refresh(); } },
        h('option', { value: '', selected: !f.trackId }, 'Pick a track…'),
        lineTracks.map((t) => h('option', { value: t.id, selected: f.trackId === t.id }, `${t.name} (${fmtDist(t.stats.length)})`)))
        : h('p', { class: 'note' }, 'No tracks yet: import a GPX in Tracks.'),
      h('label', { class: 'row' }, h('span', { class: 'grow' }, 'Width each side (m)'),
        h('input', { type: 'number', min: 50, max: 2000, step: 50, value: f.buffer, class: 'num', oninput: (e) => { f.buffer = Math.max(50, Math.min(2000, +e.target.value || 300)); refresh(); } })),
    ) : null,
    h('div', { class: 'label' }, 'Zoom'),
    h('div', { class: 'row zoom-row' }, h('span', {}, 'From'), zoomSel('zmin'), h('span', {}, 'to'), zoomSel('zmax')),
    est,
    startBtn,
    h('p', { class: 'note' }, 'Downloads stay inside the riding area, a few tiles at a time. Keep DirtScout open: the screen stays on by itself, and a stopped download resumes where it left off.'),
  ];
  queueMicrotask(refresh);
  return nodes;
}

async function startDownload() {
  const f = app.dlForm;
  const area = jobArea(f);
  if (!area || !f.sources.length) return;
  const e = estimateJob({ sources: f.sources, area, zmin: f.zmin, zmax: f.zmax }, app.stats);
  if (e.bytes > 1.5 * 1024 ** 3 && !confirm(`This is about ${fmtBytes(e.bytes)}. Start it?`)) return;
  if (!navigator.onLine) toast('No network now: the download starts when the phone is back online.');
  const names = f.sources.map((s) => SOURCES[s].short ?? SOURCES[s].name).join(' + ');
  await downloader.add({ name: `${names} · ${area.label} · z${f.zmin}-${f.zmax}`, sources: [...f.sources], area, zmin: f.zmin, zmax: f.zmax });
  toast('Download started');
  rerender();
}

let packJob = null;          // {name, got, total} while installing
let aiJob = null;            // {got, total} while the AI file downloads and opens
let aiError = null;
let aiPass = '';

// The owner's private layer: tracks DirtScout's model found in satellite imagery (pack/ai.enc, opened with a passphrase).
function aiCard() {
  const d = app.ai?.meta;
  const progress = aiJob ? [
    h('div', { class: 'bar' }, h('div', { style: `width:${aiJob.total ? Math.floor((100 * aiJob.got) / aiJob.total) : 5}%` })),
    h('p', { class: 'note' }, aiJob.got && aiJob.got === aiJob.total ? 'Opening…' : `Downloading ${fmtBytes(aiJob.got)}${aiJob.total ? ` of ${fmtBytes(aiJob.total)}` : ''}`),
  ] : null;
  const err = aiError ? h('p', { class: 'note warn' }, aiError) : null;
  if (app.ai?.stale) {
    return h('div', { class: 'card', id: 'ai-card' },
      h('p', { class: 'note' }, 'Your AI tracks need a one-time update: the new file fixes routes that jumped across the map and joins the tracks across short gaps. It downloads with your saved passphrase.'),
      progress, err,
      aiJob ? null : h('div', { class: 'row-btns' }, btn('Update', () => runAi(null), 'primary'), btn('Remove', removeAi)));
  }
  if (d) {
    return h('div', { class: 'card', id: 'ai-card' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'AI-found tracks'), h('span', { class: 'badge ok' }, `unlocked ${d.version}`)),
      h('p', { class: 'note' }, `${fmtInt(d.stats?.lines ?? 0)} tracks, ${fmtInt(d.stats?.km ?? 0)} km that no map has; `
        + `${fmtInt(aiShown(settings.aiMin ?? 0.4).km)} km shown at your setting (Layers, under the AI layer). `
        + 'Plan and Investigate use the ones shown. Kept on this phone; works offline.'),
      progress, err,
      aiJob ? null : h('div', { class: 'row-btns' }, btn('Update', () => runAi(null)), btn('Remove', removeAi)));
  }
  return h('div', { class: 'card', id: 'ai-card' },
    h('p', { class: 'note' }, 'Your private layer: tracks DirtScout\'s own model found in satellite imagery that no map has. '
      + 'The file is encrypted; type your passphrase once to open it.'),
    h('label', { class: 'row' }, h('span', {}, 'Passphrase'),
      h('input', { class: 'grow', id: 'ai-pass', type: 'text', value: aiPass, autocomplete: 'off', autocapitalize: 'off',
        autocorrect: 'off', spellcheck: 'false', placeholder: 'xxxx-xxxx-xxxx-xxxx',
        oninput: (e) => { aiPass = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') runAi(aiPass); } })),
    progress, err,
    aiJob ? null : h('div', { class: 'row-btns' }, btn('Unlock', () => runAi(aiPass), 'primary')));
}

// After start-up: an AI file stored in an older format is fetched again in the new one (online only).
export function refreshAi() {
  if (navigator.onLine !== false) runAi(null);
}

async function runAi(pass) {
  if (aiJob) return;
  if (pass != null && !pass.trim()) { aiError = 'Type the passphrase first.'; rerender(); return; }
  aiJob = { got: 0, total: 0 };
  aiError = null;
  rerender();
  let last = 0;
  const onProgress = (got, total) => {
    aiJob.got = got;
    aiJob.total = total;
    if (performance.now() - last > 300) { last = performance.now(); if (current === 'downloads') rerender(); }
  };
  try {
    app.ai = pass == null ? await aiUpdate(onProgress) : await aiUnlock(pass, onProgress);
    aiPass = '';
    addBlobTiles('ai', app.ai.tiles);
    setAiTiles(app.map, true);
    app.graph = null;
    app.graphIndex = null;
    applyLayers(app.map);
    toast(`AI tracks ${app.ai.meta.version}: ${fmtInt(aiShown(settings.aiMin ?? 0.4).km)} km shown at your setting `
      + `(${fmtInt(app.ai.meta.stats?.km ?? 0)} km in all), on the map and in your routes.`);
  } catch (e) {
    aiError = `Could not open it: ${e.message}.`;
  } finally {
    aiJob = null;
    rerender();
  }
}

async function removeAi() {
  if (!confirm('Remove the AI-found tracks from this phone? You can unlock them again with the passphrase.')) return;
  await aiRemove();
  app.ai = null;
  setAiTiles(app.map, false);
  removeBlobTiles('ai');
  app.graph = null;
  app.graphIndex = null;
  applyLayers(app.map);
  rerender();
}

async function packCard() {
  const man = await fetchManifest();
  app.packManifest = man ?? app.packManifest;
  const m = app.packManifest;
  const names = m ? Object.keys(m.files).filter((n) => PACK_FILES[n]) : Object.keys(PACK_FILES);
  const inst = names.every((n) => packInstalled[n]);
  const outdated = m && inst && names.some((n) => packInstalled[n].version !== m.version);
  const size = m ? names.reduce((a, n) => a + m.files[n].bytes, 0) : null;
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'DirtScout map + bare-earth elevation'),
      h('span', { class: `badge${inst ? ' ok' : ''}` }, inst ? `installed ${packInstalled.area.version}` : 'not installed')),
    h('p', { class: 'note' }, 'Tracks with their evidence (seen from above, GPS traces, forest, steepness, access), gates, peaks, '
      + 'springs, villages, routes, contours and Microsoft road detections, plus FABDEM elevation for hillshade and slope.'),
    m ? h('p', { class: 'note' }, `Server version ${m.version}, ${fmtBytes(size)}.`) : h('p', { class: 'note' }, 'Server not reachable now.'),
    packJob ? h('div', { class: 'bar' }, h('div', { style: `width:${packJob.total ? Math.floor((100 * packJob.got) / packJob.total) : 5}%` })) : null,
    packJob ? h('p', { class: 'note' }, `Downloading ${packJob.name}: ${fmtBytes(packJob.got)}${packJob.total ? ` of ${fmtBytes(packJob.total)}` : ''}`) : null,
    h('div', { class: 'row-btns' },
      m && !packJob && (!inst || outdated) ? btn(outdated ? 'Update the area pack' : 'Install the area pack', () => runPackInstall(m), 'primary') : null,
      inst && !packJob ? btn('Remove', async () => {
        if (!confirm('Remove the area pack from this phone?')) return;
        for (const n of Object.keys(PACK_FILES)) await uninstallPack(n);
        app.graph = null;
        clearDemCaches();
        reloadPack(app.map);
        applyLayers(app.map);
        rerender();
      }) : null));
}

async function runPackInstall(m) {
  if (!navigator.onLine) { toast('No network'); return; }
  try {
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    wake.want('pack', true);
    for (const name of Object.keys(m.files).filter((n) => PACK_FILES[n])) {
      packJob = { name: { area: 'map', dem: 'elevation', graph: 'route network', samples: 'sample rides' }[name] ?? name, got: 0, total: m.files[name].bytes };
      rerender();
      let last = 0;
      await installPack(name, m.version, (got, total) => {
        packJob.got = got;
        packJob.total = total || packJob.total;
        if (performance.now() - last > 400) { last = performance.now(); if (current === 'downloads') rerender(); }
      });
    }
    packJob = null;
    app.graph = null;
    clearDemCaches();
    reloadPack(app.map);
    applyLayers(app.map);
    toast(`Area pack ${m.version} installed: the DirtScout map now works offline.`);
  } catch (e) {
    packJob = null;
    toast(`Area pack download failed: ${e.message}`);
  } finally {
    wake.want('pack', false);
    rerender();
  }
}

async function renderDownloads() {
  app.stats = await db.tileStats();
  const est = (await navigator.storage?.estimate?.().catch(() => null)) ?? {};
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const out = [h('div', { class: 'card' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Phone storage'),
      h('span', {}, est.quota ? `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)}` : 'unknown')),
    h('p', { class: 'note' }, persisted ? 'Protected: Chrome will not clear this data by itself.'
      : 'Not protected yet: Chrome may clear it if the phone runs out of space. DirtScout asks for protection with the first download; installing the app helps.'))];

  out.push(h('h3', {}, 'Area pack'), await packCard());
  out.push(h('h3', {}, 'Tracks the AI found (private)'), aiCard());

  out.push(h('h3', {}, 'Saved on this phone'));
  for (const id of OFFLINE_SOURCES) {
    const st = app.stats[id];
    out.push(h('div', { class: 'row' },
      h('span', { class: 'grow' }, SOURCES[id].name),
      h('span', { class: 'muted' }, st?.count ? `${fmtInt(st.count)} tiles · ${fmtBytes(st.bytes)}` : 'nothing'),
      st?.count ? btn('Delete', async () => {
        if (!confirm(`Delete all saved ${SOURCES[id].name} tiles?`)) return;
        await db.deleteSourceTiles(id);
        app.stats = await db.tileStats();
        toast(`${SOURCES[id].name} tiles deleted`);
        rerender();
      }, 'small') : null));
  }

  out.push(h('h3', {}, 'Downloads'), h('div', { id: 'dl-jobs' }, ...(await renderJobs())));
  out.push(h('h3', {}, 'New download'), ...newDownloadForm());
  return out;
}

// ---------------------------------------------------------------- Tracks

async function renderTracks() {
  const input = h('input', {
    type: 'file', multiple: true, hidden: true,
    onchange: async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const { added, failed } = await importFiles(files, { markTet: app.markTet });
      await app.refreshTracks();
      if (added[0]?.stats.bbox) fitTrack(added[0]);
      toast(`Imported ${added.length} file${added.length === 1 ? '' : 's'}${failed.length ? ` · ${failed.length} failed: ${failed.map((x) => `${x.name} (${x.error})`).join(', ')}` : ''}`, { ms: failed.length ? 8000 : 4000 });
      rerender();
    },
  });
  const out = [h('div', { class: 'card' },
    btn('Import GPX / KML files', () => input.click(), 'primary big'), input,
    toggleRow('These are TET / ACT files', app.markTet, (on) => { app.markTet = on; }),
    btn('Draw a road on the map', startDraw, 'big'),
    h('p', { class: 'note' }, 'For a road you know that no map has: tap along it on the imagery. It joins the network, so Plan and '
      + 'Investigate can use it.'),
    h('p', { class: 'note' }, 'Tracks stay on this phone. TET and ACT files are for your own use only: their terms forbid sharing them.'))];

  if (!app.tracks.length) out.push(h('p', { class: 'note' }, 'No tracks yet.'));
  for (const t of app.tracks) {
    const lines = trackLines(t).length;
    const kind = { import: 'imported', tet: 'TET / ACT', recording: 'my ride', drawn: 'my road', planned: 'plan' }[t.kind] ?? t.kind;
    out.push(h('div', { class: 'card track' },
      h('div', { class: 'row' },
        h('input', { type: 'checkbox', checked: t.visible, 'aria-label': 'Show on map', onchange: async (e) => { await updateTrack(t.id, { visible: e.target.checked }); await app.refreshTracks(); } }),
        h('i', { class: 'swatch', style: `background:${t.color}` }),
        h('span', { class: 'grow name' }, t.name),
        h('span', { class: 'badge' }, kind)),
      lines ? toggleRow('Use as a road in Plan & Investigate', !!t.network, async (on) => {
        await updateTrack(t.id, { network: on });
        await app.refreshTracks();
        app.graph = null;
      }) : null,
      h('div', { class: 'note' }, [
        lines ? fmtDist(t.stats.length) : null,
        t.stats.points ? `${t.stats.points} waypoints` : null,
        t.kind === 'recording' && t.ended ? `${new Date(t.created).toLocaleString()} · ${fmtDuration(t.ended - t.created)}` : null,
      ].filter(Boolean).join(' · ')),
      h('div', { class: 'row-btns' },
        t.stats.bbox ? btn('Show', () => { fitTrack(t); closePanel(); }) : null,
        t.plan?.built ? btn('Edit', () => { if (app.draw) endDraw(); startBuilder({ track: t }); }, 'primary') : null,
        lines ? btn('Profile', () => (t.kind === 'planned' ? editRoute(t.name, trackLines(t).flat(), t)
          : openProfile(t.name, trackLines(t).flat()))) : null,
        lines ? btn('Investigate', () => runInvestigation(t), t.plan?.built ? '' : 'primary') : null,
        lines ? btn('Save detail offline', () => { presetCorridor(t.id); openPanel('downloads'); }) : null,
        btn('GPX', async () => { const r = await shareGPX(t); if (r === 'downloaded') toast('GPX saved to Downloads'); }),
        btn('Rename', async () => {
          const name = prompt('Track name', t.name);
          if (name && name.trim()) { await updateTrack(t.id, { name: name.trim() }); await app.refreshTracks(); rerender(); }
        }),
        btn('Delete', async () => {
          if (!confirm(`Delete "${t.name}" from this phone?`)) return;
          await deleteTrack(t.id);
          await app.refreshTracks();
          if (t.network) app.graph = null;
          rerender();
        }, 'danger-text'),
      )));
  }
  return out;
}

// ---------------------------------------------------------------- Elevation profile of a track or a route

// A route's profile in edit mode: the route opens in "Make my own route" (its points, or points along its line)
// with the profile under the map. The generated routes leave the map meanwhile (back when the builder closes).
function editRoute(title, coords, track = null) {
  if (app.draw) endDraw();
  setPlan(app.map, { type: 'FeatureCollection', features: [] });
  startBuilder(track ? { track, line: track.plan?.built ? null : coords, profile: true } : { line: coords, title, profile: true });
}

async function openProfile(title, coords) {
  const p = { title, coords, profile: null, len: lineLength(coords) };
  app.prof = p;
  openPanel('profile');
  requestAnimationFrame(() => fitInView(app.map, coords));          // into the map above the sheet
  p.profile = (await elevationProfile(coords, elevationAt)) ?? false;
  if (app.prof === p && current === 'profile') rerender();
}

function renderProfile() {
  const p = app.prof;
  if (!p) return [h('p', { class: 'note' }, 'Open a track in Tracks and tap Profile.')];
  const out = [h('h3', {}, `${p.title} · ${fmtDist(p.len)}`)];
  if (p.profile === null) out.push(h('p', { class: 'note' }, 'Reading the elevation…'));
  else if (p.profile === false) out.push(h('p', { class: 'note' }, 'No elevation here: download "Elevation" in Offline maps, or go online.'));
  else out.push(...profileSection(app.map, p.profile));
  out.push(h('div', { class: 'row-btns' }, btn('Edit as my own route', () => editRoute(p.title, p.coords))),
    h('p', { class: 'note' }, 'Makes an editable copy that follows the mapped ways along this line (where it leaves them, the copy goes '
      + 'around); the original stays as it is.'));
  return out;
}

function fitTrack(t) {
  const b = t.stats.bbox;
  if (!b) return;
  if (b[0] === b[2] && b[1] === b[3]) app.map.easeTo({ center: [b[0], b[1]], zoom: 15 });
  else app.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 50, maxZoom: 16, duration: 600 });
}

// ---------------------------------------------------------------- Ride (GPS + recording)

function liveRide() {
  const f = gps.last;
  const rows = [];
  if (recorder.on) {
    const r = recorder.rec;
    const elapsed = Date.now() - r.started;
    rows.push(h('div', { class: 'stats' },
      stat('Time', fmtDuration(elapsed)), stat('Distance', fmtDist(r.dist)), stat('Speed', fmtSpeed(f?.speed)),
      stat('Max', fmtSpeed(r.maxSpeed)), stat('Moving', fmtDuration(r.moving * 1000)), stat('Climb', fmtElev(r.climb))));
  }
  rows.push(h('div', { class: 'stats' },
    stat('Accuracy', f ? `±${Math.round(f.acc)} m` : '–'),
    stat('GPS height', fmtElev(f?.alt)),
    stat('Map height', app.demElev != null ? fmtElev(app.demElev) : '–')));
  rows.push(h('div', { class: 'note' }, f ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)} · ${Math.round((Date.now() - f.t) / 1000)} s ago`
    : gps.on ? (gps.error ?? 'Waiting for the first fix… (slower in airplane mode)') : 'GPS is off.'));
  return rows;
}

const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, value), h('div', { class: 'stat-l' }, label));

function renderRecord() {
  return [
    h('div', { id: 'ride-live', class: 'card' }, ...liveRide()),
    recorder.on ? btn('Stop and save ride', stopRecording, 'danger big') : btn('Start recording', startRecording, 'primary big'),
    h('div', { class: 'row-btns' },
      gps.on ? btn('Turn GPS off', () => {
        if (recorder.on) { toast('Stop the recording first'); return; }
        gps.stop(); app.follow = false; app.me.hide(); updateStatus(); rerender();
      }) : btn('Turn GPS on', () => { locate(); rerender(); })),
    toggleRow('Keep screen on', settings.keepAwake, (on) => { settings.keepAwake = on; saveSettings(); wake.want('user', on); }),
    h('p', { class: 'note' }, wake.supported()
      ? 'Keep DirtScout on screen while riding: Android can pause the GPS when the screen is off or another app is in front. The screen stays on by itself while recording.'
      : 'This browser cannot keep the screen on: set a long screen timeout while riding.'),
  ];
}

async function startRecording() {
  await recorder.start();
  app.recLine = [];
  setRecLine(app.map, []);
  app.follow = true;
  toast('Recording. Keep the app on screen.');
  updateStatus();
  rerender();
}

async function stopRecording() {
  if (!confirm('Stop recording and save the ride?')) return;
  const rec = await recorder.stop();
  setRecLine(app.map, []);
  app.recLine = [];
  if (!rec) { toast('Nothing recorded (no GPS fixes)'); rerender(); return; }
  const d = new Date(rec.started);
  const name = `Ride ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const t = await saveRecording(rec, name);
  await app.refreshTracks();
  toast(`Saved "${name}" · ${fmtDist(rec.stats.dist)}`, { action: 'Export GPX', onAction: () => shareGPX(t) });
  updateStatus();
  rerender();
}

export function locate() {
  if (!gps.on) {
    gps.start();
    app.follow = true;
    if (!gps.last) toast('Looking for GPS… In airplane mode the first fix can take a minute.');
  } else {
    app.follow = !app.follow;
  }
  if (app.follow && gps.last) app.map.easeTo({ center: [gps.last.lon, gps.last.lat], zoom: Math.max(app.map.getZoom(), 15), duration: 500 });
  updateStatus();
}

// ---------------------------------------------------------------- More (settings, checks, about)

function areaEditor() {
  const a = [...settings.area];
  const inputs = ['West', 'South', 'East', 'North'].map((label, i) => h('label', { class: 'coord' }, h('span', {}, label),
    h('input', { type: 'number', step: 0.01, value: a[i], class: 'num', oninput: (e) => { a[i] = +e.target.value; } })));
  const size = bboxSizeKm(settings.area);
  const apply = (box) => {
    const [w, s, e, n] = box;
    if (!(w < e && s < n) || w < -180 || e > 180 || s < -85 || n > 85) { toast('Those numbers do not make a box'); return; }
    const km = bboxSizeKm(box);
    if (km.w * km.h > 40000) { toast('Keep the area under 200 x 200 km'); return; }
    settings.area = box.map((v) => +(+v).toFixed(5));
    saveSettings();
    setArea(app.map, settings.area);
    toast('Riding area updated');
    rerender();
  };
  return h('div', { class: 'card' },
    h('div', { class: 'note' }, `Now ${size.w.toFixed(0)} × ${size.h.toFixed(0)} km. Downloads and the area pack stay inside it.`),
    h('div', { class: 'coords' }, inputs),
    h('div', { class: 'row-btns' },
      btn('Apply', () => apply(a), 'primary'),
      btn('Use the screen', () => { const b = app.map.getBounds(); apply([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); }),
      btn('Reset', () => apply(defaultArea()))));
}

async function checkSources(box) {
  const [w, s, e, n] = settings.area;
  const lon = (w + e) / 2, lat = (s + n) / 2;
  const rows = [];
  for (const [id, src] of Object.entries(SOURCES)) {
    const z = src.kind === 'dem' ? 12 : 14;
    const x = Math.floor(lon2x(lon, z)), y = Math.floor(lat2y(lat, z));
    let cls = 'ok', msg;
    try {
      const t0 = performance.now();
      const r = await fetch(upstreamURL(id, z, x, y), { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      const buf = await r.arrayBuffer();
      const type = (r.headers.get('content-type') || '?').split(';')[0];
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) { cls = 'bad'; msg = `HTTP ${r.status}`; }
      else if (src.bing && type.includes('png')) { cls = 'warn'; msg = 'answers, but no imagery at the test spot'; }
      else {
        const date = r.headers.get('x-ve-tilemeta-capturedatemaxyymm');
        msg = `OK · ${type} · ${fmtBytes(buf.byteLength)} · ${ms} ms${date ? ` · imagery up to 20${date.slice(0, 2)}-${date.slice(2)}` : ''}`;
      }
    } catch (err) {
      cls = 'bad';
      msg = navigator.onLine ? `blocked (CORS or network): ${err.message}` : 'no network';
    }
    rows.push(h('div', { class: `row check ${cls}` }, h('span', { class: 'grow' }, src.name), h('span', {}, msg)));
    fill(box, ...rows);
  }
}

async function deviceChecks() {
  const out = [];
  const add = (label, ok, text) => out.push(h('div', { class: `row check ${ok ? 'ok' : 'warn'}` }, h('span', { class: 'grow' }, label), h('span', {}, text)));
  const standalone = matchMedia('(display-mode: standalone)').matches;
  add('Installed as an app', standalone, standalone ? 'yes' : 'no (open in Chrome: menu ⋮ → Install app)');
  add('Works offline (service worker)', !!navigator.serviceWorker?.controller, navigator.serviceWorker?.controller ? 'yes' : 'not yet (reload once)');
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  add('Storage protected', !!persisted, persisted ? 'yes' : 'no');
  add('Keep screen on', wake.supported(), wake.supported() ? 'supported' : 'not supported');
  let geo = 'unknown';
  try { geo = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* not supported */ }
  add('Location permission', geo === 'granted', geo);
  return out;
}

async function renderMore() {
  const checkBox = h('div', {});
  const out = [h('h3', {}, 'Riding area'), areaEditor(), h('h3', {}, 'Settings')];
  out.push(h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Units'),
    h('select', { onchange: (e) => { settings.units = e.target.value; saveSettings(); toast('Units changed (the scale bar updates after a reload)'); rerender(); } },
      h('option', { value: 'metric', selected: settings.units === 'metric' }, 'km, m'),
      h('option', { value: 'imperial', selected: settings.units === 'imperial' }, 'miles, ft'))));
  out.push(toggleRow('Offline mode (no network for maps)', settings.offlineOnly, (on) => {
    settings.offlineOnly = on; saveSettings(); applyLayers(app.map); updateStatus();
  }));
  out.push(toggleRow('Also save tiles I look at online', settings.saveBrowse, (on) => { settings.saveBrowse = on; saveSettings(); }));
  out.push(h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Parallel downloads'),
    h('select', { onchange: (e) => { settings.concurrency = +e.target.value; saveSettings(); } },
      [2, 3, 4, 5, 6].map((n) => h('option', { value: n, selected: settings.concurrency === n }, String(n))))));
  out.push(h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Microsoft imagery server'),
    h('select', { onchange: (e) => { settings.bingHost = e.target.value; saveSettings(); } },
      h('option', { value: 'tiles', selected: settings.bingHost === 'tiles' }, 'tiles.virtualearth.net'),
      h('option', { value: 'ecn', selected: settings.bingHost === 'ecn' }, 'ecn.t0-3.tiles.virtualearth.net'))));

  out.push(h('h3', {}, 'Checks'));
  out.push(btn('Check map sources', () => { fill(checkBox, h('p', { class: 'note' }, 'Checking…')); checkSources(checkBox); }, 'primary'));
  out.push(checkBox);
  out.push(...(await deviceChecks()));
  if (app.installPrompt) {
    out.push(btn('Install DirtScout on this phone', async () => {
      app.installPrompt.prompt();
      await app.installPrompt.userChoice.catch(() => null);
      app.installPrompt = null;
      rerender();
    }, 'primary big'));
  }

  out.push(h('h3', {}, 'About'));
  out.push(h('p', { class: 'note' }, `${APP_NAME} ${app.version}. Offline dirt-bike map for one riding area.`));
  out.push(h('p', { class: 'note' }, 'Microsoft (Bing) and Esri imagery: their terms do not allow caching; you chose to save them for personal use. Never share saved tiles.'));
  out.push(h('p', { class: 'note' }, 'OpenStreetMap, OpenTopoMap, CyclOSM, Waymarked Trails and the GPS-trace layer are online only: their volunteer servers do not allow offline download.'));
  out.push(h('div', { class: 'credits' }, Object.values(SOURCES).map((s) => h('div', { class: 'note' }, `${s.name}: ${s.attribution.replace(/<[^>]+>/g, '')}`))));
  return out;
}

// ---------------------------------------------------------------- wiring

export function initUI(appState) {
  app = appState;
  app.dlForm = { sources: ['ms-earth', 'dem'], areaType: 'bbox', trackId: null, buffer: 300, zmin: 10, zmax: 16 };
  if (app.debug) app.debug.ensureGraph = ensureGraph;          // for the e2e tests
  initBuilder({ app, ensureGraph, toast, openPanel, closePanel, rerender, current: () => current, refreshTracks: () => app.refreshTracks(),
    onClose: () => drawPlan() });
  const kept = settings.plan;
  app.plan = { startMode: kept.startMode ?? 'gps', start: kept.start ?? null, kmMin: kept.kmMin ?? 30, kmMax: kept.kmMax ?? 40,
    shape: 'loop', climbs: 1, minClimbGrade: 15, avoidRed: true, preferDirt: true, allowNoAccess: false, results: [], sel: 0,
    busy: false, seed: 1 };
  app.markTet = false;
  app.follow = false;
  app.recLine = [];

  for (const b of document.querySelectorAll('#toolbar [data-sheet]')) {
    b.addEventListener('click', () => (current === b.dataset.sheet ? closePanel() : openPanel(b.dataset.sheet)));
  }
  $('sheet-close').addEventListener('click', closePanel);
  $('draw-undo').addEventListener('click', undoDraw);
  $('draw-cancel').addEventListener('click', endDraw);
  $('draw-save').addEventListener('click', saveDraw);
  $('btn-locate').addEventListener('click', locate);
  $('btn-record').addEventListener('click', () => (current === 'record' ? closePanel() : openPanel('record')));
  $('st-gps').addEventListener('click', () => openPanel('record'));
  $('st-rec').addEventListener('click', () => openPanel('record'));
  $('st-dl').addEventListener('click', () => openPanel('downloads'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  app.map.on('click', onMapClick);
  app.map.on('dragstart', (e) => {
    if (e.originalEvent && app.follow) { app.follow = false; updateStatus(); }
  });

  let lastElev = 0;
  gps.addEventListener('fix', (e) => {
    const f = e.detail;
    app.me.update(f);
    if (app.follow) {
      const firstFix = !app.hadFix;
      app.map.easeTo({ center: [f.lon, f.lat], zoom: firstFix ? Math.max(app.map.getZoom(), 15) : app.map.getZoom(), duration: firstFix ? 600 : 300 });
    }
    if (!app.hadFix && $('toast').textContent.startsWith('Looking for GPS')) $('toast').hidden = true;
    app.hadFix = true;
    if (Date.now() - lastElev > 5000) {
      lastElev = Date.now();
      elevationAt(f.lon, f.lat).then((v) => { app.demElev = v; });
    }
    updateStatus();
    if (current === 'record') $('ride-live') && fill($('ride-live'), liveRide());
  });
  gps.addEventListener('gpserror', (e) => {
    updateStatus();
    if (e.detail === 'Location permission denied') toast('Location is blocked: allow it for this site in Chrome settings.', { ms: 8000 });
  });
  gps.addEventListener('state', updateStatus);

  recorder.addEventListener('point', (e) => {
    app.recLine.push(e.detail);
    setRecLine(app.map, app.recLine);
  });
  recorder.addEventListener('state', updateStatus);

  downloader.addEventListener('change', async (e) => {
    updateStatus();
    const j = e.detail;
    if (!j) {
      app.stats = await db.tileStats();
      const jobs = await downloader.jobs();
      const last = jobs.sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))[0];
      if (last?.finished && Date.now() - last.finished < 3000 && last.status.startsWith('done')) {
        toast(last.status === 'done' ? `Download finished: ${last.name}` : `Download finished with errors: ${last.name}`);
      }
      if (current === 'downloads' || current === 'layers') rerender();
      return;
    }
    if (current === 'downloads') $('dl-jobs') && fill($('dl-jobs'), await renderJobs());
  });

  const netChanged = () => {
    if (navigator.onLine && !packInstalled.area) reloadPack(app.map);
    applyLayers(app.map);
    updateStatus();
    if (current === 'layers') rerender();
  };
  window.addEventListener('online', netChanged);
  window.addEventListener('offline', netChanged);

  setInterval(() => {
    if (recorder.on) {
      updateStatus();
      if (current === 'record') $('ride-live') && fill($('ride-live'), liveRide());
    }
  }, 1000);

  updateStatus();
}
