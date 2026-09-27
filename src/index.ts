/**
 * Public surface of the Sigmar's Garden engine.
 *
 * `main.js` (built from `src/main.ts`) is the full application; this
 * bundle exposes the engine itself so the rules, geometry and solver can
 * be imported on their own — for tests, tools or a different front end.
 */

export * from './tiles.js';
export * from './grid.js';
export * from './game.js';
export * from './solver.js';

export { BoardRenderer, MARBLE_DIAMETER, BOARD_IMAGE_WIDTH, BOARD_IMAGE_HEIGHT } from './render/board.js';
export type { RenderState, Pulse, RendererAssets } from './render/board.js';
export { buildSpriteSheet, buildLegendSprites, SPRITE_SIZE } from './render/sprites.js';
export type { SpriteSet } from './render/sprites.js';

export { Session } from './app/session.js';
export type { AppliedMove, GameEvents } from './app/session.js';
export { App } from './app/ui.js';
export { AudioEngine, audio } from './app/audio.js';
