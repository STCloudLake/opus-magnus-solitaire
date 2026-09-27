/**
 * Verifies the calibration panel moves the marbles and reports the values.
 *
 * Usage:  node tools/test_calibrate.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);

const CDP = 9354;
const profile = mkdtempSync(path.join(tmpdir(), 'sg-cal-'));
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

await send('Page.navigate', { url: 'http://127.0.0.1:8123/?motion=off&seed=1&calibrate=1' });
for (let i = 0; i < 120; i++) {
  try { if (await ev('window.sgReady === true')) break; } catch {}
  await sleep(200);
}

console.log('calibration panel');
check('panel is visible with ?calibrate', await ev('!document.querySelector(".sg-calib").hidden'));
check(
  'has two axis sliders',
  (await ev('document.querySelectorAll(".sg-calib input[type=range]").length')) === 2,
);
check(
  'has two numeric inputs',
  (await ev('document.querySelectorAll(".sg-calib input[type=number]").length')) === 2,
);

// A marble's screen position before and after a known nudge.
const before = await ev('JSON.stringify(sg.renderer.cellToCss(60))');
const scale = await ev('sg.renderer.scale');

// Drag the horizontal slider by setting its value and firing input.
await ev(`(() => {
  const r = document.querySelectorAll('.sg-calib input[type=range]')[0];
  r.value = '12';
  r.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(120);
await ev(`(() => {
  const r = document.querySelectorAll('.sg-calib input[type=range]')[1];
  r.value = '-7';
  r.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(120);

const reported = JSON.parse(await ev('JSON.stringify(sg.getCalibration())'));
check('reports the values it was given', reported.x === 12 && reported.y === -7, JSON.stringify(reported));

const after = JSON.parse(await ev('JSON.stringify(sg.renderer.cellToCss(60))'));
const b = JSON.parse(before);
const dx = (after.x - b.x) / scale;
const dy = (after.y - b.y) / scale;
check(
  'marble moved by the requested board-pixel amounts',
  Math.abs(dx - 12) < 0.01 && Math.abs(dy + 7) < 0.01,
  `moved (${dx.toFixed(3)}, ${dy.toFixed(3)}), wanted (12, -7)`,
);
check(
  'board itself did not move',
  (await ev('JSON.stringify(sg.renderer.offsetX)')) ===
    (await ev('String(sg.renderer.offsetX)')),
);

// Nudge buttons.
await ev(`document.querySelector('.sg-calib-row[data-axis="x"] [data-nudge="1"]').click()`);
await sleep(100);
check('nudge button adjusts by one', (await ev('sg.getCalibration().x')) === 13);

// Reset.
await ev(`document.querySelector('[data-action="reset"]').click()`);
await sleep(100);
const reset = JSON.parse(await ev('JSON.stringify(sg.getCalibration())'));
check('reset returns to zero', reset.x === 0 && reset.y === 0, JSON.stringify(reset));

// The offset must apply to hit-testing too, so clicking stays accurate.
const hit = await ev(`(() => {
  sg.setCalibration(10, 10);
  const p = sg.renderer.cellToCss(60);
  const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
  return JSON.stringify({ cell: sg.renderer.cellAtPoint(p.x, p.y), want: 60,
    offset: sg.getCalibration() });
})()`);
check('hit-testing follows the offset', JSON.parse(hit).cell === 60, hit);

// Toggle visibility.
await ev('sgCalibrate()');
check('sgCalibrate() hides the panel', await ev('document.querySelector(".sg-calib").hidden'));
await ev('sgCalibrate()');
check('sgCalibrate() shows it again', await ev('!document.querySelector(".sg-calib").hidden'));

await send('Browser.close').catch(() => {});
child.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nall calibration checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
