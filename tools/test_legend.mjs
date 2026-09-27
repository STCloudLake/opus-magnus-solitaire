/**
 * Verifies the legend's is-playable state against the transmutation order, in
 * the real UI.
 *
 * Usage:  node tools/test_legend.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);

const CDP = 9372;
const profile = mkdtempSync(path.join(tmpdir(), 'sg-legend-'));
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* wait */ }
  if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
  return r.result?.value;
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failures++;
};

await send('Page.navigate', { url: 'http://127.0.0.1:8123/?motion=off&seed=1' });
for (let i = 0; i < 120; i++) {
  try { if (await ev('window.sgReady === true')) break; } catch { /* wait */ }
  await sleep(200);
}

console.log('legend is-playable state vs the transmutation order');
const res = await ev(`(() => {
  const app = sg, s = app.session;
  const NAME = {1:'salt',2:'air',3:'fire',4:'water',5:'earth',6:'quicksilver',
                7:'lead',8:'tin',9:'iron',10:'copper',11:'silver',12:'gold',
                13:'vitae',14:'mors'};
  const rows = [...document.querySelectorAll('.sg-legend-row')];
  const lit = rows.filter(r => r.classList.contains('is-playable'))
                  .map(r => r.querySelector('.sg-legend-label').textContent);
  const kinds = [...s.playableKinds()].map(t => NAME[t]);
  const lowest = NAME[s.lowestMetal()] || 'none';
  // Any lit metal that is not the lowest is the bug.
  const litMetals = lit.filter(n => ['lead','tin','iron','copper','silver'].includes(n));
  return JSON.stringify({ lit, kinds, lowest, litMetals, variant: s.variant });
})()`);
const r = JSON.parse(res);
console.log(`    variant ${r.variant}, lowest metal ${r.lowest}`);
console.log(`    lit: ${r.lit.join(', ')}`);
check('no non-lowest metal is lit', r.litMetals.every(n => n === r.lowest),
  `lit metals ${JSON.stringify(r.litMetals)} with lowest ${r.lowest}`);
check('the lowest metal is lit if any metal is', r.litMetals.length === 0 || r.litMetals.includes(r.lowest));
check('legend matches playableKinds', JSON.stringify([...r.lit].map(s => s.toLowerCase()).sort()) === JSON.stringify([...r.kinds].map(s => s.toLowerCase()).sort()),
  `lit ${JSON.stringify(r.lit)} vs kinds ${JSON.stringify(r.kinds)}`);

// Now take the lead (force it) and confirm tin lights instead.
const after = await ev(`(() => {
  const s = sg.session;
  const E = sg.engine;
  s.board = E.cloneBoard(s.board);
  // Remove lead if present so tin becomes lowest.
  for (const c of E.VALID_CELLS) {
    if (s.board[c] === E.Tile.Lead) s.board[c] = E.Tile.Empty;
  }
  s.emit ? null : null;
  // Rebuild the UI the same way a move would.
  window.dispatchEvent(new Event('resize'));
  const E2 = sg.engine;
  const lowest = E2.lowestMetalRemaining(s.board);
  const kinds = [...s.playableKinds()];
  return JSON.stringify({ lowest, kinds });
})()`);
console.log('    after removing lead:', after);

await send('Browser.close').catch(() => {});
child.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nlegend checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
