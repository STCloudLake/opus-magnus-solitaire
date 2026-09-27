import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(os.tmpdir(), `sg-bench-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile, logLevel: 'error',
});
const M = await import(`file://${outfile.replace(/\\/g, '/')}`);
const { generateBoard, verifySolution, solveBoard, countMarbles } = M;

const N = Number(process.argv[2] ?? 300);
const variant = process.argv[3] ?? 'quicksilver';

let maxMs = 0, maxSeed = 0, totalMs = 0, bad = 0, totalAttempts = 0;
const times = [];
const t0 = Date.now();
for (let s = 1; s <= N; s++) {
  const a = Date.now();
  const g = generateBoard(s, variant);
  const ms = Date.now() - a;
  times.push(ms);
  totalMs += ms;
  totalAttempts += g.attempts;
  if (ms > maxMs) { maxMs = ms; maxSeed = s; }
  if (!verifySolution(g.board, g.solution, variant) || countMarbles(g.board) !== 55) {
    bad++;
    console.log(`  BAD seed ${s}`);
  }
}
times.sort((x, y) => x - y);
const wall = Date.now() - t0;
console.log(`variant=${variant}  boards=${N}`);
console.log(`  bad boards      : ${bad}`);
console.log(`  wall time       : ${wall}ms  (${(N / (wall / 1000)).toFixed(1)} boards/sec)`);
console.log(`  mean / median   : ${(totalMs / N).toFixed(1)}ms / ${times[N >> 1]}ms`);
console.log(`  p90 / p99 / max : ${times[Math.floor(N * 0.9)]}ms / ${times[Math.floor(N * 0.99)]}ms / ${maxMs}ms (seed ${maxSeed})`);
console.log(`  mean attempts   : ${(totalAttempts / N).toFixed(2)}`);

// Solver-only timing on a fixed board.
const g = generateBoard(7, variant);
const t1 = Date.now();
for (let i = 0; i < 50; i++) solveBoard(g.board, variant, { nodeLimit: 500000 });
console.log(`  solver on a fresh board: ${((Date.now() - t1) / 50).toFixed(2)}ms per solve`);
