/**
 * Drives the Hint and Show-solution buttons in a real browser and checks that
 * they do something observable.
 *
 * Both were reported as having no effect. A hint is only useful if it marks the
 * pair on the board, and the solution player is only useful if the board
 * actually changes.
 *
 * Usage:  node tools/test_hint_solution.mjs
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
  for (let port = 9333; port <= 9380; port++) {
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

/** Clicks a toolbar button by its label. */
const clickButton = (label) => `(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
  if (!btn) return 'no-button';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'clicked';
})()`;

/** Visible highlight state the renderer is drawing from. */
const HIGHLIGHT = `(() => {
  const sg = window.sg, s = sg.session;
  return JSON.stringify({
    debug: sg.debugState(),
    sessionHinted: [...s.hinted],
    selected: s.selected,
    moves: s.moveCount,
    left: s.marbleCount,
    solutionMoves: sg.debugState().solutionQueued,
    showSolution: sg.debugState().showSolution,
  });
})()`;

async function main() {
  if (!EDGE) throw new Error('Edge not found');
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9361', `--user-data-dir=${path.join(tmpdir(), `sg-hs-${Date.now()}`)}`,
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
    await cdp.send('Page.navigate', { url: `${BASE}/?motion=off&seed=3&difficulty=hard` });
    await sleep(3000);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('window.sgReady === true')) break;
      await sleep(300);
    }


    console.log('Hint');
    const beforeHint = JSON.parse(await cdp.eval(HIGHLIGHT));
    const hintClick = await cdp.eval(clickButton('Hint'));
    await sleep(400);
    const afterHint = JSON.parse(await cdp.eval(HIGHLIGHT));
    console.log(`      click: ${hintClick}`);
    console.log(`      session.hinted: ${JSON.stringify(afterHint.sessionHinted)}`);
    check('the Hint button exists and is clickable', hintClick === 'clicked', hintClick);
    check('the hint marks a pair on the board',
      afterHint.sessionHinted.length === 2, JSON.stringify(afterHint.sessionHinted));
    check('the hint does not move any marble',
      afterHint.moves === beforeHint.moves, `${beforeHint.moves} -> ${afterHint.moves}`);

    console.log('');
    console.log('Show solution');
    const beforeSolve = JSON.parse(await cdp.eval(HIGHLIGHT));
    const solveLabel = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /solution/i.test(b.textContent));
      return btn ? btn.textContent.trim() : 'no-button';
    })()`);
    const solveClick = await cdp.eval(clickButton(solveLabel));
    console.log(`      button "${solveLabel}", click: ${solveClick}`);
    // Give the auto-player several steps.
    await sleep(3000);
    const afterSolve = JSON.parse(await cdp.eval(HIGHLIGHT));
    console.log('      debug: ' + JSON.stringify(afterSolve.debug) + ' selected=' + afterSolve.selected);
    check('the Show-solution button exists and is clickable',
      solveClick === 'clicked', solveClick);
    check('the solution player actually plays moves',
      afterSolve.moves > beforeSolve.moves,
      `${beforeSolve.moves} -> ${afterSolve.moves} moves`);

    // Let it run to completion if it is going to.
    await sleep(6000);
    const later = JSON.parse(await cdp.eval(HIGHLIGHT));
    console.log(`      after 9s: ${later.moves} moves, ${later.left} marbles left`);
    check('the solution makes progress', later.moves > beforeSolve.moves,
      `${beforeSolve.moves} -> ${later.moves}`);
  } finally {
    try { proc.kill(); } catch { /* gone */ }
  }

  console.log('');
  console.log(failures === 0 ? 'hint and solution checks passed' : `${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
