// Riding a route (Navigate): the route on the map, the next turn, km and climb left, and a camera that follows the
// rider: north up, heading up (the arrow always points up), or 3D from behind and above, like a car navigator.
// Quick buttons on the sides: the layers (satellite, topo or plain; tracks, hillshade ...), Edit, the ride recording,
// the camera and zoom. Edit opens the route in the route builder with a blue dot where the rider is (drag a dot onto
// another track, or Avoid a stretch); Continue rides the new route. Away from the route the banner shows the way to
// its start (and opens a car navigator for the drive there); off the route, the way back. A reload carries on.
import { prepareRoute, locate, routeTurns, nextTurn, pointAt, bearingAt, sliceRoute, turnAngle, TURN_TEXT, climbIndex, climbLeft, roundDist } from '../../core/nav.js';
import { elevationProfile, steepSections } from '../../core/profile.js';
import { haversine, bearing } from '../../core/geo.js';
import { gps, recorder } from './gps.js';
import * as wake from './wakelock.js';
import { settings, saveSettings } from './settings.js';
import { elevationAt } from './tiles.js';
import { setNav, applyLayers, packUsable } from './mapview.js';
import { on3d } from './terrain3d.js';
import { DS_BASE } from './config.js';
import { h, fill, fmtDist, fmtElev, fmtSpeed } from './format.js';

const $ = (id) => document.getElementById(id);
const KEY = 'dirtscout.nav.v1';
const MODES = ['north', 'heading', 'follow'];
const MODE_NAMES = { north: 'North up', heading: 'Heading', follow: '3D' };
const ON = 35, OFF = 55;           // metres off the line: on the route / off it (plus half the GPS accuracy)
const IMAGERY = ['ms-earth', 'ms-hybrid', 'esri-imagery'];
const ZERO = { top: 0, bottom: 0, left: 0, right: 0 };
// {app, toast, ensureGraph, startBuilder, leaveBuilder, closePanel, startRecording, stopRecording, saveRoute, updateStatus, showPlan}
let ctx = null;
const N = () => ctx?.app.nav ?? null;
const map = () => ctx.app.map;

export function initNav(c) {
  ctx = c;
  $('nav-cam').addEventListener('click', () => setMode(MODES[(MODES.indexOf(N()?.mode) + 1) % MODES.length]));
  $('nav-zin').addEventListener('click', () => zoomBy(1));
  $('nav-zout').addEventListener('click', () => zoomBy(-1));
  $('nav-recenter').addEventListener('click', () => follow(true));
  $('nav-layers-btn').addEventListener('click', () => toggleLayers());
  $('nav-edit').addEventListener('click', edit);
  $('nav-rec-btn').addEventListener('click', toggleRec);
  $('nav-exit').addEventListener('click', end);
  gps.addEventListener('fix', (e) => onFix(e.detail));
  gps.addEventListener('gpserror', () => ui());
  recorder.addEventListener('state', () => ui());

  // fingers on the map: the camera waits; a pan of the map (not a pinch) stops following until Re-centre
  const el = map().getCanvasContainer();
  let fingers = 0;
  const touches = (e) => {
    fingers = e.touches.length;
    if (N()) N().gesture = fingers > 0;
  };
  el.addEventListener('touchstart', touches, { passive: true });
  el.addEventListener('touchend', touches, { passive: true });
  el.addEventListener('touchcancel', touches, { passive: true });
  let from = null;
  map().on('dragstart', (e) => { if (N() && e.originalEvent) from = map().project(N().pos ?? map().getCenter()); });
  map().on('dragend', (e) => {
    const nv = N();
    if (!nv || !e.originalEvent || !nv.pos || !from) return;
    const p = map().project(nv.pos);
    if (Math.hypot(p.x - from.x, p.y - from.y) > 60) follow(false);
    else camera(true);
    from = null;
  });
  map().on('zoomend', (e) => {
    const nv = N();
    if (!nv || !e.originalEvent) return;
    nv.zoom = map().getZoom();
    settings.nav.zoom = +nv.zoom.toFixed(2);
    saveSettings();
  });
  // the turn icons point the way on screen: they follow the map as it turns
  map().on('rotateend', () => { if (N()) ui(); });
}

