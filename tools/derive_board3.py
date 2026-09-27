"""Recover the exact playable-cell set by detecting hex grooves in board.png.

Each row of the board is a run of hexagons separated by dark grooves.
Along a row's centre line the brightness therefore looks like

    [frame] [tile] g [tile] g [tile] ... [tile] [frame]

Counting the bright lobes and matching their centres to lattice
coordinates gives the exact set of playable cells, with no guessing from
an assumed board shape.
"""
import os
import numpy as np
from PIL import Image, ImageDraw

CONTENT = r"F:\SteamLibrary\steamapps\common\Opus Magnum\Content\textures\solitaire"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_ref")
PITCH_X, PITCH_Y, OFF = 66.0, 57.0, 26.0
LX, LY = 24, 20  # half-height of the sampling band around a row centre


def load_profile(img, cy):
    """Average brightness over a horizontal band around the row centre."""
    y0, y1 = int(cy) - LY, int(cy) + LY
    band = img[max(0, y0):y1]
    return band.mean(axis=0)


def smooth(x, k=7):
    ker = np.ones(k) / k
    return np.convolve(x, ker, mode="same")


def main():
    rgb = np.asarray(Image.open(os.path.join(CONTENT, "board.png")).convert("RGB"),
                     dtype=np.float64) / 255.0
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    H, W = lum.shape

    print(f"board {W}x{H}")
    valid = np.zeros((11, 11), dtype=bool)

    for row in range(11):
        cy = PITCH_Y * row + OFF
        prof = smooth(load_profile(lum, cy))
        on_card = prof > 0.30
        # Find the longest card run, then split it into bright lobes.
        idx = np.nonzero(on_card)[0]
        if len(idx) == 0:
            continue
        best, s, p = (0, 0), idx[0], idx[0]
        for i in idx[1:]:
            if i != p + 1:
                if p - s > best[1] - best[0]:
                    best = (s, p)
                s = i
            p = i
        if p - s > best[1] - best[0]:
            best = (s, p)
        x0, x1 = best
        span = prof[x0:x1 + 1]

        # Lobes = local maxima of the (smoothed) segment. A groove is a
        # dip of at least 2% brightness relative to the running plateau.
        lobe_centres = []
        i = 0
        n = len(span)
        thr = max(span.max() * 0.93, 0.45)
        while i < n:
            if span[i] >= thr:
                j = i
                while j < n and span[j] >= thr:
                    j += 1
                # brightness-weighted centre of this lobe
                seg = span[i:j]
                if j - i >= 8:
                    weights = seg - thr * 0.9
                    weights = np.clip(weights, 1e-6, None)
                    c = x0 + i + float((weights * np.arange(len(seg))).sum() / weights.sum())
                    lobe_centres.append(c)
                i = j
            else:
                i += 1

        off = -PITCH_X / 2 if row % 2 else 0
        hits = []
        for c in lobe_centres:
            gx = (c - off - OFF) / PITCH_X
            xi = int(round(gx))
            if 0 <= xi < 11 and abs(gx - xi) < 0.30:
                valid[row, xi] = True
                hits.append((xi, round(gx - xi, 2)))
        print(f"  row {row:2d}: lobes={len(lobe_centres):2d}  matched={sorted(hits)}")

    dead = [(x, y) for y in range(11) for x in range(11) if not valid[y, x]]
    print(f"\nplayable cells: {int(valid.sum())}   dead: {len(dead)}")
    for y in range(11):
        print(f"  row {y:2d}: {[x for x in range(11) if valid[y, x]]}")
    sym = all(valid[y, x] == valid[y, 10 - x] for y in range(11) for x in range(11))
    print(f"horizontally symmetric: {sym}")

    print("\nDEAD_CELLS:")
    for y in range(11):
        line = ", ".join(f"[{x}, {y}]" for x in range(11) if not valid[y, x])
        if line:
            print("  " + line + ",")

    im = Image.open(os.path.join(CONTENT, "board.png")).convert("RGB")
    d = ImageDraw.Draw(im)
    for y in range(11):
        for x in range(11):
            cx = PITCH_X * x + (-PITCH_X / 2 if y % 2 else 0) + OFF
            cy = PITCH_Y * y + OFF
            col = (0, 160, 0) if valid[y, x] else (230, 0, 0)
            d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], outline=col, width=3)
            d.text((cx - 12, cy - 28), f"{x},{y}", fill=(0, 0, 255))
    im.save(os.path.join(OUT, "board_lobes.png"))
    print("\nwrote _ref/board_lobes.png")


if __name__ == "__main__":
    main()
