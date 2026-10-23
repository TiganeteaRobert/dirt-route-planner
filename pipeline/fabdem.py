"""FABDEM V1-2 (Hawker et al. 2022, University of Bristol; CC BY-NC-SA 4.0): Copernicus GLO-30 with forests and
buildings removed - a bare-earth model, so grades along tracks are not thrown off where a track enters a forest.
The data comes as 10x10 degree zips (ours is 2.1 GB); the server allows byte ranges, so only the zip's index and the two
1x1 degree tiles we need are downloaded (to data/raw/fabdem/). Then mosaicked like copdem.py -> data/area/dem_fab.npz.
    uv run --with rasterio --with numpy python pipeline/fabdem.py
"""
import io
import urllib.request
import zipfile

import numpy as np

from common import AREA, BBOX, RAW, UA, bbox_buffer

ZIP_URL = "https://data.bris.ac.uk/datasets/s5hqmjcdj8yo2ibzi9b4ew3sn/N40E020-N50E030_FABDEM_V1-2.zip"
NAMES = ["N46E022_FABDEM_V1-2.tif", "N46E023_FABDEM_V1-2.tif"]
DIR = RAW / "fabdem"


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP byte ranges (enough for zipfile)."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={"User-Agent": UA, "Range": f"bytes={self.pos}-{end}"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def download():
    DIR.mkdir(parents=True, exist_ok=True)
    todo = [n for n in NAMES if not (DIR / n).exists()]
    if not todo:
        return
    with zipfile.ZipFile(io.BufferedReader(HttpRangeFile(ZIP_URL), buffer_size=4 * 1024 * 1024)) as z:
        names = z.namelist()
        for want in todo:
            match = [n for n in names if n.endswith(want)]
            if not match:
                raise SystemExit(f"{want} not in the zip; it has e.g. {names[:5]}")
            info = z.getinfo(match[0])
            print(f"extracting {match[0]} ({info.compress_size / 1e6:.0f} MB)", flush=True)
            with z.open(info) as src, open(DIR / want, "wb") as dst:
                while chunk := src.read(8 * 1024 * 1024):
                    dst.write(chunk)


def build():
    import rasterio
    from rasterio.merge import merge

    w, s, e, n = bbox_buffer(BBOX, 2000)
    srcs = [rasterio.open(DIR / p) for p in NAMES]
    arr, tr = merge(srcs, bounds=(w, s, e, n))
    for s_ in srcs:
        s_.close()
    elev = arr[0].astype(np.float32)
    bad = elev < -1000                      # no-data (the merge window runs one pixel past the tiles' east edge)
    if bad.any():
        from scipy.ndimage import distance_transform_edt
        idx = distance_transform_edt(bad, return_distances=False, return_indices=True)
        elev = elev[tuple(idx)]
    np.savez_compressed(AREA / "dem_fab.npz", elev=elev, transform=np.array([tr.a, tr.b, tr.c, tr.d, tr.e, tr.f]))
    print(f"fabdem {elev.shape}, {elev.min():.0f}..{elev.max():.0f} m")


if __name__ == "__main__":
    download()
    build()