// ---------------------------------------------------------------- start / end

/**
 * route: {coords, title, built (the route builder's points, when it has them), track (a saved track), trackId,
 * stats (a saved route's stats), unsaved (offer to save it at the end)}. saved: the state kept by the last session.
 */
export function startNav(route, saved = null) {
  if (!route?.coords || route.coords.length < 2) return;
  if (ctx.app.build && !ctx.leaveBuilder()) return;
  if (N()) stopNav();
  ctx.closePanel();
  const R = prepareRoute(route.coords);
  if (R.len < 10) { ctx.toast('This route has no length to ride.'); return; }
  const nv = {
    R, title: route.title ?? route.track?.name ?? 'Route', built: route.built ?? route.track?.plan?.built ?? null,
    trackId: route.track?.id ?? route.trackId ?? null, color: route.track?.color ?? null, stats: route.stats ?? null,
    unsaved: !!route.unsaved, edited: !!saved?.edited,
    joined: !!saved?.joined, along: saved?.along ?? 0, maxAlong: saved?.maxAlong ?? 0, state: saved?.joined ? 'on' : 'approach',
    done: false, d: null, q: null, pos: null, heading: null,
    turns: [], prof: null, up: null, steep: [],
    mode: MODES.includes(settings.nav.mode) ? settings.nav.mode : 'heading', zoom: settings.nav.zoom ?? 16.5,
    following: true, editing: false, gesture: false, layers: false,
    recByNav: !!saved?.recByNav, started: saved?.started ?? Date.now(),
  };
  ctx.app.nav = nv;
  ctx.app.follow = false;
  ctx.showPlan(false);
  document.body.classList.add('navigating');
  $('nav').hidden = false;
  wake.want('nav', true);
  mapMode(true);
  if (!gps.on) gps.start();
  persist();
  prepare(nv);
  if (gps.last && Date.now() - gps.last.t < 60000) onFix(gps.last);
  else {
    // no position yet: the whole route, between the banner and the bottom bar
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of R.coords) { w = Math.min(w, x); so = Math.min(so, y); e = Math.max(e, x); n = Math.max(n, y); }
    map().fitBounds([[w, so], [e, n]], { padding: { top: 130, bottom: 110, left: 86, right: 86 }, bearing: 0, pitch: 0, maxZoom: 16, duration: 600 });
    draw();
    ui();
  }
}

// After a reload: the route that was being ridden.
export function resumeNav() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* none */ }
  if (!s?.coords?.length) return false;
  startNav(s, s);
  ctx.toast(`Navigation continues: ${s.title}.`);
  return true;
}

// Ends the navigation (no questions; end() asks them).
export function stopNav() {
  const nv = N();
  if (!nv) return;
  ctx.app.nav = null;
  if (ctx.app.build?.nav) ctx.leaveBuilder(true);
  try { localStorage.removeItem(KEY); } catch { /* fine */ }
  document.body.classList.remove('navigating', 'nav-editing');
  $('nav').hidden = true;
  $('nav-layers').hidden = true;
  setNav(map(), null);
  ctx.app.me.setNav(null);
  wake.want('nav', false);
  mapMode(false);
  ctx.showPlan(true);
  ctx.updateStatus();
}

