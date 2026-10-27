// The PC's 3D view, flown (desktop only; app/src/terrain3d.js has the terrain itself):
// - Fly (F): W/S forward and back, A/D sideways, Q/E down and up, drag the mouse or the arrow keys to look around, Shift
//   for five times the speed. The speed goes with the height, so skimming a valley and crossing the area both feel right.
//   The camera does not dive into the ground.
// - Orbit (O): the view turns slowly around the spot in the middle (Shift: faster).
// - Fly through a route: the camera rides a track or a plan ahead of a dot, with the km, the height and the grade; Space
//   plays and pauses, the arrows skip (Shift: further), speeds x1-x8, a bar to scrub, drag to look aside.
// - [ and ]: the relief lower or higher. Esc stops flying.
import { Marker } from 'maplibre-gl';
import { setNav } from './mapview.js';
import { on3d, set3d, setExaggeration } from './terrain3d.js';
import { settings } from './settings.js';
import { elevationAt } from './tiles.js';
import { prepareRoute, pointAt, sliceRoute, turnAngle } from '../../core/nav.js';
import { elevationProfile, gradeColor } from '../../core/profile.js';
import { bearing } from '../../core/geo.js';
import { h, fill, fmtDist, fmtElev } from './format.js';

const $ = (id) => document.getElementById(id);
const RAD = Math.PI / 180;
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);
const TOUR_SPEEDS = [1, 2, 4, 8];
const TOUR_MPS = 40;              // metres a second at x1 (x8: a 35 km loop in under 2 minutes)
let app = null;
let mode = null;                  // null | 'fly' | 'orbit' | 'tour'
let raf = 0, last = 0, hudAt = 0;
const keys = new Set();
const vel = { f: 0, s: 0, z: 0, b: 0, p: 0 };   // forward and sideways m/s, zoom/s, turn and tilt degrees/s (smoothed)
let tour = null;
let drag = null;

const map = () => app.map;
const fast = () => (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1);
const typing = (t) => t?.closest?.('input, textarea, select, [contenteditable="true"]');

export function initFly(a) {
  app = a;
  $('t3d-fly').addEventListener('click', () => toggleFly());
  $('t3d-orbit').addEventListener('click', () => setMode(mode === 'orbit' ? null : 'orbit'));
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());           // no key stuck down after switching windows
  // drag to look around (instead of moving the map)
  const el = map().getCanvasContainer();
  el.addEventListener('mousedown', (e) => {
    if (!mode || mode === 'orbit' || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    const m = map();
    if (mode === 'tour') tour.look += dx * 0.25;
    else m.setBearing(m.getBearing() + dx * 0.25);
    m.setPitch(Math.max(0, Math.min(85, m.getPitch() - dy * 0.2)));
  });
  window.addEventListener('mouseup', () => { drag = null; });
}

function onKey(e) {
  if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.body.classList.contains('navigating')) return;
  const code = e.code;
  if (code === 'KeyF') { toggleFly(); e.preventDefault(); return; }
  if (!on3d() && !mode) return;
  if (code === 'KeyO') { setMode(mode === 'orbit' ? null : 'orbit'); return; }
  if (code === 'BracketLeft' || code === 'BracketRight') {
    setExaggeration(settings.terrain3d.exag + (code === 'BracketRight' ? 0.5 : -0.5));
    return;
  }
  if (!mode) return;
  if (code === 'Escape') { setMode(null); return; }
  if (mode === 'tour') {
    if (code === 'Space') { tour.playing = !tour.playing; if (tour.s >= tour.R.len) tour.s = 0; tourHud(true); e.preventDefault(); return; }
    if (code === 'ArrowRight' || code === 'ArrowLeft') {
      skip((code === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 2000 : 500));
      e.preventDefault();
      return;
    }
  }
  if (KEYS.has(code)) {
    if (mode === 'orbit' && /^Key[WASDQE]$/.test(code)) setMode('fly');     // moving ends the orbit
    keys.add(code);
    e.preventDefault();
  }
}

function toggleFly() {
  if (mode === 'fly') { setMode(null); return; }
  if (!on3d()) set3d(true);
  setMode('fly');
}

// The map's own mouse and keys step aside while flying (dragging looks around, the wheel zooms at the middle).
function grab(on) {
  const m = map();
  m.scrollZoom.disable();
  if (on) {
    m.dragPan.disable();
    m.dragRotate.disable();
    m.keyboard.disable();
    m.scrollZoom.enable({ around: 'center' });
  } else {
    m.dragPan.enable();
    m.dragRotate.enable();
    m.keyboard.enable();
    m.scrollZoom.enable();
  }
}

