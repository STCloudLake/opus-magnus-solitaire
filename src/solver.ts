/**
 * Solver and board generator for Sigmar's Garden.
 *
 * The search is a depth-first walk over board states with three things
 * that keep it fast enough for interactive use:
 *
 *  1. Occupancy is mirrored into a bitboard, so the "three contiguous
 *     empty neighbours" test is a handful of word operations.
 *  2. Marble tallies and the lowest remaining metal are maintained
 *     incrementally, so dead-end pruning is O(1) per node.
 *  3. Visited states are memoised on a hash that includes the tallies,
 *     which collapses the huge number of transpositions caused by
 *     removing independent pairs in either order.
 *
 * The generator simply shuffles marbles on to the board and asks the
 * solver; because so many arrangements are solvable it usually succeeds
 * on the first attempt.
 */

import {
  BOARD_SIZE,
  CELL_BIT,
  CELL_WORD,
  NB_MASK,
  NEIGHBOURS,
  NEIGHBOUR_COUNT,
  THREE_ORBITS,
  VALID_CELLS,
  type CellIndex,
} from './grid.js';
import {
  Board,
  Move,
  TOTAL_MARBLES,
  Variant,
  canPair,
  cloneBoard,
  countMarbles,
  countsFor,
  createEmptyBoard,
  hasEnoughFreeNeighbours,
  reachableMetal,
  tallyTiles,
  variantTotal,
} from './game.js';
import { Tile, isMetal } from './tiles.js';

/** Deterministic PRNG (mulberry32) so boards can be reproduced from a seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SolveOptions {
  /** Maximum number of search nodes before giving up. */
  nodeLimit?: number;
  /** Optional deterministic tie-breaking for reproducible solutions. */
  rng?: () => number;
  /** Return every solution found rather than stopping at the first. */
  all?: boolean;
  /** Cap on returned solutions when `all` is set. */
  maxSolutions?: number;
}

export interface SolveResult {
  solved: boolean;
  moves: Move[];
  nodes: number;
  /** True when the node limit was hit before the search finished. */
  exhausted: boolean;
}

type Word = number;

class Search {
  readonly tile: Uint8Array;
  readonly occ: Int32Array = new Int32Array(4);
  readonly counts: Int32Array = new Int32Array(16);
  readonly variant: Variant;
  readonly nodeLimit: number;
  readonly rng: () => number;
  readonly all: boolean;
  readonly maxSolutions: number;

  nodes = 0;
  exhausted = false;
  readonly solutions: Move[][] = [];
  readonly path: Move[] = [];
  private readonly visited = new Set<string>();

  constructor(board: Board, variant: Variant, opts: SolveOptions) {
    this.tile = new Uint8Array(board);
    this.variant = variant;
    this.nodeLimit = opts.nodeLimit ?? 4_000_000;
    this.rng = opts.rng ?? Math.random;
    this.all = opts.all ?? false;
    this.maxSolutions = opts.maxSolutions ?? 1;
    for (const c of VALID_CELLS) {
      const t = this.tile[c];
      if (t !== Tile.Empty) {
        this.occ[CELL_WORD[c]] |= CELL_BIT[c];
        this.counts[t]++;
      }
    }
  }

  private remaining(): number {
    let n = 0;
    for (let t = 1; t < 16; t++) n += this.counts[t];
    return n;
  }

  /** Lowest metal still present, or Empty when the metals are gone. */
  private lowestMetal(): number {
    for (let t = Tile.Lead; t <= Tile.Gold; t++) if (this.counts[t] > 0) return t;
    return Tile.Empty;
  }

  /**
   * Cheap, sound tests that kill a branch outright.
   *
   * Note there is deliberately **no** "entombed marble" test here. It is
   * tempting: a marble with no empty neighbour cannot be taken right now. But it
   * can be freed later by clearing its neighbours, and the game's own boards
   * rely on that — **1504 of 2000 real deals start with at least one marble
   * that has no empty neighbour at all**, and one had 28 of them. Pruning on
   * that condition rejected nearly every solvable board, including every board
   * this generator produced.
   */
  private prunable(): boolean {
    if (this.counts[Tile.Vitae] !== this.counts[Tile.Mors]) return true;
    let odd = 0;
    if (this.counts[Tile.Air] & 1) odd++;
    if (this.counts[Tile.Fire] & 1) odd++;
    if (this.counts[Tile.Water] & 1) odd++;
    if (this.counts[Tile.Earth] & 1) odd++;
    if (odd > this.counts[Tile.Salt]) return true;
    return false;
  }

