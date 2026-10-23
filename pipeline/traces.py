"""Step 5: OSM public GPS traces ("people actually went here") from the OSM API trackpoints call.

Deep paging times out on the API side (page ~60 gives "503 first byte timeout"), so the area is cut into a 0.1 degree
grid and any cell that needs more than MAX_PAGES pages (5000 points each) or keeps failing is split in four.
A pause between calls keeps the load polite. Raw pages are kept in data/raw/traces/ (a re-run only fetches what is
missing) -> data/area/traces.npz (lon, lat, trace id; -1 = anonymous point, whose order the API scrambles).
    uv run --with numpy python pipeline/traces.py
"""
import re
import time
import urllib.error
import urllib.request

import numpy as np

from common import AREA, BBOX, RAW, UA

API = "https://api.openstreetmap.org/api/0.6/trackpoints?bbox={l:.5f},{b:.5f},{r:.5f},{t:.5f}&page={p}"
CACHE = RAW / "traces"
CACHE.mkdir(parents=True, exist_ok=True)
GRID = 0.1
MAX_PAGES = 20
TRK = re.compile(r"<trk>(.*?)</trk>", re.S)
PT = re.compile(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)"')
URL_RE = re.compile(r"<url>[^<]*?/traces/(\d+)</url>")


class TooDeep(Exception):
    pass


def get_page(key, cell, p):
    f = CACHE / f"{key}_p{p:03d}.gpx"
    if f.exists():
        return f.read_text(encoding="utf-8")
    url = API.format(l=cell[0], b=cell[1], r=cell[2], t=cell[3], p=p)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=90) as r:
                text = r.read().decode("utf-8")
            f.write_text(text, encoding="utf-8")
            time.sleep(1.0)
            return text
        except urllib.error.HTTPError as e:
            if e.code in (503, 504) and p > 0:
                raise TooDeep(f"{key} page {p}: HTTP {e.code}") from e
            print(f"  {key} page {p}: HTTP {e.code}, retry", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"  {key} page {p}: {e}, retry", flush=True)
        time.sleep(10 * 2 ** attempt)
    raise TooDeep(f"{key} page {p} failed 4 times")


def parse(text, lon, lat, tid):
    n = 0
    for trk in TRK.findall(text):
        m = URL_RE.search(trk)
        t = int(m.group(1)) if m else -1
        for a, b in PT.findall(trk):
            lat.append(float(a)); lon.append(float(b)); tid.append(t)
            n += 1
    return n


def from_cache():
    """Builds traces.npz from the pages already downloaded, using only leaf cells (a cell split into a/b/c/d is
    replaced by its children), so nothing is counted twice. For a quick pack while the full download runs."""
    pages = {}
    for f in CACHE.glob("*_p*.gpx"):
        key, p = f.stem.rsplit("_p", 1)
        pages.setdefault(key, []).append((int(p), f))
    keys = set(pages)
    leaves = [k for k in keys if not any(k + c in keys for c in "abcd")]
    lon, lat, tid = [], [], []
    for k in leaves:
        for _, f in sorted(pages[k]):
            parse(f.read_text(encoding="utf-8"), lon, lat, tid)
    np.savez_compressed(AREA / "traces.npz", lon=np.array(lon), lat=np.array(lat), tid=np.array(tid, dtype=np.int64))
    print(f"traces from cache: {len(lon)} points from {len(leaves)} leaf cells ({len(keys) - len(leaves)} split cells skipped)")


def main():
    t0 = time.time()
    w, s, e, n = BBOX
    queue = []
    nx, ny = int(np.ceil((e - w) / GRID)), int(np.ceil((n - s) / GRID))
    for j in range(ny):
        for i in range(nx):
            queue.append((f"g{j:02d}_{i:02d}", (w + i * GRID, s + j * GRID, min(e, w + (i + 1) * GRID), min(n, s + (j + 1) * GRID))))
    lon, lat, tid = [], [], []
    requests = 0
    done = 0
    while queue:
        key, cell = queue.pop(0)
        texts = []
        try:
            for p in range(MAX_PAGES):
                text = get_page(key, cell, p)
                requests += 1
                texts.append(text)
                if text.count("<trkpt") < 5000:
                    break
            else:
                raise TooDeep(f"{key}: more than {MAX_PAGES} pages")
        except TooDeep as ex:
            print(f"  split {key} ({ex})", flush=True)
            l, b, r, t = cell
            mx, my = (l + r) / 2, (b + t) / 2
            queue[0:0] = [(f"{key}a", (l, b, mx, my)), (f"{key}b", (mx, b, r, my)),
                          (f"{key}c", (l, my, mx, t)), (f"{key}d", (mx, my, r, t))]
            continue
        got = sum(parse(tx, lon, lat, tid) for tx in texts)
        done += 1
        if done % 10 == 0 or got > 20000:
            print(f"{key}: {got} points in {len(texts)} pages (cells done {done}, queue {len(queue)}, "
                  f"total {len(lon)}, {time.time() - t0:.0f} s)", flush=True)
    lon, lat, tid = np.array(lon), np.array(lat), np.array(tid, dtype=np.int64)
    np.savez_compressed(AREA / "traces.npz", lon=lon, lat=lat, tid=tid)
    print(f"traces: {len(lon)} points, {len(set(tid[tid >= 0].tolist()))} identifiable traces, "
          f"{requests} pages, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    import sys
    from_cache() if "--from-cache" in sys.argv else main()
