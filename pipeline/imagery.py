"""AI step 1: Esri World Imagery tiles for the whole riding area at one zoom (default z17, ~0.8 m/px), for training
and running the track detector. Kept in data/raw/imagery/esri/<z>/<x>/<y>.jpg (shared with tools/imagery_crops.py);
re-runs only fetch what is missing. Local only: the imagery terms do not allow sharing these tiles or anything that
reproduces them. The owner approved this bulk download for personal use (2026-10-23).
    uv run python pipeline/imagery.py [z=17] [threads=6, at most 6]
"""
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from common import BBOX, RAW, UA, bbox_buffer

URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
CACHE = RAW / "imagery" / "esri"


def lon2x(lon, z):
    return (lon + 180) / 360 * 2 ** z


def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z


def tile_range(z):
    w, s, e, n = bbox_buffer(BBOX, 200)
    return int(lon2x(w, z)), int(lon2x(e, z)), int(lat2y(n, z)), int(lat2y(s, z))


def fetch(job):
    z, x, y = job
    p = CACHE / str(z) / str(x) / f"{y}.jpg"
    if p.exists() and p.stat().st_size > 0:
        return 0, 0
    p.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(6):
        try:
            req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            p.write_bytes(data)
            return 1, len(data)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 0, 0
            time.sleep(2 ** attempt)
        except Exception:  # noqa: BLE001
            time.sleep(2 ** attempt)
    return -1, 0


def main():
    z = int(sys.argv[1]) if len(sys.argv) > 1 else 17
    threads = min(6, int(sys.argv[2]) if len(sys.argv) > 2 else 6)        # CLAUDE.md: at most 6 parallel requests
    x0, x1, y0, y1 = tile_range(z)
    jobs = [(z, x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    print(f"z{z}: {len(jobs)} tiles ({x1 - x0 + 1} x {y1 - y0 + 1}), {threads} threads", flush=True)
    t0, got, size, failed = time.time(), 0, 0, 0
    with ThreadPoolExecutor(threads) as pool:
        for i, (ok, n) in enumerate(pool.map(fetch, jobs), 1):
            got += ok > 0
            failed += ok < 0
            size += n
            if i % 2000 == 0:
                rate = got / max(1, time.time() - t0)
                print(f"  {i}/{len(jobs)} checked, {got} new ({size / 1e6:.0f} MB), {failed} failed, "
                      f"{rate:.1f} tiles/s, {time.time() - t0:.0f} s", flush=True)
    print(f"done: {got} new tiles, {size / 1e6:.0f} MB, {failed} failed, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
