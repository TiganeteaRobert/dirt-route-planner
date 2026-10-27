// Make my own route (Plan): numbered points tapped on the map, each held on the nearest way of the routing graph;
// between two points the route follows the network (core/builder.js). Drag a point to move it (the route follows
// while it moves), tap the line between two points to add one there, tap a point for its menu (remove it; on point 1:
// back to the start, closing the loop). The bar shows length and climb; Profile opens the stats and the elevation
// chart, and the route stays editable under it (the steep stretches red on the map, the chart updating in place).
// Routes saved from here keep their points; a generated or saved route without them gets points along its line.
// Opening a route's profile from Plan or Tracks starts here, with the profile open.
// Avoid: tap a stretch and the route goes around it (the stretch costs 50 times more, so it is ridden only when there
// is no other way); saved with the route. While riding (app/src/nav.js), Edit opens the route here with a blue dot where
// the rider is, and Continue rides the new route from that dot.
import { Marker, Popup } from 'maplibre-gl';
import { traceCost, withAvoid, snapToNetwork, snapToPieces, leg, pieceCoords, piecesCoords, piecesStats, sumStats, pointsForLine } from '../../core/builder.js';
import { haversine } from '../../core/routing.js';
import { elevationProfile, steepSections } from '../../core/profile.js';
import { setBuild, setCursor, setSteep } from './mapview.js';
import { elevationAt } from './tiles.js';
import { savePlanned, shareGPX } from './tracks.js';
import { h, fmtDist, fmtElev } from './format.js';
import { profileSection, fitInView } from './profileview.js';

const $ = (id) => document.getElementById(id);
const SNAP_PX = 44;              // a tap holds on to the nearest way within this many screen pixels (25 m at least)
const COLOR = '#ff6d00';
let ctx = null;                  // {app, ensureGraph, toast, openPanel, closePanel, rerender, current, refreshTracks, onClose, navigate, send, tour}
const B = () => ctx?.app.build ?? null;

export function initBuilder(c) {
  ctx = c;
  $('build-undo').addEventListener('click', undo);
  $('build-loop').addEventListener('click', () => toggleLoop());
  $('build-avoid').addEventListener('click', () => avoidMode());
  $('build-stats').addEventListener('click', openRoutePanel);
  $('build-save').addEventListener('click', () => (B()?.nav ? navContinue() : save()));
  $('build-exit').addEventListener('click', () => leave());
}

const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, type: 'button', onclick }, label);

// ---------------------------------------------------------------- state

// legs[i] joins point i to point i + 1, and - when the loop is closed - the last point to the first.
const legCount = (b) => (b.pts.length < 2 ? 0 : b.closed ? b.pts.length : b.pts.length - 1);
const key = (s) => `${s.e}:${s.t.toFixed(6)}`;

function legFor(b, A, Z) {
  const k = `${key(A)}>${key(Z)}`;
  let r = b.cache.get(k);
  if (!r) {
    const pieces = leg(b.G, A, Z, b.cost);
    r = { pieces, coords: piecesCoords(ctx.app.graphIndex, pieces), stats: piecesStats(b.G, pieces) };
    if (b.cache.size > 600) b.cache.clear();
    b.cache.set(k, r);
  }
  return r;
}

const legOf = (b, i) => legFor(b, b.pts[i].s, b.pts[(i + 1) % b.pts.length].s);

const computeLegs = (b) => { b.legs = Array.from({ length: legCount(b) }, (_, i) => legOf(b, i)); };

// The whole route's line.
export function routeLine(b = B()) {
  const out = [];
  for (const l of b.legs) for (let i = out.length ? 1 : 0; i < l.coords.length; i++) out.push(l.coords[i]);
  if (!out.length && b.pts.length) out.push([b.pts[0].s.lon, b.pts[0].s.lat]);
  return out;
}

export const routeStats = (b = B()) => sumStats(b.legs.map((l) => l.stats));

const snapshot = (b) => ({ G: b.G, closed: b.closed, pts: b.pts.map((p) => ({ s: { ...p.s }, here: p.here })), avoidAt: new Map(b.avoidAt) });

