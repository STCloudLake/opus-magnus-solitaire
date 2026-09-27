/**
 * Pins the off-board rule: sides of a tile that fall off the card count as
 * empty for the "three contiguous empty neighbours" test.
 *
 * This was missing. The neighbour ring used to contain only the cells that
 * exist, so an off-board side was ignored rather than treated as empty, which
 * made every edge and corner marble harder to free than the game intends.
 *
 * Usage:  node tools/test_offboard.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-offboard.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const M = await import('file://' + out.replace(/\\/g, '/'));
const { VALID_CELLS, NEIGHBOURS, OFF_BOARD, Tile, createEmptyBoard,
        playableCells, hasEnoughFreeNeighbours } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' - ' + detail));
  if (!ok) failures++;
};

const xy = (c) => [c % 11, (c / 11) | 0];

console.log('a packed board, so the only empty sides are off-board ones');
const b = createEmptyBoard();
for (const c of VALID_CELLS) b[c] = Tile.Air;
b[60] = Tile.Gold;

const corners = VALID_CELLS.filter((c) => NEIGHBOURS[c].filter((n) => n === OFF_BOARD).length === 3);
const edges = VALID_CELLS.filter((c) => NEIGHBOURS[c].filter((n) => n === OFF_BOARD).length === 2);
const interior = VALID_CELLS.filter((c) => !NEIGHBOURS[c].includes(OFF_BOARD));
check('there are 6 corner tiles, each with 3 off-board sides', corners.length === 6, String(corners.length));
check('there are 24 edge tiles, each with 2 off-board sides', edges.length === 24, String(edges.length));
check('there are 61 interior tiles', interior.length === 61, String(interior.length));

// A corner has three contiguous off-board sides, so it is selectable at once.
let cornerLoose = 0;
for (const c of corners) if (hasEnoughFreeNeighbours(b, c)) cornerLoose++;
check('every corner marble is loose on a packed board', cornerLoose === 6,
  cornerLoose + '/6');

// An interior marble on a packed board has no empty side at all.
let interiorLoose = 0;
for (const c of interior) if (hasEnoughFreeNeighbours(b, c)) interiorLoose++;
check('no interior marble is loose on a packed board', interiorLoose === 0,
  String(interiorLoose));

console.log('');
console.log('the playable set on a packed board is exactly the corners');
const loose = playableCells(b);
check('playable cells are the 6 corners',
  loose.length === 6 && loose.every((c) => corners.includes(c)),
  loose.map(xy).map(String).join(' '));

console.log('');
console.log('an off-board side counts as one empty slot, not three');
// The six cells adjacent to a corner: freeing exactly two of them plus the
// off-board side should not be enough for a corner that has three off-board
// sides... but a corner needs 3, which it already has. Check an edge tile
// instead: it has 1 off-board side, so it needs 2 more contiguous.
check('edge marbles are not loose on a packed board (2 off-board is not enough)',
  edges.every((c) => !hasEnoughFreeNeighbours(b, c)),
  'edges loose: ' + edges.filter((c) => hasEnoughFreeNeighbours(b, c)).length);

console.log('');
console.log(failures === 0 ? 'off-board rule checks passed' : failures + ' failed');
process.exitCode = failures === 0 ? 0 : 1;
