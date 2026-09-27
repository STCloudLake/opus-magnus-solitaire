/**
 * Rules engine for Sigmar's Garden.
 *
 * ## The rules
 *
 * The board holds marbles. A move removes two marbles at once:
 *
 *  * **Placement.** A marble may only be taken if at least *three of its
 *    contiguous neighbours* are empty. Positions outside the board count
 *    as empty, so marbles along the rim come loose first. The three
 *    empty neighbours must be *contiguous* around the hexagonal ring —
 *    with no marbles wedged between them.
 *  * **Cardinal elements** (air, fire, water, earth) pair with a marble
 *    of the same element.
 *  * **Salt** pairs with itself or with any cardinal element.
 *  * **Metals** pair with quicksilver, but only in the order of their
 *    transmutation, lead → tin → iron → copper → silver → gold. Only the
 *    lowest-ranked metal still on the board may be transmuted, and each
 *    pairing consumes one of the five quicksilver marbles.
 *  * **House Colvan variant**: metals pair with another marble of the
 *    same metal instead of with quicksilver.
 *  * **Vitae and Mors** pair with each other.
 *
 * The board is clear — and the game won — when the last marble is
 * removed.
 */

import {
  BOARD_SIZE,
  CELL_BIT,
  CELL_WORD,
  NEIGHBOURS,
  NEIGHBOUR_COUNT,
  OFF_BOARD,
  VALID_CELLS,
  cellIndex,
  type CellIndex,
} from './grid.js';
import { GOLD, METAL_SEQUENCE, Tile, isCardinal, isMetal, metallicity } from './tiles.js';

/**
 * How metals behave in the current ruleset.
 *
 * `quicksilver` is the standard game described in the in-game help.
 * `colvan` is the House Colvan variant, also documented in the game,
 * where metals pair with a matching metal and quicksilver is inert.
 */
export type Variant = 'quicksilver' | 'colvan';

export const VARIANTS: Record<Variant, { name: string; blurb: string }> = {  quicksilver: {
    name: "Standard Sigmar's Garden",
    blurb: 'Metals pair with quicksilver in transmutation order, lead to gold.',
  },
  colvan: {
    name: 'House Colvan variant',
    blurb: 'Metals pair with another marble of the same metal. Quicksilver is inert.',
  },
};

/**
 * How the board is dealt.
 *
 * Both deal the whole 55 marbles on the centre plus 18 orbits of the
 * 120-degree rotation, so both are 3-fold symmetric; they differ in whether the
 * orbits are spread over the board or grown as one connected blob. The game's
 * own layouts are blobs, which is what makes its opening position tight.
 */
export const DIFFICULTIES: Record<'easy' | 'hard', { name: string; blurb: string }> = {
  easy: {
    name: 'Easy — open board',
    blurb: 'Support spread over the board; many marbles are playable from the start.',
  },
  hard: {
    name: 'Hard — faithful to the game',
    blurb: "Support grown as one connected blob, shaped like the game's own layouts.",
  },
};

/**
 * Standard starting counts of each marble, as used by the game. There
 * are 55 marbles in total:
 *
 *   - 8 of each of the four cardinal elements     32
 *   - 4 salt                                       4
 *   - 4 vitae and 4 mors                           8
 *   - 5 quicksilver                                5
 *   - one of each of the six metals                6
 *                                                 --
 *                                                 55
 *
 * The odd total is not a mistake: gold may be removed on its own, which
 * leaves 54 marbles forming 27 pairs.
 */
export const STANDARD_COUNTS: Readonly<Record<number, number>> = {
  [Tile.Salt]: 4,
  [Tile.Air]: 8,
  [Tile.Fire]: 8,
  [Tile.Water]: 8,
  [Tile.Earth]: 8,
  [Tile.Quicksilver]: 5,
  [Tile.Lead]: 1,
  [Tile.Tin]: 1,
  [Tile.Iron]: 1,
  [Tile.Copper]: 1,
  [Tile.Silver]: 1,
  [Tile.Gold]: 1,
  [Tile.Vitae]: 4,
  [Tile.Mors]: 4,
};