// The way the builder joins two points, with the avoided stretches 50 times dearer (taken only when nothing else goes).
// b.avoidAt is read live: marking a stretch only needs the legs' cache cleared.
const makeCost = (b) => withAvoid(traceCost(b.G), { has: (e) => b.avoidAt.has(e) });

// Avoided stretches are kept as places (edge ids change with the area pack): hold them on to the network again.
function snapAvoid(b, places) {
  b.avoidAt = new Map();
  for (const [lon, lat] of places) {
    const s = snapToNetwork(b.G, ctx.app.graphIndex, lon, lat, 15);
    if (s) b.avoidAt.set(s.e, [lon, lat]);
  }
}

// The nearest way to a place, within SNAP_PX on screen.
function snapAt(b, lon, lat) {
  const map = ctx.app.map;
  const p = map.project([lon, lat]), q = map.unproject([p.x + SNAP_PX, p.y]);
  const r = Math.min(1500, Math.max(25, haversine(lon, lat, q.lng, q.lat)));
  return snapToNetwork(b.G, ctx.app.graphIndex, lon, lat, r);
}

// The routing graph can change under the builder (AI switch, sensitivity, a road of yours): hold the points again.
async function ready(b) {
  const G = await ctx.ensureGraph();
  if (G === b.G) return;
  b.G = G;
  snapAvoid(b, [...b.avoidAt.values()]);
  b.cost = makeCost(b);
  b.cache.clear();
  const n = b.pts.length;
  b.pts = b.pts.map((p) => ({ s: snapToNetwork(G, ctx.app.graphIndex, p.s.lon, p.s.lat, 500), here: p.here })).filter((p) => p.s);
  b.undo = [];
  if (b.pts.length < n) ctx.toast(`${n - b.pts.length} point${n - b.pts.length === 1 ? ' was' : 's were'} on a track that is no longer shown: removed.`);
  if (b.pts.length < 2) b.closed = false;
  computeLegs(b);
  draw();
}

// ---------------------------------------------------------------- start / leave

export const builderActive = () => !!B();

// While a panel with the elevation chart is open the bar steps aside (the map above the sheet is all there is).
export function panelShown(name) {
  if (B()) $('buildbar').hidden = name === 'route' || name === 'profile';
}

/**
 * opts: track (a saved route: its own points, else points along `line`, its line), line + title (a route that is not
 * saved yet, e.g. a generated one), built ({pts, closed, avoid}: the points of a route made here, when there is no
 * track), profile (open the profile right away: edit while you look at the elevation), nav (editing while riding:
 * {here: {at [lon, lat], along (m along `line`), onRoute}, onContinue(result), onCancel()}).
 * With no options: a new route, tapped from scratch.
 */
export async function startBuilder({ track = null, line = null, title = null, profile = false, built = null, nav = null } = {}) {
  if (B() && !track && !line) { ctx.closePanel(); return; }   // already building: back to the map
  if (B()) { leave(); if (B()) return; }                      // another route: leave the current one first
  ctx.closePanel();
  let G;
  try {
    G = await ctx.ensureGraph();
  } catch (e) {
    ctx.toast(`Cannot build a route: ${e.message}`, { ms: 7000 });
    return;
  }
  const b = { G, cost: null, cache: new Map(), pts: [], legs: [], closed: false, undo: [], markers: [], menu: null,
    track, title, dirty: false, profile: null, shown: null, profSeq: 0, before: null, avoidAt: new Map(), avoiding: false, nav };
  const kept = track?.plan?.built ?? built;
  snapAvoid(b, kept?.avoid ?? []);
  b.cost = makeCost(b);
  ctx.app.build = b;
  $('buildbar').hidden = false;
  if (kept) {
    for (const [lon, lat] of kept.pts) {
      const s = snapToNetwork(G, ctx.app.graphIndex, lon, lat, 200);
      if (s) b.pts.push({ s });
    }
    b.closed = !!kept.closed && b.pts.length >= 2;
  } else if (line) {
    // points along the line, as many as it takes for the builder to ride the same way
    bar('Getting the route ready to edit…');
    await new Promise((r) => setTimeout(r, 30));
    const r = pointsForLine(G, ctx.app.graphIndex, line, (A, Z) => legFor(b, A, Z));
    if (B() !== b) return;
    if (!r) {
      ctx.toast('This line is not on the route network here, so it cannot be edited.', { ms: 6000 });
      close();
      return;
    }
    b.pts = r.pts.map((s) => ({ s }));
    b.closed = r.closed;
  }
  computeLegs(b);
  if (nav?.here && b.legs.length) {
    insertHere(b, nav.here);
    computeLegs(b);
  }
  draw();
  if (b.pts.length > 1) {
    scheduleProfile();
    if (profile) openRoutePanel();
    else if (!nav) fit(routeLine(b));
  }
  const name = track?.name ?? title;
  ctx.toast(nav ? 'The blue dot is where you are. Drag a dot onto another track, tap the line to add a dot, or tap Avoid and then '
    + 'a stretch: the route goes around it. Continue rides the new route.'
    : name ? `Editing "${name}": drag a dot to take another way, tap the line to add one, tap a dot for its menu.`
    + `${profile ? ' Steep stretches are red on the map.' : ''}`
    : 'Tap where the route starts, then where it goes: each tap holds on to the nearest track and the route follows the tracks between your points.',
  { ms: nav ? 9000 : 7000 });
}

