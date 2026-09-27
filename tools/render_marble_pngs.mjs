/**
 * Renders every marble kind from the app's own compositor and saves them as
 * PNGs, so help artwork can be built from exactly the marbles the board draws.
 *
 * Usage:  node tools/render_marble_pngs.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.SG_BASE ?? 'http://127.0.0.1:8123';
const OUT = process.argv[2] ?? path.join('public', 'assets', 'help', 'marbles');
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
  for (let port = 9333; port <= 9384; port++) {
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

const NAMES = {
  1: 'salt', 2: 'air', 3: 'fire', 4: 'water', 5: 'earth', 6: 'quicksilver',
  7: 'lead', 8: 'tin', 9: 'iron', 10: 'copper', 11: 'silver', 12: 'gold',
  13: 'vitae', 14: 'mors',
};

async function main() {
  if (!EDGE) throw new Error('Edge not found');
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9363', `--user-data-dir=${path.join(tmpdir(), `sg-marble-${Date.now()}`)}`,
    '--window-size=1200,900', 'about:blank',
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
    await cdp.send('Page.navigate', { url: `${BASE}/?motion=off&seed=1` });
    await sleep(3000);
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval('window.sgReady === true')) break;
      await sleep(300);
    }

    mkdirSync(OUT, { recursive: true });
    const ids = Object.keys(NAMES).map(Number);
    const payload = await cdp.eval(`(async () => {
      const E = window.sg.engine;
      const sprites = await E.buildSpriteSheet();
      const out = {};
      for (const id of ${JSON.stringify(ids)}) {
        const cv = sprites.marbles.get(id);
        if (cv) out[id] = cv.toDataURL('image/png');
      }
      return JSON.stringify(out);
    })()`);

    const map = JSON.parse(payload);
    let n = 0;
    for (const [id, dataUrl] of Object.entries(map)) {
      const b64 = dataUrl.split(',')[1];
      writeFileSync(path.join(OUT, `${NAMES[id]}.png`), Buffer.from(b64, 'base64'));
      n++;
    }
    console.log(`wrote ${n} marble PNGs to ${OUT}`);
  } finally {
    try { proc.kill(); } catch { /* gone */ }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