function setMode(next) {
  if (next === mode) return;
  if (mode === 'tour' && next !== 'tour') endTour();
  mode = next;
  keys.clear();
  Object.assign(vel, { f: 0, s: 0, z: 0, b: 0, p: 0 });
  grab(!!mode && mode !== 'orbit');
  document.activeElement?.blur?.();                               // Space must not press the last button clicked
  $('t3d-fly')?.classList.toggle('on', mode === 'fly');
  $('t3d-orbit')?.classList.toggle('on', mode === 'orbit');
  $('fly-hud').hidden = mode !== 'fly' && mode !== 'orbit';
  document.body.classList.toggle('touring', mode === 'tour');     // the 3D panel steps aside for the tour's bar
  if (mode === 'fly' && map().getPitch() < 45) map().easeTo({ pitch: 70, duration: 600 });
  last = 0;
  if (mode && !raf) raf = requestAnimationFrame(frame);
  hud(true);
}

export const flying = () => mode;
// for the e2e tests
export const flyState = () => ({ mode, keys: [...keys], vel: { ...vel }, tour: tour && { s: tour.s, playing: tour.playing, speed: tour.speed, len: tour.R.len } });

// ---------------------------------------------------------------- the frame loop

function frame(t) {
  raf = 0;
  if (mode && !on3d()) setMode(null);                            // Flat map: flying ends
  if (!mode) return;
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
  last = t;
  const m = map();
  if (mode === 'fly') fly(m, dt);
  else if (mode === 'orbit') m.setBearing(m.getBearing() + 8 * fast() * dt);
  else if (mode === 'tour') tourFrame(m, dt);
  if (mode === 'fly' || mode === 'tour') keepAboveGround(m);
  if (t - hudAt > 250) { hudAt = t; if (mode === 'tour') tourHud(); else hud(); }
  raf = requestAnimationFrame(frame);
}

function fly(m, dt) {
  const k = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
  const c = m.getCenter(), z = m.getZoom(), H = m.getContainer().clientHeight;
  const mpp = (40075016.686 * Math.cos(c.lat * RAD)) / (512 * 2 ** z);       // metres per screen pixel at the middle
  const speed = mpp * H * 0.6 * fast();                                       // 60 % of the screen's height a second
  const target = { f: k('KeyW', 'KeyS') * speed, s: k('KeyD', 'KeyA') * speed, z: k('KeyQ', 'KeyE') * (fast() > 1 ? 2.2 : 0.9),
    b: k('ArrowRight', 'ArrowLeft') * 70, p: k('ArrowUp', 'ArrowDown') * 35 };
  const a = 1 - Math.exp(-dt * 7);                                            // eases in and out
  for (const key of Object.keys(vel)) vel[key] += (target[key] - vel[key]) * a;
  if (Object.values(vel).every((v) => Math.abs(v) < 1e-3)) return;
  const br = m.getBearing() * RAD;
  const east = (Math.sin(br) * vel.f + Math.cos(br) * vel.s) * dt, north = (Math.cos(br) * vel.f - Math.sin(br) * vel.s) * dt;
  m.jumpTo({
    center: [c.lng + east / (111320 * Math.cos(c.lat * RAD)), Math.max(-85, Math.min(85, c.lat + north / 110540))],
    zoom: Math.max(3, Math.min(19, z + vel.z * dt)),
    bearing: m.getBearing() + vel.b * dt,
    pitch: Math.max(0, Math.min(85, m.getPitch() + vel.p * dt)),
  });
}

// The camera stays at least 40 m (in the raised relief) above the ground under it: too low, it rises a little.
function keepAboveGround(m) {
  const T = m.transform ?? m._camera?.transform;               // MapLibre 6 keeps it on its camera
  if (!on3d() || !T?.getCameraAltitude || !T.getCameraLngLat) return;
  const ground = m.queryTerrainElevation(T.getCameraLngLat());
  if (ground == null) return;
  const gap = T.getCameraAltitude() - ground;
  if (gap < 40) m.setZoom(m.getZoom() - Math.min(0.3, 0.02 + (40 - gap) / 400));
}

// The line at the top while flying: the keys, the ground under the middle, the heading.
function hud(force = false) {
  const el = $('fly-hud');
  if (el.hidden && !force) return;
  const m = map();
  const g = m.queryTerrainElevation?.(m.getCenter());
  const real = g != null ? g / (settings.terrain3d.exag || 1) : null;
  const head = Math.round((m.getBearing() + 360) % 360);
  fill(el,
    h('strong', {}, mode === 'orbit' ? 'Orbiting' : 'Flying'),
    h('span', {}, mode === 'orbit' ? 'O or Esc: stop · Shift: faster · W A S D: fly'
      : 'W S forward/back · A D sideways · Q E down/up · drag or arrows: look · Shift: ×5 · Esc: stop'),
    h('span', { class: 'fly-num' }, `${real != null ? `ground ${fmtElev(real)} · ` : ''}heading ${head}°${fast() > 1 ? ' · ×5' : ''}`));
}

// ---------------------------------------------------------------- fly through a route

