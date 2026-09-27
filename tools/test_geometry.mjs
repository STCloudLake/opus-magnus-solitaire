/**
 * Checks the neighbour table against the tile geometry.
 *
 * A cell's neighbours are the valid cells within one tile width of it — that is
 * the definition, so this rebuilds the table from the coordinates and asserts
 * the two agree. Doing it this way is deliberate: the table was hand-written
 * more than once and each time it disagreed with the artwork somewhere, most
 * recently on the clipped cells at the card's edges.
 *
 * Usage:  node tools/test_geometry.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-geom2.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const M = await import('file://' + out.replace(/\\/g, '/'));
const { VALID_CELLS, BOARD_SIZE, NEIGHBOURS, cellCentrePx } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failures++;
};

const C = (i) => cellCentrePx(i % BOARD_SIZE, (i / BOARD_SIZE) | 0);
const D = (a, b) => Math.hypot(C(a).x - C(b).x, C(a).y - C(b).y);

let pitch = Infinity;
for (const a of VALID_CELLS) {
  for (const b of VALID_CELLS) if (a < b) pitch = Math.min(pitch, D(a, b));
}

console.log('neighbour table vs tile geometry');
console.log(`  measured pitch: ${pitch.toFixed(4)} px`);

let agree = 0;
const disagree = [];
for (const a of VALID_CELLS) {
  const derived = VALID_CELLS.filter((b) => b !== a && D(a, b) <= pitch + 0.5);
  const table = new Set(NEIGHBOURS[a].filter((n) => n >= 0));
  const same = derived.length === table.size && derived.every((n) => table.has(n));
  if (same) agree++;
  else disagree.push({
    cell: [a % BOARD_SIZE, (a / BOARD_SIZE) | 0],
    derived: derived.map((n) => [n % BOARD_SIZE, (n / BOARD_SIZE) | 0]),
    table: [...table].map((n) => [n % BOARD_SIZE, (n / BOARD_SIZE) | 0]),
  });
}
check(`agrees with geometry on all ${VALID_CELLS.length} cells`,
  agree === VALID_CELLS.length, `${agree}/${VALID_CELLS.length}`);
for (const d of disagree.slice(0, 3)) {
  console.log(`    cell ${d.cell}`);
  console.log(`      derived: ${JSON.stringify(d.derived)}`);
  console.log(`      table  : ${JSON.stringify(d.table)}`);
}

const counts = {};
const ringSizes = new Set();
for (const a of VALID_CELLS) {
  const on = NEIGHBOURS[a].filter((n) => n >= 0).length;
  counts[on] = (counts[on] ?? 0) + 1;
  ringSizes.add(NEIGHBOURS[a].length);
}
// The ring is always six slots; 30 tiles have at least one off-board side, and
// those sides count as empty for the placement rule.
check('every ring is six slots', ringSizes.size === 1 && ringSizes.has(6), [...ringSizes].join(','));
check('on-board neighbour counts are 6 / 4 / 3',
  counts[6] === 61 && counts[4] === 24 && counts[3] === 6, JSON.stringify(counts));
check('30 tiles have an off-board side',
  VALID_CELLS.filter((c) => NEIGHBOURS[c].some((n) => n < 0)).length === 30);

let nonMutual = 0;
let worst = 0;
for (const a of VALID_CELLS) {
  for (const b of NEIGHBOURS[a]) {
    if (b < 0) continue;
    if (!NEIGHBOURS[b].includes(a)) nonMutual++;
    worst = Math.max(worst, Math.abs(D(a, b) - pitch));
  }
}
check('the relation is mutual', nonMutual === 0, `${nonMutual} non-mutual pairs`);
check('every neighbour pair is one tile apart', worst <= 0.5, `worst ${worst.toFixed(3)} px`);

console.log('\nplayable region');
const widths = Array.from({ length: BOARD_SIZE }, (_, y) =>
  VALID_CELLS.filter((c) => ((c / BOARD_SIZE) | 0) === y).length,
);
check('row widths are 6,7,8,9,10,11,10,9,8,7,6',
  widths.join(',') === '6,7,8,9,10,11,10,9,8,7,6', widths.join(','));
check('91 playable cells', VALID_CELLS.length === 91, String(VALID_CELLS.length));

const enc = (x, y) => [x - ((y - (y & 1)) >> 1), y];
const hexDist = (a, b) => {
  const dq = a[0] - b[0], dr = a[1] - b[1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
};
const axial = VALID_CELLS.map((c) => enc(c % BOARD_SIZE, (c / BOARD_SIZE) | 0));
const centre = enc(5, 5);
const radii = axial.reduce((h, a) => {
  const d = hexDist(a, centre);
  h[d] = (h[d] ?? 0) + 1;
  return h;
}, {});
const shell = [0, 1, 2, 3, 4, 5].map((d) => radii[d] ?? 0);
const beyond = radii[6] ?? 0;
console.log('  hex shells from (5,5):', [0, 1, 2, 3, 4, 5, 6].map((d) => radii[d] ?? 0).join(','));
check('is a radius-5 hexagon with six cells carved out of the outer shell',
  shell.join(',') === '1,6,12,18,24,24' && beyond === 6,
  `shell ${shell.join(',')}, beyond ${beyond}`);

console.log(failures === 0 ? '\ngeometry checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
