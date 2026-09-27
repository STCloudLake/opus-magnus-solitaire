/**
 * Board geometry for Sigmar's Garden.
 *
 * The board is an 11x11 lattice of hexagonal cells with 30 unusable
 * cells clipped from the four corners, leaving exactly 91 playable
 * cells. Odd-numbered rows are shifted half a cell to the right, which
 * is the standard "odd-r offset" hex layout with pointy-top hexes.
 *
 * Geometry was verified against the game's own `board.png`: cell pitch
 * is 66px horizontally and 57px vertically, and cell centres sit at
 * (66 * x + (y odd ? -33 : 0) + 26, 57 * y + 26) in board-image space.
 */

export const BOARD_SIZE = 11;
export const PITCH_X = 66;
export const PITCH_Y = 57;

/** Cell index into the flat tile array, or -1 when off the board. */
export type CellIndex = number;

/**
 * The playable column span of each row, as `[first, last]`.
 *
 * The board is the intersection of the lattice with the beige card, and the
 * card narrows towards the top and bottom, giving row widths
 *
 *     6, 7, 8, 9, 10, 11, 10, 9, 8, 7, 6
 *
 * — **91 cells** in total. Note the sequence is not a simple
 * `[lead, 10-lead]` span: because the even rows carry the half-tile stagger,
 * the rows that hold an even number of tiles sit half a tile off the column
 * axis, so e.g. row 0 spans columns 3..8 while row 1 spans 2..8. Each span
 * below was checked against the card's measured width at that row, and no
 * tile crosses the card edge.
 */
const ROW_SPAN: ReadonlyArray<readonly [number, number]> = [
  [2, 7], // row 0  — 6
  [2, 8], // row 1  — 7
  [1, 8], // row 2  — 8
  [1, 9], // row 3  — 9
  [0, 9], // row 4  — 10
  [0, 10], // row 5 — 11
  [0, 9], // row 6 — 10
  [1, 9], // row 7  — 9
  [1, 8], // row 8  — 8
  [2, 8], // row 9  — 7
  [2, 7], // row 10 — 6
];

const deadFlags = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
for (let y = 0; y < BOARD_SIZE; y++) {
  const [first, last] = ROW_SPAN[y];
  for (let x = 0; x < first; x++) deadFlags[y * BOARD_SIZE + x] = 1;
  for (let x = last + 1; x < BOARD_SIZE; x++) deadFlags[y * BOARD_SIZE + x] = 1;
}

/** True when (x, y) is a real cell on the board. */
export function isValidCell(x: number, y: number): boolean {
  return (
    x >= 0 &&
    y >= 0 &&
    x < BOARD_SIZE &&
    y < BOARD_SIZE &&
    deadFlags[y * BOARD_SIZE + x] === 0
  );
}

export function cellIndex(x: number, y: number): CellIndex {
  return isValidCell(x, y) ? y * BOARD_SIZE + x : -1;
}

export function cellX(index: number): number {
  return index % BOARD_SIZE;
}

export function cellY(index: number): number {
  return (index / BOARD_SIZE) | 0;
}

/**
 * Fine placement nudge, in board-image pixels, applied to every tile centre.
 *
 * Dialled in against the artwork with the calibration panel
 * (`?calibrate`): the lattice's phase and the carved tiles disagree by a
 * small residual that is not a clean multiple of the pitch, so it is
 * settled by eye rather than fit. Adjust `cellCentrePx`'s constants below
 * if this ever needs redoing.
 */
const NUDGE_X = 32.5;
const NUDGE_Y = -9.5;

/**
 * Centre of a cell's carved tile, in board-image pixels — the point a marble
 * must be drawn at.
 *
 * `x = 66c + 33·even + 57 + NUDGE_X`, `y = 57r + 69 + NUDGE_Y`.
 *
 * The row pitch is 57 while the column pitch is 66. That is deliberate: with
 * the odd/even rows staggered by 33 in x, the six neighbours of a tile sit at
 * `(0, ±57)` and `(±33, ±57)`, which are `65.9`, `65.9`, `65.9`, `65.9`, `66`
 * and `66` px away — one tile width, as a hex tiling requires. Row pitch and
 * stagger are coupled; changing one without the other breaks the neighbour
 * structure.
 *
 * Derived from the beige card's own bounds in `board.png`. Sampling the card
 * row by row gives a hexagonal shape centred on **x = 420**, **y = 354**,
 * widest at the middle (x 21..819) and narrowest at the top (x 174..666).
 */
