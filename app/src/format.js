// Number formatting in the chosen units, plus a tiny DOM builder (text is always set as text, never as HTML).
import { settings } from './settings.js';

const imperial = () => settings.units === 'imperial';

export function fmtDist(m) {
  if (m == null || !Number.isFinite(m)) return '–';
  if (imperial()) {
    const mi = m / 1609.344;
    return mi < 0.1 ? `${Math.round(m * 3.28084)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export const fmtSpeed = (mps) => (mps == null || !Number.isFinite(mps) ? '–'
  : imperial() ? `${Math.round(mps * 2.23694)} mph` : `${Math.round(mps * 3.6)} km/h`);

export const fmtElev = (m) => (m == null || !Number.isFinite(m) ? '–'
  : imperial() ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`);

export function fmtBytes(b) {
  if (!Number.isFinite(b)) return '–';
  if (b < 1024 * 1024) return `${Math.max(0, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

// replaceChildren that skips null/false (replaceChildren itself would print them as text).
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate']);

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
