import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(os.tmpdir(), `sg-board-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile, logLevel: 'error',
});
const M = await import(`file://${outfile.replace(/\\/g, '/')}`);
const { generateBoard, VALID_CELLS, BOARD_SIZE, Tile, tileInfo, countMarbles, CENTRE_CELL } = M;

const g = generateBoard(Number(process.argv[2] ?? 7), process.argv[3] ?? 'quicksilver');
console.log('marbles', countMarbles(g.board), 'centre cell', CENTRE_CELL,
            `(${CENTRE_CELL % 11},${Math.floor(CENTRE_CELL / 11)})`);

const glyph = (t) => (t === Tile.Empty ? ' .' : (tileInfo(t)?.key ?? '??').slice(0, 2).padEnd(2, ' '));
for (let y = 0; y < BOARD_SIZE; y++) {
  let line = '';
  if (y % 2 === 1) line += '  ';
  for (let x = 0; x < BOARD_SIZE; x++) {
    const c = y * BOARD_SIZE + x;
    line += VALID_CELLS.includes(c) ? glyph(g.board[c]) + ' ' : '   ';
  }
  console.log(`${String(y).padStart(2)} ${line}`);
}

// Occupancy per column and row.
console.log('\nper-row marble counts:');
for (let y = 0; y < BOARD_SIZE; y++) {
  let n = 0, cells = 0;
  for (let x = 0; x < BOARD_SIZE; x++) {
    const c = y * BOARD_SIZE + x;
    if (!VALID_CELLS.includes(c)) continue;
    cells++;
    if (g.board[c] !== Tile.Empty) n++;
  }
  console.log(`  row ${String(y).padStart(2)}: ${n}/${cells}`);
}
let left = 0, right = 0;
for (const c of VALID_CELLS) {
  if (g.board[c] === Tile.Empty) continue;
  const x = c % BOARD_SIZE;
  if (x < 5) left++; else if (x > 5) right++;
}
console.log(`\nmarbles left of centre: ${left}, right of centre: ${right}`);