  /**
   * Whether a marble currently satisfies the placement rule.
   *
   * Off-board sides count as empty, so they extend a marble's run of empty
   * neighbours. This is *not* used for pruning — see `prunable`.
   */
  private isFree(cell: number): boolean {
    const ring = NEIGHBOURS[cell];
    const n = ring.length;
    if (n < 3) return false;
    const occ = this.occ;
    let trailing = 0;
    let leading = -1;
    for (let i = 0; i < n; i++) {
      const c = ring[i];
      const empty = c < 0 || (occ[CELL_WORD[c]] & CELL_BIT[c]) === 0;
      if (empty) {
        if (++trailing >= 3) return true;
      } else {
        if (leading < 0) leading = trailing;
        trailing = 0;
      }
    }
    if (leading < 0) leading = 0;
    return trailing + leading >= 3;
  }

  /** Hash of the current state, used to merge transpositions. */
  private hash(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += (this.occ[i] >>> 0).toString(36) + '.';
    for (let t = 1; t < 16; t++) if (this.counts[t]) s += t.toString(36) + this.counts[t].toString(36);
    return s;
  }

  private collectMoves(): Move[] {
    const free: number[] = [];
    for (const c of VALID_CELLS) {
      if ((this.occ[CELL_WORD[c]] & CELL_BIT[c]) === 0) continue;
      if (this.isFree(c)) free.push(c);
    }

    const lowest = this.variant === 'colvan' ? Tile.Empty : this.lowestMetal();
    // Gold may only be cleared once nothing else is left.
    const goldIsLast = this.remaining() === 1;
    const moves: Move[] = [];
    for (let i = 0; i < free.length; i++) {
      const ca = free[i];
      const ta = this.tile[ca];
      // Gold is the one marble that may be cleared on its own, and only as the
      // last marble. Note `goldIsLast` rather than "gold is the lowest metal
      // remaining": with salt or a cardinal still on the board, gold is the
      // lowest *metal* but must still not be takeable.
      if (ta === Tile.Gold && goldIsLast) {
        moves.push({ a: ca, b: ca, solo: true });
      }
      for (let j = i + 1; j < free.length; j++) {
        const cb = free[j];
        const tb = this.tile[cb];
        if (canPair(ta as Tile, tb as Tile, this.variant, lowest as Tile)) {
          moves.push({ a: ca, b: cb });
        }
      }
    }
    return moves;
  }

  /**
   * Ordering heuristic. Moves that free up the board are tried first:
   * pairing off a locked metal early, or clearing a marble that is
   * adjacent to many occupied cells, tends to open the board up.
   */
  private scoreMove(m: Move): number {
    const ta = this.tile[m.a];
    const tb = this.tile[m.b];
    let score = 0;
    if (m.b === m.a) score -= 60; // clearing gold outright is always good
    if (isMetal(ta) || isMetal(tb)) score -= 40;
    if (ta === Tile.Quicksilver || tb === Tile.Quicksilver) score -= 30;
    if (ta === Tile.Vitae || tb === Tile.Vitae || ta === Tile.Mors || tb === Tile.Mors) score -= 10;
    if (ta === Tile.Salt || tb === Tile.Salt) score += 12;
    for (const cell of m.b === m.a ? [m.a] : [m.a, m.b]) {
      for (const nb of NEIGHBOURS[cell]) {
        if (this.occ[CELL_WORD[nb]] & CELL_BIT[nb]) score -= 1;
      }
    }
    return score;
  }