// The exit button: asks before ending, offers to keep a changed route, and to stop the recording it started.
async function end() {
  const nv = N();
  if (!nv) return;
  if (!nv.done && !confirm('End the navigation?')) return;
  if (nv.edited || nv.unsaved) {
    const q = nv.trackId && nv.edited ? `You changed "${nv.title}" while riding. Save the changes?` : 'Keep this route in Tracks?';
    if (confirm(q)) {
      const t = await ctx.saveRoute({ name: nv.title, coords: nv.R.coords, stats: nv.stats, built: nv.built, trackId: nv.edited ? nv.trackId : null,
        color: nv.color, ask: !nv.trackId });
      if (t) ctx.toast(`Saved "${t.name}" in Tracks.`);
    }
  }
  if (nv.recByNav && recorder.on) await ctx.stopRecording();
  stopNav();
}

function persist() {
  const nv = N();
  if (!nv) return;
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      coords: nv.R.coords.map(([x, y]) => [r6(x), r6(y)]), title: nv.title, built: nv.built, trackId: nv.trackId, stats: nv.stats,
      unsaved: nv.unsaved, edited: nv.edited, joined: nv.joined, along: Math.round(nv.along), maxAlong: Math.round(nv.maxAlong),
      recByNav: nv.recByNav, started: nv.started,
    }));
  } catch { /* storage full: the ride goes on without it */ }
}

// The turns (from the route network) and the elevation (climb left, steep stretches): read after the start.
async function prepare(nv) {
  const R = nv.R;
  try {
    const G = await ctx.ensureGraph();
    if (N() !== nv || nv.R !== R) return;
    nv.turns = routeTurns(R, G, ctx.app.graphIndex);
  } catch {
    nv.turns = routeTurns(R);                     // no route network here: only the turn-backs
  }
  draw();
  ui();
  const prof = await elevationProfile(R.coords, elevationAt).catch(() => null);
  if (N() !== nv || nv.R !== R || !prof) return;
  nv.prof = prof;
  nv.up = climbIndex(prof);
  nv.steep = steepSections(prof, settings.steepRed ?? 45);
  draw();
  ui();
}

// ---------------------------------------------------------------- the rider moves

function onFix(f) {
  const nv = N();
  if (!nv || !f) return;
  const R = nv.R, p = [f.lon, f.lat];
  nv.pos = p;
  const moving = f.speed != null && f.speed > 1.4 && Number.isFinite(f.heading);
  const slack = Math.min(f.acc ?? 10, 40) / 2;
  const prev = nv.joined ? nv.along : haversine(p, R.coords[0]) < 250 ? 0 : null;
  const loc = locate(R, p, { prev, heading: moving ? f.heading : null });
  nv.d = loc.d;
  nv.q = loc.q;
  if (!nv.joined) {
    if (loc.d <= ON + slack) join(nv, loc.along);
  } else if (nv.state === 'off') {
    if (loc.d <= ON + slack) { nv.state = 'on'; nv.along = loc.along; }
  } else if (loc.d > OFF + slack) {
    nv.state = 'off';
    navigator.vibrate?.([250, 120, 250]);
  } else nv.along = loc.along;
  if (nv.joined && nv.state === 'on') {
    nv.maxAlong = Math.max(nv.maxAlong, nv.along);
    if (!nv.done && nv.along >= R.len - 40 && nv.maxAlong > R.len * 0.6) {
      nv.done = true;
      navigator.vibrate?.([120, 80, 120, 80, 120]);
    }
  }
  // which way the arrow (and in heading and 3D modes the map) points: where the rider goes; standing still on the
  // route, the way the route goes on; otherwise as it was
  const hd = moving ? f.heading : nv.joined && nv.state === 'on' ? bearingAt(R, nv.along) : nv.heading;
  if (hd != null && (nv.heading == null || Math.abs(turnAngle(nv.heading, hd)) > 4)) nv.heading = hd;
  ctx.app.me.setNav(nv.heading ?? 0);
  if (!nv.editing) {
    draw();
    ui();
    camera();
  }
  if (Date.now() - (nv.saved ?? 0) > 10000) { nv.saved = Date.now(); persist(); }
}