// While riding: a point where the rider is, on the leg they are riding (by the distance along the route), or - off the
// route - on the nearest way, between the points before and after them.
function insertHere(b, here) {
  let acc = 0, li = b.legs.length - 1;
  for (let i = 0; i < b.legs.length; i++) {
    acc += b.legs[i].stats.len;
    if (acc >= here.along) { li = i; break; }
  }
  let s = here.onRoute ? snapToPieces(ctx.app.graphIndex, b.legs[li].pieces, here.at[0], here.at[1]) : null;
  if (!s || s.d > 60) s = snapToNetwork(b.G, ctx.app.graphIndex, here.at[0], here.at[1], 150);
  if (!s) return;
  const on = b.pts.find((p) => haversine(p.s.lon, p.s.lat, s.lon, s.lat) < 3);
  if (on) on.here = true;
  else b.pts.splice(li + 1, 0, { s, here: true });
}

// The profile under the map: the route fitted into the map above it, every dot still draggable.
function openRoutePanel() {
  const b = B();
  if (!b) return;
  closeMenu();
  ctx.openPanel('route');
  requestAnimationFrame(() => fitInView(ctx.app.map, routeLine(b)));
}

function close() {
  const b = B();
  if (!b) return;
  for (const m of b.markers) m.remove();
  b.menu?.remove();
  setBuild(ctx.app.map, null);
  setCursor(ctx.app.map, null);
  setSteep(ctx.app.map, null);
  $('buildbar').hidden = true;
  ctx.app.build = null;
  if (ctx.current() === 'route') ctx.closePanel();
  ctx.onClose?.();
}

// Leave the builder (asks first when there are unsaved changes). While riding: back to the route as it was.
export function leave(force = false) {
  const b = B();
  if (!b) return;
  if (b.nav) {
    if (!force && b.dirty && !confirm('Drop the changes and ride on with the route as it was?')) return;
    close();
    b.nav.onCancel?.();
    return;
  }
  if (!force && b.dirty && b.pts.length > 1 && !confirm('Leave without saving this route?')) return;
  close();
}

// While riding: ride the changed route (from the blue dot).
async function navContinue() {
  const b = B();
  if (!b?.nav || b.pts.length < 2) return;
  const res = await summary(b);
  if (B() !== b) return;
  const hi = b.pts.findIndex((p) => p.here);
  res.hereAlong = hi > 0 ? b.legs.slice(0, hi).reduce((m, l) => m + l.stats.len, 0) : null;
  res.changed = b.dirty;
  close();
  b.nav.onContinue(res);
}