  private descend(depth: number): void {
    if (this.solutions.length >= this.maxSolutions) return;
    if (this.nodes >= this.nodeLimit) {
      this.exhausted = true;
      return;
    }
    this.nodes++;

    if (depth === 0) {
      this.solutions.push(this.path.slice());
      return;
    }
    if (this.prunable()) return;

    const key = this.hash();
    if (!this.all) {
      if (this.visited.has(key)) return;
      this.visited.add(key);
    }

    const moves = this.collectMoves();
    if (moves.length === 0) return;

    const scored = moves.map((m) => ({ m, s: this.scoreMove(m) + (this.rng() - 0.5) * 0.5 }));
    scored.sort((x, y) => x.s - y.s);

    for (const { m } of scored) {
      if (this.nodes >= this.nodeLimit) {
        this.exhausted = true;
        return;
      }
      const ta = this.tile[m.a];
      const tb = this.tile[m.b];
      const solo = m.b === m.a;

      this.occ[CELL_WORD[m.a]] &= ~CELL_BIT[m.a];
      this.counts[ta]--;
      this.tile[m.a] = Tile.Empty;
      if (!solo) {
        this.occ[CELL_WORD[m.b]] &= ~CELL_BIT[m.b];
        this.counts[tb]--;
        this.tile[m.b] = Tile.Empty;
      }
      this.path.push(m);

      this.descend(depth - 1);

      this.path.pop();
      this.tile[m.a] = ta;
      this.counts[ta]++;
      this.occ[CELL_WORD[m.a]] |= CELL_BIT[m.a];
      if (!solo) {
        this.tile[m.b] = tb;
        this.counts[tb]++;
        this.occ[CELL_WORD[m.b]] |= CELL_BIT[m.b];
      }

      if (this.solutions.length >= this.maxSolutions) return;
    }
  }

  run(): SolveResult {
    const marbles = this.remaining();
    if (marbles === 0) return { solved: true, moves: [], nodes: 0, exhausted: false };
    // Gold can be cleared alone, so a board with an odd marble count is
    // fine as long as one of them is gold. Everything else pairs up.
    const solos = this.counts[Tile.Gold];
    const rest = marbles - solos;
    if (rest % 2 !== 0) {
      return { solved: false, moves: [], nodes: 0, exhausted: false };
    }
    const depth = rest / 2 + (solos > 0 ? 1 : 0);
    this.descend(depth);
    const best = this.solutions[0] ?? [];
    return {
      solved: this.solutions.length > 0,
      moves: best,
      nodes: this.nodes,
      exhausted: this.exhausted,
    };
  }
}

/** Solves a board, returning the first solution found. */
export function solveBoard(
  board: Board,
  variant: Variant = 'quicksilver',
  opts: SolveOptions = {},
): SolveResult {
  return new Search(board, variant, opts).run();
}

/** Finds up to `maxSolutions` distinct solutions. */
export function solveBoardAll(
  board: Board,
  variant: Variant = 'quicksilver',
  maxSolutions = 5,
  opts: SolveOptions = {},
): Move[][] {
  const search = new Search(board, variant, {
    ...opts,
    all: true,
    maxSolutions,
  });
  search.run();
  return search.solutions;
}

export interface GeneratedBoard {
  board: Board;
  solution: Move[];
  seed: number;
  attempts: number;
  nodes: number;
}

/**
 * The middle cell, which is the fixed point of the 120-degree rotation and
 * where gold always goes.
 */
export const CENTRE_CELL: CellIndex = 5 * BOARD_SIZE + 5;

/**
 * How the support — the 55 cells that hold a marble — is chosen.
 *
 * `easy` sprinkles whole 120-degree orbits over the board, which leaves the
 * marbles spread out and a lot of them unlocked at the start.
 *
 * `hard` grows the orbits outwards from the centre as a single connected blob,
 * matching how the game's own layouts are shaped: its boards have a median of
 * 98 boundary edges against 120 for a scattered support, and the empties form
 * many small pockets rather than a few large ones. That closes the board up and
 * leaves far fewer marbles playable at the start.
 */
export type Difficulty = 'easy' | 'hard';