function join(nv, along) {
  nv.joined = true;
  nv.state = 'on';
  nv.along = along;
  nv.maxAlong = along;
  persist();
  if (settings.nav.record !== false && !recorder.on) {
    nv.recByNav = true;
    ctx.startRecording();
  }
}

// ---------------------------------------------------------------- the map

function draw() {
  const nv = N();
  if (!nv || nv.editing) return;
  const R = nv.R, a = nv.joined ? nv.along : 0;
  const features = [];
  const line = (kind, c) => { if (c.length > 1) features.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: c } }); };
  const point = (kind, c) => features.push({ type: 'Feature', properties: { kind }, geometry: { type: 'Point', coordinates: c } });
  if (nv.joined) line('done', sliceRoute(R, 0, a));
  line('ahead', sliceRoute(R, a, R.len));
  for (const s of nv.steep) if (s.to > a) line('steep', sliceRoute(R, Math.max(a, s.from), s.to));
  if (nv.pos && (!nv.joined || nv.state === 'off')) line('link', [nv.pos, nv.joined ? nv.q : R.coords[0]]);
  const t = nv.joined ? nextTurn(nv.turns, a) : null;
  if (t) point('turn', t.at);
  if (!nv.joined) point('start', R.coords[0]);
  setNav(map(), { type: 'FeatureCollection', features });
}

// Map gestures while riding: zoom around the rider, no turning the map with two fingers (the camera turns it), tilt
// allowed for the 3D camera.
function mapMode(on) {
  const m = map();
  m.scrollZoom.disable();
  m.touchZoomRotate.disable();
  if (on) {
    m.setMaxPitch(70);
    m.scrollZoom.enable({ around: 'center' });
    m.touchZoomRotate.enable({ around: 'center' });
    m.touchZoomRotate.disableRotation();
  } else {
    m.scrollZoom.enable();
    m.touchZoomRotate.enable();
    m.touchZoomRotate.enableRotation();
    m.easeTo({ pitch: on3d() ? m.getPitch() : 0, bearing: on3d() ? m.getBearing() : 0, padding: ZERO, duration: 400 });
    m.once('moveend', () => { if (!N() && !on3d()) m.setMaxPitch(0); });
  }
}

// The camera on the rider: in heading and 3D modes the rider sits below the middle, with more of the way ahead.
function camera(quick = false) {
  const nv = N();
  if (!nv || !nv.following || nv.editing || !nv.pos || nv.gesture) return;
  const m = map();
  const H = m.getContainer().clientHeight;
  const top = Math.min(H * 0.4, $('nav-banner').getBoundingClientRect().bottom - m.getContainer().getBoundingClientRect().top + 8);
  const bottom = $('nav-bottom').offsetHeight;
  const free = Math.max(100, H - top - bottom);
  if (far(nv)) {
    const s = nv.R.coords[0];
    const box = [[Math.min(s[0], nv.pos[0]), Math.min(s[1], nv.pos[1])], [Math.max(s[0], nv.pos[0]), Math.max(s[1], nv.pos[1])]];
    const c = m.cameraForBounds(box, { padding: { top: top + 30, bottom: bottom + 40, left: 90, right: 90 }, bearing: 0 });
    if (c) m.easeTo({ center: c.center, zoom: Math.min(c.zoom, 16), bearing: 0, pitch: 0, padding: ZERO, duration: quick ? 500 : 1000, essential: true });
    return;
  }
  const lift = nv.mode === 'north' ? 0 : nv.mode === 'heading' ? 0.3 : 0.42;
  m.easeTo({
    center: nv.pos, zoom: nv.zoom, pitch: nv.mode === 'follow' ? 60 : 0,
    bearing: nv.mode === 'north' ? 0 : nv.heading ?? m.getBearing(),
    padding: { top: Math.round(top + free * lift), bottom, left: 0, right: 0 },
    duration: quick ? 500 : 1000, easing: (t) => t, essential: true,
  });
}

