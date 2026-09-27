/**
 * Headless checks for the rules engine and solver.
 *
 * Run with:  node tools/selftest.mjs
 *
 * The TypeScript sources are bundled on the fly with esbuild so the tests
 * exercise exactly the same code the browser runs.
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const outfile = path.join(os.tmpdir(), `sg-selftest-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src', 'selftest.entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile,
  logLevel: 'warning',
});

const mod = await import(`file://${outfile.replace(/\\/g, '/')}`);
const failures = mod.runSelfTest();
rmSync(outfile, { force: true });
process.exit(failures === 0 ? 0 : 1);
