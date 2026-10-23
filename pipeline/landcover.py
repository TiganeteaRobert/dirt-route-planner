"""Step 4: ESA WorldCover 2021 v200 (10 m, CC BY 4.0) for the area, read as a window of the cloud-optimised GeoTIFF
over HTTP (no full 77 MB download) -> data/area/worldcover.npz (class grid + its lon/lat transform).
Class 10 = tree cover, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare, 80 water.
    uv run --with rasterio --with numpy python pipeline/landcover.py
"""
import time

import numpy as np
import rasterio
from rasterio.windows import from_bounds

from common import AREA, BBOX, bbox_buffer

URL = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
       "ESA_WorldCover_10m_2021_v200_N45E021_Map.tif")


def main():
    t0 = time.time()
    w, s, e, n = bbox_buffer(BBOX, 500)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
        with rasterio.open("/vsicurl/" + URL) as src:
            win = from_bounds(w, s, e, n, src.transform).round_offsets().round_lengths()
            cls = src.read(1, window=win)
            tr = src.window_transform(win)
    np.savez_compressed(AREA / "worldcover.npz", cls=cls, transform=np.array([tr.a, tr.b, tr.c, tr.d, tr.e, tr.f]))
    vals, counts = np.unique(cls, return_counts=True)
    share = {int(v): round(100 * c / cls.size, 1) for v, c in zip(vals, counts)}
    print(f"worldcover {cls.shape}, class shares %: {share}, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
