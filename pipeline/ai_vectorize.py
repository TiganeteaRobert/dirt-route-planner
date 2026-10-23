"""AI step 5: the predicted probabilities (ai_infer.py) -> lines of tracks that no map has.
 1. blocks of 4 x 4 patches (2048 px) with a one-patch halo: hysteresis threshold, close small gaps, drop specks, thin to a 1 px
    skeleton, trace it into lines between nodes (ends and junctions), drop short spurs, cut the lines to the block's
    core (the halo makes neighbouring blocks agree there) and merge them across blocks;
 2. the parts within 15 m of an OSM highway or a Microsoft detection are known roads and go; new runs keep one point
    on each side so they reach towards the road they leave; runs within 25 m of a known road along 70 % of their
    length are that road mapped a little off its place, and go too;
 3. ends of new lines within 25 m of each other that point at each other are joined (within 8 m in any case): a
    track under a tree, a faint bit the model missed;
 4. lines of 60 m and more stay (not wiggly when short, not mostly on buildings or bare ground, not a twin of a
    longer one, sure enough under forest, near villages and when short, at least 0.45 sure, not a shore), with their
    mean probability (conf) and land cover along them.
-> data/ai/ai_lines.geojson (lon/lat). Private: derived from Esri imagery, never published as it is.
    uv run --with numpy --with scipy --with shapely --with scikit-image --with pillow python pipeline/ai_vectorize.py [low=0.2] [high=0.4]
Hysteresis thresholds on the ridge map (see ridge): a line starts where it reaches `high` and runs on while above `low`.
"""
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import shapely
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

from ai_common import AI, MPP, PRED, Z, lat2gy, lon2gx
from common import AREA, read_fc

B = 4                 # patches per block side
HALO = 1              # patches of context around a block
SPUR = 15             # px: dead ends shorter than this off a junction are skeleton noise
KNOWN = 15.0          # m: this close to an OSM highway or a Microsoft detection = already known
PARALLEL = 25.0       # m: a new run this close to a known road along most of it is that road drawn off its place
GAP = 25.0            # m: ends of new lines this close are joined when they point at each other
GAP_ANY = 8.0         # m: ... and this close whatever their direction
GAP_ANGLE = 40.0      # degrees
MIN_LEN = 60.0        # m
EDGE = 0.37           # block cuts lie at pixel k - EDGE, never on a vertex
SIGMA = 1.0           # px: blur of the gap-filled probabilities, so a dashed band becomes one ridge
SMOOTH = 5            # points (every 4 px) averaged along the final lines: the skeleton zig-zags
MAX_WIGGLE = 1.6      # length / end-to-end distance above which a short line is noise
BARE = 60             # WorldCover bare ground (quarries, rock): the model traces their rims
TWIN = 8.0            # m: a line this close to a longer AI line along 60 % of it is the same track drawn twice
FOREST_CONF = 0.8     # under mostly forest (tree share > 0.6) keep only lines the model is this sure of
VILLAGE = 200.0       # m: lines mostly this close to buildings (where maps have the roads) are mostly parcel edges...
SHORT, SHORT_CONF = 100.0, 0.5   # m: shorter lines stay only when the model is at least this sure
MIN_CONF = 0.45       # below this the lines are mostly terrace and field edges
WATER = 30.0          # m: lines mostly this close to open water are shores (a reservoir's dry margin looks like a road)
VILLAGE_CONF = 0.7    # ... and stay only when the model is this sure
OFFS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def ridge(prob):
    """uint8 probabilities -> the map the lines are traced on (uint8). The model draws lines as dashes on every other
    pixel row (its 2x upsampling lets it tell the rows apart, and dashes satisfy its loss as well as lines): a 3 x 3
    maximum joins them and a light blur makes the band one smooth ridge for the skeleton."""
    return ndimage.gaussian_filter(ndimage.maximum_filter(prob, size=3).astype(np.float32), SIGMA).round().astype(np.uint8)


