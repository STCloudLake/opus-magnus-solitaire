/**
 * Verifies the sound/music switches gate playback correctly.
 *
 * The bug this pins down: `unlock()` ran on every click and started the music
 * regardless of whether sound was on, so turning sound off still restarted the
 * music on the next click.
 *
 * Usage:  node tools/test_audio_gating.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);

const CDP = 9370;
const profile = mkdtempSync(path.join(tmpdir(), 'sg-gate-'));
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--mute-audio',
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

const canvasCentre = JSON.parse(await ev(`(() => {
  const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
  return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]);
})()`));
const clickCanvas = async () => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: canvasCentre[0], y: canvasCentre[1], button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvasCentre[0], y: canvasCentre[1], button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: canvasCentre[0], y: canvasCentre[1], button: 'left', clickCount: 1 });
  await sleep(250);
};

const state = () => ev(`JSON.stringify({
  muted: sg.audio.options.muted, music: sg.audio.options.music,
  trackPaused: sg.audio.music.paused,
  soundLabel: sg.els.muteButton.textContent, musicLabel: sg.els.musicButton.textContent,
})`).then(JSON.parse);

// Both switches exist and default to on.
console.log('controls');
const initial = await state();
check('sound switch exists and reads Sound: on', initial.soundLabel === 'Sound: on', JSON.stringify(initial));
check('music switch exists and reads Music: on', initial.musicLabel === 'Music: on', JSON.stringify(initial));

// Start from a clean, unmuted, music-on state with a real gesture.
await ev(`sg.audio.setOptions({ muted: false, music: true })`);
await clickCanvas();
let s = await state();
check('music plays when both switches are on', s.trackPaused === false, JSON.stringify(s));

console.log('\nsound off must silence everything, including the music');
await ev(`sg.els.muteButton.click()`);
await sleep(300);
s = await state();
check('sound switch turns off', s.muted === true, JSON.stringify(s));
check('music is paused when sound is off', s.trackPaused === true, JSON.stringify(s));
check('music switch still shows its own state as on', s.music === true, JSON.stringify(s));
check('music button reads Music: off while sound is off', s.musicLabel === 'Music: off', JSON.stringify(s));

// The regression: clicking with sound off must NOT restart the music.
await clickCanvas();
await clickCanvas();
s = await state();
check('clicking with sound off does not restart the music', s.trackPaused === true, JSON.stringify(s));

console.log('\nsound back on resumes the music');
await ev(`sg.els.muteButton.click()`);
await sleep(300);
s = await state();
check('sound switch turns on', s.muted === false, JSON.stringify(s));
check('music resumes', s.trackPaused === false, JSON.stringify(s));

console.log('\nmusic off leaves effects alone');
await ev(`sg.els.musicButton.click()`);
await sleep(300);
s = await state();
check('music switch turns off', s.music === false, JSON.stringify(s));
check('track is paused', s.trackPaused === true, JSON.stringify(s));
check('sound is still on', s.muted === false, JSON.stringify(s));

// Click an actual selectable marble -- the dead centre of the board may well
// be empty, in which case there is nothing to pick up and no sound is right.
const target = JSON.parse(await ev(`(() => {
  const app = sg, sel = app.session;
  sel.selected = null;
  const loose = sel.playable();
  if (!loose.length) return JSON.stringify({ none: true });
  const cell = loose[0];
  const c = app.renderer.cellToCss(cell);
  const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
  return JSON.stringify({ cell, x: r.left + c.x, y: r.top + c.y });
})()`));
check('found a selectable marble', target.none !== true, JSON.stringify(target));

await ev('window.__sfx = []; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function(){ window.__sfx.push(String(this.src).split("/").pop()); return o.apply(this, arguments); };');
if (target.none !== true) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', clickCount: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await sleep(300);
}
const afterMusicOff = JSON.parse(await ev('JSON.stringify(window.__sfx)'));
check(
  'effects still fire with the music off',
  afterMusicOff.some((f) => f === 'solitaire_select.ogg'),
  JSON.stringify(afterMusicOff),
);
check(
  'the music is not restarted while its switch is off',
  !afterMusicOff.includes('solitaire.ogg'),
  JSON.stringify(afterMusicOff),
);

console.log('\nsettings persist across a reload');
await ev(`localStorage.setItem('sg.muted','1'); localStorage.setItem('sg.music','0')`);
await send('Page.navigate', { url: 'http://127.0.0.1:8123/?motion=off&seed=1' });
for (let i = 0; i < 120; i++) {
  try { if (await ev('window.sgReady === true')) break; } catch { /* wait */ }
  await sleep(200);
}
s = await state();
check('structured mute persists', s.muted === true, JSON.stringify(s));
check('structured music-off persists', s.music === false, JSON.stringify(s));

await send('Browser.close').catch(() => {});
child.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nall audio gating checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
