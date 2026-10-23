"""Step 10: the pack manifest (data/area/pack.json: version, sizes, hashes, sources) and a copy of the pack next to
the app (app/public/pack/, gitignored) for local testing. Publishing: pipeline/README.md.
    uv run python pipeline/pack.py
"""
import hashlib
import json
import shutil
import time

from common import AREA, BBOX, ROOT

FILES = {"area": AREA / "area.pmtiles", "dem": AREA / "dem.pmtiles", "graph": AREA / "graph.json",
         "samples": AREA / "samples.json"}


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def main():
    sums = {k: sha256(p) for k, p in FILES.items()}
    version = time.strftime("%Y-%m-%d") + "." + hashlib.sha256("".join(sums.values()).encode()).hexdigest()[:6]
    extract = json.loads((AREA / "osm_extract.json").read_text())
    manifest = {
        "version": version,
        "built": int(time.time()),
        "bbox": BBOX,
        "files": {k: {"bytes": p.stat().st_size, "sha256": sums[k]} for k, p in FILES.items()},
        "sources": {
            "osm": {"what": "OpenStreetMap (Geofabrik Romania extract)", "date": time.strftime("%Y-%m-%d", time.gmtime(extract["source_mtime"])),
                    "licence": "ODbL, (c) OpenStreetMap contributors"},
            "detections": {"what": "Microsoft Road Detections (Bing imagery, mostly 2020-2022)", "licence": "ODbL"},
            "traces": {"what": "OSM public GPS traces (trackpoints API)", "licence": "ODbL / per-trace terms"},
            "landcover": {"what": "ESA WorldCover 2021 v200", "licence": "CC BY 4.0"},
            "elevation": {"what": "FABDEM V1-2 (bare-earth Copernicus GLO-30), University of Bristol", "licence": "CC BY-NC-SA 4.0"},
        },
    }
    (AREA / "pack.json").write_text(json.dumps(manifest, indent=1))
    dest = ROOT / "app" / "public" / "pack"
    dest.mkdir(parents=True, exist_ok=True)
    for k, p in FILES.items():
        shutil.copy2(p, dest / p.name)
    shutil.copy2(AREA / "pack.json", dest / "pack.json")
    total = sum(p.stat().st_size for p in FILES.values())
    print(f"pack {version}: {total / 1e6:.1f} MB -> {dest}")


if __name__ == "__main__":
    main()
