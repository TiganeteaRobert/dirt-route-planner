"""Shared bits of the AI track detector: the patch grid over the imagery (z17, 2x2 tiles = 512 px per patch), image
loading, coordinates. Patch (i, j) covers tiles x = X0+2i..X0+2i+1, y = Y0+2j..Y0+2j+1."""
import math
import os
from pathlib import Path

import numpy as np
from PIL import Image

from common import AREA, RAW, ROOT

Z = 17
TILES = RAW / "imagery" / "esri" / str(Z)
AI = ROOT / "data" / "ai"
AI.mkdir(parents=True, exist_ok=True)
LABELS = AI / "labels"
PRED = Path(os.environ.get("DS_AI_PRED", AI / "pred"))          # DS_AI_PRED: a test region's predictions elsewhere
MPP = 156543.03392 * math.cos(math.radians(46.55)) / 2 ** Z      # ~0.82 m per pixel here


FOLDS = 3


def fold_of(i, j):
    """Cross-fitting fold of patch (i, j), by whole 8 x 8 patch blocks (~6.5 km) spread over the area. The model for
    fold k never trains on fold k, so the unmapped tracks there (labelled as background) cannot teach it to miss them."""
    return ((i // 8) * 7 + (j // 8) * 13) % FOLDS


def lon2gx(lon):
    return (lon + 180) / 360 * 2 ** Z * 256


def lat2gy(lat):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z * 256


def gx2lon(gx):
    return gx / (2 ** Z * 256) * 360 - 180


def gy2lat(gy):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / (2 ** Z * 256)))))


# The models were trained on a grid starting at tile x 73854 (the first area, west edge 22.85). When the area grows west
# the origin moves by whole steps of 48 tiles (24 patches = 3 fold blocks of 8), so every patch keeps its fold and each
# model still predicts only patches it never trained on.
X_ANCHOR, X_STEP = 73854, 48


def grid():
    """(X0, Y0, ni, nj) of the patch grid covering the area's tiles (the same range pipeline/imagery.py downloads)."""
    from imagery import tile_range
    x0, x1, y0, y1 = tile_range(Z)
    X0, Y0 = x0 // 2 * 2, y0 // 2 * 2
    if X0 < X_ANCHOR:
        X0 = X_ANCHOR - -(-(X_ANCHOR - X0) // X_STEP) * X_STEP
    return X0, Y0, (x1 - X0) // 2 + 1, (y1 - Y0) // 2 + 1


def tile_img(x, y):
    p = TILES / str(x) / f"{y}.jpg"
    if not p.exists():
        return None
    try:
        return np.asarray(Image.open(p).convert("RGB"))
    except Exception:  # noqa: BLE001
        return None


def has_patch(X0, Y0, i, j):
    """All four imagery tiles of patch (i, j) are downloaded."""
    return all((TILES / str(X0 + 2 * i + dx) / f"{Y0 + 2 * j + dy}.jpg").exists() for dx in (0, 1) for dy in (0, 1))


def patch_img(X0, Y0, i, j, margin_tiles=0):
    """RGB array of patch (i, j), optionally with a margin of whole neighbouring tiles; None if a core tile is missing."""
    m = margin_tiles
    size = (2 + 2 * m) * 256
    out = np.zeros((size, size, 3), np.uint8)
    for dy in range(-m, 2 + m):
        for dx in range(-m, 2 + m):
            t = tile_img(X0 + 2 * i + dx, Y0 + 2 * j + dy)
            if t is None:
                if 0 <= dx < 2 and 0 <= dy < 2:
                    return None
                continue
            out[(dy + m) * 256:(dy + m + 1) * 256, (dx + m) * 256:(dx + m + 1) * 256] = t
    return out