export function cellCentrePx(x: number, y: number): { x: number; y: number } {
  const even = y % 2 === 0;
  return {
    x: PITCH_X * x + (even ? PITCH_X / 2 : 0) + 57 + NUDGE_X,
    y: PITCH_Y * y + 69 + NUDGE_Y,
  };
}

/** Every playable cell index, in reading order. */
export const VALID_CELLS: readonly CellIndex[] = (() => {
  const out: CellIndex[] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (isValidCell(x, y)) out.push(y * BOARD_SIZE + x);
    }
  }
  return out;
})();

export const VALID_CELL_COUNT = VALID_CELLS.length;

/**
 * A side of a tile that falls off the card.
 *
 * Treated as permanently empty by the placement rule, so it counts towards a
 * marble's run of empty neighbours.
 */
export const OFF_BOARD: CellIndex = -1;

/**
 * The six-slot neighbour ring of a cell, clockwise, with off-board sides kept as
 * `OFF_BOARD`.
 *
 * Which slot is "off the board" is decided from tile geometry, not from an index
 * range test: the lattice staggers rows by half a pitch horizontally as well as
 * vertically, so the obvious odd-r offset table is wrong here and several
 * hand-written versions disagreed with the artwork. Each of the six ideal
 * directions is therefore sampled and the nearest in-board tile within one tile
 * width is taken; a direction with nothing there is off the board. Deciding it
 * this way also handles the clipped corners of the card for free.
 *
 * The clockwise ordering matters: the placement rule runs around the ring, so a
 * run may wrap from the last slot back to the first.
 */
export function neighbourRing(x: number, y: number): CellIndex[] {
  const self = cellCentrePx(x, y);
  const inBoard: { cell: CellIndex; angle: number }[] = [];
  for (const cell of VALID_CELLS) {
    if (cell === y * BOARD_SIZE + x) continue;
    const p = cellCentrePx(cell % BOARD_SIZE, (cell / BOARD_SIZE) | 0);
    const dx = p.x - self.x;
    const dy = p.y - self.y;
    if (Math.hypot(dx, dy) > PITCH_X + 0.5) continue;
    inBoard.push({ cell, angle: Math.atan2(dy, dx) });
  }
  inBoard.sort((a, b) => a.angle - b.angle);

  // Merge the found tiles into the six directional slots, filling any direction
  // with no tile as off-board.
  const SLOTS = 6;
  const ring: CellIndex[] = new Array(SLOTS).fill(OFF_BOARD);
  for (const found of inBoard) {
    // Which of the six 60-degree sectors does this neighbour sit in?
    const sector = Math.round((found.angle / (Math.PI / 3))) % SLOTS;
    const idx = ((sector % SLOTS) + SLOTS) % SLOTS;
    if (ring[idx] === OFF_BOARD) ring[idx] = found.cell;
  }
  return ring;
}

/** On-board neighbours only, clockwise. */
export function neighbours(x: number, y: number): CellIndex[] {
  return neighbourRing(x, y).filter((c) => c !== OFF_BOARD);
}

/* ------------------------------------------------------------------ *
 * Three-fold rotation
 * ------------------------------------------------------------------ */

/** The middle cell, which is the fixed point of every symmetry. */
const MIDDLE_CELL: CellIndex = 5 * BOARD_SIZE + 5;

/**
 * A cell turned by `k` x 120 degrees about the centre cell, snapped to the
 * nearest tile.
 *
 * This has to be done on the tile *centres* rather than on the index grid: the
 * lattice staggers rows by half a pitch horizontally as well as vertically, so
 * the obvious integer matrix is not the rotation of the tiling. Rotating the
 * continuous position and snapping lands within 0.8px on every cell, and the
 * result is a genuine automorphism — it maps neighbours to neighbours on all 91
 * cells, for each of the three turns.
 */
