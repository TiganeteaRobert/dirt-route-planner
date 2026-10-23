"""Step 9: the app's elevation for the area - FABDEM (bare earth: no forest canopy, so no false cliffs at forest
edges) rendered as terrarium PNG tiles z8-12 (z12 = 26 m pixels, about FABDEM's own 30 m) -> data/area/dem.pmtiles.
z12 is sampled from the FABDEM grid; z11..z8 average their four children. The fractional byte is rounded to 1/16 m,
which shrinks the PNGs without changing anything visible.
FABDEM V1-2 (c) University of Bristol, CC BY-NC-SA 4.0 - so this file is shared under the same licence.
    uv run --with numpy --with scipy --with pillow --with pmtiles python pipeline/dem_tiles.py
"""
import io
import math
import time

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from common import AREA, BBOX, bbox_buffer
from copdem import CopDem

ZMIN, ZMAX = 8, 12
OUT = AREA / "dem.pmtiles"


class FabDem(CopDem):
    def __init__(self):
        d = np.load(AREA / "dem_fab.npz")
        self.e = d["elev"]
        self.a, _, self.c, _, self.ee, self.f = d["transform"]


def lon2x(lon, z):
    return (lon + 180) / 360 * 2 ** z


def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z


def encode(elev):
    v = np.clip(elev + 32768.0, 0, 65535.99)
    r = np.floor(v / 256)
    g = np.floor(v) - r * 256
    b = np.round((v - np.floor(v)) * 16) * 16
    b = np.minimum(b, 240)
    img = np.dstack([r, g, b]).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img, "RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main():
    t0 = time.time()
    dem = FabDem()
    w, s, e, n = bbox_buffer(BBOX, 2000)
    tiles = {}
    z = ZMAX
    x0, x1 = int(lon2x(w, z)), int(lon2x(e, z))
    y0, y1 = int(lat2y(n, z)), int(lat2y(s, z))
    px = (np.arange(256) + 0.5) / 256
    for ty in range(y0, y1 + 1):
        lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * (ty + px) / 2 ** z))))
        for tx in range(x0, x1 + 1):
            lon = (tx + px) / 2 ** z * 360 - 180
            LON, LAT = np.meshgrid(lon, lat)
            tiles[(z, tx, ty)] = dem.sample(LON, LAT).astype(np.float32)
    for z in range(ZMAX - 1, ZMIN - 1, -1):
        parents = {}
        for (cz, cx, cy), arr in tiles.items():
            if cz != z + 1:
                continue
            key = (z, cx // 2, cy // 2)
            if key not in parents:
                parents[key] = np.full((512, 512), np.nan, dtype=np.float32)
            parents[key][(cy % 2) * 256:(cy % 2 + 1) * 256, (cx % 2) * 256:(cx % 2 + 1) * 256] = arr
        for key, big in parents.items():
            with np.errstate(invalid="ignore"):
                small = np.nanmean(big.reshape(256, 2, 256, 2), axis=(1, 3))
            hole = ~np.isfinite(small)
            if hole.all():
                continue
            if hole.any():                      # outside the data: extend the edge values (no fake cliffs)
                idx = distance_transform_edt(hole, return_distances=False, return_indices=True)
                small = small[tuple(idx)]
            tiles[key] = small.astype(np.float32)
    with open(OUT, "wb") as fh:
        wr = Writer(fh)
        size = 0
        for (z, x, y) in sorted(tiles, key=lambda k: zxy_to_tileid(*k)):
            data = encode(tiles[(z, x, y)])
            size += len(data)
            wr.write_tile(zxy_to_tileid(z, x, y), data)
        cx, cy = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2
        wr.finalize({"tile_type": TileType.PNG, "tile_compression": Compression.NONE, "min_zoom": ZMIN, "max_zoom": ZMAX,
                     "min_lon_e7": int(w * 1e7), "min_lat_e7": int(s * 1e7), "max_lon_e7": int(e * 1e7),
                     "max_lat_e7": int(n * 1e7), "center_zoom": 10, "center_lon_e7": int(cx * 1e7),
                     "center_lat_e7": int(cy * 1e7)},
                    {"name": "DirtScout elevation (FABDEM)", "encoding": "terrarium", "version": time.strftime("%Y-%m-%d"),
                     "attribution": "FABDEM V1-2 © University of Bristol (CC BY-NC-SA 4.0), from Copernicus DEM GLO-30"})
    print(f"{OUT.name}: {len(tiles)} tiles, {OUT.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