/**
 * Builds a random board that is guaranteed to be solvable.
 *
 * The **support** is built first as the centre plus 18 whole orbits of the
 * 120-degree rotation. That is `1 + 18 * 3 = 55` cells, it is 3-fold symmetric
 * by construction, and it is what the game itself does: decoding
 * `Content/solitaire.dat` shows every board occupying 55 cells in such orbits
 * (97.4% of orbits are wholly occupied or wholly empty), and there are only
 * C(30,18) = 86,493,225 possible supports.
 *
 * The 27 pairs of marble *kinds* are then dealt across that support at random,
 * and gold takes the centre. The kinds are deliberately **not** symmetric: the
 * game's own boards are not, and a kind-symmetric deal is never solvable,
 * because both copies of a marble become loose together and then lock together.
 *
 * Unsolvable arrangements are discarded and redealt, which is cheap because the
 * solver rejects most dead boards quickly.
 */
export function generateBoard(
  seed: number,
  variant: Variant = 'quicksilver',
  opts: { maxAttempts?: number; nodeLimit?: number; difficulty?: Difficulty } = {},
): GeneratedBoard {
  const difficulty = opts.difficulty ?? 'easy';
  const maxAttempts = opts.maxAttempts ?? 600;
  const nodeLimit = opts.nodeLimit ?? 15_000;
  const rng = makeRng(seed);
  const counts = countsFor(variant);
  const total = variantTotal(variant);

  if (total > VALID_CELLS.length) {
    throw new Error(`Cannot fit ${total} marbles into ${VALID_CELLS.length} cells`);
  }

  const cut = makeRng(seed * 2654435761 + 12345);

  // A 3-fold symmetric support needs `1 + 3k` cells. The standard game is
  // `1 + 3 * 18 = 55`; House Colvan's 51 marbles are `1 + 3 * 16` with three
  // left over, so that variant cannot be symmetric and falls back to a plain
  // deal across the whole region.
  const spare = total - 1;
  const symmetricPossible = spare >= 0 && spare % 3 === 0 && spare / 3 <= THREE_ORBITS.length;
  const orbitsNeeded = symmetricPossible ? spare / 3 : 0;
  const fallbackCells = VALID_CELLS.filter((c) => c !== CENTRE_CELL);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const board = createEmptyBoard();

    // The support. `easy` sprinkles whole orbits over the board; `hard` grows
    // them as one connected blob and then discards any support whose opening
    // position is too open. Both occupy the centre plus 18 orbits of three, so
    // both are 3-fold symmetric.
    let support: number[];
    if (symmetricPossible) {
      support =
        difficulty === 'hard'
          ? tightSupport(orbitsNeeded, cut)
          : scatterSupport(orbitsNeeded, cut);
    } else {
      support = [CENTRE_CELL, ...fallbackCells];
    }

    // Marble pool, with gold reserved for the centre.
    const pool: number[] = [];
    for (const [tileStr, n] of Object.entries(counts)) {
      const t = Number(tileStr);
      const reserve = t === Tile.Gold ? 1 : 0;
      for (let i = 0; i < n - reserve; i++) pool.push(t);
    }
    board[CENTRE_CELL] = Tile.Gold;

    // Shuffle the pool and deal it across the support.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (cut() * (i + 1)) | 0;
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const spots = support.filter((c) => c !== CENTRE_CELL);
    for (let i = spots.length - 1; i > 0; i--) {
      const j = (cut() * (i + 1)) | 0;
      const tmp = spots[i];
      spots[i] = spots[j];
      spots[j] = tmp;
    }
    for (let i = 0; i < pool.length && i < spots.length; i++) board[spots[i]] = pool[i];

    // Seed the solver's tie-breaking from the same stream so a given
    // board seed always yields the same solution.
    const result = solveBoard(board, variant, {
      nodeLimit: attempt <= 40 ? nodeLimit : nodeLimit * 20,
      rng: cut,
    });
    if (result.solved) {
      return { board, solution: result.moves, seed, attempts: attempt, nodes: result.nodes };
    }
  }

  throw new Error(`Failed to generate a solvable board after ${maxAttempts} attempts (seed ${seed})`);
}

