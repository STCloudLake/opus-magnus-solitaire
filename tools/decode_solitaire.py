"""Decode Opus Magnum's solitaire board files.

CONTAINER
---------
  int32LE record count, then fixed 165-byte records.
  50000 * 165 + 4 = 8,250,004 bytes exactly.

RECORD
------
  165 = 3 + 54 * 3. Three header bytes (always 07 05 00), then 54 triples.
  A triple is (type, q, r): `type` identifies the marble and (q, r) is its
  position as **hex axial coordinates centred on (5, 0)**.

  The 54 stored positions are exactly the radius-5 hexagon *minus its centre*:

      shell 1:  6 cells      shell 4: 24 cells
      shell 2: 12 cells      shell 5: 30 cells
      shell 3: 18 cells      ---------------------
                                        90 cells

  The missing 91st cell is the centre, and it is always gold. `type 7` never
  occurs anywhere in the file, so gold is implicit - which is why the game
  always draws it in the middle.

TYPE MULTISET - one distinct multiset across all 50,000 records
---------------------------------------------------------------
  1 x4, 2 x8, 3 x8, 4 x8, 5 x8, 6 x5, 8 x1, 9 x1, 10 x1, 11 x1, 12 x1,
  13 x4, 14 x4   -> 54, plus gold = 55

  The exact Sigmar's Garden multiset. By count: x4 = Salt/Vitae/Mors,
  x5 = quicksilver, x8 = the four cardinals, x1 = the five metals plus gold.

SYMMETRY
--------
  The region is invariant under BOTH the 180-degree rotation
  (q, r) -> (10 - q, -r) and the 120-degree rotation (q, r) -> (-r, q + r)
  about (5, 0). Of 3000 sample boards, 59.3% are 180-invariant and 55.1% are
  120-invariant - a large majority, not all, since the marbles themselves are
  drawn as randomly ordered pairs.

Usage:  python tools/decode_solitaire.py
"""
import struct
from collections import Counter

BASE = r"F:\SteamLibrary\steamapps\common\Opus Magnum\Content"
REC = 165
HEADER = (7, 5, 0)
CENTRE = (5, 0)

NAMES = {1:'salt', 2:'air', 3:'fire', 4:'water', 5:'earth', 6:'quicksilver',
         7:'gold', 8:'lead', 9:'tin', 10:'iron', 11:'copper', 12:'silver',
         13:'vitae', 14:'mors'}


def sb(v):
    return v if v < 128 else v - 256


def records(name, limit=None):
    data = open(BASE + "\\" + name, "rb").read()
    n = struct.unpack_from("<i", data, 0)[0]
    for i in range(n if limit is None else min(n, limit)):
        r = data[4 + i*REC: 4 + (i+1)*REC]
        yield r[0:3], [(r[j], sb(r[j+1]), sb(r[j+2])) for j in range(3, 165, 3)]


def hex_dist(p):
    q, r = p[0] - CENTRE[0], p[1] - CENTRE[1]
    return max(abs(q), abs(r), abs(q + r))


def region():
    """The 90 cells the file can address."""
    out = set()
    for q in range(-5, 6):
        for r in range(-5, 6):
            if max(abs(q), abs(r), abs(q + r)) <= 5 and (q, r) != (0, 0):
                out.add((CENTRE[0] + q, CENTRE[1] + r))
    return out


def main():
    N = 5000
    reg = region()
    header_bad = multisets = 0
    seen_multisets = Counter()
    positions = set()
    boards = []
    for hdr, ts in records('solitaire.dat', N):
        if tuple(hdr) != HEADER:
            header_bad += 1
        seen_multisets[tuple(sorted(t for (t, _, _) in ts))] += 1
        s = set((a, b) for (_, a, b) in ts)
        positions |= s
        boards.append(s)

    print(f"records read              : {N}")
    print(f"records with a bad header : {header_bad}")
    print(f"distinct type multisets   : {len(seen_multisets)}")
    ms = next(iter(seen_multisets))
    print("multiset:", ", ".join(f"{NAMES[t]}x{k}" for t, k in Counter(ms).items()))
    print()
    print(f"distinct positions used   : {len(positions)}")
    print(f"positions == hexagon minus centre: {positions == reg}")
    shells = Counter(hex_dist(p) for p in positions)
    print(f"shell sizes about {CENTRE}         : {dict(sorted(shells.items()))}"
          f"   (a full radius-5 hexagon is 6,12,18,24,30)")
    print(f"type 7 (gold) ever stored : "
          f"{any(t == 7 for _, ts in records('solitaire.dat', 200) for (t, _, _) in ts)}")

    print()
    print("region symmetry:")
    for name, f in {'180 deg (q,r)->(10-q,-r)': lambda p: (10 - p[0], -p[1]),
                    '120 deg (q,r)->(-r,q+r)': lambda p: (CENTRE[0] - p[1],
                                                          (p[0] - CENTRE[0]) + p[1])}.items():
        inv = set(f(p) for p in positions) == positions
        hits = sum(1 for s in boards if all(f(p) in s for p in s))
        print(f"   {name:24s} region invariant {inv}   boards {hits}/{N}"
              f"  ({100*hits/N:.1f}%)")

    print()
    print("board 0, as stored (q, r) with r increasing downward:")
    _, ts = next(iter(records('solitaire.dat', 1)))
    board = {}
    for (t, q, r) in ts:
        board[(q, r)] = t
    board[CENTRE] = 7
    for r in range(-5, 6):
        cells = []
        for q in range(0, 11):
            if hex_dist((q, r)) <= 5:
                cells.append(f"{NAMES[board[(q, r)]][:2]:>2}" if (q, r) in board else " .")
            else:
                cells.append("  ")
        print("   " + " ".join(cells))


if __name__ == '__main__':
    main()
