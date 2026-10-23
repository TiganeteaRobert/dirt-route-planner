# Area pack pipeline (M2)

Builds DirtScout's own map and the evidence for every track in the riding area. It runs on the PC with `uv`; no
Java, GDAL or osmium CLI is needed. Steps 2-5 can run in any order once step 1 has run.

| Step | Script | Input | Output (data/area/) |
|---|---|---|---|
| 0 | download by hand (see below) | | data/raw/romania-latest.osm.pbf, ROU.parquet |
| 1 | `osm_extract.py` | Geofabrik Romania pbf | osm_highways / waterways / areas / points / routes .geojson |
| 2 | `fabdem.py` | FABDEM V1-2 (2 tiles out of the 2.1 GB zip, by byte ranges) | dem_fab.npz |
| 2c | `contours.py` | dem_fab.npz | contours.geojson |
| 3 | `detections.py` | Microsoft Road Detections ROU.parquet | ms_roads.geojson |
| 4 | `landcover.py` | ESA WorldCover 2021 (window of the remote COG) | worldcover.npz |
| 5 | `traces.py` | OSM API trackpoints (0.1 degree grid, busy cells split) | traces.npz |
| 6 | `graph.py` | osm_highways | edges.geojson (routable ways split at junctions) |
| 7 | `evidence.py` | edges + 2-5 | edges_evidence.geojson, evidence_summary.json |
| 7b | `score.mjs` (Node) | edges_evidence + core/scoring.js | edge_scores.json (exists, class, level, legal) |
| 8 | `build_tiles.py` | everything above | area.pmtiles (vector tiles z8-14) |
| 8b | `graph_pack.py` | edges_evidence + edge_scores | graph.json (routing graph for the phone) |
| 9 | `dem_tiles.py` | dem_fab.npz | dem.pmtiles (terrarium z8-12) |
| 9b | `../tools/samples.mjs` | graph.json, osm_points | samples.json (sample rides for review) |
| 10 | `pack.py` | area, dem, graph, samples | pack.json, copy in app/public/pack/ |

```
cd pipeline
curl -L -o ../data/raw/romania-latest.osm.pbf https://download.geofabrik.de/europe/romania-latest.osm.pbf
curl -L -o ../data/raw/ROU.parquet https://data.source.coop/nlebovits/microsoft-ml-road-detections/road-detections/by_country/country=ROU/ROU.parquet
uv run --with osmium python osm_extract.py
uv run --with rasterio --with numpy --with scipy python fabdem.py
uv run --with numpy --with scipy --with contourpy --with shapely python contours.py
uv run --with duckdb --with shapely python detections.py
uv run --with rasterio --with numpy python landcover.py
uv run --with numpy python traces.py        # slow (Cluj is dense); --from-cache builds traces.npz from pages so far
uv run python graph.py
uv run --with numpy --with scipy --with shapely python evidence.py
node score.mjs
uv run --with numpy --with shapely --with mapbox-vector-tile --with pmtiles python build_tiles.py
uv run python graph_pack.py
node ../tools/samples.mjs
uv run --with numpy --with scipy --with pillow --with pmtiles python dem_tiles.py
uv run python pack.py
```

## Publishing a new pack

The pack is not committed. It is a GitHub release asset that the Pages workflow copies into `dist/pack/`:

```
gh release create pack-<version> data/area/area.pmtiles data/area/dem.pmtiles data/area/graph.json data/area/samples.json data/area/pack.json --title "Area pack <version>" --notes "..."
```

The workflow always takes the newest release whose tag starts with `pack-`. Re-run the workflow after uploading.

## AI-found tracks (private)

A U-Net (ResNet-34 encoder) trained on Esri World Imagery z17 (~0.8 m/px) finds tracks that neither OSM nor
Microsoft's detections have. Its lines are derived from Esri imagery, so they are never published as they are: the
phone gets them in `ai.enc`, encrypted with the owner's passphrase (`private/ai_passphrase.txt`). The imagery tiles stay
in `data/raw/imagery/` and are never shared. GPU steps run in `.venv-ml` (Python 3.12, torch 2.11.0+cu128,
segmentation-models-pytorch 0.5.0); set `TORCH_HOME` to a folder on E: so the ImageNet weights do not land on C:.

| Step | Script | Output (data/ai/) |
|---|---|---|
| A1 | `imagery.py 17` | data/raw/imagery/esri/17 (~100k tiles, 1.1 GB, at most 6 parallel requests) |
| A2 | `ai_labels.py` | labels/ (known lines + ignore band + tree cover per 512 px patch), grid.json |
| A3 | `ai_train.py <fold>` | model_f0-2.pt: cross-fitting, each model never trains on its own fold (~6.5 km blocks) |
| A4 | `ai_infer.py [fold]` | pred/ (probability per patch; each fold predicted by its own model) |
| A5 | `ai_vectorize.py` | ai_lines.geojson: lines not within 15 m of a known road, each with a score (model strength x how track-like the imagery is across it); traced pieces cached in pieces_*.npz |
| A6 | `DS_AI=1` graph.py, evidence.py, score.mjs, graph_pack.py | edges / evidence / scores / graph.json with class `ai` |
| A7 | `ai_bundle.py` | ai.enc (AES-256-GCM, PBKDF2 key): meta, the gzipped graph, the lines as vector tiles z12-14; a copy in app/public/pack/ |

```
cd pipeline
uv run python imagery.py 17 6
uv run --with numpy --with pillow --with shapely python ai_labels.py
../.venv-ml/Scripts/python ai_train.py 0      # two folds fit side by side on the 8 GB GPU (RAM is the limit)
../.venv-ml/Scripts/python ai_train.py 1
../.venv-ml/Scripts/python ai_train.py 2
../.venv-ml/Scripts/python ai_infer.py
uv run --with numpy --with scipy --with shapely --with scikit-image --with pillow python ai_vectorize.py   # DS_AI_DEBUG=1: dropped lines too
DS_AI=1 uv run python graph.py
DS_AI=1 uv run --with numpy --with scipy --with shapely python evidence.py
DS_AI=1 node score.mjs
DS_AI=1 uv run python graph_pack.py
uv run --with cryptography --with numpy --with shapely --with mapbox-vector-tile --with pmtiles python ai_bundle.py
gh release upload pack-<version> ../data/ai/ai.enc --clobber     # then re-run the Pages workflow
```

The score was set on hand-labelled lines (2026-10-24): at the app's default (0.4) about 4 in 5 shown lines were real
tracks on a fresh sample, below it mostly field and forest edges. Re-runs that only change steps after the tracing
read the cached pieces (minutes instead of ~15); delete pieces_*.npz after a new inference.

The bundle carries a whole routing graph, so it keeps working when the public pack changes; rebuild it (A6-A7) with
each new pack so both use the same OSM data, and upload it to the newest `pack-*` release (the workflow serves `*.enc`).

## What the evidence means (and does not)

- **Grades** come from FABDEM, a bare-earth version of Copernicus GLO-30, smoothed over 30 m. They were tested on
  2026-10-23: main roads, which really stay under about 10-12 %, read p90 about 10 % and p99 15-20 %. Treat grades as
  approximate. A 30 m model cannot see a short steep pitch.
- **Seen from above** means Microsoft's model found a road there in Bing imagery (mostly 2020-2022). When it is
  missing, nothing is proven: forest canopy hides tracks, and the coverage has holes.
- **GPS traces** are public OSM trace points within 15 m. Every point counts toward its nearest edge only.
- **Forest** is the ESA WorldCover 2021 tree-cover share within 30 m.
