"""DirtScout app icons: a dark-green tile, two ridges and an orange dirt trail winding up to the saddle.
Writes app/public/icons/icon-192.png, icon-512.png (rounded tile) and maskable-512.png (full bleed, content inside
the 80 % safe circle).  uv run --with pillow python tools/make_icons.py"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "app", "public", "icons")
S = 1024


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def art(scale=1.0):
    """The picture on a full square; `scale` shrinks the content toward the centre (for the maskable safe zone)."""
    img = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(img)
    top, bottom = (40, 78, 54), (13, 27, 18)
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(top, bottom, y / S) + (255,))

    def P(x, y):  # content coordinates (0..1024) scaled about the centre
        return (S / 2 + (x - S / 2) * scale, S / 2 + (y - S / 2) * scale)

    d.polygon([P(*p) for p in [(-60, 760), (250, 330), (420, 520), (640, 250), (1090, 760), (1090, 1100), (-60, 1100)]],
              fill=(52, 99, 70, 255))
    d.polygon([P(*p) for p in [(-60, 880), (330, 470), (520, 640), (760, 420), (1090, 860), (1090, 1100), (-60, 1100)]],
              fill=(86, 146, 96, 255))
    d.polygon([P(*p) for p in [(640, 250), (700, 325), (650, 310), (612, 352), (590, 315)]], fill=(214, 232, 214, 255))
    d.polygon([P(*p) for p in [(250, 330), (300, 398), (262, 386), (232, 420), (212, 383)]], fill=(214, 232, 214, 255))

    # The trail: a smooth S from the bottom up to the saddle between the two front peaks.
    pts = []
    for i in range(241):
        t = i / 240
        y = 1000 - 440 * t
        x = 520 + 190 * math.sin(t * math.pi * 2.1) * (1 - t * 0.55)
        pts.append(P(x, y))
    for w, col in ((92, (60, 34, 8, 255)), (66, (255, 143, 0, 255))):
        r = w * scale / 2
        for (x, y) in pts:
            d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    for k in range(0, 240, 18):           # tyre marks along the trail
        (x0, y0), (x1, y1) = pts[k], pts[min(k + 6, 240)]
        d.line([(x0, y0), (x1, y1)], fill=(255, 214, 140, 255), width=max(2, int(10 * scale)))
    return img


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


os.makedirs(OUT, exist_ok=True)
tile = rounded(art(1.0), int(S * 0.22))
for size in (192, 512):
    tile.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon-{size}.png"), optimize=True)
art(0.78).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "maskable-512.png"), optimize=True)
print("icons written to", os.path.normpath(OUT))
