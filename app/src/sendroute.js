// Send to phone: a route as a QR code (plus a link to copy or share) that opens DirtScout on the phone and saves the
// route in its Tracks, ready to Navigate. Tracks live in each browser on its own (no account, no server), so this is
// how a route planned on the PC gets to the phone. The route travels in the link (core/routelink.js): the points of a
// route the builder can ride (the phone rebuilds it on its own copy of the network), or a line off the network,
// simplified. TET / ACT files are never sent (their terms).
import { renderSVG } from 'uqr';
import { encodeRoute, decodeRoute, lineForLink, LINK_KEY } from '../../core/routelink.js';
import { pointsForLine, routeFromPoints, traceCost, leg, piecesCoords, piecesStats } from '../../core/builder.js';
import { elevationProfile, steepSections } from '../../core/profile.js';
import { lineLength } from '../../core/geo.js';
import { elevationAt } from './tiles.js';
import { savePlanned } from './tracks.js';
import { h, fmtDist } from './format.js';

const COLOR = '#ff6d00';
let ctx = null;              // {app, ensureGraph, toast, openPanel, rerender, refreshTracks, startNav, fitCoords}

export function initSend(c) {
  ctx = c;
  window.addEventListener('hashchange', () => receive());       // a link opened while the app is already open
}

const appUrl = () => location.href.replace(/[?#].*$/, '');
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, type: 'button', onclick }, label);

/**
 * Opens the panel with the QR code for a route. src: {name, coords, built ({pts, closed, avoid}: the builder's
 * points, when the route has them), len}. Without points, points along the line are worked out here, so the phone
 * rides the same way; a line the network cannot follow goes as the line.
 */
export async function sendRoute(src) {
  const app = ctx.app;
  const s = { name: src.name, busy: true };
  app.send = s;
  ctx.openPanel('send');
  try {
    let built = src.built ?? null;
    if (!built && src.coords?.length > 1) {
      try {
        const G = await ctx.ensureGraph(), X = app.graphIndex, cost = traceCost(G), memo = new Map();
        const legOf = (A, B) => {
          const k = `${A.e}:${A.t}>${B.e}:${B.t}`;
          if (!memo.has(k)) { const p = leg(G, A, B, cost); memo.set(k, { pieces: p, coords: piecesCoords(X, p), stats: piecesStats(G, p) }); }
          return memo.get(k);
        };
        const r = pointsForLine(G, X, src.coords, legOf);
        if (r) built = { pts: r.pts.map((p) => [p.lon, p.lat]), closed: r.closed, avoid: [] };
      } catch { /* no route network here: the line itself goes */ }
    }
    const len = src.len ?? lineLength(src.coords ?? []);
    let value, note = null;
    if (built) value = encodeRoute({ name: src.name, len, pts: built.pts, closed: built.closed, avoid: built.avoid ?? [] });
    else {
      const l = lineForLink(src.name, src.coords);
      value = l.value;
      if (l.tol > 10) note = `This track is not on the map's network, so it goes as its line, simplified to within ${l.tol} m.`;
    }
    Object.assign(s, { busy: false, len, url: `${appUrl()}#${LINK_KEY}=${value}`, points: built?.pts.length ?? 0, note });
  } catch (e) {
    Object.assign(s, { busy: false, error: e.message });
  }
  if (app.send === s) ctx.rerender();
}

