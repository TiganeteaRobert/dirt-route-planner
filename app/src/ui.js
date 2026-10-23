// Panels (one bottom sheet at a time), the toolbar, status pills and toasts.
import { SOURCES, LOCAL_OVERLAYS, SLOPE_CLASSES, OFFLINE_SOURCES, APP_NAME } from './config.js';
import { settings, saveSettings, defaultArea } from './settings.js';
import { applyLayers, setArea, effectiveBase, setRecLine } from './mapview.js';
import { downloader, estimateJob, sourceZooms } from './downloads.js';
import * as db from './db.js';
import { gps, recorder } from './gps.js';
import * as wake from './wakelock.js';
import { importFiles, updateTrack, deleteTrack, shareGPX, trackLines, saveRecording } from './tracks.js';
import { upstreamURL, networkAllowed, elevationAt } from './tiles.js';
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
  more: ['More', renderMore],
};

// ---------------------------------------------------------------- sheet, toast, status

export function openPanel(name) {
  current = name;
  $('sheet').hidden = false;
  $('sheet-title').textContent = PANELS[name][0];
  $('sheet-body').scrollTop = 0;
  for (const b of document.querySelectorAll('#toolbar [data-sheet]')) b.classList.toggle('active', b.dataset.sheet === name);
  rerender();
}

export function closePanel() {
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

async function renderDownloads() {
  app.stats = await db.tileStats();
  const est = (await navigator.storage?.estimate?.().catch(() => null)) ?? {};
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const out = [h('div', { class: 'card' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Phone storage'),
      h('span', {}, est.quota ? `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)}` : 'unknown')),
    h('p', { class: 'note' }, persisted ? 'Protected: Chrome will not clear this data by itself.'
      : 'Not protected yet: Chrome may clear it if the phone runs out of space. DirtScout asks for protection with the first download; installing the app helps.'))];

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
    h('p', { class: 'note' }, 'Tracks stay on this phone. TET and ACT files are for your own use only: their terms forbid sharing them.'))];

  if (!app.tracks.length) out.push(h('p', { class: 'note' }, 'No tracks yet.'));
  for (const t of app.tracks) {
    const lines = trackLines(t).length;
    const kind = { import: 'imported', tet: 'TET / ACT', recording: 'my ride' }[t.kind] ?? t.kind;
    out.push(h('div', { class: 'card track' },
      h('div', { class: 'row' },
        h('input', { type: 'checkbox', checked: t.visible, 'aria-label': 'Show on map', onchange: async (e) => { await updateTrack(t.id, { visible: e.target.checked }); await app.refreshTracks(); } }),
        h('i', { class: 'swatch', style: `background:${t.color}` }),
        h('span', { class: 'grow name' }, t.name),
        h('span', { class: 'badge' }, kind)),
      h('div', { class: 'note' }, [
        lines ? fmtDist(t.stats.length) : null,
        t.stats.points ? `${t.stats.points} waypoints` : null,
        t.kind === 'recording' && t.ended ? `${new Date(t.created).toLocaleString()} · ${fmtDuration(t.ended - t.created)}` : null,
      ].filter(Boolean).join(' · ')),
      h('div', { class: 'row-btns' },
        t.stats.bbox ? btn('Show', () => { fitTrack(t); closePanel(); }) : null,
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
          rerender();
        }, 'danger-text'),
      )));
  }
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
  app.markTet = false;
  app.follow = false;
  app.recLine = [];

  for (const b of document.querySelectorAll('#toolbar [data-sheet]')) {
    b.addEventListener('click', () => (current === b.dataset.sheet ? closePanel() : openPanel(b.dataset.sheet)));
  }
  $('sheet-close').addEventListener('click', closePanel);
  $('btn-locate').addEventListener('click', locate);
  $('btn-record').addEventListener('click', () => (current === 'record' ? closePanel() : openPanel('record')));
  $('st-gps').addEventListener('click', () => openPanel('record'));
  $('st-rec').addEventListener('click', () => openPanel('record'));
  $('st-dl').addEventListener('click', () => openPanel('downloads'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

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

  const netChanged = () => { applyLayers(app.map); updateStatus(); if (current === 'layers') rerender(); };
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
