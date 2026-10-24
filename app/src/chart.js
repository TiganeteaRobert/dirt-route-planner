// Elevation chart of a route profile (core/profile.js), phone first: the ground under the line coloured by grade, a
// crosshair with distance, elevation and grade, pinch / wheel zoom and pan, and buttons big enough for gloves. Builds
// its own DOM and injects its CSS once (classes ec-*). The ~30 m elevation model misses short steep pitches: the note
// under the chart says so.
import { gradeColor, gradeBands } from '../../core/profile.js';
import { fmtDist, fmtElev, h, fill } from './format.js';
import { settings } from './settings.js';

const MIN_SPAN = 200;                       // m: the narrowest window (the whole route when it is shorter)
const RED_CHOICES = [25, 35, 45];           // %: the "Red above" buttons
const PAD_T = 8, PAD_R = 10, PAD_B = 24;    // CSS px around the plot; on the left, room for the elevation labels
const FONT = '700 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TIP_FONT = '800 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const INK = '#111511', MUTED = '#475046', LINE = '#2b312c', GRID = 'rgba(17, 21, 17, 0.14)', AXIS = '#8d978c';
const FT = 0.3048, MI = 1609.344;
const NOTE = 'From a ~30 m elevation model: short steep pitches do not show, and real grades can be steeper.';

const CSS = `
.elev-chart { color: #111511; }
.ec-canvas { display: block; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; cursor: crosshair; }
.ec-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
.ec-btn { appearance: none; border: 2px solid #2e3a30; background: #fff; color: #111511; border-radius: 10px;
  min-height: 48px; padding: 8px 14px; font: 800 15.5px/1.1 system-ui, sans-serif; touch-action: manipulation;
  cursor: pointer; }
.ec-btn:disabled { opacity: 0.45; cursor: default; }
.ec-btn.ec-sym { min-width: 60px; padding: 0 10px; font-size: 24px; line-height: 1; }
.ec-btn.ec-grow { flex: 1; }
.ec-btn.ec-small { min-height: 44px; padding: 4px 12px; font-size: 14.5px; }
.ec-btn.ec-on { background: #ff8f00; border-color: #ff8f00; }
.ec-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 10px 0 0; font-size: 14.5px; color: #475046; }
.ec-band { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.ec-band i { width: 22px; height: 14px; border-radius: 3px; border: 1px solid rgba(0, 0, 0, 0.25); flex: none; }
.ec-label { font-weight: 800; font-size: 14.5px; }
.ec-note { margin: 4px 0 0; font-size: 14px; line-height: 1.35; color: #475046; }
`;

function injectCss() {
  if (!document.getElementById('elev-chart-css')) document.head.append(h('style', { id: 'elev-chart-css' }, CSS));
}

// 1, 2 or 5 times a power of ten, at least v.
function niceUp(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1.000001 ? 1 : f <= 2.000001 ? 2 : f <= 5.000001 ? 5 : 10) * p;
}

// Elevation ticks at least 26 px apart, in m or ft: [{v (metres), label}].
function yTicks(lo, hi, ph) {
  const u = settings.units === 'imperial' ? FT : 1, sfx = u === 1 ? ' m' : ' ft';
  const step = niceUp(((hi - lo) / u) * (26 / ph));
  const out = [];
  for (let k = Math.ceil(lo / u / step); k * step * u <= hi; k++) {
    out.push({ v: k * step * u, label: `${Math.round(k * step)}${sfx}` });
  }
  return out;
}

// Distance ticks far enough apart for their labels: m / ft until the window reaches 1 km / 0.1 mi, then km / mi with
// the decimals the step needs. [{v (metres), label}]
function xTicks(ctx, w0, w1, pw) {
  const imp = settings.units === 'imperial';
  const small = w1 < (imp ? 0.1 * MI : 1000);
  const u = imp ? (small ? FT : MI) : (small ? 1 : 1000);
  const sfx = imp ? (small ? ' ft' : ' mi') : (small ? ' m' : ' km');
  const span = (w1 - w0) / u;
  let step = niceUp(span / 10), dec = 0;
  for (;;) {
    dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    if (step * (pw / span) >= ctx.measureText(`${(w1 / u).toFixed(dec)}${sfx}`).width + 18) break;
    step = niceUp(step * 1.5);
  }
  const out = [];
  for (let k = Math.ceil(w0 / u / step - 1e-9); k * step <= w1 / u + 1e-9; k++) {
    const v = k * step;
    out.push({ v: v * u, label: `${v ? v.toFixed(dec) : '0'}${sfx}` });
  }
  return out;
}

