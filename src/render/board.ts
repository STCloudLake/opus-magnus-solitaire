/**
 * Board renderer.
 *
 * The hexagonal board is drawn from the game's own `board.png` so the
 * carved tiles, frame and lighting are authentic. Marbles are drawn on
 * top with the procedural sprites, and all overlay effects (hover,
 * selection, hints, spawn and clear animations) are composed in the same
 * coordinate space.
 *
 * The renderer works in *board space* — the pixel coordinates of
 * `board.png` — and applies a single uniform scale so the whole board
 * always fits the viewport.
 */

import {
  BOARD_SIZE,
  NEIGHBOURS,
  PITCH_X,
  PITCH_Y,
  VALID_CELLS,
  cellCentrePx,
} from '../grid.js';
import { Tile, tileInfo } from '../tiles.js';
import type { Board } from '../game.js';
import { SPRITE_SIZE, buildSpriteSheet, type SpriteSet } from './sprites.js';

/** Native size of `board.png`. */
export const BOARD_IMAGE_WIDTH = 841;
export const BOARD_IMAGE_HEIGHT = 758;

/** Half-width and half-height of a carved tile, for hover outlines. */
const HEX_W = 66;
const HEX_H = 76;

/**
 * Marble diameter as drawn, in board-space pixels.
 *
 * The game's own coordinate helper puts a marble at 52 px on a 66 px tile
 * (`MarbleSize` / `MarbleOffsetX` in the community reverse engineering),
 * and its hover overlay is 74 px. 56 px keeps the sphere comfortably
 * inside the carved recess without looking undersized.
 */
export const MARBLE_DIAMETER = 56;

export interface Pulse {
  cell: number;
  /** Milliseconds elapsed since the pulse started. */
  age: number;
  /** Total lifetime in milliseconds. */
  life: number;
  /** Which of the four shadow frames to use. */
  frame: number;
}

export interface RenderState {
  board: Board;
  time: number;
  hoverCell: number | null;
  selected: number | null;
  /** Cells that satisfy the placement rule, for the "playable" affordance. */
  playable: Set<number>;
  /** Cells highlighted by the hint button. */
  hinted: Set<number>;
  /** Cells holding a marble compatible with the current selection. */
  matchable: Set<number>;
  /** Cells that are in the middle of their clear animation. */
  clearing: Map<number, number>;
  /** Cells still animating in after a new deal. */
  spawning: Map<number, number>;
  pulses: Pulse[];
  /** When false the board is drawn without interaction affordances. */
  interactive: boolean;
}

export interface RendererAssets {
  board: HTMLImageElement;
  hexHovered: HTMLImageElement;
  atomHovered: HTMLImageElement;
  atomSpawned: HTMLImageElement;
  pulseHighlight: HTMLImageElement;
  pulseShadow: HTMLImageElement[];
}

const PULSE_FRAMES = 4;
const SPAWN_MS = 260;
const CLEAR_MS = 320;

export class BoardRenderer {
  private sprites: SpriteSet;
  private assets: RendererAssets;
  /** Fraction of board space per canvas pixel. */
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  /**
   * Fine alignment nudge for the marbles, in board pixels.
   *
   * A single global correction is not enough to seat every marble: the
   * lattice phase and the tile centres disagree by a fraction of a tile
   * that varies with how the artwork was generated. This shifts every
   * marble (and its shadow) together so the whole set can be dialled in
   * against the carved tiles by eye.
   *
   * It is applied to drawing *and* hit-testing, so clicking always lands on
   * the marble you can see.
   */
  marbleOffset = { x: 0, y: 0 };

  private constructor(assets: RendererAssets, sprites: SpriteSet) {
    this.assets = assets;
    this.sprites = sprites;
  }

  /**
   * Builds a renderer with every marble composited from the game's
   * textures. Loading is asynchronous, so this must be awaited before the
   * first draw.
   */
  static async create(assets: RendererAssets): Promise<BoardRenderer> {
    const sprites = await buildSpriteSheet();
    return new BoardRenderer(assets, sprites);
  }

