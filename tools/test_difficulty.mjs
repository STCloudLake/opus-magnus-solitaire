/**
 * Pins the difficulty split.
 *
 * Easy spreads the support over the board; Hard grows it as a connected blob
 * and screens it so the opening position is as closed as the original's. The
 * loose count (how many marbles are playable at the first move) is decided
 * entirely by which cells the support occupies, so it is measured directly.
 *
 * Usage:  node tools/test_difficulty.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-diff.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const M = await import('file://' + out.replace(/\\/g, '/'));
const { generateBoard, playableCells, VALID_CELLS, NEIGHBOURS, rotateCell, Tile,
        verifySolution, countMarbles, variantTotal } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' - ' + detail));
  if (!ok) failures++;
};

const live = (c) => NEIGHBOURS[c].filter((n) => n !== -1);
const N = 60;

function measure(difficulty) {
  const loose = [];
  let sym = 0, conn = 0, solved = 0, marbles = 0;
  for (let s = 1; s <= N; s++) {
    const g = generateBoard(s, 'quicksilver', { difficulty });
    const b = g.board;
    const occ = VALID_CELLS.filter((c) => b[c] !== Tile.Empty);
    const set = new Set(occ);
    if (occ.every((c) => set.has(rotateCell(c, 1)))) sym++;
    const seen = new Set([occ[0]]);
    const dq = [occ[0]];
    while (dq.length) {
      const p = dq.pop();
      for (const q of live(p)) if (set.has(q) && !seen.has(q)) { seen.add(q); dq.push(q); }
    }
    if (seen.size === occ.length) conn++;
    if (countMarbles(b) === variantTotal('quicksilver')) marbles++;
    loose.push(playableCells(b).length);
    // Verify the solution the generator recorded, not a fresh search: the solver
    // breaks ties randomly and is node-limited, so re-solving can miss a
    // solution that the generator already found and proved.
    if (verifySolution(b, g.solution, 'quicksilver')) solved++;
  }
  const mean = loose.reduce((a, b) => a + b, 0) / N;
  return { loose, mean, min: Math.min(...loose), max: Math.max(...loose), sym, conn, solved, marbles };
}

console.log('hard is tight, easy is open');
const hard = measure('hard');
const easy = measure('easy');

// The original's opening position holds 6-9 loose marbles, from decoding
// solitaire.dat over 10000 boards.
check('hard stays within the original\'s range (6..9)',
  hard.min >= 6 && hard.max <= 9, hard.min + '..' + hard.max);
check('hard is much tighter than easy',
  hard.mean < easy.mean - 5, 'hard ' + hard.mean.toFixed(2) + ' vs easy ' + easy.mean.toFixed(2));
check('hard mean loose is under 9', hard.mean < 9, hard.mean.toFixed(2));
check('easy mean loose is well above the original', easy.mean > 12, easy.mean.toFixed(2));

console.log('');
console.log('both modes stay valid');
for (const [name, m] of [['hard', hard], ['easy', easy]]) {
  check(name + ' deals 55 marbles', m.marbles === N, m.marbles + '/' + N);
  check(name + ' support is 120-degree symmetric', m.sym === N, m.sym + '/' + N);
  check(name + ' is solvable and the solution verifies', m.solved === N, m.solved + '/' + N);
}
check('hard support is always connected', hard.conn === N, hard.conn + '/' + N);

console.log('');
console.log('  hard loose: min ' + hard.min + ' mean ' + hard.mean.toFixed(2) + ' max ' + hard.max);
console.log('  easy loose: min ' + easy.min + ' mean ' + easy.mean.toFixed(2) + ' max ' + easy.max);
console.log('  original  : min 6 mean 7.42 max 9');
console.log('');
console.log(failures === 0 ? 'difficulty checks passed' : failures + ' failed');
process.exitCode = failures === 0 ? 0 : 1;