export function rotateCell(cell: CellIndex, k = 1): CellIndex {
  const rad = ((k % 3) + 3) % 3 * ((2 * Math.PI) / 3);
  if (rad === 0) return cell;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = cellCentrePx(MIDDLE_CELL % BOARD_SIZE, (MIDDLE_CELL / BOARD_SIZE) | 0);
  const p = cellCentrePx(cell % BOARD_SIZE, (cell / BOARD_SIZE) | 0);
  const dx = p.x - cx.x;
  const dy = p.y - cx.y;
  const tx = cx.x + dx * cos - dy * sin;
  const ty = cx.y + dx * sin + dy * cos;
  let best = VALID_CELLS[0];
  let bestD = Infinity;
  for (const o of VALID_CELLS) {
    const q = cellCentrePx(o % BOARD_SIZE, (o / BOARD_SIZE) | 0);
    const d = (q.x - tx) ** 2 + (q.y - ty) ** 2;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * The playable cells grouped into orbits under the 120-degree rotation.
 *
 * Every orbit has size 3 except the centre, which is fixed — 1 + 30 x 3 = 91.
 * The game builds its deals from these orbits: it chooses the centre plus 18
 * orbits of three, giving `1 + 18 * 3 = 55` cells, which is exactly the marble
 * count. See `generateBoard`.
 */
export const ROTATION_ORBITS: ReadonlyArray<readonly CellIndex[]> = (() => {
  const seen = new Set<CellIndex>();
  const orbits: CellIndex[][] = [];
  for (const c of VALID_CELLS) {
    if (seen.has(c)) continue;
    const orbit = [c, rotateCell(c, 1), rotateCell(c, 2)];
    for (const o of orbit) seen.add(o);
    orbits.push(orbit);
  }
  return orbits;
})();

/** Orbits of three cells; the centre is the only fixed point. */
export const THREE_ORBITS: ReadonlyArray<readonly CellIndex[]> = ROTATION_ORBITS.filter(
  (o) => o[0] !== o[1],
);

/**
 * Precomputed neighbour table.
 *
 * Each entry is the full six-slot ring in clockwise order, with **off-board
 * slots kept** as `OFF_BOARD` rather than dropped. That matters because the
 * placement rule treats positions outside the board as empty: a marble in a
 * corner tile has three sides off the card, so those three sides count towards
 * its "three contiguous empty neighbours" straight away. Dropping them made
 * every edge marble much harder to free than the game intends and cost a lot of
 * solvable boards.
 */
export const NEIGHBOURS: ReadonlyArray<readonly CellIndex[]> = (() => {
  const table: CellIndex[][] = new Array(BOARD_SIZE * BOARD_SIZE);
  for (let i = 0; i < table.length; i++) table[i] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      table[y * BOARD_SIZE + x] = neighbourRing(x, y);
    }
  }
  return table;
})();

/** Always six, by construction. */
export const NEIGHBOUR_COUNT: ReadonlyArray<number> = NEIGHBOURS.map((n) => n.length);

/**
 * Bit masks, one per cell, marking its neighbours. Used by the solver to
 * test emptiness of a cell's surroundings with a couple of word ops.
 */
export const CELL_BIT: readonly number[] = (() => {
  const bits = new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0);
  for (const c of VALID_CELLS) bits[c] = 1 << (c % 32);
  return bits;
})();

export const CELL_WORD: readonly number[] = (() => {
  const words = new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0);
  for (const c of VALID_CELLS) words[c] = (c / 32) | 0;
  return words;
})();

/**
 * Occupancy masks covering each cell's neighbours, split by bitboard
 * word. Used by the solver, where "are this cell's neighbours empty?"
 * has to be answered millions of times.
 */
export const NB_MASK: readonly (readonly number[])[] = (() => {
  const masks = new Array<number[]>(BOARD_SIZE * BOARD_SIZE);
  for (let i = 0; i < masks.length; i++) masks[i] = [0, 0, 0, 0];
  for (const c of VALID_CELLS) {
    for (const nb of NEIGHBOURS[c]) masks[c][CELL_WORD[nb]] |= CELL_BIT[nb];
  }
  return masks;
})();
