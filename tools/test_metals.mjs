/**
 * Pins the metal-highlight rule.
 *
 * The bug: the legend lit a metal as soon as a marble of its kind was *loose*,
 * ignoring the transmutation order, so tin, iron and silver all lit up while
 * lead was still on the board. Reproducing it needs a board with several
 * different metals loose at once, which is why the scenario below opens a board
 * up deliberately rather than trusting a random deal to expose it.
 *
 * Usage:  node tools/test_metals.mjs
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source entry relative to this file, so the repo runs from any
// checkout rather than only the machine it was written on.
const SRC_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const out = path.join(tmpdir(), 'sg-metals.mjs');
await build({
  entryPoints: [SRC_ENTRY],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: out, logLevel: 'error',
});
const engine = await import('file://' + out.replace(/\\/g, '/'));
const M = engine;
const { Tile, canPair, lowestMetalRemaining, createEmptyBoard, cloneBoard,
        generateBoard, VALID_CELLS, playableCells, applyMove } = M;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failures++;
};
const NAME = { 1:'salt',2:'air',3:'fire',4:'water',5:'earth',6:'quicksilver',
               7:'lead',8:'tin',9:'iron',10:'copper',11:'silver',12:'gold',
               13:'vitae',14:'mors' };
const METALS = [Tile.Lead, Tile.Tin, Tile.Iron, Tile.Copper, Tile.Silver];
const isMetal = (t) => t >= Tile.Lead && t <= Tile.Silver;

/**
 * The legend rule, taken from the engine rather than reimplemented here.
 *
 * This used to be a local copy, and that copy carried the very bug being
 * tested: it lit every loose gold unconditionally. The engine now owns the one
 * definition, so the legend's highlight and these checks cannot disagree.
 */
const legendPlayableKinds = (board, variant = 'quicksilver') =>
  engine.playableKinds(board, variant);

console.log('canPair respects the transmutation order');
const b = createEmptyBoard();
const place = (t, n) => {
  let k = 0;
  for (const c of VALID_CELLS) if (b[c] === Tile.Empty && k < n) { b[c] = t; k++; }
};
place(Tile.Lead, 1); place(Tile.Tin, 1); place(Tile.Iron, 1); place(Tile.Silver, 1);
place(Tile.Quicksilver, 4);
check('lowest remaining metal is lead', lowestMetalRemaining(b) === Tile.Lead);
check('lead pairs with quicksilver', canPair(Tile.Lead, Tile.Quicksilver, 'quicksilver', lowestMetalRemaining(b)));
for (const t of [Tile.Tin, Tile.Iron, Tile.Copper, Tile.Silver]) {
  check(`${NAME[t]} does not pair while lead remains`,
    !canPair(t, Tile.Quicksilver, 'quicksilver', lowestMetalRemaining(b)));
}

console.log('\nafter lead is removed, tin takes over');
const b2 = applyMove(b, {
  a: VALID_CELLS.find((c) => b[c] === Tile.Lead),
  b: VALID_CELLS.find((c) => b[c] === Tile.Quicksilver),
});
check('lowest is now tin', lowestMetalRemaining(b2) === Tile.Tin);
check('tin pairs with quicksilver', canPair(Tile.Tin, Tile.Quicksilver, 'quicksilver', lowestMetalRemaining(b2)));
check('iron does not pair while tin remains',
  !canPair(Tile.Iron, Tile.Quicksilver, 'quicksilver', lowestMetalRemaining(b2)));

console.log('\nthe regression: several metals loose at once');
// Open a real board up so that lead, tin, iron and silver are ALL loose.
const opened = cloneBoard(generateBoard(2, 'quicksilver').board);
for (const c of VALID_CELLS.slice(0, 40)) if (opened[c] !== Tile.Gold) opened[c] = Tile.Empty;
const spots = playableCells(opened);
for (let k = 0; k < 4 && k < spots.length; k++) opened[spots[k]] = METALS[k];
for (let k = 4; k < Math.min(spots.length, 8); k++) opened[spots[k]] = Tile.Quicksilver;

const loose = playableCells(opened);
const lowest = lowestMetalRemaining(opened);
const kinds = legendPlayableKinds(opened);
console.log(`    lowest metal ${NAME[lowest]}, loose kinds: ${[...new Set(loose.map((c) => NAME[opened[c]]))].join(', ')}`);
console.log(`    lit: ${[...kinds].map((t) => NAME[t]).join(', ')}`);