function follow(on) {
  const nv = N();
  if (!nv) return;
  nv.following = on;
  $('nav-recenter').hidden = on;
  if (on) camera(true);
}

function setMode(mode) {
  const nv = N();
  if (!nv) return;
  nv.mode = mode;
  settings.nav.mode = mode;
  saveSettings();
  // the 3D camera looks further: one step closer
  if (mode === 'follow' && nv.zoom < 16.5) nv.zoom = 16.5;
  ui();
  follow(true);
}

function zoomBy(dz) {
  const nv = N();
  if (!nv) return;
  nv.zoom = Math.min(19, Math.max(9, Math.round(nv.zoom + dz)));
  settings.nav.zoom = nv.zoom;
  saveSettings();
  if (nv.following && nv.pos) camera(true);
  else map().easeTo({ zoom: nv.zoom, duration: 300 });
}

// ---------------------------------------------------------------- the banner and the bottom bar

const SVG = 'http://www.w3.org/2000/svg';
function svg(paths, rot = 0) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const g = document.createElementNS(SVG, 'g');
  if (rot) g.setAttribute('transform', `rotate(${rot.toFixed(1)} 12 12)`);
  for (const [d, fillIt] of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fillIt ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', fillIt ? '0' : '2.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    g.append(p);
  }
  s.append(g);
  return s;
}

// A turn: the way in from below, the way out at `angle` (+ = right).
function turnIcon(angle, kind) {
  if (kind === 'uturn') return svg([['M15 21V10a4.5 4.5 0 0 0-9 0v6', false], ['M2.5 14.5 6 19.5l3.5-5Z', true]]);
  const a = angle * Math.PI / 180, L = 7.5;
  const x = 12 + L * Math.sin(a), y = 12 - L * Math.cos(a);
  // the arrow head: a triangle at the end of the way out, pointing along it
  const ux = Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
  const tip = [x + ux * 3.2, y + uy * 3.2], l = [x - px * 3.4, y - py * 3.4], r = [x + px * 3.4, y + py * 3.4];
  const f = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  return svg([[`M12 22V12L${f([x, y])}`, false], [`M${f(tip)}L${f(l)}L${f(r)}Z`, true]]);
}

// A straight arrow pointing `deg` on screen (the way to the start, or back to the route).
const pointer = (deg) => svg([['M12 21V6', false], ['M12 1.5 17.5 9h-11Z', true]], deg);
const flag = () => svg([['M6 22V3', false], ['M7 3h12l-3 4.5 3 4.5H7Z', true]]);

// Screen direction of a compass bearing: against the bearing the camera is turning the map to (it may be mid-turn).
function onScreen(deg) {
  const nv = N();
  const view = nv?.following && nv.pos && (nv.joined || !far(nv)) ? (nv.mode === 'north' ? 0 : nv.heading ?? map().getBearing()) : map().getBearing();
  return turnAngle(view, deg);
}

// Far from the start (not riding yet): the camera shows the rider and the start together.
const far = (nv) => !nv.joined && nv.pos && haversine(nv.pos, nv.R.coords[0]) > 600;

const gmaps = ([lon, lat]) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`;
const waze = ([lon, lat]) => `https://waze.com/ul?ll=${lat.toFixed(6)},${lon.toFixed(6)}&navigate=yes`;

