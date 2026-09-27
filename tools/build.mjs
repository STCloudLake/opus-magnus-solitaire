/**
 * Bundles the TypeScript sources into `public/`.
 *
 * The output is a plain static site: `public/index.html`,
 * `public/styles.css`, `public/main.js` and `public/assets/**`. Any
 * static host works; `tools/serve.mjs` is provided for local use.
 *
 * Usage:  node tools/build.mjs [--watch] [--minify]
 */
import * as esbuild from 'esbuild';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
const outdir = path.join(root, 'public');

if (!existsSync(path.join(outdir, 'assets', 'textures', 'board.png'))) {
  console.warn(
    'warning: public/assets is missing or incomplete — run `node tools/copy-assets.mjs` first.',
  );
}

/** Copies nothing but reports bundle size, so CI logs stay readable. */
function sizeReporter() {
  return {
    name: 'size-reporter',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return;
        const outputs = result.metafile?.outputs ?? {};
        for (const [file, info] of Object.entries(outputs)) {
          if (!file.endsWith('.js')) continue;
          const kb = (info.bytes / 1024).toFixed(1);
          console.log(`  ${path.relative(root, file)}  ${kb} kB`);
        }
      });
    },
  };
}

const options = {
  entryPoints: {
    main: path.join(root, 'src', 'main.ts'),
    engine: path.join(root, 'src', 'index.ts'),
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  sourcemap: true,
  minify,
  metafile: true,
  logLevel: 'info',
  plugins: [sizeReporter()],
};

mkdirSync(outdir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`watching src/ -> ${path.relative(root, outdir)}/`);
} else {
  await esbuild.build(options);
  console.log(`built to ${path.relative(root, outdir)}/`);
}