export const TOTAL_MARBLES = Object.values(STANDARD_COUNTS).reduce((a, b) => a + b, 0);

/**
 * Counts used by the House Colvan variant.
 *
 * Read off the game's own `Content/solitaire3.dat` (5,000 boards) rather than
 * guessed, and asserted against that file in the selftest. The file stores 54
 * marbles with the multiset identical in every record; gold is implicit at the
 * centre, so it is listed here for completeness.
 *
 * Mapping the file's type ids onto ours (file 1=salt, 2..5=cardinals,
 * 6=quicksilver, 7=gold, 8=lead, 9=tin, 10=iron, 11=copper, 12=silver,
 * 13=vitae, 14=mors):
 *
 *     file  1 x4, 2 x8, 3 x8, 4 x8, 5 x8, 8 x2, 9 x4, 10 x4, 11 x4, 12 x4
 *     ours  salt 4, cardinals 8 each, lead 2, tin 4, iron 4, copper 4, silver 4
 *
 * so this variant ships **no quicksilver and no vitae/mors at all**, and only 2
 * lead. It still totals 55 including the implicit gold — the standard count — and
 * because that is `1 + 3 x 18` the variant is 3-fold symmetric exactly like the
 * standard game.
 *
 * An earlier version of this table read the metal ids one place too low, giving
 * lead 0 and tin 2 and therefore 51 marbles. That is why the colvan board could
 * not be made centre-symmetric: 51 is not `1 + 3k`, so no arrangement of whole
 * 120-degree orbits can total it.
 */
export const COLVAN_COUNTS: Readonly<Record<number, number>> = {
  [Tile.Salt]: 4,
  [Tile.Air]: 8,
  [Tile.Fire]: 8,
  [Tile.Water]: 8,
  [Tile.Earth]: 8,
  [Tile.Quicksilver]: 0,
  [Tile.Lead]: 2,
  [Tile.Tin]: 4,
  [Tile.Iron]: 4,
  [Tile.Copper]: 4,
  [Tile.Silver]: 4,
  [Tile.Gold]: 1,
  [Tile.Vitae]: 0,
  [Tile.Mors]: 0,
};

/**
 * The third shipped variant (`Content/solitaire2.dat`) is the standard game
 * with two salt replaced by **Quintessence** (type 16), which is why it has 15
 * kinds:
 *
 *     salt 4, cardinals 8 each, quicksilver 5, metals 1 each, vitae 3, mors 3,
 *     quintessence 2   -> 54 stored, plus gold = 55
 *
 * It is not implemented: the game ships `atoms/whiteout.png` for it but no
 * symbol sprite, so it cannot be rendered faithfully yet. `Variant` would gain
 * a `quintessence` case and `countsFor` the table below to add it.
 */
export function countsFor(variant: Variant): Readonly<Record<number, number>> {
  return variant === 'colvan' ? COLVAN_COUNTS : STANDARD_COUNTS;
}

export function variantTotal(variant: Variant): number {
  return Object.values(countsFor(variant)).reduce((a, b) => a + b, 0);
}

/**
 * A board is just the tile occupying each lattice cell. Clipped cells
 * are permanently `Empty` and are never considered by any rule.
 */
export type Board = Uint8Array;

export function createEmptyBoard(): Board {
  return new Uint8Array(BOARD_SIZE * BOARD_SIZE);
}

export function cloneBoard(board: Board): Board {
  return new Uint8Array(board);
}

export function boardFromLayout(layout: number[][]): Board {
  const board = createEmptyBoard();
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      board[y * BOARD_SIZE + x] = layout[y][x] ?? Tile.Empty;
    }
  }
  return board;
}

export function boardToLayout(board: Board): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    const row: number[] = [];
    for (let x = 0; x < BOARD_SIZE; x++) row.push(board[y * BOARD_SIZE + x]);
    out.push(row);
  }
  return out;
}

export function countMarbles(board: Board): number {
  let n = 0;
  for (const c of VALID_CELLS) if (board[c] !== Tile.Empty) n++;
  return n;
}