function ui() {
  const nv = N();
  if (!nv) return;
  const R = nv.R;
  let icon, main, sub = '', note = null, extra = null, cls = '';
  if (!nv.pos) {
    icon = pointer(0);
    main = gps.error && gps.error !== 'Waiting for GPS…' ? gps.error : 'Finding GPS…';
    sub = `${fmtDist(R.len)} route${R.closed ? ' (a loop)' : ''}: keep the phone where it sees the sky`;
    cls = 'approach';
  } else if (!nv.joined) {
    const d = haversine(nv.pos, R.coords[0]);
    icon = pointer(onScreen(bearing(nv.pos, R.coords[0])));
    main = fmtDist(d);
    sub = 'to the start of the route (green dot)';
    cls = 'approach';
    if (d > 1000) {
      extra = h('div', { class: 'nav-drive' },
        h('a', { class: 'btn', href: gmaps(R.coords[0]), target: '_blank', rel: 'noopener' }, 'Drive: Google Maps'),
        h('a', { class: 'btn', href: waze(R.coords[0]), target: '_blank', rel: 'noopener' }, 'Waze'));
    }
  } else if (nv.done) {
    icon = flag();
    main = R.closed ? 'Back at the start' : 'You made it';
    sub = `${fmtDist(nv.maxAlong)} ridden`;
    cls = 'done';
    extra = h('div', { class: 'nav-drive' }, h('button', { class: 'btn', type: 'button', onclick: end }, 'End navigation'));
  } else if (nv.state === 'off') {
    icon = pointer(onScreen(bearing(nv.pos, nv.q)));
    main = fmtDist(nv.d);
    sub = 'off the route: the arrow points back to it. Edit takes another way.';
    cls = 'off';
  } else {
    const a = nv.along, t = nextTurn(nv.turns, a);
    if (t) {
      icon = turnIcon(t.angle, t.kind);
      main = fmtDist(roundDist(t.along - a));
      sub = TURN_TEXT[t.kind];
      const t2 = nextTurn(nv.turns, t.along);
      if (t2 && t2.along - t.along < 150) sub += `, then ${TURN_TEXT[t2.kind].toLowerCase()}`;
    } else {
      icon = flag();
      main = fmtDist(roundDist(R.len - a));
      sub = R.closed ? 'back to the start' : 'to the end';
    }
    const s = nv.steep.find((x) => x.to > a && x.from - a < 800);
    if (s) {
      const what = `Steep ${s.dir > 0 ? 'climb' : 'descent'} ${Math.round(s.max)} %`;
      note = s.from <= a ? `${what} now` : `${what} in ${fmtDist(roundDist(s.from - a))}`;
    }
  }
  const banner = $('nav-banner');
  banner.className = `nav-banner ${cls}`;
  fill(banner,
    h('div', { class: 'nav-icon' }, icon),
    h('div', { class: 'grow' },
      h('div', { class: 'nav-main' }, main),
      h('div', { class: 'nav-sub' }, sub),
      note ? h('div', { class: 'nav-note' }, note) : null,
      extra));
  // the bottom bar: what is left
  const a = nv.joined ? nv.along : 0;
  $('nav-togo').textContent = fmtDist(R.len - a);
  $('nav-meta').textContent = [
    nv.prof ? `↑ ${fmtElev(climbLeft(nv.prof, nv.up, a))} to climb` : null,
    gps.last?.speed != null ? fmtSpeed(gps.last.speed) : null,
  ].filter(Boolean).join(' · ');
  $('nav-rec').hidden = !recorder.on;
  $('nav-rec-btn').classList.toggle('on', recorder.on);
  $('nav-rec-btn').querySelector('span').textContent = recorder.on ? 'Rec on' : 'Record';
  const cam = $('nav-cam');
  cam.dataset.mode = nv.mode;
  cam.querySelector('span').textContent = MODE_NAMES[nv.mode];
  $('nav-recenter').hidden = nv.following;
  if (nv.layers) layersPanel();
}

// ---------------------------------------------------------------- quick buttons

function toggleLayers(on = !N()?.layers) {
  const nv = N();
  if (!nv) return;
  nv.layers = on;
  $('nav-layers').hidden = !on;
  $('nav-layers-btn').classList.toggle('on', on);
  if (on) layersPanel();
}

export const closeLayers = () => { if (N()?.layers) toggleLayers(false); };