/**
 * How many marbles are playable from the opening position, for a support.
 *
 * Depends only on which cells are occupied, not on which marble kind sits on
 * them — the placement rule is about empty neighbours — so this is cheap and
 * can be used to screen supports before dealing any marbles.
 */
function looseCount(support: readonly number[]): number {
  const occ = createEmptyBoard();
  for (const c of support) occ[c] = Tile.Salt;
  let n = 0;
  for (const c of support) if (hasEnoughFreeNeighbours(occ, c)) n++;
  return n;
}

/**
 * The loose-count distribution of the game's own 50,000 boards, measured from
 * `Content/solitaire.dat` over 10,000 of them:
 *
 * ```
 * loose 6: 37.77%   loose 7: 20.34%   loose 8: 3.79%   loose 9: 38.10%
 * ```
 *
 * The distribution is bimodal — 6 and 9 dominate — which is a fingerprint of
 * the original's construction, so it is matched rather than replaced by a
 * simple range.
 */
const LOOSE_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [6, 3777],
  [7, 2034],
  [8, 379],
  [9, 3810],
];

const LOOSE_TOTAL = LOOSE_WEIGHTS.reduce((n, [, w]) => n + w, 0);

/**
 * Grows connected supports until one opens as tightly as the game's own.
 *
 * A grown support almost never comes out below 9 loose (about 7% of them), so
 * this samples until it finds one in the game's range, then picks a target from
 * the game's own distribution and narrows towards it. Supports are screened
 * before any marbles are dealt, which costs about 40 microseconds each, so a
 * few hundred samples is cheap.
 *
 * Values of 7 and 8 do occur but are rare, so the search accepts a nearby
 * reading rather than spinning: it keeps a shortlist and picks the closest after
 * a bounded number of samples.
 */