// Ride the route on screen (Navigate).
async function rideIt() {
  const b = B();
  if (!b || b.pts.length < 2 || !ctx.navigate) return;
  const res = await summary(b);
  if (B() !== b) return;
  close();
  ctx.navigate({ coords: res.coords, title: b.track?.name ?? b.title ?? 'My route', built: res.built,
    track: b.dirty ? null : b.track, stats: res.stats, unsaved: b.dirty || !b.track });
}

function fit(coords) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
  if (w === e && s === n) return;
  ctx.app.map.fitBounds([[w, s], [e, n]], { padding: { top: 140, bottom: 60, left: 40, right: 70 }, maxZoom: 16, duration: 500 });
}

// ---------------------------------------------------------------- drawing

function draw() {
  drawLines();
  syncMarkers();
  bar();
}

function drawLines() {
  const b = B();
  const X = ctx.app.graphIndex, GAP = b.G.classes.indexOf('gap');
  const features = [];
  b.legs.forEach((l, i) => {
    let run = [], kind = null;
    const flush = () => {
      if (run.length > 1) features.push({ type: 'Feature', properties: { kind, leg: i }, geometry: { type: 'LineString', coordinates: run } });
      run = [];
    };
    for (const p of l.pieces) {
      const k = p.straight ? 'off' : 'way';
      const c = pieceCoords(X, p);
      if (k !== kind) { flush(); kind = k; run = c.slice(); } else run.push(...c.slice(1));
      if (!p.straight && b.G.e.cls[p.e] === GAP) {
        features.push({ type: 'Feature', properties: { kind: 'gap', leg: i }, geometry: { type: 'LineString', coordinates: c } });
      }
    }
    flush();
  });
  for (const e of b.avoidAt.keys()) {
    features.push({ type: 'Feature', properties: { kind: 'blocked' }, geometry: { type: 'LineString', coordinates: X.coords[e] } });
  }
  setBuild(ctx.app.map, { type: 'FeatureCollection', features });
}

function makeMarker(at) {
  const el = h('div', { class: 'rb-pt', role: 'button', 'aria-label': 'Route point' }, h('b', {}, ''));
  const m = new Marker({ element: el, draggable: true }).setLngLat(at).addTo(ctx.app.map);
  let moved = false;
  el.addEventListener('pointerdown', () => { moved = false; });
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (moved) return;                                  // the end of a drag, not a tap
    openMenu(+el.dataset.i);
  });
  m.on('dragstart', () => { moved = true; el.classList.add('drag'); dragStart(); });
  m.on('drag', () => dragMove(+el.dataset.i, m.getLngLat()));
  m.on('dragend', () => { el.classList.remove('drag'); dragEnd(+el.dataset.i, m.getLngLat()); });
  return m;
}

function syncMarkers() {
  const b = B();
  while (b.markers.length > b.pts.length) b.markers.pop().remove();
  while (b.markers.length < b.pts.length) {
    const p = b.pts[b.markers.length].s;
    b.markers.push(makeMarker([p.lon, p.lat]));
  }
  b.pts.forEach((p, i) => {
    const m = b.markers[i], el = m.getElement();
    m.setLngLat([p.s.lon, p.s.lat]);
    el.dataset.i = i;
    el.firstChild.textContent = String(i + 1);
    el.classList.toggle('start', i === 0);
    el.classList.toggle('here', !!p.here);
    el.classList.toggle('small', b.pts.length > 12);                 // many dots (a long route): smaller ones
    el.setAttribute('aria-label', p.here ? `Route point ${i + 1}: where you are` : `Route point ${i + 1}`);
  });
}