def load_mask(bi, bj, ni, nj, thr):
    """The block's line pixels: hysteresis on the ridge map (thr = (low, high), 0-1) - faint stretches stay when they
    continue a confident line, faint specks on their own do not."""
    from skimage.filters import apply_hysteresis_threshold
    n = B + 2 * HALO
    prob = np.zeros((n * 512, n * 512), np.uint8)
    for dj in range(n):
        for di in range(n):
            i, j = bi * B - HALO + di, bj * B - HALO + dj
            p = PRED / f"{i}_{j}.png"
            if 0 <= i < ni and 0 <= j < nj and p.exists():
                prob[dj * 512:(dj + 1) * 512, di * 512:(di + 1) * 512] = np.asarray(Image.open(p))
    return apply_hysteresis_threshold(ridge(prob), 255 * thr[0], 255 * thr[1])


def trace(skel):
    """1 px skeleton -> chains [(y, x), ...] between nodes. Nodes are clusters of pixels that do not have exactly two
    neighbours (ends, junctions); every chain at a node starts or ends at the cluster's centre, so they meet exactly."""
    sk = skel.astype(np.uint8)
    nb = ndimage.convolve(sk, np.ones((3, 3), np.uint8), mode="constant") - sk
    node = skel & (nb != 2)
    lab, n = ndimage.label(node, structure=np.ones((3, 3)))
    centre = [None] + [tuple(c) for c in ndimage.center_of_mass(node, lab, range(1, n + 1))]
    H, W = skel.shape
    S, N, L = skel.tolist(), node.tolist(), lab.tolist()
    seen = np.zeros(skel.shape, bool)
    chains = []
    ys, xs = np.nonzero(node)
    for y, x in zip(ys.tolist(), xs.tolist()):
        for dy, dx in OFFS:
            y1, x1 = y + dy, x + dx
            if not (0 <= y1 < H and 0 <= x1 < W) or not S[y1][x1] or N[y1][x1] or seen[y1, x1]:
                continue
            seen[y1, x1] = True
            path, py, px, cy, cx, end = [(y1, x1)], y, x, y1, x1, 0
            while True:
                step = None
                for ey, ex in OFFS:
                    yy, xx = cy + ey, cx + ex
                    if (yy == py and xx == px) or not (0 <= yy < H and 0 <= xx < W) or not S[yy][xx]:
                        continue
                    step = (yy, xx)
                    break
                if step is None:
                    break
                yy, xx = step
                if N[yy][xx]:
                    end = L[yy][xx]
                    break
                if seen[yy, xx]:
                    break
                seen[yy, xx] = True
                path.append(step)
                py, px, cy, cx = cy, cx, yy, xx
            if end:
                chains.append((L[y][x], end, path))
    return chains, centre


def block(job):
    bi, bj, ni, nj, thr = job
    mask = load_mask(bi, bj, ni, nj, thr)
    from skimage.morphology import disk, remove_small_holes, remove_small_objects, skeletonize
    if mask.sum() < 50:
        return []
    mask = ndimage.binary_closing(mask, structure=disk(2))
    mask = remove_small_objects(mask, max_size=60)
    mask = remove_small_holes(mask, max_size=150)          # a track drawn as two lines -> one
    chains, centre = trace(skeletonize(mask))
    deg = np.zeros(len(centre), int)
    for a, b, _ in chains:
        deg[a] += 1
        deg[b] += 1
    out = []
    ox, oy = bi * B * 512 - HALO * 512, bj * B * 512 - HALO * 512          # mosaic origin in the area's pixel grid
    x0, y0 = HALO * 512 + ox - EDGE, HALO * 512 + oy - EDGE
    x1, y1 = x0 + B * 512, y0 + B * 512
    for a, b, path in chains:
        if len(path) < SPUR and min(deg[a], deg[b]) == 1 and max(deg[a], deg[b]) >= 3:
            continue
        pts = [centre[a]] + path + [centre[b]]
        xy = np.array([(x + ox, y + oy) for y, x in pts], float)
        if len(xy) < 2 or np.hypot(*(xy[-1] - xy[0])) == 0 and len(xy) < 4:
            continue
        clip = shapely.clip_by_rect(shapely.linestrings(xy), x0, y0, x1, y1)
        for part in shapely.get_parts(clip):
            if part.geom_type == "LineString" and part.length > 0:
                out.append(np.asarray(shapely.simplify(part, 0.6).coords))
    return out