/**
 * profile: from profileFrom / elevationProfile (core/profile.js). Returns a div.elev-chart (width 100 % of its parent)
 * with methods setRedAt(v), highlight(index) (crosshair at a sample, e.g. from the map; null hides it), view() ->
 * [from, to] metres shown (view([from, to]) sets it), zoom(factor) (> 1 = in, around the centre) and redraw() (after a
 * units change). onPoint(index) when the rider moves the crosshair; onRedAt(v) when a "Red above" button is pressed.
 */
export function elevationChart(profile, { redAt = 45, onPoint = null, onRedAt = null, height = 180 } = {}) {
  injectCss();
  const { dist, elev, grade } = profile ?? {};
  const n = dist?.length ?? 0, L = profile?.length ?? 0;
  if (n < 2 || !(L > 0)) {
    const none = h('div', { class: 'elev-chart' }, h('p', { class: 'ec-note' }, 'No elevation profile for this route.'));
    return Object.assign(none, { setRedAt() {}, highlight() {}, view: () => [0, 0], zoom() {}, redraw() {} });
  }
  redAt = +redAt;
  const minSpan = Math.min(MIN_SPAN, L);
  let w0 = 0, w1 = L;                       // the window shown, metres from the start
  let cross = -1;                           // crosshair sample, -1 = none
  let W = 0, dpr = 1, frame = 0;            // canvas width (CSS px), backing-store scale, pending redraw
  let pl = 0, pr = 1;                       // plot's left and right edges (CSS px), from the last draw

  const canvas = h('canvas', {
    class: 'ec-canvas', style: `height: ${height}px`, role: 'img', 'aria-label': 'Elevation profile',
    oncontextmenu: (e) => e.preventDefault(),          // a finger held still on the chart is not a long press
  });
  const ctx = canvas.getContext('2d');
  const button = (cls, label, onclick, aria) =>
    h('button', { type: 'button', class: `ec-btn ${cls}`, 'aria-label': aria, onclick }, label);
  const btnOut = button('ec-sym', '−', () => zoomAt(0.5, 0.5), 'Zoom out');
  const btnIn = button('ec-sym', '+', () => zoomIn(), 'Zoom in');
  const btnAll = button('ec-grow', 'Whole route', () => setWindow(0, L));
  const legend = h('div', { class: 'ec-legend' });
  const reds = h('div', { class: 'ec-row' });
  const el = h('div', { class: 'elev-chart' },
    canvas, h('div', { class: 'ec-row' }, btnOut, btnIn, btnAll), legend, reds, h('p', { class: 'ec-note' }, NOTE));

  // ---- samples
  // first sample at or after x metres (strictly after it with `past`)
  const seek = (x, past) => {
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (dist[m] < x || (past && dist[m] === x)) lo = m + 1; else hi = m;
    }
    return lo;
  };
  const lower = (x) => seek(x, false), upper = (x) => seek(x, true);
  const elevAt = (x) => {
    const k = Math.min(n - 1, Math.max(1, lower(x)));
    const span = dist[k] - dist[k - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (x - dist[k - 1]) / span)) : 1;
    return elev[k - 1] + t * (elev[k] - elev[k - 1]);
  };
  // the sample nearest to x metres, among those in the window
  const nearest = (x) => {
    const k = lower(x);
    let i = k <= 0 ? 0 : k >= n ? n - 1 : x - dist[k - 1] <= dist[k] - x ? k - 1 : k;
    const k0 = lower(w0), k1 = upper(w1) - 1;
    if (k0 <= k1) i = Math.min(k1, Math.max(k0, i));
    return i;
  };

  // ---- the window
  const clampSpan = (s) => Math.min(L, Math.max(minSpan, s));
  function setWindow(start, span) {
    span = clampSpan(span);
    start = Math.min(L - span, Math.max(0, start));
    if (start !== w0 || start + span !== w1) { w0 = start; w1 = Math.min(L, start + span); schedule(); }
    btnIn.disabled = w1 - w0 <= minSpan + 0.01;
    btnOut.disabled = btnAll.disabled = w1 - w0 >= L - 0.01;
  }
  // zoom by `factor` (> 1 = in), the point at `frac` of the window's width staying where it is
  function zoomAt(factor, frac) {
    const c = w0 + frac * (w1 - w0), span = clampSpan((w1 - w0) / factor);
    setWindow(c - frac * span, span);
  }
  // "+": centred on the crosshair when it is in view, else around the centre
  function zoomIn() {
    if (cross >= 0 && dist[cross] >= w0 && dist[cross] <= w1) {
      const span = clampSpan((w1 - w0) / 2);
      setWindow(dist[cross] - span / 2, span);
    } else zoomAt(2, 0.5);
  }
  const toDist = (x) => w0 + ((x - pl) / (pr - pl)) * (w1 - w0);

  // ---- drawing
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function draw() {
    frame = 0;
    if (!W) return;
    const H = height, imp = settings.units === 'imperial';
    const dev = Math.max(1, Math.round(dpr));           // a hairline in device pixels
    const hair = dev / dpr, off = (dev % 2) / 2;
    const snap = (v) => (Math.round(v * dpr - off) + off) / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;

    // elevation range: the samples in the window, 5 % padding, at least 20 m
    const ea = elevAt(w0), eb = elevAt(w1);
    const k0 = upper(w0), k1 = lower(w1) - 1;           // samples strictly inside the window
    let lo = Math.min(ea, eb), hi = Math.max(ea, eb);
    for (let k = k0; k <= k1; k++) { if (elev[k] < lo) lo = elev[k]; if (elev[k] > hi) hi = elev[k]; }
    if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
    const padY = (hi - lo) * 0.05;
    lo -= padY; hi += padY;

    // left margin: wide enough for the longest elevation label this route can show (steady while zooming)
    const { min, max } = profile;
    const most = (Math.max(Math.abs(min), Math.abs(max)) + Math.max(20, max - min) * 0.1) / (imp ? FT : 1);
    const widest = `${min < 0 ? '-' : ''}${'8'.repeat(String(Math.round(most)).length)}${imp ? ' ft' : ' m'}`;
    pl = Math.round((ctx.measureText(widest).width + 10) * dpr) / dpr;
    pr = Math.round((W - PAD_R) * dpr) / dpr;
    const pt = PAD_T, pb = Math.round((H - PAD_B) * dpr) / dpr;
    if (pr - pl < 20 || pb - pt < 20) { pr = pl + 1; return; }     // no room to plot (a layout in passing)
    const X = (d) => pl + ((d - w0) / (w1 - w0)) * (pr - pl);
    const Y = (e) => pb - ((e - lo) / (hi - lo)) * (pb - pt);
    const trace = () => {
      ctx.lineTo(pl, Y(ea));
      for (let k = k0; k <= k1; k++) ctx.lineTo(X(dist[k]), Y(elev[k]));
      ctx.lineTo(pr, Y(eb));
    };

    // ground under the line: one device-pixel column at a time, coloured by the steepest sample touching it, widened
    // by ~1 px each side (a 50 m pitch still shows on a 30 km route), filled in vertical slices clipped to the line
    const cols = Math.max(1, Math.round((pr - pl) * dpr));
    const raw = new Float32Array(cols), steep = new Float32Array(cols);
    const perM = cols / (w1 - w0);
    for (let k = Math.max(0, k0 - 1); k <= Math.min(n - 1, k1 + 1); k++) {
      const s0 = k > 0 ? (dist[k - 1] + dist[k]) / 2 : dist[0];
      const s1 = k < n - 1 ? (dist[k] + dist[k + 1]) / 2 : dist[n - 1];
      const c0 = Math.max(0, Math.floor((s0 - w0) * perM)), c1 = Math.min(cols, Math.ceil((s1 - w0) * perM));
      const g = Math.abs(grade[k]);
      for (let c = c0; c < c1; c++) if (g > raw[c]) raw[c] = g;
    }
    for (let c = 0; c < cols; c++) {
      const j1 = Math.min(cols - 1, c + dev);
      for (let j = Math.max(0, c - dev); j <= j1; j++) if (raw[j] > steep[c]) steep[c] = raw[j];
    }
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pl, pb);
    trace();
    ctx.lineTo(pr, pb);
    ctx.closePath();
    ctx.clip();
    for (let c = 0; c < cols;) {
      const color = gradeColor(steep[c], redAt);
      let e = c + 1;
      while (e < cols && gradeColor(steep[e], redAt) === color) e++;
      ctx.fillStyle = color;
      ctx.fillRect(pl + c / dpr, pt, (e - c) / dpr, pb - pt);
      c = e;
    }
    ctx.restore();

    // grid, axis, the line
    const yt = yTicks(lo, hi, pb - pt), xt = xTicks(ctx, w0, w1, pr - pl);
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (const t of yt) { const y = snap(Y(t.v)); ctx.moveTo(pl, y); ctx.lineTo(pr, y); }
    for (const t of xt) { const x = snap(X(t.v)); ctx.moveTo(x, pt); ctx.lineTo(x, pb); }
    ctx.strokeStyle = GRID;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pl, snap(pb));
    ctx.lineTo(pr, snap(pb));
    ctx.strokeStyle = AXIS;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pl, Y(ea));
    trace();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = LINE;
    ctx.stroke();

    // tick labels: elevation on the left (none right at the axis), distance below (kept inside the canvas)
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yt) { const y = Y(t.v); if (y < pb - 8) ctx.fillText(t.label, pl - 6, y); }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let right = -Infinity;
    for (const t of xt) {
      const half = ctx.measureText(t.label).width / 2;
      const x = Math.min(W - half - 1, Math.max(half + 1, X(t.v)));
      if (x - half < right + 8) continue;               // pushed in from the edge onto its neighbour
      ctx.fillText(t.label, x, H - 7);
      right = x + half;
    }

    // crosshair and its label (at the top of the plot, or at its bottom when the point is up there)
    if (cross >= 0 && dist[cross] >= w0 && dist[cross] <= w1) {
      const x = snap(X(dist[cross])), y = Y(elev[cross]);
      ctx.beginPath();
      ctx.moveTo(x, pt);
      ctx.lineTo(x, pb);
      ctx.lineWidth = hair * 1.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.stroke();
      const g = Math.round(grade[cross]), sign = g > 0 ? '+' : g < 0 ? '−' : '';
      const text = `${fmtDist(dist[cross])} · ${fmtElev(elev[cross])} · ${sign}${Math.abs(g)} %`;
      ctx.font = TIP_FONT;
      const bw = ctx.measureText(text).width + 30, bh = 24;
      const bx = Math.min(W - bw - 2, Math.max(2, x - bw / 2));
      let by = pt + 2;
      if (y < by + bh + 8) by = pb - bh - 4;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 7); else ctx.rect(bx, by, bw, bh);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = gradeColor(grade[cross], redAt);
      ctx.fillRect(bx + 8, by + bh / 2 - 5, 10, 10);
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 23, by + bh / 2 + 0.5);
    }
  }

  // the canvas follows its CSS width; the backing store is drawn at the device's pixel ratio
  // (a chart that was on screen and is gone - the panel re-rendered - stops observing)
  const ro = new ResizeObserver(([entry]) => {
    const w = entry.contentRect.width, r = window.devicePixelRatio || 1;
    if (!w) {
      if (W && !canvas.isConnected) ro.disconnect();
      W = 0;
      return;
    }
    if (w === W && r === dpr) return;
    W = w;
    dpr = r;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(height * dpr);
    if (frame) cancelAnimationFrame(frame);
    draw();
  });
  ro.observe(canvas);

  // ---- touch, mouse, pen
  const down = new Map();         // pointers pressed on the canvas: id -> {x, y, x0, y0, t0, moved}
  let mode = null;                // 'point' (one finger), 'pinch', 'hold' (after a pinch, till all are up), 'pan'
  let pinch = null, drag = null, lastTap = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function pointAt(x, force) {
    const i = nearest(Math.min(w1, Math.max(w0, toDist(x))));
    if (i === cross && !force) return;
    cross = i;
    schedule();
    onPoint?.(i);
  }
  function fingers() {
    const [p, q] = down.values();
    return { cx: (p.x + q.x) / 2, d: Math.max(24, Math.hypot(p.x - q.x, p.y - q.y)) };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e);
    if (e.isPrimary) { down.clear(); mode = null; }   // a new first finger: whatever was held before has ended
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not an active pointer */ }
    down.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: e.timeStamp, moved: false });
    if (e.pointerType === 'mouse') {
      if (e.button === 0) { mode = 'pan'; drag = { x0: p.x, w0 }; }
    } else if (down.size === 1) {
      mode = 'point';
      pointAt(p.x, true);
    } else if (down.size === 2) {
      const f = fingers();
      mode = 'pinch';
      pinch = { d0: f.d, span0: w1 - w0, c0: toDist(f.cx) };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e), q = down.get(e.pointerId);
    if (q) {
      q.x = p.x;
      q.y = p.y;
      if (Math.hypot(p.x - q.x0, p.y - q.y0) > 10) q.moved = true;
    }
    if (e.pointerType === 'mouse') {
      if (mode === 'pan' && q) setWindow(drag.w0 - ((p.x - drag.x0) / (pr - pl)) * (w1 - w0), w1 - w0);
      else if (!q) pointAt(p.x, false);
    } else if (q && mode === 'point') pointAt(p.x, false);
    else if (q && mode === 'pinch' && down.size >= 2) {
      // spread / pinch zooms around the fingers; moving them together pans
      const f = fingers(), span = clampSpan((pinch.span0 * pinch.d0) / f.d);
      setWindow(pinch.c0 - ((f.cx - pl) / (pr - pl)) * span, span);
    }
  });
  const up = (e) => {
    const q = down.get(e.pointerId);
    if (!q) return;
    down.delete(e.pointerId);
    if (e.type === 'pointerup' && (mode === 'point' || mode === 'pan') && !q.moved && e.timeStamp - q.t0 < 300) {
      // a tap; two in a row show the whole route again
      if (lastTap && e.timeStamp - lastTap.t < 350 && Math.abs(q.x - lastTap.x) < 30) {
        lastTap = null;
        setWindow(0, L);
      } else lastTap = { t: e.timeStamp, x: q.x };
    }
    if (mode === 'pinch' && down.size) mode = 'hold';
    if (!down.size) mode = pinch = drag = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  // touch-action alone still lets Chrome start a fling after a quick two-finger flick, and the next tap (on "+")
  // only stops that fling instead of clicking: consuming the moves keeps the browser out of it
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    if (Math.abs(dx) > Math.abs(dy)) setWindow(w0 + (dx / (pr - pl)) * (w1 - w0), w1 - w0);
    else zoomAt(Math.exp(-dy * 0.002), Math.min(1, Math.max(0, (local(e).x - pl) / (pr - pl))));
  }, { passive: false });

  // ---- legend and the red threshold
  function renderLegend() {
    fill(legend, gradeBands(redAt).map(([color, label]) =>
      h('span', { class: 'ec-band' }, h('i', { style: `background: ${color}` }), label)));
    fill(reds, h('span', { class: 'ec-label' }, 'Red above:'), RED_CHOICES.map((v) => h('button', {
      type: 'button', class: `ec-btn ec-small${v === redAt ? ' ec-on' : ''}`, 'aria-pressed': String(v === redAt),
      onclick: () => { el.setRedAt(v); onRedAt?.(v); },
    }, `${v} %`)));
  }

  el.setRedAt = (v) => { redAt = +v; renderLegend(); schedule(); };
  el.highlight = (i) => {
    const k = i == null ? -1 : Math.round(i);
    cross = k >= 0 && k < n ? k : -1;
    if (cross >= 0 && (dist[cross] < w0 || dist[cross] > w1)) setWindow(dist[cross] - (w1 - w0) / 2, w1 - w0);
    schedule();
  };
  el.view = (range) => {
    if (range) setWindow(range[0], range[1] - range[0]);
    return [w0, w1];
  };
  el.zoom = (factor) => zoomAt(factor, 0.5);
  el.redraw = schedule;

  renderLegend();
  setWindow(0, L);
  return el;
}
