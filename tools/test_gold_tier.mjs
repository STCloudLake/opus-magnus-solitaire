/**
 * End-to-end check that the legend's metal highlight follows the transmutation
 * order in a real browser, over many deals and deep into play.
 *
 * The legend lights a kind only when a loose marble of that kind can actually be
 * picked up. For metals that means the lowest one remaining, and gold is gated
 * the same way because it is the last link of the chain (lead to gold).
 *
 * Usage:  node tools/test_gold_tier.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.SG_BASE ?? 'http://127.0.0.1:8123';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
    return r.result.value;
  }
}

async function findTarget() {
  for (let port = 9333; port <= 9378; port++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not listening */ }
  }
  throw new Error('no CDP target');
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return new Cdp(ws);
}

let failures = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${ok || !d ? '' : ' - ' + d}`);
  if (!ok) failures++;
};

/**
 * In the page: every lit metal must be the lowest remaining metal (or gold when
 * no lower metal is left), and every lit kind must be pickable somewhere.
 */
const PROBE = `(() => {
  const sg = window.sg, s = sg.session, E = sg.engine;
  const board = s.board;
  const lowest = s.variant === 'colvan' ? 0 : E.lowestMetalRemaining(board);
  const lit = sg.legendState().lit;
  const litMetals = lit.filter(t => t >= E.Tile.Lead && t <= E.Tile.Gold);
  const badTier = litMetals.filter(t => lowest !== 0 && t !== lowest);
  // every lit kind must have a selectable marble on the board
  const loose = s.playable();
  const unpickable = lit.filter(id =>
    !loose.some(c => board[c] === id && s.isSelectable(c)));
  return JSON.stringify({
    lowest, litMetals, badTier, unpickable,
    variant: s.variant, moves: s.moveCount,
  });
})()`;

/**
 * Builds the endgame in the page and probes gold at three points:
 *   1. silver + salt + gold        -> gold dark (a lower metal remains)
 *   2. gold + salt                 -> gold dark (other marbles remain)
 *   3. gold alone                  -> gold lit, and one click clears it
 * Greedy play rarely survives a tight board this far, so the endgame is reached
 * directly.
 */
const ENDGAME = `(() => {
  const sg = window.sg, E = sg.engine;
  const s = sg.session;
  const b = E.createEmptyBoard();
  const spots = E.VALID_CELLS.filter(c => c !== 60).filter((_, i) => i % 11 === 0).slice(0, 4);
  b[60] = E.Tile.Gold;
  b[spots[0]] = E.Tile.Silver;
  b[spots[1]] = E.Tile.Quicksilver;
  b[spots[2]] = E.Tile.Salt;
  b[spots[3]] = E.Tile.Salt;

  const goldBefore = E.playableKinds(b, s.variant).has(E.Tile.Gold);
  const beforeLowest = E.reachableMetal(b);

  // Silver removed, but the two salts are still there.
  const withSalt = E.applyMove(b, { a: spots[0], b: spots[1] });
  const litWithSalt = E.playableKinds(withSalt, s.variant);

  // Everything but gold removed.
  let alone = withSalt.slice();
  for (const c of E.VALID_CELLS) if (alone[c] !== E.Tile.Empty && c !== 60) alone[c] = E.Tile.Empty;
  const litAlone = E.playableKinds(alone, s.variant);
  const remainingAlone = E.marblesOnBoard(alone);

  // A session on the gold-only board: selection and a single click must clear it.
  const session = new sg.session.constructor();
  session.board = alone.slice();
  const selectableAlone = session.isSelectable(60);

  return JSON.stringify({
    beforeLowest, goldBefore,
    saltRemaining: E.marblesOnBoard(withSalt),
    goldWithSalt: litWithSalt.has(E.Tile.Gold),
    saltWithSalt: litWithSalt.has(E.Tile.Salt),
    remainingAlone,
    goldAlone: litAlone.has(E.Tile.Gold),
    selectableAlone,
  });
})()`;

/** One click on gold when it is the only marble left must clear the board. */
const GOLD_CLICK = `(() => {
  const sg = window.sg, E = sg.engine;
  const alone = E.createEmptyBoard();
  alone[60] = E.Tile.Gold;
  const session = new sg.session.constructor();
  session.board = alone.slice();
  const applied = session.click(60);
  return JSON.stringify({
    applied: !!applied,
    left: sg.engine.countMarbles(session.board),
  });
})()`;

async function main() {
  if (!EDGE) throw new Error('Edge not found');
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9358', `--user-data-dir=${path.join(tmpdir(), `sg-gold-${Date.now()}`)}`,
    '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let ws = null;
    for (let i = 0; i < 60 && !ws; i++) {
      await sleep(400);
      try { ws = await findTarget(); } catch { /* not up */ }
    }
    if (!ws) throw new Error('browser did not start');
    const cdp = await connect(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('lit metals must be the lowest remaining metal');
    let tierViolations = 0, unpickableViolations = 0, samples = 0, goldLitCount = 0;
    const reachedTiers = new Set();
    for (const seed of [1, 2, 3, 4, 5, 7, 11, 16, 23, 31]) {
      await cdp.send('Page.navigate', { url: `${BASE}/?motion=off&seed=${seed}&difficulty=hard` });
      await sleep(2000);
      // play a long way into each deal so the chain advances through every tier
      for (let step = 0; step < 46; step++) {
        const r = JSON.parse(await cdp.eval(PROBE));
        samples++;
        if (r.badTier.length) {
          tierViolations++;
          if (tierViolations <= 3) console.log(`      seed ${seed} step ${step}: lit ${JSON.stringify(r.badTier)} while lowest ${r.lowest}`);
        }
        if (r.unpickable.length) {
          unpickableViolations++;
          if (unpickableViolations <= 3) console.log(`      seed ${seed} step ${step}: lit but unpickable ${JSON.stringify(r.unpickable)}`);
        }
        if (r.lowest !== 0) reachedTiers.add(r.lowest);
        if (r.litMetals.includes(12)) goldLitCount++;
        // take one move
        const moved = await cdp.eval(`(() => {
          const s = window.sg.session;
          for (const c of s.playable()) {
            if (!s.isSelectable(c)) continue;
            s.click(c);
            for (const d of s.playable()) {
              if (d === c) continue;
              if (s.click(d)) return true;
            }
            s.deselect();
          }
          return false;
        })()`);
        if (!moved) break;
      }
    }
    check('no metal is ever lit above its tier', tierViolations === 0,
      `${tierViolations} of ${samples} observations`);
    check('nothing lit is ever unpickable', unpickableViolations === 0,
      `${unpickableViolations} of ${samples} observations`);
    // Greedy play rarely survives a tight board all the way to the gold tier, so
    // gold being reached is reported rather than required; that it lights exactly
    // when its tier arrives is pinned deterministically by test:metals and by the
    // engine selftest.
    console.log(`      (gold was lit in ${goldLitCount} of ${samples} observations)`);
    check('the chain advanced past the first tier',
      reachedTiers.size >= 2, `tiers seen: ${[...reachedTiers].sort((a,b)=>a-b)}`);

    // Greedy play does not survive a tight board to the end, so the gold tier is
    // reached deterministically instead: build the endgame in the page and ask
    // the app for the legend state.
    console.log('');
    console.log('the gold tier, reached directly');
    const endgame = JSON.parse(await cdp.eval(ENDGAME));
    check('gold is dark while silver remains',
      endgame.beforeLowest !== 12 && endgame.goldBefore === false,
      JSON.stringify(endgame));
    check('gold stays dark while other marbles remain',
      endgame.saltRemaining > 1 && endgame.goldWithSalt === false,
      JSON.stringify(endgame));
    check('the remaining salt is still lit',
      endgame.saltWithSalt === true, JSON.stringify(endgame));
    check('gold is the only marble left', endgame.remainingAlone === 1,
      String(endgame.remainingAlone));
    check('then gold lights', endgame.goldAlone === true, JSON.stringify(endgame));
    check('and gold is selectable', endgame.selectableAlone === true,
      JSON.stringify(endgame));

    // The rule the user described: one click on the lone gold clears the board.
    const click = JSON.parse(await cdp.eval(GOLD_CLICK));
    check('one click on the lone gold clears it',
      click.applied === true && click.left === 0, JSON.stringify(click));
  } finally {
    try { proc.kill(); } catch { /* gone */ }
  }

  console.log('');
  console.log(failures === 0 ? 'gold tier checks passed' : `${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
