# DirtScout

An offline dirt-bike map for one riding area: Cluj-Napoca west across the Apuseni mountains, past Lake
Beliș-Fântânele to the Bihor heights, south to Aiud. An installable web app for Android (Chrome), built to work in airplane mode.

**App:** https://tiganetearobert.github.io/dirt-route-planner/

## What it does

- **Maps:** Microsoft Earth (Bing aerial), Microsoft Hybrid and Esri World Imagery, which you can save to the phone. OpenStreetMap,
  OpenTopoMap and CyclOSM are online only.
- **Overlays:** riding-area outline, hillshade and slope shading. Both are computed on the phone from saved elevation tiles,
  so they work offline. Waymarked MTB/hiking routes and OSM public GPS traces are online only.
- **Offline maps:** save tiles for the whole riding area, for what is on screen, or along a track with a buffer, for a chosen
  zoom range. You see the tile count and size before starting. Downloads can be paused, resumed or cancelled, tiles
  already saved are skipped, 4-6 requests run at a time with backoff, and the screen stays on while downloading. With no
  network, zoom levels that were not saved are filled in by stretching the closest saved level.
- **GPS:** position, accuracy circle, heading and follow mode. Ride recording is crash-safe, shows live time, distance,
  speed and climb, and exports to GPX (Android share sheet or download).
- **Tracks:** import GPX/KML files (Wikiloc, TET, ACT, your own). Every track stays on the phone.
- **Checks:** a source check (one tile per map server) and device checks (installed, offline-ready, storage protected,
  keep-screen-on, location permission).
- **Area pack (M2):** DirtScout's own map, built on the PC from open data (`pipeline/`): a topo base (forest, water,
  villages, 20 m contours, peaks, springs, huts, gates and fords) and every track and path with its evidence. The
  evidence is:
  - seen from above (Microsoft road detections),
  - public GPS traces,
  - tree cover,
  - steepness from bare-earth elevation (FABDEM),
  - hiking/MTB route membership, access tags and OSM edit history.

  Tracks can be coloured by each piece of evidence. Tap a track to see everything known about it. It is about 40 MB and
  installs in the Offline panel to work in airplane mode.
- **Risk colours (M3):** every track gets a verdict (likely fine / uncertain or demanding / doubtful or hard), plus a
  flag where motors are not allowed. Its reasons show in the track card. The weights are a starting point, to be tuned
  with real rides.
- **Plan (M4):** "a 4 km loop with some hill climbs" from your position, the map centre or a tapped point. You can
  ask for a loop or an out-and-back ride, 2-60 km, 0-3 climbs steeper than 12-25 %, with red tracks avoided and dirt
  preferred over tarmac. It returns up to five different routes with climb, dirt share and risk mix, to show, save
  or export as GPX. Ten sample rides around Cluj come with the area pack for your review.
- **Roads no map has:** 705 km of roads that Microsoft's AI saw in Bing imagery but OpenStreetMap lacks are part of
  the map and the planner. They show as cyan dashes, marked as unverified (yellow) until GPS traces back them up.
  For anything else: **Tracks → Draw a road on the map**. Tap where the road starts and where it bends or ends; the
  line follows the pale track in the satellite imagery between taps. Taps near a mapped track snap onto it. Your road
  then counts in Plan and Investigate. Any recorded ride can also be marked "Use as a road".
- **Investigate (M5):** on any track (Wikiloc, TET, a plan, your ride), DirtScout map-matches it to the network. It
  colours each stretch (fine / doubtful / not on any mapped way), lists climbs, steep descents and risky stretches with
  km markers, and finds ways around the red stretches. On the PC, `tools/investigate.mjs` and
  `tools/imagery_crops.py` add an imagery check of the flagged stretches.
