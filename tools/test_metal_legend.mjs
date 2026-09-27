/**
 * Checks the legend's highlighted kinds against an independent computation.
 *
 * The legend lights a kind only when a loose marble of that kind has a legal
 * partner that is also loose. For metals that is not the same as being loose:
 * tin cannot be taken while lead remains, however loose it is.
 *
 * Ground truth is recomputed inside the page from the placement rule directly,
 * rather than by calling the method the legend itself uses, so a mistake in that
 * method cannot hide.
 *
 * Usage:  node tools/test_metal_legend.mjs
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
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
    return r.result.value;
  }
}

async function findTarget() {
  for (let port = 9333; port <= 9372; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* port not listening */ }
  }
  throw new Error('no CDP target found');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return new Cdp(ws);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`);
  if (!ok) failures++;
};

/** Recomputes the lit kinds from the placement rule, inside the page. */
const GROUND_TRUTH = `(() => {
  const sg = window.sg, s = sg.session;
  // Ask the module for the rule primitives through the exposed object.
  const api = sg.engine;
  const board = s.board.slice();
  const variant = s.variant;
  const valid = api.VALID_CELLS;
  // empty-neighbour count in the virtual board below
  const occ = board.map(t => t !== 0);
  const N = api.NEIGHBOURS;
  const looseCells = [];
  for (const c of valid) {
    if (!occ[c]) continue;
    const ring = N[c];
    let t = 0, hit = false;
    for (let i = 0; i < ring.length; i++) {
      const nb = ring[i];
      const empty = nb < 0 || !occ[nb];
      if (empty) { if (++t >= 3) { hit = true; break; } } else t = 0;
    }
    if (!hit) {
      let lead = 0;
      for (let i = 0; i < ring.length; i++) { const nb = ring[i]; if (nb < 0 || !occ[nb]) lead++; else break; }
      let tail = 0;
      for (let i = ring.length - 1; i >= 0; i--) { const nb = ring[i]; if (nb < 0 || !occ[nb]) tail++; else break; }
      hit = lead + tail >= 3;
    }
    if (hit) looseCells.push(c);
  }
  const lowest = variant === 'colvan' ? 0 : api.lowestMetalRemaining(board);
  const kinds = [];
  for (let i = 0; i < looseCells.length; i++) {
    const ta = board[looseCells[i]];
    if (ta === api.Tile.Gold) { kinds.push(ta); continue; }
    for (let j = 0; j < looseCells.length; j++) {
      if (i === j) continue;
      if (api.canPair(ta, board[looseCells[j]], variant, lowest)) { kinds.push(ta); break; }
    }
  }
  const legendLit = sg.legendState().lit;
  // Independent cross-check that does not restate the pairing rule: for every
  // kind the legend lights, there must be a loose marble of that kind the SESSION
  // itself considers selectable. If the legend lights a metal the board refuses
  // to let you pick up, that is the bug, whatever the rule "should" be.
  const notSelectable = [];
  for (const id of legendLit) {
    const cand = looseCells.filter(c => board[c] === id && s.isSelectable(c));
    if (cand.length === 0) notSelectable.push(id);
  }
  return JSON.stringify({
    variant, lowest,
    ground: [...new Set(kinds)].sort((a,b)=>a-b),
    legend: legendLit.sort((a,b)=>a-b),
    notSelectable,
    looseCount: looseCells.length,
    marbleCount: s.marbleCount,
  });
})()`;

async function main() {
  if (!EDGE) throw new Error('Edge not found');
  const userDir = path.join(tmpdir(), `sg-metal-${Date.now()}`);
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9355', `--user-data-dir=${userDir}`,
    '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore', detached: false });

  try {
    let ws = null;
    for (let i = 0; i < 60 && !ws; i++) {
      await sleep(400);
      try { ws = await findTarget(); } catch { /* not up yet */ }
    }
    if (!ws) throw new Error('browser did not come up');
    const cdp = await connect(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const haveRules = await (async () => {
      await cdp.send('Page.navigate', { url: `${BASE}/?motion=off&seed=3` });
      await sleep(3000);
      for (let i = 0; i < 40; i++) {
        if (await cdp.eval('window.sgReady === true')) break;
        await sleep(300);
      }
      return cdp.eval('!!(window.sg && window.sg.engine && window.sg.engine.canPair)');
    })();

    if (!haveRules) {
      console.log('  skip  sg.engine is not exposed on window; cannot verify independently');
      console.log('\nmetal legend checks skipped');
      return;
    }

    console.log('legend highlight vs an independent recomputation');
    for (const seed of [1, 2, 3, 5, 8, 13, 21]) {
      await cdp.send('Page.navigate', { url: `${BASE}/?motion=off&seed=${seed}` });
      await sleep(2200);
      const raw = await cdp.eval(GROUND_TRUTH);
      const r = JSON.parse(raw);
      const same = JSON.stringify(r.ground) === JSON.stringify(r.legend);
      check(`seed ${seed}: legend matches the rule`, same,
        same ? '' : `ground ${r.ground} vs legend ${r.legend}`);
      // The decisive check, and the one that does not restate the rule: nothing
      // the legend lights may be un-pickable on the board itself.
      check(`seed ${seed}: every lit kind is actually selectable`,
        r.notSelectable.length === 0,
        `lit but not selectable: ${JSON.stringify(r.notSelectable)}`);
    }

    // Play a few moves and re-check: the transmutation order changes as metals go.
    console.log('\nafter playing moves');
    await cdp.send('Page.navigate', { url: `${BASE}/?motion=off&seed=1` });
    await sleep(2200);
    for (let step = 0; step < 16; step++) {
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
      await sleep(80);
    }
    const raw = await cdp.eval(GROUND_TRUTH);
    const r = JSON.parse(raw);
    check('legend still matches after the board changed',
      JSON.stringify(r.ground) === JSON.stringify(r.legend),
      `ground ${r.ground} vs legend ${r.legend}`);
    check('every lit kind is still selectable after the board changed',
      r.notSelectable.length === 0,
      `lit but not selectable: ${JSON.stringify(r.notSelectable)}`);
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
  }

  console.log('');
  console.log(failures === 0 ? 'metal legend checks passed' : `${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
