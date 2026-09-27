"""Extract reference colours and verify board hex-grid alignment.

Reads the original Opus Magnum solitaire art and reports the orb / glyph
palette for every marble type, plus the hex lattice geometry of board.png.
"""
import os
import numpy as np
from PIL import Image

CONTENT = r"F:\SteamLibrary\steamapps\common\Opus Magnum\Content\textures\solitaire"
RULES = os.path.join(CONTENT, "help", "matching_rules")


def load(path):
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float64) / 255.0


def hexs(rgb):
    return "#%02x%02x%02x" % tuple(int(round(max(0, min(1, c)) * 255)) for c in rgb[:3])


def find_discs(img, min_px=1500):
    """Connected components of non-white pixels -> orb bounding boxes."""
    h, w, _ = img.shape
    fg = img[:, :, 3] > 0.25
    lab = np.zeros((h, w), dtype=np.int32)
    comps = []
    cur = 0
    for y0 in range(h):
        for x0 in range(w):
            if not fg[y0, x0] or lab[y0, x0]:
                continue
            cur += 1
            stack = [(y0, x0)]
            lab[y0, x0] = cur
            pix = []
            while stack:
                y, x = stack.pop()
                pix.append((y, x))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and not lab[ny, nx]:
                            lab[ny, nx] = cur
                            stack.append((ny, nx))
            if len(pix) >= min_px:
                ys = [p[0] for p in pix]
                xs = [p[1] for p in pix]
                comps.append((min(xs), min(ys), max(xs), max(ys), len(pix), pix))
    return comps


def analyse(img, box):
    x0, y0, x1, y1, _, pix = box
    arr = np.array(pix)
    px = img[arr[:, 0], arr[:, 1], :3]
    lum = px @ np.array([0.2126, 0.7152, 0.0722])
    order = np.argsort(lum)
    dark = px[order[: max(1, len(px) // 3)]]
    glow = px[order[-max(1, len(px) // 40):]]
    # background/base colour: median of all orb pixels
    base = np.median(px, axis=0)
    return base, np.median(dark, axis=0), np.median(glow, axis=0), (x1 - x0 + 1, y1 - y0 + 1)


def report(title, path, expected):
    img = load(path)
    discs = find_discs(img)
    # keep only roughly circular blobs, sorted top-left reading order
    discs = [d for d in discs if abs((d[2] - d[0]) - (d[3] - d[1])) <= 8 and 30 <= d[2] - d[0] <= 220]
    discs.sort(key=lambda d: (round(d[1] / 60), d[0]))
    print(f"== {title} ({os.path.basename(path)}) : {len(discs)} orbs ==")
    for i, d in enumerate(discs):
        base, dark, glow, size = analyse(img, d)
        nm = expected[i] if i < len(expected) else f"#{i}"
        print(f"  {nm:<12} size={size} base={hexs(base)} core={hexs(dark)} glow={hexs(glow)}")
    return discs


def main():
    report("cardinal elements", os.path.join(RULES, "cardinals.png"), ["Fire", "Earth", "Water", "Air"])
    report("salt", os.path.join(RULES, "salt.png"), ["Salt"])
    report("animismus", os.path.join(RULES, "animismus.png"), ["Vitae", "Mors"])
    report("projection", os.path.join(RULES, "projection.png"),
           ["Quicksilver", "Lead", "Tin", "Iron", "Copper", "Silver", "Gold"])

    # ---- board grid alignment -------------------------------------------
    board = load(os.path.join(CONTENT, "board.png"))
    print("\n== board.png ==", board.shape)
    a = board[:, :, 3]
    print("  alpha min=%.2f max=%.2f (premultiplied=%s)" % (a.min(), a.max(),
          bool(np.all(board[:, :, :3] <= a[..., None] + 1e-6))))

    OFFSET_X, OFFSET_Y, MARBLE = 66.0, 57.0, 26.0
    print("  hex centre colours at helper lattice coords:")
    for (bx, by) in [(6, 5), (5, 0), (0, 5), (5, 10), (10, 5), (6, 0), (6, 10), (6, 1)]:
        ox = OFFSET_X * bx + (-OFFSET_X / 2 if by % 2 else 0)
        cx, cy = ox + MARBLE, OFFSET_Y * by + MARBLE
        patch = board[int(cy) - 2:int(cy) + 3, int(cx) - 2:int(cx) + 3, :3].mean(axis=(0, 1))
        print(f"    cell({bx:2d},{by:2d}) px=({cx:6.1f},{cy:6.1f}) rgb={hexs(patch)}")

    # Hex pitch: the recessed centre of each cell is darker than the walls.
    cy = int(OFFSET_Y * 5 + MARBLE)
    line = board[cy, :, :3].mean(axis=1)
    k = np.ones(9) / 9
    sm = np.convolve(line, k, mode="same")
    mins = [x for x in range(30, len(sm) - 30) if sm[x] == min(sm[x - 25:x + 26])]
    collapsed = []
    for p in mins:
        if not collapsed or p - collapsed[-1] > 25:
            collapsed.append(p)
    print("  dark hex-centre x positions on row 5:", collapsed)
    if len(collapsed) > 2:
        print("  measured x pitch:", np.diff(collapsed))

    cxx = int(OFFSET_X * 5 + MARBLE)
    col = board[:, cxx, :3].mean(axis=1)
    smc = np.convolve(col, k, mode="same")
    minsy = [y for y in range(30, len(smc) - 30) if smc[y] == min(smc[y - 25:y + 26])]
    cy2 = []
    for p in minsy:
        if not cy2 or p - cy2[-1] > 25:
            cy2.append(p)
    print("  dark hex-centre y positions on column 5:", cy2)
    if len(cy2) > 2:
        print("  measured y pitch:", np.diff(cy2))


if __name__ == "__main__":
    main()