let looseMetals = 0;
for (const t of METALS) {
  const n = loose.filter((c) => opened[c] === t).length;
  if (n > 0) looseMetals++;
}
check('the scenario really has several metals loose', looseMetals >= 3, `${looseMetals} metals loose`);
check('only the lowest metal is lit',
  METALS.filter((t) => kinds.has(t)).every((t) => t === lowest),
  `lit ${JSON.stringify(METALS.filter((t) => kinds.has(t)).map((t) => NAME[t]))} with lowest ${NAME[lowest]}`);
check('the lowest metal IS lit', kinds.has(lowest));
check('loose non-lowest metals are NOT lit',
  METALS.every((t) => t === lowest || !kinds.has(t)),
  JSON.stringify(METALS.filter((t) => t !== lowest && kinds.has(t)).map((t) => NAME[t])));

console.log('\nacross generated solutions');
let observations = 0, violations = 0;
for (let seed = 1; seed <= 6; seed++) {
  const g = generateBoard(seed, 'quicksilver');
  let board = g.board;
  for (const move of g.solution) {
    const low = lowestMetalRemaining(board);
    for (const t of legendPlayableKinds(board)) {
      if (isMetal(t)) {
        observations++;
        if (t !== low) violations++;
      }
    }
    board = applyMove(board, move);
  }
}
check('no non-lowest metal is ever lit during play', violations === 0,
  `${violations} violations over ${observations} observations`);

console.log('\ngold is gated by the chain too (the second regression)');
// Gold used to be lit whenever it was merely loose, even with a lower metal on
// the board, because the rule special-cased it. Build exactly that state: gold
// loose, plus tin, and no quicksilver anywhere.
const goldBoard = createEmptyBoard();
const openCells = [];
for (const c of VALID_CELLS) {
  if (c === 60) continue;                       // reserve the centre for gold
  if (goldBoard[c] === Tile.Empty) openCells.push(c);
}
goldBoard[60] = Tile.Gold;
// Spread tin and salt far apart so everything is comfortably loose.
const far = openCells.filter((_, i) => i % 11 === 0).slice(0, 3);
goldBoard[far[0]] = Tile.Tin;
goldBoard[far[1]] = Tile.Salt;
goldBoard[far[2]] = Tile.Salt;
const goldLoose = playableCells(goldBoard).includes(60);
const goldLowest = lowestMetalRemaining(goldBoard);
const goldLit = legendPlayableKinds(goldBoard);
check('the scenario really has gold loose', goldLoose);
check('and tin is the lowest metal', goldLowest === Tile.Tin, NAME[goldLowest]);
check('gold is NOT lit while a lower metal remains', !goldLit.has(Tile.Gold));

// Once every other marble is gone, gold becomes takeable.
const onlyGold = cloneBoard(goldBoard);
for (const c of VALID_CELLS) {
  if (c !== 60) onlyGold[c] = Tile.Empty;
}
check('with only gold left it is the lowest metal',
  lowestMetalRemaining(onlyGold) === Tile.Gold, NAME[lowestMetalRemaining(onlyGold)]);
check('and then gold IS lit', legendPlayableKinds(onlyGold).has(Tile.Gold));

// The third regression, reported after the first two were fixed: gold must not
// be takeable while ANY other marble remains, not merely while a lower metal
// does. Salt and vitae are not metals, so a "lowest metal" gate lets gold
// through; only a "is it the last marble" gate is correct.
console.log('\ngold waits for every other marble, not just the other metals');
const goldPlusSalt = createEmptyBoard();
goldPlusSalt[60] = Tile.Gold;
goldPlusSalt[far[0]] = Tile.Salt;
goldPlusSalt[far[1]] = Tile.Salt;
check('gold behaves as the lowest metal here',
  lowestMetalRemaining(goldPlusSalt) === Tile.Gold);
check('but it is NOT lit while those salts remain',
  !legendPlayableKinds(goldPlusSalt).has(Tile.Gold));
check('gold clears alone only as the last marble',
  engine.canPair(Tile.Gold, Tile.Gold, 'quicksilver', Tile.Gold, true) &&
  !engine.canPair(Tile.Gold, Tile.Gold, 'quicksilver', Tile.Empty, true));

console.log(failures === 0 ? '\nmetal highlight checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