function bar(msg = null) {
  const b = B();
  if (!b) return;
  const n = b.pts.length;
  let text;
  if (msg) text = msg;
  else if (b.avoiding) text = 'Tap the stretch to avoid (tap a red one to ride it again)';
  else if (!n) text = 'Tap the map where the route starts';
  else if (n === 1) text = 'Point 1 set: tap where the route goes next';
  else {
    const st = routeStats(b);
    text = `${n} points · ${fmtDist(st.len)}${b.profile ? ` · ↑ ${fmtElev(b.profile.up)}` : ''}${b.closed ? ' · loop' : ''}`
      + `${st.offs ? ` · ${fmtDist(st.off)} with no track` : ''}`;
  }
  $('buildbar-text').textContent = text;
  $('build-undo').disabled = !b.undo.length;
  $('build-loop').disabled = n < 2;
  $('build-loop').textContent = b.closed ? 'Open' : 'Loop';
  $('build-loop').hidden = !!b.nav;                                // riding: Avoid in its place
  $('build-avoid').hidden = !b.nav && !b.avoiding;
  $('build-avoid').classList.toggle('on', b.avoiding);
  $('build-avoid').disabled = n < 2;
  $('build-stats').disabled = n < 2;
  $('build-save').disabled = n < 2;
  $('build-save').textContent = b.nav ? 'Continue' : 'Save';
}

// ---------------------------------------------------------------- edits

function changed(b) {
  b.dirty = true;
  computeLegs(b);
  draw();
  scheduleProfile();
  if (ctx.current() === 'route') {
    // the chart on screen is now out of date: dimmed, and its red stretches off the map, until the new one is in
    document.querySelector('#sheet-body .elev-chart')?.classList.add('ec-stale');
    setSteep(ctx.app.map, null);
    setCursor(ctx.app.map, null);
    if (b.legs.length === 0) ctx.rerender();
  }
}

function pushUndo(b, snap = snapshot(b)) {
  b.undo.push(snap);
  if (b.undo.length > 100) b.undo.shift();
}

// A tap on the map while building: on the line between two points it adds a point there, elsewhere the next point.
export async function builderClick(e) {
  const b = B();
  if (!b || e.originalEvent?.target?.closest?.('.rb-pt, .rb-menu')) return;
  if (b.menu) { closeMenu(); return; }                   // a tap away from the menu closes it first
  await ready(b);
  const map = ctx.app.map;
  const box = [[e.point.x - 16, e.point.y - 16], [e.point.x + 16, e.point.y + 16]];
  const hit = map.queryRenderedFeatures(box, { layers: ['build-casing', 'build-line', 'build-off'] }).find((f) => f.properties.leg != null);
  if (b.avoiding) { avoidAt(b, e, hit); return; }
  if (hit && b.legs[hit.properties.leg]) {
    const li = hit.properties.leg;
    const s = snapToPieces(ctx.app.graphIndex, b.legs[li].pieces, e.lngLat.lng, e.lngLat.lat);
    if (s) {
      pushUndo(b);
      b.pts.splice(li + 1, 0, { s });
      changed(b);
      return;
    }
  }
  const s = snapAt(b, e.lngLat.lng, e.lngLat.lat);
  if (!s) {
    ctx.toast('No track near here: tap on or next to a track (zoom in to be precise).');
    return;
  }
  pushUndo(b);
  b.pts.push({ s });
  changed(b);
}

export function undo() {
  const b = B();
  if (!b?.undo.length) return;
  closeMenu();
  const u = b.undo.pop();
  b.closed = u.closed;
  b.pts = u.G === b.G ? u.pts
    : u.pts.map((p) => ({ s: snapToNetwork(b.G, ctx.app.graphIndex, p.s.lon, p.s.lat, 200), here: p.here })).filter((p) => p.s);
  if (u.G === b.G) b.avoidAt = u.avoidAt;
  else snapAvoid(b, [...u.avoidAt.values()]);
  b.cache.clear();
  changed(b);
}

// ---------------------------------------------------------------- avoid a stretch

// The next tap marks a stretch to avoid (or rides a marked one again).
export function avoidMode(on = !B()?.avoiding) {
  const b = B();
  if (!b) return;
  closeMenu();
  b.avoiding = on;
  if (on && ctx.current() === 'route') ctx.closePanel();
  bar();
  if (on) ctx.toast('Tap the stretch of track you want to avoid: the route goes around it.', { ms: 5000 });
}

