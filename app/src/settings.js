// User settings, kept in localStorage (small and read synchronously at start-up, so the map opens where it was left).
import { DEFAULT_AREA } from './config.js';

const KEY = 'dirtscout.settings.v1';

const DEFAULTS = {
  area: DEFAULT_AREA,
  base: 'ms-earth',
  overlays: {
    area: { on: true, opacity: 1 },
    hillshade: { on: false, opacity: 0.5 },
    slope: { on: false, opacity: 0.75 },
    'wmt-mtb': { on: false, opacity: 0.9 },
    'wmt-hiking': { on: false, opacity: 0.9 },
    'osm-gps': { on: false, opacity: 0.8 },
    'ds-tracks': { on: true, opacity: 1 },
    'ds-unmapped': { on: true, opacity: 1 },
    'ds-ai': { on: true, opacity: 1 },
    'ds-pois': { on: true, opacity: 1 },
    'ds-places': { on: true, opacity: 1 },
    'ds-routes': { on: false, opacity: 0.55 },
    'ds-detections': { on: false, opacity: 0.85 },
    'ds-contours': { on: false, opacity: 1 },
    'ds-protected': { on: false, opacity: 1 },
  },
  colorBy: 'risk',            // how the DirtScout tracks are coloured (see dsstyle.js COLOR_MODES)
  aiMin: 0.5,                 // AI-found tracks: show and route on those the model is at least this sure of (0.3-0.95)
  units: 'metric',
  bingHost: 'tiles',          // 'tiles' = tiles.virtualearth.net, 'ecn' = ecn.t0-3.tiles.virtualearth.net
  saveBrowse: false,          // also store tiles seen while browsing online
  offlineOnly: false,         // never use the network for map tiles
  concurrency: 4,             // parallel downloads (the plan allows 4-6)
  keepAwake: false,
  view: null,                 // {center, zoom, bearing}
};

function merge(a, b) {
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v);
    else a[k] = v;
  }
  return a;
}

function load() {
  try {
    return merge(structuredClone(DEFAULTS), JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings = load();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked: settings last this session */ }
}

export const defaultArea = () => [...DEFAULT_AREA];