- **Navigate:** ride any route (a saved track, a Plan route, your own route) with the phone on the handlebar.
  - **Getting there:** away from the route, the banner shows the way to its start, with buttons that open Google Maps or
    Waze for the drive.
  - **On the route:** the next turn at each junction comes with its distance (turn, bear, keep left or right at a fork,
    turn around), plus the steep stretches ahead and the km and climb left. Off the route, an arrow points back to it.
  - **Camera:** north up, heading up (the map turns with you), or 3D from behind and above.
  - **Quick buttons:** the base map (satellite, topo, or none) and the overlays (tracks, AI tracks, hillshade, slope,
    contours, places), zoom, and the ride recording, which starts by itself at the start of the route.
  - **Edit on the spot:** the route opens with a dot where you are. Drag a dot onto another track, or tap Avoid and then
    a stretch, and the route goes around it. Continue rides the new route.
  - **A reload:** the ride carries on.
- **3D terrain (PC):** tilt and turn the map over the relief, with a slider that raises it (x1 to x5) so the steep
  ground and the valleys read at a glance. Heights come from the ~30 m model.

## Install on Android

1. Open the app link in **Chrome**.
2. Tap menu ⋮ → **Install app** (or "Add to Home screen"), or use the Install button under More.
3. Open DirtScout from the home screen. Go to Offline → **Install the area pack** (about 50 MB), then **Whole area
   overview** → Start download (about 0.6-0.8 GB of imagery, on Wi-Fi).
4. For riding detail, import a track and use **Save detail offline** on it (z17-18 along the track).
5. Test in airplane mode: the app opens and shows the saved imagery, slope and your GPS position.

Keep DirtScout on screen while riding. Android can pause web-app GPS when the screen is off or another app is in front.

## Data sources and terms

| Source | Use in DirtScout |
|---|---|
| Microsoft Earth / Hybrid (Bing Maps) | Can be saved for personal use. Bing's terms do not allow caching; the owner accepted that risk. Never shared. |
| Esri World Imagery | Same as Bing. Esri's terms only allow offline use through Esri's own apps; the owner accepted that risk. |
| OpenStreetMap, OpenTopoMap, CyclOSM, Waymarked Trails, OSM GPS traces | Online only. Their volunteer servers forbid bulk or offline download. |
| FABDEM (bare-earth Copernicus DEM, University of Bristol) | Elevation in the area pack: hillshade, slope, contours, grades. CC BY-NC-SA 4.0 (non-commercial). |
| Terrain Tiles (Mapzen/Tilezen on AWS Open Data) | Elevation outside the area pack. Open data. |
| Microsoft Road Detections, ESA WorldCover, OSM GPS traces | Evidence in the area pack. ODbL / CC BY 4.0. |
| TET / ACT GPX | Imported on the phone only. Their terms forbid redistribution, so they never enter this repository. |

The elevation model has ~25-30 m pixels. Short steep pitches (10-20 m) do not show in the slope shading, so a clear
slope map does not prove that a climb is rideable.

## Development

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (core/: tile math, corridors, GPX/KML)
npm run e2e        # build + phone emulation in the local Chrome (download, airplane mode, GPS, recording, import)
node tests/e2e/m2.e2e.mjs   # area pack; m4 = Plan, m5 = Investigate (all take E2E_URL=https://... for the live site)
node tools/investigate.mjs track.gpx          # report + ways around in private/reports/<name>/
uv run --with pillow python tools/imagery_crops.py private/reports/<name>   # imagery of the flagged stretches
```

- `core/`: plain ES modules with no DOM, shared by the app and the Node data pipeline (tile math, GPX, scoring).
- `app/`: the PWA (MapLibre GL JS 6, IndexedDB tile store, service worker, PMTiles area pack).
- `pipeline/`: builds the area pack from open data; see [pipeline/README.md](pipeline/README.md).

Pushing to `main` deploys to GitHub Pages.

Roadmap: tune the risk colours and route costs with real rides, then M6, a batch of 100 tracks (`tools/samples.mjs`
already makes the review set).

Map data © OpenStreetMap contributors (ODbL). Imagery © Microsoft, © Esri and its providers. Road detections ©
Microsoft (ODbL). WorldCover © ESA 2021 (CC BY 4.0). Elevation: FABDEM V1-2 © University of Bristol (CC BY-NC-SA 4.0).
Fonts: Noto Sans (SIL OFL 1.1).