def smooth(g):
    """The line resampled every 4 px and averaged over SMOOTH points (ends kept)."""
    xy = densify(np.asarray(g.coords), 4.0)
    if len(xy) <= SMOOTH:
        return g
    k = np.ones(SMOOTH) / SMOOTH
    pad = SMOOTH // 2
    sm = np.column_stack([np.convolve(np.pad(xy[:, d], pad, mode="edge"), k, mode="valid") for d in (0, 1)])
    sm[0], sm[-1] = xy[0], xy[-1]
    return shapely.linestrings(sm)


def densify(xy, step):
    """Points every `step` along a polyline (the ends included)."""
    seg = np.hypot(*np.diff(xy, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    n = max(2, int(math.ceil(cum[-1] / step)) + 1)
    s = np.linspace(0, cum[-1], n)
    return np.column_stack([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])])


def known_tree(X0, Y0):
    """Points every 3 m along every OSM highway and Microsoft detection, in pixel coordinates of the patch grid (pixel
    k's centre at k, like the skeleton)."""
    pts = []
    for name in ("osm_highways.geojson", "ms_roads.geojson"):
        for f in read_fc(AREA / name):
            c = f["geometry"]["coordinates"]
            xy = np.array([(lon2gx(x) - X0 * 256 - 0.5, lat2gy(y) - Y0 * 256 - 0.5) for x, y, *_ in c])
            pts.append(densify(xy, 3.0 / MPP))
    return cKDTree(np.concatenate(pts))


def sample_pred(xy, X0, Y0):
    """Probability (0-1) at each point, read patch by patch."""
    ix, iy = np.rint(xy[:, 0]).astype(int), np.rint(xy[:, 1]).astype(int)
    pi, pj = ix // 512, iy // 512
    key = pi * 100000 + pj
    out = np.zeros(len(xy))
    order = np.argsort(key, kind="stable")
    ks = key[order]
    cut = np.flatnonzero(np.diff(ks)) + 1
    for grp in np.split(order, cut):
        i, j = int(pi[grp[0]]), int(pj[grp[0]])
        p = PRED / f"{i}_{j}.png"
        if not p.exists():
            continue
        a = ridge(np.asarray(Image.open(p)))                                     # as in load_mask
        out[grp] = a[iy[grp] - j * 512, ix[grp] - i * 512] / 255.0
    return out


def landcover_sampler(X0, Y0, near=None):
    """WorldCover class at points of the patch grid; with near=(class, metres): whether that class is that close."""
    wc = np.load(AREA / "worldcover.npz")
    cls, (a, _, c, _, e, f) = wc["cls"], wc["transform"]
    n = 2 ** Z * 256
    if near:
        r = max(1, round(near[1] / (a * 111320 * math.cos(math.radians(46.55)))))
        cls = ndimage.maximum_filter((cls == near[0]).astype(np.uint8), size=2 * r + 1)

    def sample(xy):
        lon = (xy[:, 0] + X0 * 256 + 0.5) / n * 360 - 180
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (xy[:, 1] + Y0 * 256 + 0.5) / n))))
        col = np.clip(((lon - c) / a).astype(int), 0, cls.shape[1] - 1)
        row = np.clip(((lat - f) / e).astype(int), 0, cls.shape[0] - 1)
        return cls[row, col]
    return sample