export function tallyTiles(board: Board): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const c of VALID_CELLS) {
    const t = board[c];
    if (t !== Tile.Empty) counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * Occupancy bitboards
 *
 * The solver runs millions of emptiness tests, so occupancy is mirrored
 * into four 32-bit words. Cell c maps to bit (c % 32) of word c >> 5.
 * ------------------------------------------------------------------ */

export interface Occupancy {
  w: Int32Array;
}

export function occupancyFrom(board: Board): Occupancy {
  const w = new Int32Array(4);
  for (const c of VALID_CELLS) {
    if (board[c] !== Tile.Empty) w[CELL_WORD[c]] |= CELL_BIT[c];
  }
  return { w };
}

export function isEmptyAt(occ: Occupancy, cell: number): boolean {
  return (occ.w[CELL_WORD[cell]] & CELL_BIT[cell]) === 0;
}

export function clearAt(occ: Occupancy, cell: number): void {
  occ.w[CELL_WORD[cell]] &= ~CELL_BIT[cell];
}

export function setAt(occ: Occupancy, cell: number): void {
  occ.w[CELL_WORD[cell]] |= CELL_BIT[cell];
}

export function popCount(occ: Occupancy): number {
  let n = 0;
  for (let i = 0; i < 4; i++) n += popcount32(occ.w[i]);
  return n;
}

export function popcount32(v: number): number {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >> 24;
}

/* ------------------------------------------------------------------ *
 * The placement rule
 * ------------------------------------------------------------------ */

/**
 * Returns true when the cell at `cell` has at least three contiguous
 * empty neighbours, which is what makes a marble selectable.
 *
 * Sides of the tile that fall off the card count as empty — that is the rule,
 * and it is what makes the marbles on the board's edge and in its corners
 * removable. The ring always has six slots, with off-board ones marked, so a
 * corner marble starts with three free sides before anything is cleared
 * anywhere.
 *
 * Neighbours are walked clockwise starting from an arbitrary point; a run may
 * straddle the start of the walk, so the leading run is kept and added to the
 * trailing one.
 */
export function hasEnoughFreeNeighbours(board: Board, cell: number): boolean {
  return hasEnoughFreeNeighboursOcc(occupancyFrom(board), cell);
}

export function hasEnoughFreeNeighboursOcc(occ: Occupancy, cell: number): boolean {
  const ring = NEIGHBOURS[cell];
  const n = ring.length;
  let trailing = 0;
  let leading = -1;
  for (let i = 0; i < n; i++) {
    if (isFreeAt(occ, ring[i])) {
      trailing++;
      if (trailing >= 3) return true;
    } else {
      if (leading < 0) leading = trailing;
      trailing = 0;
    }
  }
  if (leading < 0) leading = 0;
  return trailing + leading >= 3;
}

/** True when a ring slot is empty — including a slot that is off the board. */
export function isFreeAt(occ: Occupancy, cell: CellIndex): boolean {
  if (cell === OFF_BOARD || cell < 0) return true;
  return isEmptyAt(occ, cell);
}

/**
 * Fast conservative pre-filter. A cell can never be selectable with
 * fewer than three empty neighbours at all, so a misaligned-free count
 * lets the solver skip most cells cheaply.
 */
export function enoughNeighboursQuick(occ: Occupancy, cell: number): boolean {
  if (NEIGHBOUR_COUNT[cell] < 3) return false;
  const ring = NEIGHBOURS[cell];
  let free = 0;
  for (let i = 0; i < ring.length; i++) {
    if (isFreeAt(occ, ring[i])) {
      if (++free >= 3) return true;
    }
  }
  return false;
}

/**
 * The lowest metal still on the board, or `Tile.Empty` when none remain.
 * Only this metal may be transmuted by quicksilver.
 */
export function lowestMetalRemaining(board: Board): Tile {
  let best = Tile.Empty;
  for (const c of VALID_CELLS) {
    const t = board[c] as Tile;
    if (isMetal(t) && (best === Tile.Empty || t < best)) best = t;
  }
  return best;
}

/** Cells holding a marble that satisfies the placement rule. */
export function playableCells(board: Board): number[] {
  const occ = occupancyFrom(board);
  const out: number[] = [];
  for (const c of VALID_CELLS) {
    if (board[c] === Tile.Empty) continue;
    if (hasEnoughFreeNeighboursOcc(occ, c)) out.push(c);
  }
  return out;
}

/**
 * Number of marbles still on the board.
 *
 * Gold's rule needs it: gold may only be taken once it is the only marble left.
 */
export function marblesOnBoard(board: Board): number {
  let n = 0;
  for (const c of VALID_CELLS) if (board[c] !== Tile.Empty) n++;
  return n;
}

/**
 * The kinds that could actually be taken this instant: loose, and either
 * partnered by another loose marble of a legal kind or (gold) clearable alone.
 *
 * This is the single definition of "playable", used by the board's highlight,
 * the legend, the tests and the session, so they cannot drift apart. It is
 * deliberately stricter than "a marble of this kind is loose":
 *
 * * Under the quicksilver rules a metal is transmutable only while it is the
 *   lowest one left, so tin and iron stay dark while lead remains however loose
 *   they are.
 * * **Gold may only be taken once every other marble is gone.** It is the last
 *   link of the chain and the only marble that clears by itself, so gating it on
 *   "it is the lowest metal left" was not sufficient: that still allowed gold to
 *   be taken while salt, vitae and the cardinals were on the board. It is only
 *   reported playable when it is the sole remaining marble, which is a single
 *   click to clear.
 */
export function playableKinds(board: Board, variant: Variant = 'quicksilver'): Set<number> {
  const loose = playableCells(board);
  const lowest = variant === 'colvan' ? Tile.Empty : reachableMetal(board);
  const remaining = marblesOnBoard(board);
  const kinds = new Set<number>();
  for (let i = 0; i < loose.length; i++) {
    const ta = board[loose[i]] as Tile;
    // Gold clears on its own, but only as the very last marble.
    if (ta === Tile.Gold) {
      if (remaining === 1) kinds.add(ta);
      continue;
    }
    for (let j = 0; j < loose.length; j++) {
      if (i === j) continue;
      if (canPair(ta, board[loose[j]] as Tile, variant, lowest)) {
        kinds.add(ta);
        break;
      }
    }
  }
  return kinds;
}

/**
 * The metal the rules currently allow to be transmuted, for passing to
 * {@link canPair}.
 *
 * This is {@link lowestMetalRemaining} with gold corrected: gold counts as
 * "reachable" only once it is the **last marble on the board**, not merely the
 * lowest metal. Using `lowestMetalRemaining` directly in the pairing tests was a
 * real bug — `Tile.Gold` came back while salt or a cardinal was still on the
 * board, which made gold appear transmutable (and, through the solo branch,
 * removable) far too early.
 *
 * When gold is not yet reachable this returns `Tile.Empty`, which by `canPair`'s
 * convention blocks only gold: no metal pairs with quicksilver in that state, but
 * the genuine metals are unaffected because they are all gone by then.
 */
export function reachableMetal(board: Board): Tile {
  const lowest = lowestMetalRemaining(board);
  if (lowest !== Tile.Gold) return lowest;
  return marblesOnBoard(board) === 1 ? Tile.Gold : Tile.Empty;
}

/**
 * Whether two marbles may be removed together. `variant` selects the
 * metal rule; everything else is fixed.
 *
 * Passing the same cell for `a` and `b` is only meaningful for gold,
 * which the game allows to be taken on its own once it is the last
 * metal left on the board — that is what makes the odd 55-marble total
 * work out.
 *
 * `lowestMetal` should be the result of {@link lowestMetalRemaining} for
 * the current board, and is required for the standard ruleset.
 */
export function canPair(
  a: Tile,
  b: Tile,
  variant: Variant = 'quicksilver',
  lowestMetal: Tile = Tile.Empty,
  sameCell = false,
): boolean {
  if (a === Tile.Empty || b === Tile.Empty) return false;

  if (sameCell) {
    // Gold, and only gold, may be cleared by itself — and only as the last
    // marble on the board. `lowestMetal` alone was not a strong enough gate: it
    // reads "lowest metal remaining", so gold passed it while salt, vitae and
    // the cardinals were still there. Callers pass `Tile.Gold` for `lowestMetal`
    // once gold is all that is left.
    return a === Tile.Gold && lowestMetal === Tile.Gold;
  }

  // Cardinal elements and salt.
  if (a === Tile.Salt && b === Tile.Salt) return true;
  if (a === Tile.Salt && isCardinal(b)) return true;
  if (b === Tile.Salt && isCardinal(a)) return true;
  if (isCardinal(a) && a === b) return true;

  // Vitae and Mors.
  if (
    (a === Tile.Vitae && b === Tile.Mors) ||
    (a === Tile.Mors && b === Tile.Vitae)
  ) {
    return true;
  }

  // Metals.
  if (variant === 'colvan') {
    return isMetal(a) && isMetal(b) && a === b;
  }

  if (isMetal(a) && b === Tile.Quicksilver) {
    return lowestMetal === Tile.Empty || a === lowestMetal;
  }
  if (isMetal(b) && a === Tile.Quicksilver) {
    return lowestMetal === Tile.Empty || b === lowestMetal;
  }

  return false;
}

export interface Move {
  a: number;
  b: number;
  /** True when this move clears a single marble (gold, taken alone). */
  solo?: boolean;
}

/**
 * All legal moves on the board.
 *
 * When `variant` is the standard ruleset only pairs built from the
 * lowest remaining metal are produced, so every returned move is
 * immediately legal. A gold marble that is the last metal left may also
 * be cleared on its own; that move is reported with `a === b` and
 * `solo: true`.
 */
export function legalMoves(board: Board, variant: Variant = 'quicksilver'): Move[] {
  const free = playableCells(board);
  const lowest = variant === 'colvan' ? Tile.Empty : reachableMetal(board);
  // Gold's solo move needs the same "is it the last marble" gate the rest of the
  // rules use. `lowestMetalRemaining` was not enough: it reports gold as the
  // lowest metal while salt or a cardinal is still on the board, so a hint could
  // offer a gold the session would then refuse.
  const goldIsLast = marblesOnBoard(board) === 1;
  const moves: Move[] = [];

  for (let i = 0; i < free.length; i++) {
    const ca = free[i];
    if (board[ca] === Tile.Gold && goldIsLast) {
      moves.push({ a: ca, b: ca, solo: true });
    }
    const ta = board[ca] as Tile;
    for (let j = i + 1; j < free.length; j++) {
      const cb = free[j];
      const tb = board[cb] as Tile;
      if (canPair(ta, tb, variant, lowest)) {
        moves.push({ a: ca, b: cb });
      }
    }
  }
  return moves;
}

/** Applies a move to a board in place, returning it for chaining. */
export function applyMove(board: Board, move: Move): Board {
  board[move.a] = Tile.Empty;
  if (move.b !== move.a) board[move.b] = Tile.Empty;
  return board;
}

export function isWon(board: Board): boolean {
  return countMarbles(board) === 0;
}

/**
 * True when no move can ever be made again — checked by comparing the
 * marble tally against what the pairing rules could possibly consume.
 *
 * Vitae and Mors must pair with each other, so unequal counts are fatal.
 * Cardinal elements must pair among themselves or with salt, and each
 * salt can absorb one unpaired element, so more than `salt` elements
 * left without a partner is fatal. Gold is ignored because it can always
 * be cleared on its own.
 */
export function isStuckFromCounts(board: Board): boolean {
  const counts = tallyTiles(board);
  const salt = counts[Tile.Salt] ?? 0;

  if ((counts[Tile.Vitae] ?? 0) !== (counts[Tile.Mors] ?? 0)) return true;

  let oddElements = 0;
  for (const t of [Tile.Air, Tile.Fire, Tile.Water, Tile.Earth]) {
    if ((counts[t] ?? 0) % 2 === 1) oddElements++;
  }
  if (oddElements > salt) return true;

  return false;
}

/** True when the only marble left is gold, which can be taken alone. */
export function isGoldOnlyLeft(board: Board): boolean {
  const counts = tallyTiles(board);
  return (counts[Tile.Gold] ?? 0) === 1 && countMarbles(board) === 1;
}
