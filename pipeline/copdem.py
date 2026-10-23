"""Copernicus DEM GLO-30 (TanDEM-X, 1 arc-second ~ 30 x 21 m here; a surface model, so it includes forest canopy)
for the area -> data/area/dem_cop.npz (elevation grid + lon/lat transform). The two 1x1 degree tiles are downloaded
to data/raw/copdem/ first (curl, ~88 MB). Sampler: CopDem().sample(lon, lat), bilinear.
    uv run --with rasterio --with numpy python pipeline/copdem.py
"""
import numpy as np

from common import AREA, BBOX, RAW, bbox_buffer

TILES = [RAW / "copdem" / f"Copernicus_DSM_COG_10_N46_00_{e}_00_DEM.tif" for e in ("E022", "E023")]


def build():
    import rasterio
    from rasterio.merge import merge

    w, s, e, n = bbox_buffer(BBOX, 2000)
    srcs = [rasterio.open(p) for p in TILES]
    arr, tr = merge(srcs, bounds=(w, s, e, n))
    for s_ in srcs:
        s_.close()
    elev = arr[0].astype(np.float32)
    np.savez_compressed(AREA / "dem_cop.npz", elev=elev, transform=np.array([tr.a, tr.b, tr.c, tr.d, tr.e, tr.f]))
    print(f"copdem {elev.shape}, {elev.min():.0f}..{elev.max():.0f} m, pixel {tr.a * 3600:.2f} x {-tr.e * 3600:.2f} arcsec")


class CopDem:
    def __init__(self):
        d = np.load(AREA / "dem_cop.npz")
        self.e = d["elev"]
        self.a, _, self.c, _, self.ee, self.f = d["transform"]

    def sample(self, lon, lat):
        col = (np.asarray(lon) - self.c) / self.a - 0.5
        row = (np.asarray(lat) - self.f) / self.ee - 0.5
        ix = np.clip(np.floor(col).astype(int), 0, self.e.shape[1] - 2)
        iy = np.clip(np.floor(row).astype(int), 0, self.e.shape[0] - 2)
        tx, ty = np.clip(col - ix, 0, 1), np.clip(row - iy, 0, 1)
        E = self.e
        return ((E[iy, ix] * (1 - tx) + E[iy, ix + 1] * tx) * (1 - ty)
                + (E[iy + 1, ix] * (1 - tx) + E[iy + 1, ix + 1] * tx) * ty)


if __name__ == "__main__":
    build()