// Big chips: the base (satellite, the DirtScout topo, or plain: no base, only what is switched on) and the overlays.
function layersPanel() {
  const ov = settings.overlays, base = settings.base;
  const topo = base === DS_BASE.id && packUsable();
  const apply = () => { saveSettings(); applyLayers(map()); layersPanel(); };
  const setBase = (b) => () => {
    if (IMAGERY.includes(settings.base)) settings.lastImagery = settings.base;
    settings.base = b;
    apply();
  };
  const chip = (label, on, onclick, disabled = false) =>
    h('button', { class: `chip${on ? ' on' : ''}`, type: 'button', onclick, disabled, 'aria-pressed': on ? 'true' : 'false' }, label);
  const overlay = (id, label, onTopo = false) => (id === 'ds-ai' && !ctx.app.ai?.meta ? null
    : chip(label, ov[id]?.on || (topo && onTopo), () => { ov[id].on = !ov[id].on; apply(); }, topo && onTopo));
  fill($('nav-layers'),
    h('div', { class: 'nav-layers-title' }, 'Map'),
    chip('Satellite', IMAGERY.includes(base), setBase(IMAGERY.includes(base) ? base : settings.lastImagery ?? 'ms-earth')),
    chip('Topo', base === DS_BASE.id, setBase(DS_BASE.id), !packUsable()),
    chip('Plain', base === 'none', setBase('none')),
    h('div', { class: 'nav-layers-title' }, 'On top'),
    overlay('ds-tracks', 'Tracks', true),
    overlay('ds-ai', 'AI tracks'),
    overlay('hillshade', 'Hillshade'),
    overlay('slope', 'Slope'),
    overlay('ds-contours', 'Contours', true),
    overlay('ds-places', 'Places', true),
    h('button', { class: 'chip close', type: 'button', onclick: () => toggleLayers(false) }, 'Done'));
}

async function toggleRec() {
  const nv = N();
  if (!nv) return;
  if (recorder.on) await ctx.stopRecording();
  else { await ctx.startRecording(); nv.recByNav = true; persist(); }
  ui();
}

// ---------------------------------------------------------------- edit on the spot

async function edit() {
  const nv = N();
  if (!nv || nv.editing) return;
  toggleLayers(false);
  nv.editing = true;
  nv.following = false;
  document.body.classList.add('nav-editing');
  setNav(map(), null);
  const onRoute = nv.joined && nv.state === 'on';
  const here = nv.joined && nv.pos ? { at: onRoute ? pointAt(nv.R, nv.along) : nv.pos, along: nv.along, onRoute } : null;
  map().easeTo({ center: here?.at ?? nv.pos ?? map().getCenter(), zoom: Math.min(Math.max(map().getZoom(), 14), 15.5), pitch: 0, bearing: 0,
    padding: ZERO, duration: 500 });
  await ctx.startBuilder({ line: nv.R.coords, built: nv.built, title: nv.title,
    nav: { here, onContinue: (res) => editDone(res), onCancel: () => editDone(null) } });
  if (N() === nv && nv.editing && !ctx.app.build) editDone(null);     // the builder could not open
}

function editDone(res) {
  const nv = N();
  if (!nv || !nv.editing) return;
  nv.editing = false;
  document.body.classList.remove('nav-editing');
  if (res) {
    nv.R = prepareRoute(res.coords);
    nv.built = res.built;
    if (res.changed) { nv.edited = true; nv.stats = res.stats; }
    nv.turns = [];
    nv.prof = null;
    nv.up = null;
    nv.steep = [];
    nv.done = false;
    if (nv.joined) {
      nv.along = res.hereAlong ?? (nv.pos ? locate(nv.R, nv.pos).along : 0);
      nv.maxAlong = nv.along;
      nv.state = 'on';
    }
    persist();
    prepare(nv);
    if (res.changed) ctx.toast('Riding the changed route.');
  }
  nv.following = true;
  $('nav-recenter').hidden = true;
  if (gps.last) onFix(gps.last);
  else { draw(); ui(); }
  camera(true);
}
