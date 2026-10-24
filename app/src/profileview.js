// The elevation part of a route or track view: climb, descent and the steepest grades, the zoomable chart
// (app/src/chart.js) and, while a finger is on it, the same place on the map: a dot in the grade's colour with
// distance, elevation and grade, the steep stretch under the finger outlined, and the map moved along when the dot
// would leave the part of it that shows. The stretches at or above the red grade are listed (tap one: the map and the
// chart go there). The grade threshold is the owner's setting (settings.steepRed).
import { elevationChart } from './chart.js';
import { steepSections, gradeColor } from '../../core/profile.js';
import { setCursor } from './mapview.js';
import { settings, saveSettings } from './settings.js';
import { h, fmtDist, fmtElev } from './format.js';

const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);
const ll = (p) => [p[0], p[1]];

// The part of the map nobody covers (screen px): below the status pills or a bar, above the sheet (left of it when it
// is a side panel), left of the zoom buttons.
function visibleBox(map) {
  const r = map.getContainer().getBoundingClientRect();
  const box = { left: r.left + 14, right: r.right - 66, top: r.top + 66, bottom: r.bottom - 12 };
  for (const id of ['buildbar', 'drawbar']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) box.top = Math.max(box.top, el.getBoundingClientRect().bottom + 10);
  }
  const sheet = document.getElementById('sheet');
  if (sheet && !sheet.hidden) {
    const s = sheet.getBoundingClientRect();
    if (s.width < r.width * 0.8) box.right = Math.min(box.right, s.left - 12);
    else box.bottom = Math.min(box.bottom, s.top - 12);
  }
  return { ...box, ox: r.left, oy: r.top };
}

// Moves the map (no zoom) when p is outside the part that shows, so that it lands in its middle.
export function keepInView(map, p) {
  const b = visibleBox(map);
  const q = map.project(ll(p));
  const x = q.x + b.ox, y = q.y + b.oy;
  if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return;
  const c = map.project(map.getCenter());
  const mx = (b.left + b.right) / 2 - b.ox, my = (b.top + b.bottom) / 2 - b.oy;
  map.easeTo({ center: map.unproject([c.x + (q.x - mx), c.y + (q.y - my)]), duration: 250 });
}

// Fits a line into the part of the map that shows (call once the sheet has its size).
export function fitInView(map, coords) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
  if (!(w < e || s < n)) return;
  const b = visibleBox(map), r = map.getContainer().getBoundingClientRect();
  const padding = { left: b.left - r.left, right: r.right - b.right, top: b.top - r.top, bottom: r.bottom - b.bottom };
  if (r.width - padding.left - padding.right < 60 || r.height - padding.top - padding.bottom < 60) return;
  map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 16, duration: 500 });
}

export function profileSection(map, profile) {
  setCursor(map, null);                         // a new chart: no finger on it yet
  let redAt = settings.steepRed ?? 45;
  let steep = steepSections(profile, redAt);
  const list = h('div', { class: 'steep-list' });
  let chart = null;
  const pts = profile.pts ?? [];
  // the map at sample i: the dot, its label, and the steep stretch it is on (if any)
  const mark = (i, follow = true) => {
    const p = pts[i];
    if (!p) { setCursor(map, null); return; }
    const g = profile.grade[i];
    const s = steep.find((x) => i >= x.i0 && i <= x.i1);
    setCursor(map, p, {
      color: gradeColor(Math.abs(g), redAt),
      label: `${fmtDist(profile.dist[i])} · ${fmtElev(profile.elev[i])} · ${g > 0 ? '+' : ''}${Math.round(g)} %`,
      steep: s ? pts.slice(s.i0, s.i1 + 1).map(ll) : null,
    });
    if (follow) keepInView(map, p);
  };
  const show = (s) => {
    const p = pts[s.i0];
    if (!p) return;
    chart?.highlight(s.i0);
    mark(s.i0, false);
    map.flyTo({ center: ll(p), zoom: Math.max(map.getZoom(), 15), duration: 600 });
  };
  const fillList = () => {
    list.replaceChildren(
      h('h3', {}, `Steeper than ${redAt} %`),
      ...(steep.length
        ? steep.map((s) => h('button', { class: 'row find', type: 'button', onclick: () => show(s) },
          h('span', { class: 'km' }, `km ${km(s.from)}`),
          h('span', { class: 'grow' }, `${s.dir > 0 ? 'climb' : 'descent'}, steepest ${Math.round(s.max)} %, ${fmtDist(s.to - s.from)}`)))
        : [h('p', { class: 'note' }, `Nothing this steep on it (steepest ${Math.round(Math.max(profile.maxUp, profile.maxDown))} %).`)]));
  };
  chart = elevationChart(profile, {
    redAt,
    onPoint: (i) => mark(i),
    onRedAt: (v) => { redAt = v; settings.steepRed = v; saveSettings(); steep = steepSections(profile, v); fillList(); },
  });
  fillList();
  return [
    h('div', { class: 'note' }, `Up ${fmtElev(profile.up)} · down ${fmtElev(profile.down)} · ${fmtElev(profile.min)} to ${fmtElev(profile.max)}`
      + ` · steepest up ${Math.round(profile.maxUp)} %, down ${Math.round(profile.maxDown)} %. Slide a finger along the chart: the dot on the map shows where.`),
    chart,
    list,
  ];
}
