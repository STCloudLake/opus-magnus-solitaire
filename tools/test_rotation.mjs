/**
 * Verifies the 120-degree symmetry of the generated support.
 *
 * The game builds its deals from orbits of the 120-degree rotation about the
 * centre: the centre plus 18 whole orbits is 1 + 18*3 = 55 cells, exactly the
 * marble count, and it is 3-fold symmetric by construction. Marble *kinds* are
 * dealt across it at random and are not symmetric.
 *
 * Usage:  node tools/test_rotation.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-rot.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const M = await import('file://' + out.replace(/\\/g, '/'));
const { VALID_CELLS, NEIGHBOURS, OFF_BOARD, rotateCell, ROTATION_ORBITS,
        THREE_ORBITS, generateBoard, countMarbles, Tile, solveBoard,
        verifySolution, STANDARD_COUNTS, tallyTiles, variantTotal } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' - ' + detail));
  if (!ok) failures++;
};

console.log('the rotation');
const adjacent = (a, b) => NEIGHBOURS[a].includes(b);
let preserved = 0;
for (const c of VALID_CELLS) {
  const t = rotateCell(c, 1);
  let ok = true;
  for (const n of NEIGHBOURS[c]) {
    if (n === OFF_BOARD) continue;
    if (!adjacent(t, rotateCell(n, 1))) { ok = false; break; }
  }
  if (ok) preserved++;
}
check('120 degrees maps neighbours to neighbours', preserved === VALID_CELLS.length,
  preserved + '/' + VALID_CELLS.length);

const fixed = VALID_CELLS.filter((c) => rotateCell(c, 1) === c);
check('the only fixed cell is the centre (5,5) = 60', fixed.length === 1 && fixed[0] === 60,
  JSON.stringify(fixed.map((c) => [c % 11, (c / 11) | 0])));

// Orbits must partition the board into sizes 1 and 3.
const sizes = {};
for (const o of ROTATION_ORBITS) sizes[o.length] = (sizes[o.length] ?? 0) + 1;
check('orbits are 31 of size 3 (the centre is fixed so its orbit repeats it)', sizes[3] === 31 && !sizes[1],
  JSON.stringify(sizes));
check('18 orbits of three plus the centre is 55 cells',
  1 + 18 * 3 === variantTotal('quicksilver'), String(1 + 18 * 3));
check('the standard game marble count has the form 1 + 3k',
  (variantTotal('quicksilver') - 1) % 3 === 0,
  String(variantTotal('quicksilver')));

console.log('');
console.log('generated deals');
const N = 40;
let sym = 0, total = 0, solved = 0, multisets = 0;
for (let s = 1; s <= N; s++) {
  const g = generateBoard(s, 'quicksilver');
  const b = g.board;
  const occ = VALID_CELLS.filter((c) => b[c] !== Tile.Empty);
  if (occ.every((c) => b[rotateCell(c, 1)] !== Tile.Empty)) sym++;
  if (countMarbles(b) === variantTotal('quicksilver')) total++;
  const tt = tallyTiles(b);
  if (Object.entries(STANDARD_COUNTS).every(([k, v]) => (tt[Number(k)] ?? 0) === v)) multisets++;
  const r = solveBoard(b, 'quicksilver', { nodeLimit: 50000 });
  if (r.solved && verifySolution(b, r.moves, 'quicksilver')) solved++;
}
check('every deal has a 120-degree symmetric support', sym === N, sym + '/' + N);
check('every deal has the right marble count', total === N, total + '/' + N);
check('every deal has the exact multiset', multisets === N, multisets + '/' + N);
check('every deal is solvable and its solution verifies', solved === N, solved + '/' + N);

console.log('');
console.log('both shipped variants are 1 + 3k and so can be symmetric');
// House Colvan drops quicksilver and vitae/mors but still totals 55 including
// gold, so it is 1 + 3*18 and is symmetric exactly like the standard game.
check('House Colvan totals 55', variantTotal('colvan') === 55,
  String(variantTotal('colvan')));
check('House Colvan is 1 + 3k',
  (variantTotal('colvan') - 1) % 3 === 0, String(variantTotal('colvan')));

console.log('');
console.log(failures === 0 ? 'rotation checks passed' : failures + ' failed');
process.exitCode = failures === 0 ? 0 : 1;
