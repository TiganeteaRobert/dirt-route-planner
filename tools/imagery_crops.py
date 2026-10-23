"""M5 imagery check: one picture per flagged stretch of an investigation (tools/investigate.mjs), from Microsoft Earth
and/or Esri at z18 (~0.4 m/px), with the track in red, the mapped ways of the area pack in white and the way
around (if any) in cyan. Tiles are cached in data/raw/imagery/; the pictures stay in the report folder under
private/ - the imagery terms do not allow sharing them.
    uv run --with pillow python tools/imagery_crops.py private/reports/<name> [--z 18] [--source bing|esri|both]
"""
import io
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "raw" / "imagery"
UA = "DirtScout-investigate/0.1 (personal dirt-bike planner)"
URLS = {
    "bing": "https://tiles.virtualearth.net/tiles/a{q}.jpg?g=45",
    "esri": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
}


def lon2x(lon, z):
    return (lon + 180) / 360 * 2 ** z


def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z


def quadkey(x, y, z):
    return "".join(str((1 if x & (1 << (i - 1)) else 0) + (2 if y & (1 << (i - 1)) else 0)) for i in range(z, 0, -1))


def tile(src, z, x, y):
    p = CACHE / src / str(z) / str(x) / f"{y}.jpg"
    if p.exists():
        return Image.open(p).convert("RGB")
    p.parent.mkdir(parents=True, exist_ok=True)
    url = URLS[src].format(q=quadkey(x, y, z), z=z, x=x, y=y)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                data, ctype = r.read(), r.headers.get("content-type", "")
            if "png" in ctype and src == "bing":          # Bing "no imagery here"
                return Image.new("RGB", (256, 256), (60, 60, 60))
            p.write_bytes(data)
            time.sleep(0.15)
            return Image.open(io.BytesIO(data)).convert("RGB")
        except Exception:  # noqa: BLE001
            time.sleep(2 ** attempt)
    return Image.new("RGB", (256, 256), (90, 30, 30))


def load_edges(bbox):
    path = ROOT / "data" / "area" / "edges.geojson"
    out = []
    with open(path, encoding="utf-8") as f:
        for feat in json.load(f)["features"]:
            c = feat["geometry"]["coordinates"]
            if any(bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3] for x, y in c[:: max(1, len(c) // 20)] + [c[-1]]):
                out.append(c)
    return out


def main():
    rep = Path(sys.argv[1])
    z = int(sys.argv[sys.argv.index("--z") + 1]) if "--z" in sys.argv else 18
    srcs = ["bing", "esri"] if "--source" not in sys.argv or sys.argv[sys.argv.index("--source") + 1] == "both" \
        else [sys.argv[sys.argv.index("--source") + 1]]
    data = json.loads((rep / "flags.json").read_text())
    track = data["track"]
    for fl in data["flags"]:
        w, s, e, n = fl["bbox"]
        pad_lat = 80 / 111000
        pad_lon = pad_lat / math.cos(math.radians((s + n) / 2))
        w, s, e, n = w - pad_lon, s - pad_lat, e + pad_lon, n + pad_lat
        x0, x1 = int(lon2x(w, z)), int(lon2x(e, z))
        y0, y1 = int(lat2y(n, z)), int(lat2y(s, z))
        if (x1 - x0 + 1) * (y1 - y0 + 1) > 120:
            print(f"flag {fl['n']}: too big for z{z}, skipped")
            continue
        edges = load_edges((w, s, e, n))
        for src in srcs:
            img = Image.new("RGB", ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    img.paste(tile(src, z, x, y), ((x - x0) * 256, (y - y0) * 256))
            px = lambda c: ((lon2x(c[0], z) - x0) * 256, (lat2y(c[1], z) - y0) * 256)
            d = ImageDraw.Draw(img)
            for c in edges:
                d.line([px(p) for p in c], fill=(255, 255, 255), width=2)
            for alt in data.get("alternatives", []):
                d.line([px(p) for p in alt], fill=(0, 229, 255), width=4)
            d.line([px(p) for p in track], fill=(255, 30, 30), width=4)
            out = rep / f"flag-{fl['n']}-{fl['kind']}-{src}.jpg"
            img.save(out, quality=88)
            print(f"flag {fl['n']} ({fl['kind']}, km {fl['fromKm']:.2f}-{fl['toKm']:.2f}): {out.name} {img.size}")


if __name__ == "__main__":
    main()
