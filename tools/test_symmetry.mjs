/**
 * Checks the symmetry of the playable lattice, and the off-board rule.
 *
 * The board admits exactly one reflection that maps neighbours to neighbours:
 * the horizontal one, y -> 10-y. Adjacency is compared as a SET, from tile
 * distance, not by ring slot position -- the ring is ordered for the "three
 * contiguous" rule, and slot ordering is not preserved by a mirror of a board
 * whose rows are offset.
 *
 * Vertical reflection and 180-degree rotation are NOT automorphisms here, which
 * is worth asserting because they are the intuitive guesses.
 *
 * Usage:  node tools/test_symmetry.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-sym.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const M = await import('file://' + out.replace(/\\/g, '/'));
const { VALID_CELLS, BOARD_SIZE, NEIGHBOURS, cellCentrePx, OFF_BOARD } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' - ' + detail));
  if (!ok) failures++;
};

const valid = new Set(VALID_CELLS);
const xy = (c) => [c % BOARD_SIZE, (c / BOARD_SIZE) | 0];
const idx = (x, y) => y * BOARD_SIZE + x;
const D = (a, b) => {
  const p = cellCentrePx(xy(a)[0], xy(a)[1]);
  const q = cellCentrePx(xy(b)[0], xy(b)[1]);
  return Math.hypot(p.x - q.x, p.y - q.y);
};
const adjacent = (a, b) => a !== b && D(a, b) <= 66.5;

function evaluate(f) {
  let onBoard = 0, preserved = 0, fixed = 0;
  for (const c of VALID_CELLS) {
    const rc = f(xy(c)[0], xy(c)[1]);
    const a = rc[0], b = rc[1];
    if (a < 0 || a > 10 || b < 0 || b > 10) continue;
    const tc = idx(a, b);
    if (!valid.has(tc)) continue;
    onBoard++;
    if (tc === c) fixed++;
    let ok = true;
    for (const n of VALID_CELLS) {
      if (!adjacent(c, n)) continue;
      const rn = f(xy(n)[0], xy(n)[1]);
      const na = rn[0], nb = rn[1];
      if (na < 0 || na > 10 || nb < 0 || nb > 10) continue;
      const tn = idx(na, nb);
      if (!valid.has(tn) || !adjacent(tc, tn)) { ok = false; break; }
    }
    if (ok) preserved++;
  }
  return { onBoard, preserved, fixed };
}

console.log('candidate symmetries');
const hReflect = evaluate((x, y) => [x, 10 - y]);
check('horizontal reflection y -> 10-y preserves adjacency',
  hReflect.onBoard === 91 && hReflect.preserved === 91,
  'on-board ' + hReflect.onBoard + '/91, preserving ' + hReflect.preserved + '/91');
console.log('    fixed cells (middle row): ' + hReflect.fixed);

const vReflect = evaluate((x, y) => [10 - x, y]);
check('vertical reflection x -> 10-x does NOT preserve adjacency',
  vReflect.preserved < vReflect.onBoard,
  'preserving ' + vReflect.preserved + '/' + vReflect.onBoard);

const rot180 = evaluate((x, y) => [10 - x, 10 - y]);
check('180-degree rotation does NOT preserve adjacency',
  rot180.preserved < rot180.onBoard,
  'preserving ' + rot180.preserved + '/' + rot180.onBoard);

console.log('');
console.log('off-board sides count as empty');
check('every ring is six slots', VALID_CELLS.every((c) => NEIGHBOURS[c].length === 6));
const offCells = VALID_CELLS.filter((c) => NEIGHBOURS[c].includes(OFF_BOARD));
check('30 tiles have an off-board side', offCells.length === 30, String(offCells.length));
let mismatch = 0;
for (const a of VALID_CELLS) {
  const ring = new Set(NEIGHBOURS[a].filter((n) => n !== OFF_BOARD));
  for (const b of VALID_CELLS) {
    if (b === a) continue;
    if (adjacent(a, b) !== ring.has(b)) mismatch++;
  }
}
check('ring content matches distance adjacency', mismatch === 0, mismatch + ' mismatches');

console.log('');
console.log(failures === 0 ? 'symmetry checks passed' : failures + ' failed');
process.exitCode = failures === 0 ? 0 : 1;
