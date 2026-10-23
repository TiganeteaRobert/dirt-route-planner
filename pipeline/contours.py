"""Step 2c: contour lines from FABDEM (bare earth, so no canopy bumps): 20 m apart, every 100 m marked as index
-> data/area/contours.geojson. Run after fabdem.py.
    uv run --with numpy --with scipy --with contourpy --with shapely python pipeline/contours.py
"""
import math
import time

import contourpy
import numpy as np
from scipy.ndimage import gaussian_filter
from shapely.geometry import LineString

from common import AREA, write_fc

STEP, INDEX = 20, 100


def main():
    t0 = time.time()
    d = np.load(AREA / "dem_fab.npz")
    elev = d["elev"]
    a, _, c, _, e, f = d["transform"]
    sm = gaussian_filter(elev, 1.0)
    gen = contourpy.contour_generator(z=sm, line_type="Separate")
    feats = []
    lo, hi = math.ceil(float(sm.min()) / STEP) * STEP, math.floor(float(sm.max()) / STEP) * STEP
    for level in range(int(lo), int(hi) + 1, STEP):
        for line in gen.lines(level):
            if len(line) < 4:
                continue
            lon = c + (line[:, 0] + 0.5) * a
            lat = f + (line[:, 1] + 0.5) * e
            ls = LineString(np.column_stack([lon, lat])).simplify(2.5e-5)      # ~2-3 m
            if ls.length < 0.0008:                                            # drop tiny rings (< ~70 m)
                continue
            feats.append({"type": "Feature", "properties": {"ele": level, "index": level % INDEX == 0},
                          "geometry": {"type": "LineString",
                                       "coordinates": [[round(x, 6), round(y, 6)] for x, y in ls.coords]}})
    write_fc(AREA / "contours.geojson", feats)
    print(f"contours: {len(feats)} lines, {sum(len(x['geometry']['coordinates']) for x in feats)} vertices, "
          f"{time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
