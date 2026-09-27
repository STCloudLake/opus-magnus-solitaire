/**
 * Both shipped variants must deal a centre-symmetric board.
 *
 * The support is the centre plus 18 orbits of the 120-degree rotation, so
 * every marble has its two rotational images, and the board is unchanged by a
 * third of a turn about the middle tile.
 *
 * House Colvan only qualifies because it totals 55 marbles like the standard
 * game — it drops quicksilver and vitae/mors but keeps gold, and 55 is
 * `1 + 3 x 18`. A variant whose count is not `1 + 3k` cannot be symmetric at
 * all, because a symmetric support is the centre plus whole orbits.
 *
 * Usage:  node tools/test_variants.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-variants.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const M = await import('file://' + out.replace(/\\/g, '/'));
const { generateBoard, rotateCell, VALID_CELLS, NEIGHBOURS, Tile, countMarbles,
        variantTotal, tallyTiles, COLVAN_COUNTS, STANDARD_COUNTS, verifySolution } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + name + (ok || !detail ? '' : ' - ' + detail));
  if (!ok) failures++;
};

const live = (c) => NEIGHBOURS[c].filter((n) => n !== -1);
const WANT = { quicksilver: STANDARD_COUNTS, colvan: COLVAN_COUNTS };

for (const variant of ['quicksilver', 'colvan']) {
  console.log(variant === 'colvan' ? "House Colvan" : "Standard Sigmar's Garden");
  const N = 60;
  let sym = 0, rotOk = 0, conn = 0, multiset = 0, solved = 0;
  for (let s = 1; s <= N; s++) {
    const g = generateBoard(s, variant, { difficulty: 'hard' });
    const b = g.board;
    const occ = VALID_CELLS.filter((c) => b[c] !== Tile.Empty);
    const set = new Set(occ);
    // The occupied set must be invariant under a third of a turn...
    if (occ.every((c) => set.has(rotateCell(c, 1)))) sym++;
    // The marble KINDS are deliberately not symmetric - the original's are not,
    // and a kind-symmetric deal is unsolvable - so that is asserted the other
    // way round below.
    if (!occ.every((c) => b[rotateCell(c, 1)] === b[c])) rotOk++;
    const seen = new Set([occ[0]]);
    const dq = [occ[0]];
    while (dq.length) {
      const p = dq.pop();
      for (const q of live(p)) if (set.has(q) && !seen.has(q)) { seen.add(q); dq.push(q); }
    }
    if (seen.size === occ.length) conn++;
    const tt = tallyTiles(b);
    if (Object.entries(WANT[variant]).every(([k, n]) => (tt[Number(k)] ?? 0) === n)) multiset++;
    if (verifySolution(b, g.solution, variant)) solved++;
  }
  check('support is invariant under 120 degrees', sym === N, sym + '/' + N);
  check('marble kinds are NOT symmetric, as in the original', rotOk === N, rotOk + '/' + N);
  check('support is connected', conn === N, conn + '/' + N);
  check('exact marble multiset', multiset === N, multiset + '/' + N);
  check('solvable and solution verifies', solved === N, solved + '/' + N);
  const first = generateBoard(1, variant, { difficulty: 'hard' });
  check('deals 55 marbles', countMarbles(first.board) === 55,
    String(countMarbles(first.board)));
  check('total is 1 + 3k', (variantTotal(variant) - 1) % 3 === 0,
    String(variantTotal(variant)));
  console.log('');
}

console.log('a count that is not 1 + 3k could not be symmetric');
check('standard is 1 + 3k', (variantTotal('quicksilver') - 1) % 3 === 0);
// The support is the centre plus whole orbits, so 1 + 3k is not a choice.
check('the centre is the only fixed cell',
  VALID_CELLS.filter((c) => rotateCell(c, 1) === c).length === 1);

console.log('');
console.log(failures === 0 ? 'variant checks passed' : failures + ' failed');
process.exitCode = failures === 0 ? 0 : 1;
