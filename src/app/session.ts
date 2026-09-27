/**
 * A single session of Sigmar's Garden: the board, the moves made so far,
 * undo, hints and the solver.
 *
 * The session owns game state and emits events; all presentation lives in
 * the UI layer.
 */

import { Tile, isMetal, TILE_ORDER } from '../tiles.js';
import {
  Board,
  Move,
  TOTAL_MARBLES,
  Variant,
  applyMove,
  canPair,
  cloneBoard,
  countMarbles,
  createEmptyBoard,
  hasEnoughFreeNeighbours,
  isStuckFromCounts,
  legalMoves,
  lowestMetalRemaining,
  playableCells,
  playableKinds,
  tallyTiles,
} from '../game.js';
import { generateBoard, solveBoard, type Difficulty } from '../solver.js';

export interface AppliedMove extends Move {
  /** Marble occupying `a` before the move. */
  tileA: Tile;
  /** Marble occupying `b` before the move, or `tileA` for a solo move. */
  tileB: Tile;
  /** True when this move cleared a single marble (gold, taken alone). */
  solo: boolean;
}

export interface GameEvents {
  /** A move was accepted. */
  move: (move: AppliedMove) => void;
  /** The board changed for any reason; UI should redraw. */
  change: () => void;
  /**
   * A marble was picked up, either as a fresh selection or by moving the
   * selection after a mismatched pair.
   *
   * Kept separate from `reject` so the UI can play the pick-up sound for a
   * *successful* selection: an earlier version only played it on `reject`,
   * so tapping a marble was silent and only mis-clicks made a noise.
   */
  select: (cell: number) => void;
  /** The board was cleared. */
  win: (stats: { moves: number; elapsed: number }) => void;
  /** No legal moves remain. */
  deadEnd: () => void;
  /** An illegal attempt was made, so the UI can shake the board. */
  reject: (cell: number) => void;
}

type Listener<K extends keyof GameEvents> = GameEvents[K];

export class Session {
  board: Board = createEmptyBoard();
  variant: Variant = 'quicksilver';
  difficulty: Difficulty = 'easy';
  seed = 0;

  selected: number | null = null;
  history: AppliedMove[] = [];
  startedAt = Date.now();
  finishedAt: number | null = null;

  /** Cells the player has already been shown hints for this deal. */
  hinted: Set<number> = new Set();

  private listeners: { [K in keyof GameEvents]: Set<Listener<K>> } = {
    move: new Set(),
    change: new Set(),
    select: new Set(),
    win: new Set(),
    deadEnd: new Set(),
    reject: new Set(),
  };

  private solution: Move[] = [];
  private solutionIndex = 0;