  /** Fits the board into a canvas of the given CSS size. */
  layout(cssWidth: number, cssHeight: number): void {
    const pad = 0.02;
    const sx = cssWidth / (BOARD_IMAGE_WIDTH * (1 + pad));
    const sy = cssHeight / (BOARD_IMAGE_HEIGHT * (1 + pad));
    this.scale = Math.min(sx, sy);
    this.offsetX = (cssWidth - BOARD_IMAGE_WIDTH * this.scale) / 2;
    this.offsetY = (cssHeight - BOARD_IMAGE_HEIGHT * this.scale) / 2;
  }

  /**
   * Where a cell's marble is drawn, in board-image pixels.
   *
   * `cellCentrePx` gives the tile centre; `marbleOffset` is the global
   * alignment nudge applied on top.
   */
  marbleCentre(cell: number): { x: number; y: number } {
    const c = cellCentrePx(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE));
    return { x: c.x + this.marbleOffset.x, y: c.y + this.marbleOffset.y };
  }

  /**
   * Converts a pointer position in CSS pixels to a board cell.
   *
   * Picks the nearest marble centre rather than inverting a lattice
   * formula, so hit-testing can never drift out of step with where the
   * marbles are actually drawn — including the calibration nudge.
   */
  cellAtPoint(cssX: number, cssY: number): number | null {
    const bx = (cssX - this.offsetX) / this.scale;
    const by = (cssY - this.offsetY) / this.scale;
    let best: number | null = null;
    let bestD = Infinity;
    for (const cell of VALID_CELLS) {
      const c = this.marbleCentre(cell);
      const d = (bx - c.x) ** 2 + (by - c.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    // Reject a click that lands in the frame rather than on a tile.
    const limit = Math.min(HEX_W, HEX_H) * 0.5;
    return best !== null && bestD <= limit * limit ? best : null;
  }

  /** Centre of a cell's marble in CSS pixels. */
  cellToCss(cell: number): { x: number; y: number } {
    const c = this.marbleCentre(cell);
    return { x: this.offsetX + c.x * this.scale, y: this.offsetY + c.y * this.scale };
  }

  draw(ctx: CanvasRenderingContext2D, state: RenderState, cssWidth: number, cssHeight: number): void {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    ctx.drawImage(this.assets.board, 0, 0, BOARD_IMAGE_WIDTH, BOARD_IMAGE_HEIGHT);

    this.drawPulses(ctx, state);
    this.drawHover(ctx, state);
    this.drawMarbles(ctx, state);

    ctx.restore();
  }

  private drawHover(ctx: CanvasRenderingContext2D, state: RenderState): void {
    if (!state.interactive) return;
    const cell = state.hoverCell;
    if (cell === null) return;
    const info = state.board[cell];
    const c = this.marbleCentre(cell);
    const img = info === Tile.Empty ? this.assets.hexHovered : this.assets.atomHovered;
    if (!img.complete || img.naturalWidth === 0) return;
    // Both overlays are authored slightly larger than a tile.
    const w = info === Tile.Empty ? 71 : 74;
    const h = info === Tile.Empty ? 80 : 74;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img, c.x - w / 2, c.y - h / 2, w, h);
    ctx.restore();
  }

  private drawPulses(ctx: CanvasRenderingContext2D, state: RenderState): void {
    for (const p of state.pulses) {
      const c = this.marbleCentre(p.cell);
      const t = Math.min(1, p.age / p.life);
      const shadow = this.assets.pulseShadow[p.frame % PULSE_FRAMES];
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.85;
      const grow = 1 + t * 0.55;
      if (shadow?.complete && shadow.naturalWidth) {
        ctx.drawImage(shadow, c.x - 42 * grow, c.y - 45.5 * grow, 84 * grow, 91 * grow);
      }
      if (this.assets.pulseHighlight.complete && this.assets.pulseHighlight.naturalWidth) {
        ctx.globalAlpha = (1 - t) * 0.75;
        ctx.drawImage(
          this.assets.pulseHighlight,
          c.x - 42 * grow,
          c.y - 45.5 * grow,
          84 * grow,
          91 * grow,
        );
      }
      ctx.restore();
    }
  }

  private drawMarbles(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const r = MARBLE_DIAMETER / 2;

    // Pass 1: contact shadows, so they never overlap a neighbouring marble.
    for (const cell of VALID_CELLS) {
      const tile = state.board[cell];
      const clearing = state.clearing.get(cell);
      if (tile === Tile.Empty && clearing === undefined) continue;
      if (state.spawning.has(cell)) continue;
      const c = this.marbleCentre(cell);
      const t = clearing === undefined ? 0 : Math.min(1, clearing / CLEAR_MS);
      const alpha = clearing === undefined ? 0.62 : 0.62 * (1 - t);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.sprites.shadow, c.x - r * 1.05, c.y - r * 0.8, r * 2.1, r * 1.6);
      ctx.restore();
    }

    // Pass 2: the marbles themselves.
    for (const cell of VALID_CELLS) {
      const tile = state.board[cell];
      const clearing = state.clearing.get(cell);
      if (tile === Tile.Empty && clearing === undefined) continue;

      const info = tileInfo(tile);
      if (!info) continue;
      const sprite = this.sprites.marbles.get(tile);
      if (!sprite) continue;

      const c = this.marbleCentre(cell);
      const spawnAge = state.spawning.get(cell);

      // Spawn: marbles drop in and pop slightly past full size.
      let scale = 1;
      let alpha = 1;
      let dy = 0;
      if (spawnAge !== undefined) {
        const t = Math.min(1, spawnAge / SPAWN_MS);
        const ease = 1 - Math.pow(1 - t, 3);
        scale = 0.6 + 0.4 * ease + Math.sin(t * Math.PI) * 0.07;
        alpha = ease;
        dy = (1 - ease) * -10;
      }

      // Clear: shrink out with a bright flash.
      if (clearing !== undefined) {
        const t = Math.min(1, clearing / CLEAR_MS);
        scale = 1 + t * 0.35;
        alpha = 1 - t;
        ctx.save();
        ctx.globalAlpha = alpha * 0.9;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(
          this.sprites.glow,
          c.x - r * 2.1 * scale,
          c.y - r * 2.1 * scale + dy,
          r * 4.2 * scale,
          r * 4.2 * scale,
        );
        ctx.restore();
      }

      // Locked marbles use their own faded, desaturated sprite rather than
      // being dimmed with alpha alone, so playable and locked read differently
      // at a glance.
      const isPlayable = state.playable.has(cell);
      const isSelected = state.selected === cell;
      const isMatchable = state.matchable.has(cell);
      const isHinted = state.hinted.has(cell);
      const spriteToDraw =
        state.interactive && !isPlayable && !isSelected && !isMatchable && !isHinted
          ? (this.sprites.locked.get(tile) ?? sprite)
          : sprite;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      const size = r * 2 * scale;
      ctx.drawImage(spriteToDraw, c.x - size / 2, c.y - size / 2 + dy, size, size);
      ctx.restore();

      // Highlight rings.
      if (isSelected || isMatchable || isHinted) {
        const colour = isSelected
          ? 'rgba(255, 244, 214, 0.95)'
          : isHinted
            ? 'rgba(126, 214, 255, 0.9)'
            : 'rgba(255, 224, 150, 0.85)';
        ctx.save();
        ctx.beginPath();
        ctx.arc(c.x, c.y + dy, r * 1.06, 0, Math.PI * 2);
        ctx.strokeStyle = colour;
        ctx.lineWidth = isSelected ? 3 : 2;
        const glowPulse = 0.55 + 0.45 * Math.sin(state.time / 260);
        ctx.globalAlpha = isSelected ? 1 : 0.45 + 0.35 * glowPulse;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Pass 3: a subtle ring on every playable marble.
    if (state.interactive) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 246, 214, 0.34)';
      ctx.lineWidth = 1.2;
      for (const cell of state.playable) {
        if (cell === state.selected) continue;
        if (state.board[cell] === Tile.Empty) continue;
        const c = this.marbleCentre(cell);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r * 1.06, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

export { NEIGHBOURS, SPRITE_SIZE };