function tightSupport(orbitsNeeded: number, rng: () => number): number[] {
  const target = (() => {
    let r = rng() * LOOSE_TOTAL;
    for (const [loose, w] of LOOSE_WEIGHTS) {
      r -= w;
      if (r <= 0) return loose;
    }
    return 9;
  })();

  let best: number[] | null = null;
  let bestGap = Infinity;
  // Enough samples that a loose<=9 support (about 7% of growths) is nearly
  // certain to appear, without letting a pathological seed stall.
  const SAMPLES = 240;
  for (let i = 0; i < SAMPLES; i++) {
    const candidate = growSupport(orbitsNeeded, rng);
    if (candidate.length !== 1 + orbitsNeeded * 3) continue;
    const loose = looseCount(candidate);
    const gap = Math.abs(loose - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
    if (gap === 0) return candidate;
  }
  return best ?? growSupport(orbitsNeeded, rng);
}

/**
 * Picks whole orbits at random, anywhere on the board.
 *
 * This is the easy support: symmetric and connected often enough to be valid,
 * but spread out, so many marbles touch empty space and are playable from the
 * first move.
 */
function scatterSupport(orbitsNeeded: number, rng: () => number): number[] {
  const order = THREE_ORBITS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const cells = [CENTRE_CELL];
  for (let i = 0; i < orbitsNeeded; i++) cells.push(...THREE_ORBITS[order[i]]);
  return cells;
}

/**
 * Grows a 120-degree symmetric support of whole orbits, keeping it connected.
 *
 * The game builds its layout by repeatedly picking a free cell and adding it
 * with its two rotational images, which means the occupied set grows as a
 * *connected blob* rather than being sprinkled over the board. That distinction
 * is very visible in play: a scattered support leaves most marbles touching
 * empty space, so far too many are unlocked at the start.
 *
 * Measured over 200 boards, choosing orbits at random gives a median of **21**
 * marbles loose at the start against the real game's **7**, and only half the
 * supports come out connected. Growing orbit by orbit, only taking an orbit that
 * touches what is already placed, lands much closer to the real thing.
 */
function growSupport(orbitsNeeded: number, rng: () => number): number[] {
  const cells = [CENTRE_CELL];
  const used = new Set<number>([CENTRE_CELL]);
  const isFree = (c: number) => !used.has(c);
  const touches = (orbit: readonly number[]): boolean =>
    orbit.some((c) =>
      NEIGHBOURS[c].some((n) => n !== -1 && used.has(n)),
    );

  let guard = 0;
  while (used.size < 1 + orbitsNeeded * 3 && guard++ < 4000) {
    const touching: (readonly number[])[] = [];
    const anywhere: (readonly number[])[] = [];
    for (const orbit of THREE_ORBITS) {
      if (!orbit.every(isFree)) continue;
      anywhere.push(orbit);
      if (touches(orbit)) touching.push(orbit);
    }
    // Prefer an orbit that extends the blob; fall back to any free orbit so the
    // centre can start a second cluster when the first is boxed in.
    const pool = touching.length ? touching : anywhere;
    if (!pool.length) break;
    const orbit = pool[(rng() * pool.length) | 0];
    for (const c of orbit) {
      cells.push(c);
      used.add(c);
    }
  }
  return cells;
}

/** Replays a move list, checking every move is legal. */
export function verifySolution(
  board: Board,
  moves: Move[],
  variant: Variant = 'quicksilver',
): boolean {
  const work = cloneBoard(board);
  for (const m of moves) {
    const ta = work[m.a] as Tile;
    const tb = work[m.b] as Tile;
    if (ta === Tile.Empty || tb === Tile.Empty) return false;
    const solo = m.b === m.a;
    // `reachableMetal` for every variant, including House Colvan: gold is the
    // last marble in both rulesets and is cleared alone, so its solo move needs
    // `Tile.Gold` here. Forcing `Tile.Empty` for colvan made every colvan
    // solution unverifiable — the final gold move could never validate.
    // `reachableMetal` returns `Tile.Empty` once no metals remain, which is the
    // right input for colvan's metal-pairs-with-metal rule.
    const lowest = reachableMetal(work);
    if (!canPair(ta, tb, variant, lowest, solo)) return false;
    // placement rule
    const occ = occupancyOf(work);
    if (!freeIn(occ, m.a)) return false;
    if (!solo && !freeIn(occ, m.b)) return false;
    work[m.a] = Tile.Empty;
    if (!solo) work[m.b] = Tile.Empty;
  }
  return countMarbles(work) === 0;
}

function occupancyOf(board: Board): Int32Array {
  const occ = new Int32Array(4);
  for (const c of VALID_CELLS) {
    if (board[c] !== Tile.Empty) occ[CELL_WORD[c]] |= CELL_BIT[c];
  }
  return occ;
}

function lowestMetalOf(board: Board): Tile {
  let best = Tile.Empty;
  for (const c of VALID_CELLS) {
    const t = board[c] as Tile;
    if (isMetal(t) && (best === Tile.Empty || t < best)) best = t;
  }
  return best;
}

/**
 * Whether a cell satisfies the placement rule, from a plain occupancy bitmask.
 *
 * Off-board sides must count as **empty**, exactly as they do in the game and in
 * the search's own `isFree`. This function indexed `CELL_WORD[-1]` for an
 * off-board slot, which yields `undefined`, so `undefined & bit` is 0 and the
 * slot was silently treated as *occupied*. That made `verifySolution` reject
 * legal moves along the rim — a real solution replayed to an empty board and was
 * still reported as invalid.
 */
function freeIn(occ: Int32Array, cell: number): boolean {
  const ring = NEIGHBOURS[cell];
  const n = ring.length;
  if (n < 3) return false;
  let trailing = 0;
  let leading = -1;
  for (let i = 0; i < n; i++) {
    const c = ring[i];
    const empty = c < 0 || (occ[CELL_WORD[c]] & CELL_BIT[c]) === 0;
    if (empty) {
      if (++trailing >= 3) return true;
    } else {
      if (leading < 0) leading = trailing;
      trailing = 0;
    }
  }
  if (leading < 0) leading = 0;
  return trailing + leading >= 3;
}

/** Convenience: is this board still winnable? */
export function isSolvable(board: Board, variant: Variant = 'quicksilver'): boolean {
  return solveBoard(board, variant, { nodeLimit: 1_000_000 }).solved;
}

export { tallyTiles, TOTAL_MARBLES, NEIGHBOUR_COUNT, BOARD_SIZE };
