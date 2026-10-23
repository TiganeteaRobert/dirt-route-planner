"""AI step 2: a label image per patch from what is already known - every OSM highway and every Microsoft detection drawn
as a line on the z17 pixel grid. data/ai/labels/<i>_<j>.png, two channels:
  R: 255 = road/track core, 128 = ignore band around it (OSM lines are often a few metres off), 0 = background
  G: 255 = tree cover (ESA WorldCover), where tracks are often invisible under the canopy
    uv run --with numpy --with pillow --with shapely python pipeline/ai_labels.py
"""
import json
import math
import time

import numpy as np
import shapely
from PIL import Image, ImageDraw

from ai_common import AI, LABELS, MPP, grid, gx2lon, gy2lat, lat2gy, lon2gx
from common import AREA, read_fc

# core line width in metres by class, and the ignore band on each side
WIDTH = {"motorway": 12, "trunk": 10, "primary": 9, "secondary": 8, "tertiary": 7, "unclassified": 5, "residential": 5,
         "living_street": 5, "service": 4, "road": 5, "track": 3.5, "path": 2.5, "bridleway": 2.5, "footway": 2.5,
         "cycleway": 2.5, "pedestrian": 4, "ms": 4}
SKIP = {"steps", "corridor", "platform", "elevator", "proposed", "construction", "raceway", "bus_stop"}
BAND = 6.0          # metres of "don't know" on each side of a known line


def load_lines():
    lines, widths = [], []
    for f in read_fc(AREA / "osm_highways.geojson"):
        hw = f["properties"].get("highway", "").replace("_link", "")
        if hw in SKIP:
            continue
        c = f["geometry"]["coordinates"]
        lines.append(shapely.linestrings([[lon2gx(x), lat2gy(y)] for x, y in c]))
        widths.append(WIDTH.get(hw, 3.0))
    for f in read_fc(AREA / "ms_roads.geojson"):
        c = f["geometry"]["coordinates"]
        lines.append(shapely.linestrings([[lon2gx(x), lat2gy(y)] for x, y in c]))
        widths.append(max(WIDTH["ms"], min(10.0, f["properties"].get("width") or WIDTH["ms"])))
    return np.asarray(lines, dtype=object), np.asarray(widths)


def tree_sampler():
    wc = np.load(AREA / "worldcover.npz")
    cls, (a, _, c, _, e, f) = wc["cls"], wc["transform"]

    def sample(gx, gy):
        lon = gx / (2 ** 17 * 256) * 360 - 180
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * gy / (2 ** 17 * 256)))))
        col = np.clip(((lon - c) / a).astype(int), 0, cls.shape[1] - 1)
        row = np.clip(((lat - f) / e).astype(int), 0, cls.shape[0] - 1)
        return cls[row, col] == 10
    return sample


def main():
    t0 = time.time()
    LABELS.mkdir(parents=True, exist_ok=True)
    X0, Y0, ni, nj = grid()
    lines, widths = load_lines()
    tree = shapely.STRtree(lines)
    trees = tree_sampler()
    pad = 20 / MPP
    made = 0
    # a 64 x 64 sample grid for the tree channel, scaled up to 512
    s = (np.arange(64) + 0.5) * 8
    for j in range(nj):
        for i in range(ni):
            ox, oy = (X0 + 2 * i) * 256, (Y0 + 2 * j) * 256
            box = shapely.box(ox - pad, oy - pad, ox + 512 + pad, oy + 512 + pad)
            idx = tree.query(box)
            img = Image.new("L", (512, 512), 0)
            d = ImageDraw.Draw(img)
            for k in idx:                                   # ignore bands first, cores on top
                w = (widths[k] + 2 * BAND) / MPP
                d.line([(x - ox, y - oy) for x, y in lines[k].coords], fill=128, width=max(1, round(w)), joint="curve")
            for k in idx:
                w = widths[k] / MPP
                d.line([(x - ox, y - oy) for x, y in lines[k].coords], fill=255, width=max(2, round(w)), joint="curve")
            gxs, gys = np.meshgrid(ox + s, oy + s)
            t = trees(gxs, gys).astype(np.uint8) * 255
            tree_img = Image.fromarray(t).resize((512, 512), Image.NEAREST)
            Image.merge("RGB", (img, tree_img, Image.new("L", (512, 512), 0))).save(LABELS / f"{i}_{j}.png", optimize=True)
            made += 1
        if j % 20 == 0:
            print(f"  row {j}/{nj} ({time.time() - t0:.0f} s)", flush=True)
    meta = {"X0": X0, "Y0": Y0, "ni": ni, "nj": nj, "z": 17, "mpp": MPP}
    (AI / "grid.json").write_text(json.dumps(meta))
    print(f"labels: {made} patches ({ni} x {nj}), {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
