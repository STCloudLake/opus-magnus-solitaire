/**
 * Verifies that sound actually fires while playing, using real input.
 *
 * Instruments HTMLMediaElement.play so every call is recorded, then plays a
 * few real moves through the canvas and reports what the game asked to play
 * and whether the browser accepted it.
 *
 * Usage:  node tools/test_audio_play.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);

const CDP = 9368;
const profile = mkdtempSync(path.join(tmpdir(), 'sg-sfx-'));
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--mute-audio', '--autoplay-policy=user-gesture-required',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
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

// Record every play() the page makes, and whether it succeeded.
await ev(`(() => {
  window.__sfx = [];
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const entry = { src: String(this.src).split('/').pop(), ok: null, why: null,
                    t: Math.round(performance.now()) };
    window.__sfx.push(entry);
    const p = orig.apply(this, arguments);
    if (p && p.then) {
      p.then(() => { entry.ok = true; }, (e) => { entry.ok = false; entry.why = e && e.name; });
    }
    return p;
  };
  return true;
})()`);

// Real click on the canvas -- this is also the gesture that unlocks audio.
const rect = JSON.parse(await ev(`(() => {
  const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
  return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]);
})()`));
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
await click(rect[0], rect[1]);
await sleep(600);

const afterFirst = JSON.parse(await ev('JSON.stringify(window.__sfx)'));
check('the first click unlocked audio (music)', afterFirst.some((e) => e.src === 'solitaire.ogg'), JSON.stringify(afterFirst));

// Now play a real move through the canvas.
const move = JSON.parse(await ev(`(() => {
  const app = window.sg, s = app.session;
  const E = app.engine;
  s.selected = null;
  const loose = s.playable();
  const lowest = s.variant === 'colvan' ? 0 : s.lowestMetal();
  for (const a of loose) for (const b of loose) {
    if (a === b) continue;
    if (E.canPair(s.board[a], s.board[b], s.variant, lowest)) {
      const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
      const ca = app.renderer.cellToCss(a), cb = app.renderer.cellToCss(b);
      return JSON.stringify({ a, b,
        pa: [r.left + ca.x, r.top + ca.y], pb: [r.left + cb.x, r.top + cb.y] });
    }
  }
  return JSON.stringify({ none: true });
})()`));
check('found a legal move to play', move.none !== true, JSON.stringify(move));

await ev('window.__sfx.length = 0');
await click(move.pa[0], move.pa[1]);
await sleep(250);
await click(move.pb[0], move.pb[1]);
await sleep(500);

const played = JSON.parse(await ev('JSON.stringify(window.__sfx)'));
console.log('  sounds requested while playing:', JSON.stringify(played));
check('select sound fired on the first marble', played.some((e) => e.src === 'solitaire_select.ogg'), '');
check('match sound fired on the pair', played.some((e) => e.src === 'solitaire_match.ogg'), '');
check('every requested sound was accepted', played.every((e) => e.ok === true),
  JSON.stringify(played.filter((e) => e.ok !== true)));

// Buttons.
await ev('window.__sfx.length = 0');
await ev(`document.querySelectorAll('.sg-toolbar .sg-button')[0].click()`);
await sleep(500);
const btn = JSON.parse(await ev('JSON.stringify(window.__sfx)'));
check('button click sound fired', btn.some((e) => e.src === 'click_button.ogg'), JSON.stringify(btn));
check('new game sound fired', btn.some((e) => e.src === 'solitaire_start.ogg'), JSON.stringify(btn));

await send('Browser.close').catch(() => {});
child.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nall gameplay audio checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