  on<K extends keyof GameEvents>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn as never);
    return () => this.listeners[event].delete(fn as never);
  }

  private emit<K extends keyof GameEvents>(event: K, ...args: Parameters<GameEvents[K]>): void {
    for (const fn of this.listeners[event]) {
      (fn as (...a: unknown[]) => void)(...args);
    }
  }

  /** Starts a fresh deal, guaranteed to be solvable. */
  newGame(
    seed = (Math.random() * 0xffffffff) >>> 0,
    variant: Variant = this.variant,
    difficulty: Difficulty = this.difficulty,
  ): void {
    this.variant = variant;
    this.difficulty = difficulty;
    this.seed = seed;
    const generated = generateBoard(seed, variant, { difficulty });
    this.board = generated.board;
    this.solution = generated.solution;
    this.solutionIndex = 0;
    this.selected = null;
    this.history = [];
    this.hinted = new Set();
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.emit('change');
  }

  /** Replays a saved solution from move zero, for the "show solution" mode. */
  get fullSolution(): Move[] {
    return this.solution.slice();
  }

  get moveCount(): number {
    return this.history.length;
  }

  get marbleCount(): number {
    return countMarbles(this.board);
  }

  get elapsed(): number {
    return (this.finishedAt ?? Date.now()) - this.startedAt;
  }

  get isFinished(): boolean {
    return this.finishedAt !== null;
  }

  playable(): number[] {
    return playableCells(this.board);
  }

  /**
   * Marbles that can actually be picked up this instant.
   *
   * This is the set the board draws as lit, so it must equal what a click would
   * accept — `playable()` on its own is only the placement rule, and metals that
   * the transmutation order still bars would glow if it were used directly.
   */
  selectableCells(): Set<number> {
    const out = new Set<number>();
    for (const c of playableCells(this.board)) {
      if (this.isSelectable(c)) out.add(c);
    }
    return out;
  }

  lowestMetal(): Tile {
    return lowestMetalRemaining(this.board);
  }

  /**
   * Kinds that could actually be taken right now.
   *
   * Delegates to the engine's {@link playableKinds}, which is the single
   * definition of "playable" — the legend's highlight and the tests both use it,
   * so they cannot drift apart.
   */
  playableKinds(): Set<number> {
    return playableKinds(this.board, this.variant);
  }

  /**
   * True when the marble at `cell` can be picked up right now.
   *
   * The placement rule is the sole authority on whether a marble is
   * loose — it requires three *contiguous* empty neighbours, which is
   * stricter than merely having three empty neighbours. Metals are
   * further constrained by the transmutation order.
   *
   * **Gold is special: it can only be taken once every other marble is gone.**
   * It is the last link of the chain and the only marble that clears alone, so
   * gating it on "it is the lowest metal left" was not enough — that let gold be
   * taken while salt, vitae and the cardinals were still on the board.
   */
  isSelectable(cell: number): boolean {
    const tile = this.board[cell] as Tile;
    if (tile === Tile.Empty) return false;
    if (!hasEnoughFreeNeighbours(this.board, cell)) return false;
    if (this.variant === 'quicksilver') {
      if (tile === Tile.Gold) return this.marbleCount === 1;
      if (isMetal(tile)) {
        const lowest = this.lowestMetal();
        if (lowest !== Tile.Empty && tile !== lowest) return false;
      }
    } else if (tile === Tile.Gold) {
      return this.marbleCount === 1;
    }
    return true;
  }

  /** Clears the current selection, if any. */
  deselect(): void {
    if (this.selected === null) return;
    this.selected = null;
    this.emit('change');
  }

  /**
   * Handles a click on a cell. Returns the move that was made, if any.
   */
  click(cell: number): AppliedMove | null {
    if (this.isFinished) return null;
    const tile = this.board[cell] as Tile;
    if (tile === Tile.Empty) {
      this.selected = null;
      this.emit('change');
      return null;
    }

    if (this.selected === null) {
      if (!this.isSelectable(cell)) {
        this.emit('reject', cell);
        return null;
      }
      // Gold clears on its own, and by the time it is selectable it is the only
      // marble left, so a single click finishes the board rather than arming the
      // selection and waiting for a second one.
      if (tile === Tile.Gold && this.marbleCount === 1) {
        return this.commit({ a: cell, b: cell, solo: true });
      }
      this.selected = cell;
      this.emit('select', cell);
      this.emit('change');
      return null;
    }

    if (this.selected === cell) {
      // Clicking a selected marble again: gold clears itself, anything
      // else just deselects.
      if (tile === Tile.Gold && this.isSelectable(cell)) {
        return this.commit({ a: cell, b: cell, solo: true });
      }
      this.selected = null;
      this.emit('change');
      return null;
    }

    const first = this.selected;
    const tileA = this.board[first] as Tile;
    if (!this.isSelectable(cell)) {
      // Treat it as a fresh selection if it is selectable at all;
      // otherwise reject. `isSelectable` already failed, so reject.
      this.emit('reject', cell);
      return null;
    }

    const lowest = this.variant === 'colvan' ? Tile.Empty : this.lowestMetal();
    if (!canPair(tileA, tile, this.variant, lowest)) {
      // Switch selection to the newly clicked marble, which is the
      // friendliest behaviour for a mis-click.
      this.selected = cell;
      this.emit('select', cell);
      this.emit('reject', cell);
      this.emit('change');
      return null;
    }

    return this.commit({ a: first, b: cell });
  }

  private commit(move: Move): AppliedMove {
    const tileA = this.board[move.a] as Tile;
    const tileB = this.board[move.b] as Tile;
    const solo = move.b === move.a;

    const applied: AppliedMove = {
      a: move.a,
      b: move.b,
      tileA,
      tileB: solo ? tileA : tileB,
      solo,
    };

    this.board = cloneBoard(this.board);
    applyMove(this.board, move);
    this.history.push(applied);
    this.selected = null;
    this.hinted = new Set();
    // Keep the solution pointer in sync when the player follows it.
    if (this.solutionIndex < this.solution.length) this.solutionIndex++;

    this.emit('move', applied);

    if (countMarbles(this.board) === 0) {
      this.finishedAt = Date.now();
      this.emit('win', { moves: this.history.length, elapsed: this.elapsed });
    } else if (legalMoves(this.board, this.variant).length === 0) {
      this.finishedAt = Date.now();
      this.emit('deadEnd');
    }

    this.emit('change');
    return applied;
  }

  undo(): boolean {
    const last = this.history.pop();
    if (!last) return false;
    this.board = cloneBoard(this.board);
    this.board[last.a] = last.tileA;
    if (last.b !== last.a) this.board[last.b] = last.tileB;
    this.selected = null;
    this.finishedAt = null;
    if (this.solutionIndex > 0) this.solutionIndex--;
    this.emit('change');
    return true;
  }

  /**
   * Suggests a move. Prefers a move that belongs to the known solution so
   * the hint always leads somewhere winnable.
   */
  hint(): Move | null {
    const moves = legalMoves(this.board, this.variant);
    if (moves.length === 0) return null;

    const key = (m: Move) => `${Math.min(m.a, m.b)}:${Math.max(m.a, m.b)}`;
    const onSolution = new Set(this.solution.map(key));
    const candidates = moves.filter((m) => onSolution.has(key(m)));
    const pool = candidates.length > 0 ? candidates : moves;

    // Deterministic but varied: pick from the pool using the move index.
    const choice = pool[this.history.length % pool.length];
    this.hinted = new Set([choice.a, choice.b]);
    this.emit('change');
    return choice;
  }

  /** True when the hinted pair is a legal move right now. */
  isHintLegal(): boolean {
    if (this.hinted.size === 0) return false;
    const [a, b] = [...this.hinted];
    if (b === undefined) return canPair(Tile.Gold, Tile.Gold, this.variant, this.lowestMetal(), true);
    return canPair(
      this.board[a] as Tile,
      this.board[b] as Tile,
      this.variant,
      this.variant === 'colvan' ? Tile.Empty : this.lowestMetal(),
    );
  }

  /** Solves the current position, ignoring the original deal. */
  solveNow(): Move[] {
    const result = solveBoard(this.board, this.variant, { nodeLimit: 3_000_000 });
    return result.solved ? result.moves : [];
  }

  tally(): Record<number, number> {
    return tallyTiles(this.board);
  }

  isStuck(): boolean {
    return isStuckFromCounts(this.board) || legalMoves(this.board, this.variant).length === 0;
  }
}

export { TILE_ORDER, TOTAL_MARBLES, Tile };