// The stretch under a tap: the way between two junctions (on the route line when the tap is on it).
function avoidAt(b, e, hit) {
  const X = ctx.app.graphIndex;
  let s = hit && b.legs[hit.properties.leg] ? snapToPieces(X, b.legs[hit.properties.leg].pieces, e.lngLat.lng, e.lngLat.lat) : null;
  if (!s) {
    // a marked stretch (to ride it again) when the tap is about as near it as any track, else the nearest track
    const marked = [...b.avoidAt.keys()].map((k) => snapToNetwork(b.G, X, e.lngLat.lng, e.lngLat.lat, 60, (x) => x !== k)).filter(Boolean)
      .sort((p, q) => p.d - q.d)[0];
    const any = snapAt(b, e.lngLat.lng, e.lngLat.lat);
    s = marked && (!any || marked.d <= any.d + 8) ? marked : any;
  }
  b.avoiding = false;
  if (!s) {
    ctx.toast('No track near here: tap on the stretch itself.');
    bar();
    return;
  }
  pushUndo(b);
  const before = routeStats(b).len;
  if (b.avoidAt.has(s.e)) {
    b.avoidAt.delete(s.e);
    b.cache.clear();
    changed(b);
    ctx.toast('The route may ride that stretch again.');
    return;
  }
  // the point of the stretch nearest its middle is kept, so it holds on to the same way after an area pack update
  const c = X.coords[s.e];
  b.avoidAt.set(s.e, c[Math.floor(c.length / 2)]);
  // points on the stretch would keep the route on it: they go (not the first, the last or the rider's own)
  const n = b.pts.length;
  const dropped = b.pts.filter((p, i) => p.s.e === s.e && i > 0 && i < n - 1 && !p.here).length;
  b.pts = b.pts.filter((p, i) => !(p.s.e === s.e && i > 0 && i < n - 1 && !p.here));
  b.cache.clear();
  changed(b);
  const still = b.legs.some((l) => l.pieces.some((p) => !p.straight && p.e === s.e));
  const diff = routeStats(b).len - before;
  ctx.toast(still ? 'No way around that stretch on the known tracks: the route still rides it (marked red).'
    : `The route goes around it (${diff >= 0 ? '+' : '−'}${fmtDist(Math.abs(diff))})${dropped ? `; ${dropped} point${dropped === 1 ? '' : 's'} on it removed` : ''}.`,
  { ms: 6000 });
}

export function toggleLoop() {
  const b = B();
  if (!b || b.pts.length < 2) return;
  pushUndo(b);
  b.closed = !b.closed;
  changed(b);
}

function removePoint(i) {
  const b = B();
  pushUndo(b);
  b.pts.splice(i, 1);
  if (b.pts.length < 2) b.closed = false;
  changed(b);
}

// dragging a point: the route follows (at most every 80 ms), and the point holds on to the nearest way when dropped
let frame = 0, last = 0, pending = null;

function dragStart() {
  const b = B();
  closeMenu();
  b.before = snapshot(b);
}

function dragMove(i, ll) {
  pending = { i, ll };
  if (frame) return;
  frame = requestAnimationFrame(function step() {
    frame = 0;
    const b = B();
    if (!b || !pending) return;
    if (performance.now() - last < 80) { frame = requestAnimationFrame(step); return; }
    last = performance.now();
    const s = snapAt(b, pending.ll.lng, pending.ll.lat);
    if (s) {
      b.pts[pending.i] = { s, here: b.pts[pending.i]?.here };
      computeLegs(b);
      drawLines();
    }
  });
}

async function dragEnd(i, ll) {
  cancelAnimationFrame(frame);
  frame = 0;
  pending = null;
  const b = B();
  if (!b) return;
  const before = b.before;
  b.before = null;
  await ready(b);
  const s = snapAt(b, ll.lng, ll.lat);
  if (!s) {
    ctx.toast('No track near there: the point went back.');
    if (before) { b.pts = before.pts; b.closed = before.closed; }
    computeLegs(b);
    draw();
    return;
  }
  if (before) pushUndo(b, before);
  b.pts[i] = { s, here: b.pts[i]?.here };
  changed(b);
}

// ---------------------------------------------------------------- the point menu

function closeMenu() {
  const b = B();
  b?.menu?.remove();
  if (b) b.menu = null;
}