/** The camera rides a route: {coords, title}. */
export async function startTour({ coords, title }) {
  if (!coords || coords.length < 2 || document.body.classList.contains('navigating')) return;
  if (!on3d()) set3d(true, false);
  const R = prepareRoute(coords);
  if (R.len < 20) return;
  if (mode) setMode(null);
  const el = document.createElement('div');
  el.className = 'map-cursor';
  el.innerHTML = '<div class="map-cursor-dot"></div>';
  tour = { R, title, s: 0, playing: true, speed: settings.tourSpeed ?? 2, look: 0, bear: bearing(pointAt(R, 0), pointAt(R, 250)),
    prof: null, marker: new Marker({ element: el }).setLngLat(R.coords[0]).addTo(map()), drawn: 0 };
  map().jumpTo({ center: R.coords[0], zoom: 15, pitch: 65, bearing: tour.bear });
  $('tour').hidden = false;
  setMode('tour');
  tourHud(true);
  const t = tour;
  const prof = await elevationProfile(R.coords, elevationAt).catch(() => null);
  if (tour === t) t.prof = prof;
}

function tourFrame(m, dt) {
  const T = tour, R = T.R;
  if (T.playing) {
    T.s = Math.min(R.len, T.s + TOUR_MPS * T.speed * fast() * dt);
    if (T.s >= R.len) { T.playing = false; tourHud(true); }
  }
  const P = pointAt(R, T.s);
  // the way ahead, 250 m on: the camera turns towards it smoothly
  const ahead = bearing(P, pointAt(R, Math.min(R.len, T.s + 250)));
  if (T.s < R.len - 5) T.bear += turnAngle(T.bear, ahead) * (1 - Math.exp(-dt * 1.4));
  const k = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
  const z = m.getZoom() + k('KeyQ', 'KeyE') * 0.9 * dt;
  const pitch = Math.max(0, Math.min(85, m.getPitch() + k('ArrowUp', 'ArrowDown') * 35 * dt));
  m.jumpTo({ center: P, bearing: T.bear + T.look, zoom: Math.max(10, Math.min(18, z)), pitch });
  T.marker.setLngLat(P);
  if (performance.now() - T.drawn > 150) {
    T.drawn = performance.now();
    const line = (kind, c) => ({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: c } });
    setNav(m, { type: 'FeatureCollection', features: [line('done', sliceRoute(R, 0, T.s)), line('ahead', sliceRoute(R, T.s, R.len))]
      .filter((f) => f.geometry.coordinates.length > 1) });
  }
}

function skip(d) {
  tour.s = Math.max(0, Math.min(tour.R.len, tour.s + d));
  tourHud(true);
}

function endTour() {
  tour?.marker.remove();
  setNav(map(), null);
  tour = null;
  $('tour').hidden = true;
}

// The bar at the bottom while flying through: where on the route, the height and grade there, play, speed, scrub.
function tourHud(full = false) {
  const T = tour;
  if (!T) return;
  let elev = null, grade = null;
  if (T.prof) {
    const d = T.prof.dist;
    let lo = 0, hi = d.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (d[mid] <= T.s) lo = mid; else hi = mid; }
    elev = T.prof.elev[lo];
    grade = T.prof.grade[lo];
  }
  const where = `${fmtDist(T.s)} of ${fmtDist(T.R.len)}`;
  if (!full && $('tour-where')) {
    $('tour-where').textContent = where;
    $('tour-num').textContent = elev != null ? fmtElev(elev) : '';
    const g = $('tour-grade');
    g.textContent = grade != null ? `${grade > 0 ? '+' : ''}${Math.round(grade)} %` : '';
    g.style.background = grade != null ? gradeColor(grade, settings.steepRed ?? 45) : 'transparent';
    $('tour-bar').value = T.s;
    return;
  }
  const b = (label, onclick, cls = '') => h('button', { class: `btn small ${cls}`, type: 'button', onclick: (e) => { e.currentTarget.blur(); onclick(); } }, label);
  fill($('tour'),
    h('div', { class: 'tour-head' },
      h('strong', { class: 'grow' }, T.title ?? 'Route'),
      h('span', { id: 'tour-where' }, where),
      h('span', { id: 'tour-num' }, elev != null ? fmtElev(elev) : ''),
      h('span', { id: 'tour-grade', class: 'tour-grade' }, '')),
    h('input', { type: 'range', id: 'tour-bar', min: 0, max: Math.round(T.R.len), step: 10, value: Math.round(T.s), 'aria-label': 'Where on the route',
      oninput: (e) => { T.s = +e.target.value; }, onchange: (e) => e.target.blur() }),
    h('div', { class: 'tour-btns' },
      b('⏮', () => skip(-T.s)),
      b(T.playing ? 'Pause' : T.s >= T.R.len ? 'Again' : 'Play', () => { if (T.s >= T.R.len) T.s = 0; T.playing = !T.playing; tourHud(true); }, 'primary'),
      ...TOUR_SPEEDS.map((x) => b(`×${x}`, () => { T.speed = x; settings.tourSpeed = x; tourHud(true); }, T.speed === x ? 'on' : '')),
      b('Stop', () => setMode(null))),
    h('div', { class: 'note' }, 'Space: play / pause · ← →: skip 500 m (Shift: 2 km) · Q E or the wheel: closer / higher · drag: look aside · Shift: ×5 · Esc: stop'));
  tourHud();
}