def run(jobs, X0, Y0, out_path):
    t0 = time.time()
    pieces = []
    with ProcessPoolExecutor(10) as pool:
        for k, out in enumerate(pool.map(block, jobs, chunksize=4), 1):
            pieces += out
            if k % 200 == 0:
                print(f"  blocks {k}/{len(jobs)}, {len(pieces)} pieces ({time.time() - t0:.0f} s)", flush=True)
    merged = shapely.get_parts(shapely.line_merge(shapely.multilinestrings(
        [shapely.linestrings(np.round(p, 3)) for p in pieces if len(p) >= 2])))
    km_all = shapely.length(merged).sum() * MPP / 1000
    print(f"skeleton: {len(merged)} lines, {km_all:.0f} km ({time.time() - t0:.0f} s)", flush=True)

    # drop what maps already have
    tree = known_tree(X0, Y0)
    step, near = 4.0, KNOWN / MPP
    runs = []
    for g in merged:
        xy = densify(np.asarray(g.coords), step)
        d, _ = tree.query(xy, distance_upper_bound=near)
        new = ~np.isfinite(d)
        if not new.any():
            continue
        edges = np.flatnonzero(np.diff(np.concatenate([[0], new.astype(int), [0]])))
        for s, e in zip(edges[::2], edges[1::2]):
            s2, e2 = max(0, s - 1), min(len(xy), e + 1)          # one known point each side: reach the road
            if (e2 - s2 - 1) * step * MPP >= 15:
                runs.append(xy[s2:e2])
    n_runs = len(runs)
    runs = [r for r in runs if np.isfinite(tree.query(r, distance_upper_bound=PARALLEL / MPP)[0]).mean() <= 0.7]
    km_new = sum(len(r) - 1 for r in runs) * step * MPP / 1000
    print(f"not on any map: {len(runs)} runs, {km_new:.0f} km ({n_runs - len(runs)} that only shadow a known road dropped, "
          f"{time.time() - t0:.0f} s)", flush=True)

    # join ends that nearly meet
    ends = np.array([r[0] for r in runs] + [r[-1] for r in runs])
    owner = np.concatenate([np.arange(len(runs)), np.arange(len(runs))])
    # outward direction at each end, from the point ~5 steps (20 px) inside the run
    inner = np.array([r[min(5, len(r) - 1)] for r in runs] + [r[max(0, len(r) - 6)] for r in runs])
    out_dir = ends - inner
    out_dir /= np.maximum(1e-9, np.hypot(*out_dir.T))[:, None]
    pairs = cKDTree(ends).query_pairs(GAP / MPP, output_type="ndarray")
    if len(pairs):
        dist = np.hypot(*(ends[pairs[:, 0]] - ends[pairs[:, 1]]).T)
        pairs = pairs[np.argsort(dist)]
    used = np.zeros(len(ends), bool)
    links = []
    cos_max = math.cos(math.radians(GAP_ANGLE))
    for a, b in pairs:
        if used[a] or used[b] or owner[a] == owner[b]:
            continue
        ab = ends[b] - ends[a]
        d = math.hypot(*ab)
        if d * MPP > GAP_ANY and (d == 0 or out_dir[a] @ ab / d < cos_max or out_dir[b] @ -ab / d < cos_max):
            continue
        used[a] = used[b] = True
        links.append(np.array([ends[a], ends[b]]))
    lines = shapely.get_parts(shapely.line_merge(shapely.multilinestrings(
        [shapely.linestrings(r) for r in runs] + [shapely.linestrings(x) for x in links])))
    lines = [smooth(g) for g in lines if g.length * MPP >= MIN_LEN]
    n0 = len(lines)
    lines = [g for g in lines if g.length * MPP >= 200
             or g.length <= MAX_WIGGLE * np.hypot(*(np.asarray(g.coords[-1]) - g.coords[0]))]
    print(f"{len(links)} gaps joined; {len(lines)} lines of {MIN_LEN:.0f} m or more ({n0 - len(lines)} short wiggly ones "
          f"dropped, {time.time() - t0:.0f} s)", flush=True)

    # confidence and land cover along each line
    pts = [densify(np.asarray(g.coords), 2.0) for g in lines]
    allp = np.concatenate(pts)
    lid = np.repeat(np.arange(len(pts)), [len(p) for p in pts])
    prob = sample_pred(allp, X0, Y0)
    lc = landcover_sampler(X0, Y0)(allp)
    village = np.bincount(lid, landcover_sampler(X0, Y0, (50, VILLAGE))(allp).astype(float), minlength=len(pts))
    shore = np.bincount(lid, landcover_sampler(X0, Y0, (80, WATER))(allp).astype(float), minlength=len(pts))
    cnt = np.bincount(lid, minlength=len(pts))
    conf = np.bincount(lid, prob, minlength=len(pts)) / cnt
    share = {name: np.bincount(lid, (lc == code).astype(float), minlength=len(pts)) / cnt
             for name, code in (("tree", 10), ("grass", 30), ("crop", 40), ("built", 50), ("bare", BARE))}
    n = 2 ** Z * 256
    feats = []
    near = cKDTree(allp)
    kept = np.zeros(len(lines), bool)
    n_twin = n_forest = n_village = n_short = n_shore = 0
    for k in sorted(range(len(lines)), key=lambda k: -lines[k].length):          # longest first
        g = lines[k]
        if share["built"][k] > 0.5 or share["bare"][k] > 0.5:
            continue
        if share["tree"][k] > 0.6 and conf[k] < FOREST_CONF:
            n_forest += 1
            continue
        if village[k] / cnt[k] > 0.5 and conf[k] < VILLAGE_CONF:
            n_village += 1
            continue
        if g.length * MPP < SHORT and conf[k] < SHORT_CONF or conf[k] < MIN_CONF:
            n_short += 1
            continue
        if shore[k] / cnt[k] > 0.5:
            n_shore += 1
            continue
        nb = near.query_ball_point(pts[k], TWIN / MPP)
        if np.mean([kept[lid[i]].any() if i else False for i in nb]) > 0.6:
            n_twin += 1
            continue
        kept[k] = True
        xy = np.asarray(shapely.simplify(g, 0.8).coords)
        lon = (xy[:, 0] + X0 * 256 + 0.5) / n * 360 - 180
        lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (xy[:, 1] + Y0 * 256 + 0.5) / n))))
        feats.append({"type": "Feature",
                      "properties": {"id": f"a{len(feats)}", "len": round(g.length * MPP), "conf": round(float(conf[k]), 2),
                                     **{name: round(float(v[k]), 2) for name, v in share.items()}},
                      "geometry": {"type": "LineString", "coordinates": [[round(x, 6), round(y, 6)] for x, y in zip(lon, lat)]}})
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh)
    km = sum(f["properties"]["len"] for f in feats) / 1000
    print(f"dropped {n_twin} twins, {n_forest} unsure forest lines, {n_village} unsure village lines, {n_short} unsure "
          f"(short or below {MIN_CONF}) and {n_shore} shores")
    print(f"{out_path.name}: {len(feats)} lines, {km:.0f} km (skeleton {km_all:.0f} km, new {km_new:.0f} km), "
          f"{time.time() - t0:.0f} s")


def main():
    thr = (float(sys.argv[1]) if len(sys.argv) > 1 else 0.2, float(sys.argv[2]) if len(sys.argv) > 2 else 0.4)
    print(f"hysteresis thresholds on the ridge map: {thr}", flush=True)
    meta = json.loads((AI / "grid.json").read_text())
    X0, Y0, ni, nj = meta["X0"], meta["Y0"], meta["ni"], meta["nj"]
    jobs = [(bi, bj, ni, nj, thr) for bj in range((nj + B - 1) // B) for bi in range((ni + B - 1) // B)]
    run(jobs, X0, Y0, AI / "ai_lines.geojson")


if __name__ == "__main__":
    main()