function openMenu(i) {
  const b = B();
  if (!b || !b.pts[i]) return;
  closeMenu();
  const n = b.pts.length;
  const items = [h('div', { class: 'rb-menu-title' }, `Point ${i + 1}${i === 0 ? ' · the start' : i === n - 1 ? ' · the last' : ''}`)];
  if (i === 0 && n >= 2) {
    items.push(b.closed ? btn('Open the loop (end at the last point)', () => { closeMenu(); toggleLoop(); })
      : btn('Back to the start (close the loop)', () => { closeMenu(); toggleLoop(); }, 'primary'));
  }
  items.push(btn(`Remove point ${i + 1}`, () => { closeMenu(); removePoint(i); }, 'danger-text'));
  items.push(btn('Cancel', closeMenu));
  // below the point when it is high on the screen (above it the menu would slide under the bar)
  const map = ctx.app.map, at = [b.pts[i].s.lon, b.pts[i].s.lat];
  const anchor = map.project(at).y < map.getContainer().clientHeight * 0.5 ? 'top' : 'bottom';
  b.menu = new Popup({ closeButton: false, closeOnClick: false, offset: 22, anchor, className: 'rb-menu', maxWidth: '270px' })
    .setLngLat(at).setDOMContent(h('div', {}, items)).addTo(map);
}

// ---------------------------------------------------------------- elevation, stats panel, save

let profTimer = 0;
function scheduleProfile() {
  const b = B();
  clearTimeout(profTimer);
  b.profile = null;
  const seq = ++b.profSeq;
  profTimer = setTimeout(async () => {
    if (B() !== b || seq !== b.profSeq) return;
    const coords = routeLine(b);
    const prof = coords.length > 1 ? await elevationProfile(coords, elevationAt) : null;
    if (B() !== b || seq !== b.profSeq) return;
    b.profile = prof ?? false;
    bar();
    if (ctx.current() === 'route') ctx.rerender();
  }, 350);
}

const pct = (x, len) => `${Math.round((len ? x / len : 0) * 100)} %`;