export function renderSend() {
  const s = ctx.app.send;
  if (!s) return [h('p', { class: 'note' }, 'In Tracks, tap "Send to phone" on a route.')];
  if (s.busy) return [h('p', { class: 'note' }, `Making the code for "${s.name}"…`)];
  if (s.error) return [h('p', { class: 'note warn' }, `Cannot make the code: ${s.error}`)];
  const out = [h('div', { class: 'verdict' }, h('strong', {}, s.name), h('span', {}, ` · ${fmtDist(s.len)}`))];
  if (s.url.length <= 2300) {
    const box = h('div', { class: 'qr', role: 'img', 'aria-label': `QR code of the link to "${s.name}"` });
    box.innerHTML = renderSVG(s.url, { ecc: s.url.length < 700 ? 'M' : 'L', border: 2 });
    out.push(box, h('p', { class: 'note' }, 'On the phone: open the camera, point it at the code and tap the link. DirtScout opens '
      + 'and saves the route in Tracks, ready to Navigate.'));
  } else {
    out.push(h('p', { class: 'note warn' }, 'This route is too long for a QR code: copy or share the link instead.'));
  }
  out.push(h('div', { class: 'row-btns' },
    btn('Copy link', async () => {
      try { await navigator.clipboard.writeText(s.url); ctx.toast('Link copied: paste it into a message to yourself.'); }
      catch { ctx.toast('Could not copy: select the link below and copy it.'); }
    }, 'primary'),
    navigator.share ? btn('Share link', () => navigator.share({ title: s.name, url: s.url }).catch(() => {})) : null));
  if (s.points) {
    out.push(h('p', { class: 'note' }, `The link holds the route's ${s.points} points; the phone rebuilds the route between them on its `
      + 'own map, so it needs the area pack (or the network). With the same area pack and the same AI setting it rides exactly the same way.'));
  }
  if (s.note) out.push(h('p', { class: 'note' }, s.note));
  out.push(h('details', {}, h('summary', { class: 'note' }, 'The link'), h('p', { class: 'note link-text' }, s.url)));
  return out;
}

// A short signature of a link, so opening the same link twice does not add the route twice.
function signature(value) {
  let x = 0;
  for (let i = 0; i < value.length; i++) x = (Math.imul(x, 31) + value.charCodeAt(i)) | 0;
  return `${value.length.toString(36)}-${(x >>> 0).toString(36)}`;
}

/** On the phone: a route link opened the app. Saves the route in Tracks; returns the track (or null). */
export async function receive() {
  const m = new RegExp(`^#${LINK_KEY}=([A-Za-z0-9_-]+)$`).exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);       // a reload does not add it again
  const app = ctx.app;
  const r = decodeRoute(m[1]);
  if (!r) { ctx.toast('That route link is broken or cut off: send it again.', { ms: 7000 }); return null; }
  const sig = signature(m[1]);
  const dup = app.tracks.find((t) => t.plan?.sent === sig);
  if (dup) {
    ctx.toast(`"${dup.name}" is already in Tracks.`, { action: 'Navigate', onAction: () => ctx.startNav({ coords: dup.fc.features[0].geometry.coordinates, track: dup }) });
    return dup;
  }
  ctx.toast(`Opening "${r.name}"…`);
  let coords, built = null, risk = null, warn = '';
  if (r.kind === 'b') {
    let G;
    try {
      G = await ctx.ensureGraph();
    } catch {
      ctx.toast('To open this route the phone needs the area pack: install it in Offline (or go online), then open the link again.', { ms: 9000 });
      return null;
    }
    const res = routeFromPoints(G, app.graphIndex, r.pts, r.closed, r.avoid);
    if (!res) { ctx.toast(`"${r.name}" is not on this phone's map (outside the riding area?).`, { ms: 7000 }); return null; }
    coords = res.coords;
    built = { pts: r.pts, closed: r.closed, avoid: r.avoid };
    risk = res.stats.risk.map((x) => x / (res.stats.len || 1));
    if (r.len && Math.abs(res.stats.len - r.len) > Math.max(100, 0.03 * r.len)) {
      warn = ` It came out ${fmtDist(res.stats.len)} here, ${fmtDist(r.len)} on the other device: the AI tracks setting or the area pack differs.`;
    }
  } else coords = r.line;
  const prof = await elevationProfile(coords, elevationAt).catch(() => null);
  const stats = { up: prof?.up ?? 0, dn: prof?.down ?? 0, climbs: prof ? steepSections(prof, 15).filter((c) => c.dir > 0) : [],
    green: risk?.[0] ?? 0, yellow: risk?.[1] ?? 0, red: risk?.[2] ?? 0 };
  const t = await savePlanned(r.name, coords, stats, { ...(built ? { built } : {}), sent: sig }, COLOR);
  await ctx.refreshTracks();
  ctx.fitCoords(coords);
  ctx.toast(`Saved "${t.name}" (${fmtDist(lineLength(coords))}) in Tracks.${warn}`,
    { action: 'Navigate', onAction: () => ctx.startNav({ coords, track: t }), ms: warn ? 12000 : 9000 });
  return t;
}
