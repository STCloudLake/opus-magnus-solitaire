/**
 * End-to-end test: drives a real headless browser through the DevTools
 * protocol and plays complete games to verify the app actually works.
 *
 * Usage:  node tools/e2e.mjs [--keep]
 *
 * Requires a running server (tools/serve.mjs) and Microsoft Edge or
 * Google Chrome installed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.SG_PORT ?? 8123);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = 9333;

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const executable = BROWSERS.find((p) => existsSync(p));
if (!executable) {
  console.error('No Edge or Chrome found; skipping e2e test.');
  process.exit(0);
}

const profile = mkdtempSync(path.join(tmpdir(), 'sg-e2e-'));

const browser = spawn(
  executable,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=1400,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the DevTools endpoint');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression and returns its JSON value. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return r.result?.value;
  }
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

async function goto(cdp, url, settleMs = 2500) {
  await cdp.send('Page.navigate', { url });
  await sleep(settleMs);
}

/**
 * Waits until the app reports itself ready. Marble sprites are composited
 * from the game's textures on startup, which takes a moment.
 */
async function waitReady(cdp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval('window.sgReady === true')) return true;
    } catch { /* page may still be navigating */ }
    await sleep(200);
  }
  return false;
}

async function main() {
  const wsUrl = await findTarget();
  const cdp = await connect(wsUrl);

  console.log('boot');
  await goto(cdp, `${BASE}/?motion=off&seed=1`, 1500);
  check('app reports ready', await waitReady(cdp));
  const booted = await cdp.eval('!!window.sg');
  check('app object exposed', booted === true);
  check('canvas present', await cdp.eval('!!document.querySelector("canvas.sg-canvas")'));
  check(
    'legend shows 14 kinds',
    (await cdp.eval('document.querySelectorAll(".sg-legend-row").length')) === 14,
  );

  /* ---- layout regressions ----
   * Two bugs made the board unusable: a full-screen invisible overlay
   * swallowed every click, and a stale canvas backing store stretched the
   * render vertically so marbles drifted out of their tiles. */
  console.log('\nlayout');
  const layout = await cdp.eval(`(() => {
    const cv = document.querySelector('canvas.sg-canvas');
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const atCentre = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const overlay = document.querySelector('.sg-overlay');
    const cs = getComputedStyle(overlay);
    return JSON.stringify({
      backing: [cv.width, cv.height],
      expect: [Math.round(r.width * dpr), Math.round(r.height * dpr)],
      topElement: atCentre ? atCentre.className : null,
      overlayHidden: overlay.hidden,
      overlayDisplay: cs.display,
      overlayPointerEvents: cs.pointerEvents,
    });
  })()`);
  const L = JSON.parse(layout);
  check(
    'canvas backing matches its CSS size (no stretch)',
    L.backing[0] === L.expect[0] && L.backing[1] === L.expect[1],
    layout,
  );
  check('canvas is the topmost element over the board', L.topElement === 'sg-canvas', layout);
  check('hidden overlay does not cover the page', L.overlayDisplay === 'none', layout);

  /* ---- marbles actually land in their tiles ---- */
  const seat = await cdp.eval(`(() => {
    const app = window.sg;
    const cv = document.querySelector('canvas.sg-canvas');
    const r = cv.getBoundingClientRect();
    const { VALID_CELLS, Tile, BOARD_SIZE, cellCentrePx } = app.engine;
    // How far is a drawn marble from the centre of the carved tile it
    // occupies? Both are in board space: the marble is drawn at
    // cellCentrePx, and the tile centre is the same point.
    let worst = 0;
    let n = 0;
    for (const cell of VALID_CELLS) {
      if (app.session.board[cell] === Tile.Empty) continue;
      const c = cellCentrePx(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE));
      const p = app.renderer.cellToCss(cell);
      // Invert the renderer transform to get the marble back into board
      // space; it must round-trip to the cell centre.
      const backX = (p.x - app.renderer.offsetX) / app.renderer.scale;
      const backY = (p.y - app.renderer.offsetY) / app.renderer.scale;
      worst = Math.max(worst, Math.hypot(backX - c.x, backY - c.y));
      n++;
    }
    return JSON.stringify({ worst: +worst.toFixed(3), n });
  })()`);
  check(
    'every marble is drawn on its tile centre',
    JSON.parse(seat).worst < 0.01,
    seat,
  );

  /* ---- real pointer input reaches the canvas ---- */
  console.log('\npointer input');
  await cdp.eval(`(() => {
    window.__hits = { down: 0, move: 0, cells: [] };
    const c = document.querySelector('canvas.sg-canvas');
    c.addEventListener('pointerdown', (e) => {
      window.__hits.down++;
      const r = c.getBoundingClientRect();
      window.__hits.cells.push(window.sg.renderer.cellAtPoint(e.clientX - r.left, e.clientY - r.top));
    }, true);
    c.addEventListener('pointermove', () => { window.__hits.move++; }, true);
  })()`);
  const clickTarget = JSON.parse(await cdp.eval(`(() => {
    const app = window.sg, s = app.session;
    s.selected = null;
    const loose = s.playable();
    const E = app.engine;
    const lowest = s.variant === 'colvan' ? 0 : s.lowestMetal();
    for (const a of loose) for (const b of loose) {
      if (a === b) continue;
      if (E.canPair(s.board[a], s.board[b], s.variant, lowest)) {
        const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
        const ca = app.renderer.cellToCss(a), cb = app.renderer.cellToCss(b);
        return JSON.stringify({ a, b, before: s.marbleCount,
          pa: [Math.round(r.left + ca.x), Math.round(r.top + ca.y)],
          pb: [Math.round(r.left + cb.x), Math.round(r.top + cb.y)] });
      }
    }
    return JSON.stringify({ none: true });
  })()`));
  for (const p of [clickTarget.pa, clickTarget.pb]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1], button: 'none', clickCount: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await sleep(140);
  }
  await sleep(250);
  const hits = JSON.parse(await cdp.eval('JSON.stringify(window.__hits)'));
  check('pointermove reaches the canvas', hits.move > 0, JSON.stringify(hits));
  check('pointerdown reaches the canvas', hits.down > 0, JSON.stringify(hits));
  const clicked = JSON.parse(
    await cdp.eval('JSON.stringify({m:sg.session.marbleCount,mv:sg.session.moveCount})'),
  );
  check(
    'clicking two matching marbles plays a move',
    clicked.m === clickTarget.before - 2 && clicked.mv === 1,
    `target=${JSON.stringify(clickTarget)} result=${JSON.stringify(clicked)} hits=${JSON.stringify(hits)}`,
  );

  // Start a clean deal so the state assertions below see a fresh board.
  await cdp.eval('document.querySelectorAll(".sg-button")[0].click()');
  await sleep(400);
  const marbles = await cdp.eval('window.sg.session.marbleCount');
  check('55 marbles dealt on a new game', marbles === 55, `got ${marbles}`);
  check(
    'gold sits at the centre',
    (await cdp.eval('window.sg.session.board[window.sg.session.board.length ? 60 : 0]')) === 12,
  );
  check(
    'status line reports playable marbles',
    /Playable now/.test(await cdp.eval('document.querySelector(".sg-status").textContent')),
  );

  /* ---- placement rule is enforced ---- */
  console.log('\nplacement rule');
  const locked = await cdp.eval(`(() => {
    const s = window.sg.session;
    const play = new Set(s.playable());
    let lockedCell = -1;
    for (let c = 0; c < s.board.length; c++) {
      if (s.board[c] !== 0 && !play.has(c)) { lockedCell = c; break; }
    }
    if (lockedCell < 0) return 'none';
    const before = s.marbleCount;
    s.selected = null;
    s.click(lockedCell);
    return JSON.stringify({ selected: s.selected, before, after: s.marbleCount });
  })()`);
  if (locked !== 'none') {
    const info = JSON.parse(locked);
    check('a locked marble cannot be selected', info.selected === null, JSON.stringify(info));
    check('a locked marble is not removed', info.before === info.after);
  } else {
    check('a locked marble cannot be selected', true, 'no locked marble on this deal');
  }

  /* ---- illegal pair is rejected ---- */
  console.log('\npairing rules');
  const illegal = await cdp.eval(`(() => {
    const s = window.sg.session;
    s.selected = null;
    const moves = s.playable();
    // Find two playable marbles that must not pair.
    for (const a of moves) for (const b of moves) {
      if (a === b) continue;
      const ta = s.board[a], tb = s.board[b];
      const lowest = s.variant === 'colvan' ? 0 : s.lowestMetal();
      if (!window.sg.engine.canPair(ta, tb, s.variant, lowest)) {
        return JSON.stringify({ a, b, ta, tb });
      }
    }
    return 'none';
  })()`);
  check('found an illegal pair to try', illegal !== 'none');
  if (illegal !== 'none') {
    const { a, b } = JSON.parse(illegal);
    const res = await cdp.eval(`(() => {
      const s = window.sg.session;
      s.selected = null;
      const before = s.marbleCount;
      s.click(${a});
      s.click(${b});
      return JSON.stringify({ before, after: s.marbleCount, selected: s.selected });
    })()`);
    const r = JSON.parse(res);
    check('illegal pair removes nothing', r.before === r.after, res);
  }

  /* ---- play a whole game via the solver ---- */
  console.log('\nfull playthrough');
  // Solve once, then replay exactly that list. Solving again mid-game
  // would return a solution for a different position.
  // Gold is cleared by clicking it twice; everything else by clicking
  // the two marbles in turn.
  const play = await cdp.eval(`(() => {
    const s = window.sg.session;
    const moves = s.solveNow();
    let played = 0;
    let rejected = 0;
    const trace = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const before = s.marbleCount;
      s.selected = null;
      s.click(m.a);
      s.click(m.b);
      if (s.marbleCount < before) played++;
      else {
        rejected++;
        if (trace.length < 4) trace.push({ i, m, ta: s.board[m.a], tb: s.board[m.b], sel: s.selected, left: s.marbleCount });
      }
    }
    return JSON.stringify({ played, rejected, left: s.marbleCount, moves: moves.length, finished: s.isFinished, trace });
  })()`);
  const p = JSON.parse(play);
  check('every solution move was accepted', p.rejected === 0, play);
  check('board is cleared', p.left === 0, `left ${p.left}`);
  check('session marked finished', p.finished === true);
  check(
    'win overlay is shown',
    await cdp.eval('!document.querySelector(".sg-overlay").hidden'),
  );

  /* ---- undo restores the board ---- */
  console.log('\nundo');
  const undo = await cdp.eval(`(() => {
    const s = window.sg.session;
    const before = s.marbleCount;
    const last = s.history[s.history.length - 1];
    const expected = last.a === last.b ? 1 : 2;
    const moves = s.history.length;
    s.undo();
    return JSON.stringify({
      before, after: s.marbleCount, expected,
      solo: last.a === last.b,
      movesBefore: moves, movesAfter: s.history.length,
      finished: s.isFinished,
    });
  })()`);
  const u = JSON.parse(undo);
  check(
    `undo restores ${u.expected} marble(s) (solo=${u.solo})`,
    u.after === u.before + u.expected,
    undo,
  );
  check('undo pops one move', u.movesAfter === u.movesBefore - 1, undo);
  check('undo clears the finished flag', u.finished === false, undo);

  /* ---- hint produces a legal move ---- */
  console.log('\nhint');
  // Run on a fresh deal so there is something to hint about.
  await cdp.eval('sg.newGame ? sg.newGame() : document.querySelectorAll(".sg-button")[0].click()');
  await sleep(300);
  const hint = await cdp.eval(`(() => {
    const s = window.sg.session;
    s.selected = null;
    const m = s.hint();
    if (!m) return JSON.stringify({ ok: false, reason: 'no move' });
    const a = s.hinted.has(m.a) && (m.a === m.b || s.hinted.has(m.b));
    const ta = s.board[m.a], tb = s.board[m.b];
    const lowest = s.variant === 'colvan' ? 0 : s.lowestMetal();
    const legal = window.sg.engine.canPair(ta, tb, s.variant, lowest);
    // The hinted marbles must also be loose.
    const loose =
      window.sg.engine.hasEnoughFreeNeighbours(s.board, m.a) &&
      (m.a === m.b || window.sg.engine.hasEnoughFreeNeighbours(s.board, m.b));
    return JSON.stringify({ ok: true, legal, loose, marked: a, hintedSize: s.hinted.size });
  })()`);
  const h = JSON.parse(hint);
  check('hint returns a move', h.ok === true, hint);
  check('hinted move is a legal pairing', h.legal === true, hint);
  check('hinted marbles are loose', h.loose === true, hint);
  check('hinted cells are marked for the UI', h.marked === true, hint);

  /* ---- new game resets ---- */
  console.log('\nnew game');
  await cdp.eval('document.querySelectorAll(".sg-button")[0].click()');
  await sleep(400);
  const fresh = await cdp.eval(
    'JSON.stringify({m:sg.session.marbleCount,mv:sg.session.moveCount})',
  );
  const f = JSON.parse(fresh);
  check('new game deals a full board', f.m === 55, fresh);
  check('new game resets the move counter', f.mv === 0, fresh);

  /* ---- variant switch ---- */
  console.log('\nHouse Colvan variant');
  const colvanDiag = await cdp.eval(`(() => {
    const sel = document.querySelector('.sg-select');
    sel.value = 'colvan';
    sel.dispatchEvent(new Event('change'));
    return JSON.stringify({ selectValue: sel.value, sessionVariant: sg.session.variant });
  })()`);
  await sleep(700);
  const colvan = await cdp.eval(
    'JSON.stringify({v:sg.session.variant,m:sg.session.marbleCount,moves:sg.session.moveCount,sel:sg.session.selected})',
  );
  const c = JSON.parse(colvan);
  check('variant switched', c.v === 'colvan', `${colvan} (on change: ${colvanDiag})`);
    // House Colvan drops quicksilver and vitae/mors, but still totals 55
    // marbles including gold at the centre, read off Content/solitaire3.dat.
    // That is what makes it 3-fold symmetric like the standard game.
    check('colvan deals a full board', c.m === 55, colvan);
  check('colvan board is not finished', c.moves === 0 && c.sel === null, colvan);
  const colvanSolve = await cdp.eval(`(() => {
    const s = sg.session;
    const moves = s.solveNow();
    let played = 0;
    let rejected = 0;
    const trace = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const before = s.marbleCount;
      s.selected = null;
      s.click(m.a);
      s.click(m.b);
      if (s.marbleCount < before) played++;
      else {
        rejected++;
        if (trace.length < 4) trace.push({ i, m, ta: s.board[m.a], tb: s.board[m.b], left: s.marbleCount });
      }
    }
    return JSON.stringify({ played, rejected, left: s.marbleCount, moves: moves.length, trace });
  })()`);
  check('colvan board is solvable in the UI', JSON.parse(colvanSolve).left === 0, colvanSolve);

  /* ---- help panel ---- */
  console.log('\nhelp panel');
  await goto(cdp, `${BASE}/?motion=off&help=1`, 1200);
  await waitReady(cdp);
  check(
    'help overlay opens',
    await cdp.eval('!document.querySelector(".sg-overlay").hidden'),
  );
  check(
    'help shows the matching-rule diagrams',
    (await cdp.eval('document.querySelectorAll(".sg-overlay-body figure img").length')) >= 4,
  );

  /* ---- console cleanliness ---- */
  console.log('\nconsole');
  const errors = await cdp.eval('JSON.stringify(window.__sgErrors ?? [])');
  check('no uncaught errors recorded', errors === '[]', errors);

  await cdp.send('Browser.close').catch(() => undefined);
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  await main();
} catch (err) {
  console.error('e2e error:', err);
  process.exitCode = 1;
} finally {
  try {
    browser.kill();
  } catch {
    /* already gone */
  }
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
