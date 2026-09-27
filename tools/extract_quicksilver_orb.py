"""Lift the game's own quicksilver orb out of its help artwork.

The game ships quicksilver as a **glyph** (`Content/textures/atoms/quicksilver_symbol.png`,
with a diffuse tint), not as a body image — the sphere is drawn by a shader. So
there is nothing to composite a board-style quicksilver from, and the app's own
board sprite (which copies the game by flat-tinting the sphere) reads as a pale
coin beside the metal orbs in the help art.

The game's help artwork does contain quicksilver orbs, though: `matching_rules/
projection.png` pairs each metal with a quicksilver orb, drawn by the game in
exactly the style of the other help diagrams. This lifts one of those, so the
diagram's quicksilver is the game's own art at the game's own proportions.

Writing it out at the same 56x65 as the metal orbs keeps the grid legible and
avoids resampling it down and back up again.

Source art: Content/textures/solitaire/help/matching_rules/projection.png
Usage:  python tools/extract_quicksilver_orb.py
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
SRC = os.path.join(
    CONTENT, "textures", "solitaire", "help", "matching_rules", "projection.png"
)
if not os.path.exists(SRC):
    SRC = os.path.join(HELP, "projection.png")
OUT = os.path.join(HELP, "quicksilver_orb.png")

ORB_W, ORB_H = 56, 65

src = Image.open(SRC).convert("RGBA")

# The second row of projection.png is the quicksilver orbs, one beneath each
# metal. Take the first, which is the cleanest.
QS_X, QS_Y = 7, 105
orb = src.crop((QS_X, QS_Y, QS_X + ORB_W, QS_Y + ORB_H))

out = Image.new("RGBA", (ORB_W, ORB_H), (0, 0, 0, 0))
out.alpha_composite(orb, (0, 0))
out.save(OUT)
print("wrote", OUT, out.size[0], "x", out.size[1])
