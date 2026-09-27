/**
 * Headless test-suite entry point. Bundled and executed by tools/selftest.mjs.
 */

import {
  BOARD_SIZE,
  NEIGHBOURS,
  NEIGHBOUR_COUNT,
  PITCH_X,
  PITCH_Y,
  VALID_CELLS,
  cellCentrePx,
  isValidCell,
} from './grid.js';
import {
  COLVAN_COUNTS,
  STANDARD_COUNTS,
  TOTAL_MARBLES,
  Tile,
  VARIANTS,
  boardFromLayout,
  canPair,
  countMarbles,
  createEmptyBoard,
  legalMoves,
  lowestMetalRemaining,
  playableCells,
  tallyTiles,
  variantTotal,
  isStuckFromCounts,
} from './index.js';
import { CENTRE_CELL, generateBoard, solveBoard, verifySolution } from './solver.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `got ${String(actual)}, want ${String(expected)}`);
}

export function runSelfTest(): number {
  passed = 0;
  failed = 0;
  console.log("Sigmar's Garden — engine self-test\n");

  /* ---------------- geometry ---------------- */
  console.log('geometry');
  eq('playable cell count', VALID_CELLS.length, 91);
  eq('board is 11x11', BOARD_SIZE * BOARD_SIZE, 121);
  eq('clipped cells', 121 - VALID_CELLS.length, 30);

  // The clipped corners must be off-board and the centre must be on-board.
  check('centre cell valid', isValidCell(5, 5));
  for (const [x, y] of [[0, 0], [10, 0], [0, 10], [10, 10], [1, 1]]) {
    check(`corner (${x},${y}) clipped`, !isValidCell(x, y));
  }

  // Row widths, exactly as the game lays them out. Because the even rows
  // carry the half-tile stagger, the six-tile rows sit half a tile off the
  // column axis, so this is not a simple [lead, 10-lead] span.
  const widths = Array.from({ length: BOARD_SIZE }, (_, y) =>
    VALID_CELLS.filter((c) => Math.floor(c / BOARD_SIZE) === y).length,
  );
  check(
    'row widths are 6,7,8,9,10,11,10,9,8,7,6',
    widths.join(',') === '6,7,8,9,10,11,10,9,8,7,6',
    widths.join(','),
  );
  check('total is 91 cells', VALID_CELLS.length === 91, String(VALID_CELLS.length));

  // Neighbour relations must be mutual. The ring keeps off-board slots, so only
  // the on-board ones take part.
  let mutual = true;
  let maxDeg = 0;
  let ringSizes = new Set<number>();
  for (const c of VALID_CELLS) {
    ringSizes.add(NEIGHBOURS[c].length);
    maxDeg = Math.max(maxDeg, NEIGHBOURS[c].filter((n) => n >= 0).length);
    for (const nb of NEIGHBOURS[c]) {
      if (nb < 0) continue;
      if (!NEIGHBOURS[nb].includes(c)) mutual = false;
    }
  }
  check('neighbour relation is mutual', mutual);
  check('no cell has more than 6 neighbours', maxDeg <= 6);
  // Every ring is six slots, with the off-board ones marked rather than dropped.
  check('every ring is six slots', ringSizes.size === 1 && ringSizes.has(6),
    [...ringSizes].join(','));
  const offBoardCells = VALID_CELLS.filter((c) => NEIGHBOURS[c].some((n) => n < 0));
  check('30 cells have at least one off-board side', offBoardCells.length === 30,
    String(offBoardCells.length));

  // Pitch must match the game's own board texture.
  eq('x pitch', PITCH_X, 66);
  eq('y pitch', PITCH_Y, 57);
  const c00 = cellCentrePx(0, 0);
  const c10 = cellCentrePx(1, 0);
  const c01 = cellCentrePx(0, 1);
  const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
  check('even-row x step', near(c10.x - c00.x, 66), `got ${c10.x - c00.x}`);
  check('odd-row half shift', near(c01.x - c00.x, -33), `got ${c01.x - c00.x}`);

  // The decisive property of the tiling: every neighbour of every tile sits
  // exactly one tile width away. This is what catches a wrong half-pitch
  // parity or a neighbour table that does not match the coordinate
  // function — both of which show up as 33, 43, 91 or 114 px.
  let worstNeighbour = 0;
  let worstAt = '';
  for (const cell of VALID_CELLS) {
    const a = cellCentrePx(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE));
    for (const nb of NEIGHBOURS[cell]) {
      if (nb < 0) continue;
      const b = cellCentrePx(nb % BOARD_SIZE, Math.floor(nb / BOARD_SIZE));
      const dev = Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 66);
      if (dev > worstNeighbour) {
        worstNeighbour = dev;
        worstAt = `(${cell % BOARD_SIZE},${Math.floor(cell / BOARD_SIZE)}) -> ` +
          `(${nb % BOARD_SIZE},${Math.floor(nb / BOARD_SIZE)}) = ` +
          `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)}px`;
      }
    }
  }
  check(
    'every neighbour pair is one tile apart',
    worstNeighbour < 0.5,
    `worst deviation ${worstNeighbour.toFixed(3)} px at ${worstAt}`,
  );

  /* ---------------- counts ---------------- */
  console.log('setup');
  eq('standard marble total', TOTAL_MARBLES, 55);
  eq('standard marbles fit the board', TOTAL_MARBLES <= VALID_CELLS.length, true);
  eq('variant totals agree', variantTotal('quicksilver'), 55);
  eq('empty cells at the start', VALID_CELLS.length - TOTAL_MARBLES, 36);
  eq('27 pairs plus a solo gold', (TOTAL_MARBLES - 1) / 2, 27);
  check('variant names present', !!VARIANTS.quicksilver && !!VARIANTS.colvan);

  const sum = (c: Record<number, number>) => Object.values(c).reduce((a, b) => a + b, 0);
  eq('standard counts sum', sum(STANDARD_COUNTS), 55);
  // House Colvan drops quicksilver and vitae/mors but still totals 55 including
  // gold, so it is 1 + 3*18 and can be 3-fold symmetric like the standard game.
  // These numbers come from the game's own Content/solitaire3.dat.
  eq('colvan counts sum', sum(COLVAN_COUNTS), 55);
  eq('colvan has no quicksilver', COLVAN_COUNTS[Tile.Quicksilver], 0);
  eq('colvan has no vitae or mors',
    COLVAN_COUNTS[Tile.Vitae] + COLVAN_COUNTS[Tile.Mors], 0);
  eq('colvan keeps four salt', COLVAN_COUNTS[Tile.Salt], 4);
  eq('colvan keeps eight of each cardinal', COLVAN_COUNTS[Tile.Air], 8);
  eq('colvan has two lead', COLVAN_COUNTS[Tile.Lead], 2);
  eq('colvan has four tin, iron, copper and silver',
    COLVAN_COUNTS[Tile.Tin] + COLVAN_COUNTS[Tile.Iron] +
    COLVAN_COUNTS[Tile.Copper] + COLVAN_COUNTS[Tile.Silver], 16);
  eq('colvan can be 1 + 3k', (sum(COLVAN_COUNTS) - 1) % 3, 0);
  eq('five quicksilver', STANDARD_COUNTS[Tile.Quicksilver], 5);
  eq('four salt', STANDARD_COUNTS[Tile.Salt], 4);
  eq('eight of each cardinal', STANDARD_COUNTS[Tile.Air], 8);
  eq('four vitae and four mors', STANDARD_COUNTS[Tile.Vitae] + STANDARD_COUNTS[Tile.Mors], 8);
  eq('four salt', STANDARD_COUNTS[Tile.Salt], 4);

  // Gold may be cleared on its own; nothing else may.
  check('gold can be cleared alone once its tier is reached',
    canPair(Tile.Gold, Tile.Gold, 'quicksilver', Tile.Gold, true));
  // Gold is cleared alone only as the very last marble, which callers signal by
  // passing gold itself as `lowestMetal`. An empty lowest metal means "gold is
  // not what is left", so it must be refused.
  check('gold cannot be cleared alone by an empty lowest metal',
    !canPair(Tile.Gold, Tile.Gold, 'quicksilver', Tile.Empty, true));
  // The gate the legend and the hint must both respect: gold is not reachable
  // while a lower metal is still on the board.
  check('gold cannot be cleared alone while lead remains',
    !canPair(Tile.Gold, Tile.Gold, 'quicksilver', Tile.Lead, true));
  check('gold cannot be cleared alone while tin remains',
    !canPair(Tile.Gold, Tile.Gold, 'quicksilver', Tile.Tin, true));
  check('salt cannot be cleared alone', !canPair(Tile.Salt, Tile.Salt, 'quicksilver', Tile.Empty, true));
  check('air cannot be cleared alone', !canPair(Tile.Air, Tile.Air, 'quicksilver', Tile.Empty, true));

  /* ---------------- pairing rules ---------------- */
  console.log('pairing rules');
  const L = Tile.Lead;
  check('salt + salt', canPair(Tile.Salt, Tile.Salt));
  check('salt + fire', canPair(Tile.Salt, Tile.Fire));
  check('air + air', canPair(Tile.Air, Tile.Air));
  check('air + fire is illegal', !canPair(Tile.Air, Tile.Fire));
  check('vitae + mors', canPair(Tile.Vitae, Tile.Mors));
  check('vitae + vitae is illegal', !canPair(Tile.Vitae, Tile.Vitae));
  check('lead + quicksilver', canPair(Tile.Lead, Tile.Quicksilver, 'quicksilver', L));
  check(
    'gold + quicksilver is illegal while lead remains',
    !canPair(Tile.Gold, Tile.Quicksilver, 'quicksilver', L),
  );
  check(
    'gold + quicksilver legal once gold is lowest',
    canPair(Tile.Gold, Tile.Quicksilver, 'quicksilver', Tile.Gold),
  );
  check('metal + metal illegal in standard', !canPair(Tile.Lead, Tile.Tin, 'quicksilver', L));
  check('metal + metal legal in colvan', canPair(Tile.Lead, Tile.Lead, 'colvan'));
  check('quicksilver inert in colvan', !canPair(Tile.Lead, Tile.Quicksilver, 'colvan'));

  /* ---------------- placement rule ---------------- */
  console.log('placement rule');
  // An empty board has no marbles at all, so nothing is playable.
  const empty = createEmptyBoard();
  eq('no marbles are playable on an empty board', playableCells(empty).length, 0);
  console.log(`  board rows: ${Array.from({ length: BOARD_SIZE }, (_, y) =>
    VALID_CELLS.filter((c) => Math.floor(c / BOARD_SIZE) === y).length).join(',')}`);

  // Fill the six neighbours of the centre cell: it must become locked.
  const C = 5 * BOARD_SIZE + 5;
  const ring = NEIGHBOURS[C];
  const packed = createEmptyBoard();
  for (const nb of ring) packed[nb] = Tile.Salt;
  check('centre locked when fully surrounded', !playableCells(packed).includes(C));
  console.log(`  ring has ${ring.length} neighbours; ${playableCells(packed).length} cells playable when it is packed`);

  // Free exactly three contiguous neighbours (indices 0,1,2 of the ring),
  // with a marble sitting in the centre that should come loose.
  const three = createEmptyBoard();
  for (const nb of ring) three[nb] = Tile.Salt;
  three[ring[0]] = Tile.Empty;
  three[ring[1]] = Tile.Empty;
  three[ring[2]] = Tile.Empty;
  three[C] = Tile.Air;
  check(
    'three contiguous gaps unlock the centre',
    playableCells(three).includes(C),
    `centre ${C} not free`,
  );

  // Three free neighbours that are NOT contiguous must not unlock it.
  const split = createEmptyBoard();
  for (const nb of ring) split[nb] = Tile.Salt;
  split[ring[0]] = Tile.Empty;
  split[ring[2]] = Tile.Empty;
  split[ring[4]] = Tile.Empty;
  split[C] = Tile.Air;
  check('three split gaps do not unlock the centre', !playableCells(split).includes(C));

  /* ---------------- lowest metal ---------------- */
  console.log('metal sequence');
  // Use real board cells: row 5 spans columns 0..10.
  const A = 5 * BOARD_SIZE + 2;
  const B = 5 * BOARD_SIZE + 5;
  const D = 5 * BOARD_SIZE + 8;
  const metals = createEmptyBoard();
  metals[A] = Tile.Iron;
  metals[B] = Tile.Lead;
  metals[D] = Tile.Gold;
  eq('lowest metal is lead', lowestMetalRemaining(metals), Tile.Lead);
  metals[B] = Tile.Empty;
  eq('lowest metal is iron after lead leaves', lowestMetalRemaining(metals), Tile.Iron);
  metals[A] = Tile.Empty;
  eq('lowest metal is gold once the rest are gone', lowestMetalRemaining(metals), Tile.Gold);

  /* ---------------- solvability of generated boards ---------------- */
  console.log('generator + solver');
  const seeds = [1, 2, 3, 7, 42, 99, 1234, 20240];
  let totalAttempts = 0;
  let totalNodes = 0;
  let maxNodes = 0;
  for (const seed of seeds) {
    const t0 = Date.now();
    const gen = generateBoard(seed, 'quicksilver');
    const ms = Date.now() - t0;
    totalAttempts += gen.attempts;
    totalNodes += gen.nodes;
    maxNodes = Math.max(maxNodes, gen.nodes);
    eq(`seed ${seed}: every marble placed`, countMarbles(gen.board), TOTAL_MARBLES);
    check(
      `seed ${seed}: solution replays legally`,
      verifySolution(gen.board, gen.solution, 'quicksilver'),
      `${gen.solution.length} moves`,
    );
    eq(`seed ${seed}: 27 pairs plus gold`, gen.solution.length, 28);
    check(
      `seed ${seed}: gold is at the centre`,
      gen.board[CENTRE_CELL] === Tile.Gold,
    );
    console.log(
      `  seed ${String(seed).padStart(5)}  attempts=${gen.attempts}  nodes=${gen.nodes}  ${ms}ms`,
    );
  }
  console.log(
    `  average attempts ${(totalAttempts / seeds.length).toFixed(2)}, ` +
      `average nodes ${Math.round(totalNodes / seeds.length)}, max nodes ${maxNodes}`,
  );

  // A fresh, untouched board must offer legal openings.
  const gen0 = generateBoard(2024, 'quicksilver');
  const opening = legalMoves(gen0.board, 'quicksilver');
  check('starting board has legal moves', opening.length > 0, `${opening.length} moves`);
  console.log(`  opening moves available: ${opening.length}`);

  // The House Colvan variant must also be generatable, with its own marble set.
  const colvan = generateBoard(5, 'colvan');
  eq('colvan board holds every marble', countMarbles(colvan.board), variantTotal('colvan'));
  check(
    'colvan solution replays legally',
    verifySolution(colvan.board, colvan.solution, 'colvan'),
  );

  // An unsolvable arrangement must be reported as such.
  const impossible = createEmptyBoard();
  impossible[0 * BOARD_SIZE + 5] = Tile.Air;
  impossible[1 * BOARD_SIZE + 5] = Tile.Fire;
  // Force them adjacent-ish and surrounded so nothing can move.
  const locked = createEmptyBoard();
  for (const c of VALID_CELLS) locked[c] = Tile.Salt;
  const res = solveBoard(locked, 'quicksilver', { nodeLimit: 50_000 });
  check('odd marble count is unsolvable', !res.solved);

  // A hand-built trivial win: two adjacent salt on the rim.
  const trivial = createEmptyBoard();
  const rim = 0 * BOARD_SIZE + 4; // valid top-row cell
  const rim2 = 0 * BOARD_SIZE + 5;
  trivial[rim] = Tile.Salt;
  trivial[rim2] = Tile.Salt;
  const tres = solveBoard(trivial, 'quicksilver');
  check('two rim marbles solve in one move', tres.solved && tres.moves.length === 1);

  /* ---------------- dead-end detection ---------------- */
  console.log('dead-end detection');
  const P1 = 5 * BOARD_SIZE + 3;
  const P2 = 5 * BOARD_SIZE + 6;
  const dead = createEmptyBoard();
  dead[P1] = Tile.Air;
  dead[P2] = Tile.Lead;
  check('lone air is a dead end', isStuckFromCounts(dead));
  const fine = createEmptyBoard();
  fine[P1] = Tile.Air;
  fine[P2] = Tile.Air;
  check('paired air is not a dead end', !isStuckFromCounts(fine));
  const salty = createEmptyBoard();
  salty[P1] = Tile.Air;
  salty[P2] = Tile.Salt;
  check('air plus salt is not a dead end', !isStuckFromCounts(salty));
  const vit = createEmptyBoard();
  vit[P1] = Tile.Vitae;
  vit[P2] = Tile.Vitae;
  check('two vitae is a dead end', isStuckFromCounts(vit));
  const vpair = createEmptyBoard();
  vpair[P1] = Tile.Vitae;
  vpair[P2] = Tile.Mors;
  check('vitae plus mors is not a dead end', !isStuckFromCounts(vpair));

  /* ---------------- tally sanity ---------------- */
  const layout = boardFromLayout(
    Array.from({ length: BOARD_SIZE }, () => Array.from({ length: BOARD_SIZE }, () => Tile.Empty)),
  );
  eq('blank layout has no marbles', countMarbles(layout), 0);
  eq('blank tally is empty', Object.keys(tallyTiles(layout)).length, 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

// Allow `node tools/selftest.mjs` style execution through the bundler shim.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('selftest.entry.ts')) {
  // no-op; the wrapper calls runSelfTest()
}
