"""Rebuild the metal-rules help diagram.

The shipped `purification.png` shows each of the five transmutable metals twice —
a top row and a bottom row — with `+` glyphs between the rows and `>` glyphs
after them, ending at a gold orb. It never shows the **quicksilver** that every
one of those metals is actually paired with, which is the rule the diagram is
meant to teach.

This rebuilds it as five stacked formulas, one per column, each read downwards
and across:

    lead   + QS  >  tin
    tin    + QS  >  iron
    iron   + QS  >  copper
    copper + QS  >  silver
    silver + QS  >  gold

The whole block is roughly square, so it can sit in one row beside the short
Vitae/Mors diagram rather than being a tall column of its own.

The metal orbs, the gold orb, the quicksilver orb and the `+` / `>` glyphs are
all the game's own art; see `tools/extract_quicksilver_orb.py` for the orb.

Source art: Content/textures/solitaire/help/matching_rules/purification.png
Usage:  python tools/build_purification.py
"""
import os
from PIL import Image

# Repo root, derived from this file so the script runs from any checkout.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELP = os.path.join(ROOT, "public", "assets", "help")
CONTENT = os.environ.get(
    "OPUS_MAGNUM_CONTENT",
    r"F:\SteamLibrary\steamapps\common\Opus Magnum\Content",
)
# Prefer the copy `tools/copy-assets.mjs` made; fall back to the install so the
# script also works straight after a fresh clone with the game present.
SRC = os.path.join(HELP, "purification_original.png")
if not os.path.exists(SRC):
    SRC = os.path.join(
        CONTENT, "textures", "solitaire", "help", "matching_rules", "purification.png"
    )
# Already at the metal orbs' own 56x65, lifted by extract_quicksilver_orb.py.
QS = os.path.join(HELP, "quicksilver_orb.png")
OUT = os.path.join(HELP, "purification.png")

src = Image.open(SRC).convert("RGBA")

# Grid measured from the shipped image's connected components: ten metal orbs in
# two rows of five, plus a gold orb on the right.
COLS = [7, 84, 160, 237, 314]
TOP_Y, BOT_Y = 0, 105
GOLD_X, GOLD_Y = 411, 54
ORB_W, ORB_H = 56, 65

PLUS = src.crop((27, 69, 42, 84))
ARROW = src.crop((69, 70, 78, 81))

# Inputs are the top row. Each transmutation yields the *next* metal along, so
# the results are the bottom row shifted one place; the last is the gold orb,
# which follows silver.
INPUTS = [src.crop((x, TOP_Y, x + ORB_W, TOP_Y + ORB_H)) for x in COLS]
RESULTS = [src.crop((x, BOT_Y, x + ORB_W, BOT_Y + ORB_H)) for x in COLS[1:]]
GOLD = src.crop((GOLD_X, GOLD_Y, GOLD_X + ORB_W, GOLD_Y + ORB_H))

STEPS = len(INPUTS)
qs = Image.open(QS).convert("RGBA")

# --- layout: five vertical formulas side by side ------------------------
# Each formula is
#     metal
#       +
#      QS
#       >
#     result
# so the block is five columns wide and five cells tall: about square.
PAD = 8
COL_GAP = 14

# The orbs need their full height; the + and > glyphs are small, so giving them
# orb-height rows left big empty bands between the symbols.
ORB_W, ORB_H = 56, 65
GLYPH_H = 26
ROWS = [ORB_H, GLYPH_H, ORB_H, GLYPH_H, ORB_H]

W = PAD * 2 + STEPS * ORB_W + (STEPS - 1) * COL_GAP
H = PAD * 2 + sum(ROWS)

canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

row_top = []
y = PAD
for h in ROWS:
    row_top.append(y)
    y += h


def place(img, col, row):
    """Draw `img` in a cell, centred horizontally and vertically in its row."""
    x = PAD + col * (ORB_W + COL_GAP) + (ORB_W - img.width) // 2
    y = row_top[row] + (ROWS[row] - img.height) // 2
    canvas.alpha_composite(img, (x, y))


for i in range(STEPS):
    place(INPUTS[i], i, 0)
    place(PLUS, i, 1)
    place(qs, i, 2)
    place(ARROW, i, 3)
    place(GOLD if i >= len(RESULTS) else RESULTS[i], i, 4)

canvas.save(OUT)
print("wrote", OUT, canvas.size[0], "x", canvas.size[1])