// The "Your route" panel: what the route rides, its elevation and steep stretches, and Save / GPX.
export function renderRoute() {
  const b = B();
  if (!b) return [h('p', { class: 'note' }, 'Open Plan and tap "Make my own route".')];
  if (b.legs.length === 0) return [h('p', { class: 'note' }, 'Tap at least two points on the map.')];
  const st = routeStats(b), L = st.len;
  // the zoom of the chart this one replaces, unless it showed the whole route
  const old = document.querySelector('#sheet-body .elev-chart')?.view?.();
  const view = old && b.shownLen && (old[0] > 1 || old[1] < b.shownLen - 1) ? old : null;
  // first what the finger needs (the chart, with the map above the sheet), then what the route rides
  const out = [
    h('div', { class: 'row-btns' },
      b.nav ? btn('Continue', navContinue, 'primary') : btn('Save', save, 'primary'),
      b.nav ? null : btn('Ride it', rideIt),
      h('button', { class: 'btn', type: 'button', onclick: undo, disabled: !b.undo.length }, 'Undo'),
      btn('Hide', () => ctx.closePanel())),
    h('div', { class: 'verdict' }, h('strong', {}, fmtDist(L)),
      h('span', {}, ` · ${b.pts.length} points${b.closed ? ' · a loop' : ''}${b.profile ? ` · ↑ ${fmtElev(b.profile.up)} ↓ ${fmtElev(b.profile.down)}` : ''}`)),
  ];
  if (b.profile === null) out.push(h('p', { class: 'note' }, 'Reading the elevation…'));
  else if (b.profile === false) out.push(h('p', { class: 'note' }, 'No elevation here: download "Elevation" in Offline maps, or go online.'));
  else {
    b.shownLen = b.profile.length;
    out.push(...profileSection(ctx.app.map, b.profile, { view }));
    out.push(h('p', { class: 'note' }, 'Drag a dot on the map to take another way (the red stretches are the steep ones), '
      + 'or tap the line to add a dot there. The chart follows.'));
  }
  out.push(h('div', { class: 'row-btns' },
    btn('Avoid a stretch', () => avoidMode(true)),
    b.nav ? null : btn('Send to phone', async () => {
      const res = await summary(b);
      ctx.send?.({ name: b.track?.name ?? b.title ?? `My route ${fmtDist(res.stats.len)}`, coords: res.coords, built: res.built, len: res.stats.len });
    }),
    ctx.tour && !b.nav ? btn('Fly through', () => ctx.tour({ coords: routeLine(b), title: b.track?.name ?? b.title ?? 'My route' })) : null,
    btn('GPX', async () => {
      const r = await shareGPX({ name: b.track?.name ?? b.title ?? `DirtScout route ${fmtDist(L)}`, fc: lineFc(routeLine(b), 'route') });
      if (r === 'downloaded') ctx.toast('GPX saved to Downloads');
    })),
  h('p', { class: 'note' }, 'Avoid: tap a stretch of track and the route goes around it. Ride it: navigate this route. '
    + 'Send to phone: a QR code that puts this route on the phone.'));
  out.push(
    h('h3', {}, 'What it rides'),
    h('div', { class: 'riskbar' }, h('i', { style: `width:${(st.risk[0] / L) * 100}%;background:#00c853` }),
      h('i', { style: `width:${(st.risk[1] / L) * 100}%;background:#ffd600` }), h('i', { style: `width:${(st.risk[2] / L) * 100}%;background:#ff1744` })),
    h('div', { class: 'note' }, [`green ${pct(st.risk[0], L)}`, `yellow ${pct(st.risk[1], L)}`, `red ${pct(st.risk[2], L)}`,
      `${pct(st.dirt, L)} dirt`, st.ai ? `${pct(st.ai, L)} on AI-found tracks` : null,
      st.legal[2] ? `${fmtDist(st.legal[2])} closed to motors (OSM)` : null,
      st.legal[1] ? `${fmtDist(st.legal[1])} restricted access` : null].filter(Boolean).join(' · ')),
    st.gaps ? h('p', { class: 'note warn' }, `${st.gaps} gap${st.gaps === 1 ? '' : 's'} between AI-found tracks (${fmtDist(st.gapLen)}, white dashes): nothing was seen there.`) : null,
    st.offs ? h('p', { class: 'note warn' }, `${fmtDist(st.off)} where no track is known (red dashes): the route crosses straight between two `
      + 'networks there. Check it on the imagery, or move the points.') : null,
  );
  return out;
}

const lineFc = (coords, name) => ({ type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name, kind: 'trk' }, geometry: { type: 'LineString', coordinates: coords } }] });

// What a route made here is: its line, the stats a saved route keeps, and its points (with the avoided stretches).
async function summary(b) {
  const coords = routeLine(b);
  const st = routeStats(b);
  const prof = b.profile || (await elevationProfile(coords, elevationAt));
  const L = st.len || 1;
  const stats = { len: st.len, up: prof?.up ?? 0, dn: prof?.down ?? 0, climbs: prof ? steepSections(prof, 15).filter((c) => c.dir > 0) : [],
    green: st.risk[0] / L, yellow: st.risk[1] / L, red: st.risk[2] / L };
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const built = { pts: b.pts.map((p) => [r6(p.s.lon), r6(p.s.lat)]), closed: b.closed,
    avoid: [...b.avoidAt.values()].map(([lon, lat]) => [r6(lon), r6(lat)]) };
  return { coords, stats, built, profile: prof || null };
}

export async function save() {
  const b = B();
  if (!b || b.pts.length < 2) return;
  const { coords, stats, built } = await summary(b);
  const name = prompt('Name of this route', b.track?.name ?? `${b.title ?? 'My route'} ${fmtDist(stats.len)} ${new Date().toLocaleDateString()}`);
  if (name === null) return;
  const t = await savePlanned(name.trim() || 'My route', coords, stats, { ...(b.track?.plan ?? {}), built }, b.track?.color ?? COLOR, b.track?.id);
  close();
  await ctx.refreshTracks();
  ctx.toast(`Saved "${t.name}" in Tracks: open it there to edit it again.`, { action: 'GPX', onAction: () => shareGPX(t) });
}
