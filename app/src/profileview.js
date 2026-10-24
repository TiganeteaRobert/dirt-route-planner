// The elevation part of a route or track view: climb, descent and the steepest grades, the zoomable chart
// (app/src/chart.js) whose finger position shows as a dot on the map, and the stretches at or above the red grade
// (tap one: the map and the chart go there). The grade threshold is the owner's setting (settings.steepRed).
import { elevationChart } from './chart.js';
import { steepSections } from '../../core/profile.js';
import { setCursor } from './mapview.js';
import { settings, saveSettings } from './settings.js';
import { h, fmtDist, fmtElev } from './format.js';

const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);

export function profileSection(map, profile) {
  const redAt = settings.steepRed ?? 45;
  const list = h('div', { class: 'steep-list' });
  let chart = null;
  const show = (s) => {
    const p = profile.pts?.[s.i0];
    if (p) {
      setCursor(map, p);
      map.flyTo({ center: p, zoom: Math.max(map.getZoom(), 15.5), duration: 600 });
    }
    chart?.highlight(s.i0);
  };
  const fillList = (r) => {
    const steep = steepSections(profile, r);
    list.replaceChildren(
      h('h3', {}, `Steeper than ${r} %`),
      ...(steep.length
        ? steep.map((s) => h('button', { class: 'row find', type: 'button', onclick: () => show(s) },
          h('span', { class: 'km' }, `km ${km(s.from)}`),
          h('span', { class: 'grow' }, `${s.dir > 0 ? 'climb' : 'descent'}, steepest ${Math.round(s.max)} %, ${fmtDist(s.to - s.from)}`)))
        : [h('p', { class: 'note' }, `Nothing this steep on it (steepest ${Math.round(Math.max(profile.maxUp, profile.maxDown))} %).`)]));
  };
  chart = elevationChart(profile, {
    redAt,
    onPoint: (i) => setCursor(map, i == null ? null : profile.pts?.[i] ?? null),
    onRedAt: (v) => { settings.steepRed = v; saveSettings(); fillList(v); },
  });
  fillList(redAt);
  return [
    h('div', { class: 'note' }, `Up ${fmtElev(profile.up)} · down ${fmtElev(profile.down)} · ${fmtElev(profile.min)} to ${fmtElev(profile.max)}`
      + ` · steepest up ${Math.round(profile.maxUp)} %, down ${Math.round(profile.maxDown)} %`),
    chart,
    list,
  ];
}
