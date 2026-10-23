import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { registerProtocols } from './tiles.js';
import { initPacks } from './pack.js';
import { createMap, applyLayers, setTracks, setRecLine, setAi, MeMarker } from './mapview.js';
import { loadStored as loadAi } from './aibundle.js';
import { initUI, toast } from './ui.js';
import { listTracks, mapData } from './tracks.js';
import { downloader } from './downloads.js';
import { recorder } from './gps.js';
import { settings } from './settings.js';
import * as db from './db.js';
import * as wake from './wakelock.js';

// MapLibre 6 looks for its worker next to its own module; in the bundle it lives under assets/.
setWorkerUrl(workerUrl);
registerProtocols();
await initPacks();          // the area pack's pmtiles:// sources must exist before the map asks for them

const app = {
  version: __APP_VERSION__,
  map: createMap('map'),
  tracks: [],
  stats: {},
  installPrompt: null,
};
app.me = new MeMarker(app.map);
app.refreshTracks = async () => {
  app.tracks = await listTracks();
  setTracks(app.map, mapData(app.tracks));
};
window.dirtscout = app;          // handy from the console when debugging on the phone, and for the e2e tests
app.debug = { downloader, recorder, db, settings, applyLayers };
app.ai = await loadAi();          // the owner's private AI layer, when it was unlocked on this phone

initUI(app);

app.map.on('load', async () => {
  if (app.ai) setAi(app.map, app.ai.ai);
  applyLayers(app.map);
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');   // start folded
  app.stats = await db.tileStats().catch(() => ({}));
  await app.refreshTracks().catch((e) => console.warn('tracks', e));
  await downloader.init();
  downloader.next();
  if (await recorder.resume()) {
    app.recLine = await recorder.points();
    setRecLine(app.map, app.recLine);
    app.follow = true;
    toast('Your recording continues.');
  }
  if (settings.keepAwake) wake.want('user', true);
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  app.installPrompt = e;
});

// App shell for offline use (production build only; the dev server stays uncached).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state !== 'installed' || !navigator.serviceWorker.controller) return;
        toast('A new version of DirtScout is ready.', {
          action: 'Update',
          onAction: () => {
            if (recorder.on && !confirm('You are recording. Update now? The recording continues after the reload.')) return;
            app.updateAccepted = true;
            w.postMessage('skip-waiting');
          },
        });
      });
    });
  }).catch((e) => console.warn('service worker', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (app.updateAccepted) location.reload();
  });
}
