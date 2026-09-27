/**
 * Checks that the sound effects load and play.
 *
 * Headless browsers have no audio device, so "did I hear it" is not
 * testable — but whether the files load, decode and are accepted by the
 * autoplay policy is, and that is what usually breaks.
 *
 * Usage:  node tools/test_audio.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);

const CDP = 9364;
const profile = mkdtempSync(path.join(tmpdir(), 'sg-audio-'));
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
const cdp = { send };
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

/* ---- 1. do the files exist and decode? ---- */
console.log('sound files');
const probe = await ev(`(async () => {
  const names = ['solitaire_select','solitaire_match','solitaire_start',
                 'solitaire_end','click_button','ui_modal'];
  const out = [];
  for (const n of names) {
    const url = 'assets/audio/' + n + '.ogg';
    const res = await fetch(url, { method: 'HEAD' });
    out.push({ name: n, status: res.status, type: res.headers.get('content-type'),
               length: Number(res.headers.get('content-length') || 0) });
  }
  const music = await fetch('assets/audio/solitaire.ogg', { method: 'HEAD' });
  out.push({ name: 'solitaire (music)', status: music.status,
             type: music.headers.get('content-type'),
             length: Number(music.headers.get('content-length') || 0) });
  return JSON.stringify(out);
})()`);
for (const f of JSON.parse(probe)) {
  check(
    `${f.name} is served`,
    f.status === 200 && f.length > 1000,
    `status ${f.status}, ${f.length} bytes, type ${f.type}`,
  );
}

/* ---- 2. can the engine decode and play them? ---- */
console.log('\ndecoding and playback');
const decoded = await ev(`(async () => {
  const names = ['solitaire_select','solitaire_match','solitaire_start',
                 'solitaire_end','click_button','ui_modal'];
  const out = [];
  for (const n of names) {
    const a = new Audio('assets/audio/' + n + '.ogg');
    a.preload = 'auto';
    const ok = await new Promise((resolve) => {
      const done = (v) => resolve(v);
      a.addEventListener('canplaythrough', () => done('canplaythrough'), { once: true });
      a.addEventListener('loadeddata', () => done('loadeddata'), { once: true });
      a.addEventListener('error', () => done('error:' + (a.error && a.error.code)), { once: true });
      setTimeout(() => done('timeout'), 4000);
      a.load();
    });
    out.push({ name: n, result: ok, duration: Number.isFinite(a.duration) ? +a.duration.toFixed(3) : null });
  }
  return JSON.stringify(out);
})()`);
for (const d of JSON.parse(decoded)) {
  check(
    `${d.name} decodes`,
    d.result !== 'timeout' && !String(d.result).startsWith('error'),
    `${d.result}, duration ${d.duration}`,
  );
  check(`${d.name} has a real duration`, d.duration !== null && d.duration > 0.05, String(d.duration));
}

/* ---- 3. does the app's own engine actually play a sound? ---- */
console.log('\napp audio engine');

// Use CDP input rather than a synthetic PointerEvent: a dispatched event is
// not "user activation", so the autoplay policy would reject playback and the
// test would report a false failure.
const rect = JSON.parse(await ev(`(() => {
  const r = document.querySelector('canvas.sg-canvas').getBoundingClientRect();
  return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]);
})()`));
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect[0], y: rect[1], button: 'none', clickCount: 0 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect[0], y: rect[1], button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect[0], y: rect[1], button: 'left', clickCount: 1 });
await sleep(400);

const played = JSON.parse(await ev(`(() => {
  const a = window.sg.audio;
  return JSON.stringify({
    hasEngine: !!a, muted: a && a.options.muted, volume: a && a.options.volume,
    music: a && a.options.music, poolSize: a && a.pool ? a.pool.size : 0,
    musicPaused: a && a.music ? a.music.paused : null,
    musicTime: a && a.music ? +a.music.currentTime.toFixed(2) : null,
  });
})()`));
check('audio engine is reachable', played.hasEngine === true, JSON.stringify(played));
check('not muted by default', played.muted === false, JSON.stringify(played));
check('volume is audible', played.volume > 0, JSON.stringify(played));
check('every effect has voices loaded', played.poolSize === 6, JSON.stringify(played));

// Ask the engine to play and watch for rejection.
const res = await ev(`(async () => {
  const results = [];
  for (const name of ['select','match','start','end','button','modal']) {
    const arr = sg.audio.pool.get(name);
    if (!arr) { results.push({ name, played: false, why: 'no voice' }); continue; }
    const el = arr[0];
    try {
      el.currentTime = 0;
      await el.play();
      results.push({ name, played: true, paused: el.paused, rs: el.readyState });
    } catch (e) {
      results.push({ name, played: false, why: (e && e.name) + ': ' + (e && e.message) });
    }
  }
  return JSON.stringify(results);
})()`);
for (const r of JSON.parse(res)) {
  check(`${r.name} plays`, r.played === true, JSON.stringify(r));
}

// The music should have started too, now that there has been a gesture.
const music = JSON.parse(await ev(`JSON.stringify({
  paused: sg.audio.music.paused, time: +sg.audio.music.currentTime.toFixed(2),
  volume: +sg.audio.music.volume.toFixed(3), loop: sg.audio.music.loop,
})`));
check('music started after the first gesture', music.paused === false && music.time > 0, JSON.stringify(music));
check('music loops', music.loop === true, JSON.stringify(music));

/* ---- 4. the app's own play() path (what the game actually calls) ---- */
console.log('\nthe game calls audio.play()');
const viaEngine = JSON.parse(await ev(`(async () => {
  const a = sg.audio;
  const before = a.pool.get('match')[0].currentTime;
  a.play('match');
  await new Promise((r) => setTimeout(r, 250));
  const v = a.pool.get('match').find((x) => !x.paused) || a.pool.get('match')[0];
  return JSON.stringify({ played: !v.paused || v.currentTime > 0,
    currentTime: +v.currentTime.toFixed(3), volume: +v.volume.toFixed(2) });
})()`));
check('audio.play() starts a sound', viaEngine.played === true, JSON.stringify(viaEngine));

await send('Browser.close').catch(() => {});
child.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nall audio checks passed' : `\n${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
