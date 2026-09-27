/**
 * Rebuilds the help artwork that is derived rather than copied.
 *
 * `public/assets/help` is produced in two stages: `tools/copy-assets.mjs` copies
 * the game's own diagrams, then this script rebuilds the one diagram that cannot
 * be used as shipped.
 *
 * The metal-rules diagram in the shipped game shows each of the five transmutable
 * metals twice but never the **quicksilver** they are paired with, which is the
 * rule it is meant to teach, so `build_purification.py` recomposes it. That needs
 * a quicksilver orb, which `extract_quicksilver_orb.py` lifts out of the game's
 * own `projection.png` — the game ships quicksilver as a glyph with no body image,
 * so there is nothing to composite one from.
 *
 * Both are Python, because they are image work. If Python or Pillow is missing
 * this reports it and leaves the copied artwork in place rather than failing the
 * whole asset step: everything except that one diagram still works.
 *
 * Run with:  node tools/build-help-art.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helpDir = path.join(root, 'public', 'assets', 'help');

const STEPS = [
  ['extract_quicksilver_orb.py', 'the quicksilver orb'],
  ['build_purification.py', 'the metal-rules diagram'],
];

/** Picks a Python that Pillow is importable from. */
function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      execFileSync(cmd, ['-c', 'import PIL'], { stdio: 'ignore' });
      return cmd;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

if (!existsSync(helpDir)) {
  console.error(
    'public/assets/help is missing. Run `node tools/copy-assets.mjs` first,\n' +
      'with Opus Magnum installed (set OPUS_MAGNUM_CONTENT if it is not in the\n' +
      'default Steam location).',
  );
  process.exit(1);
}

const python = findPython();
if (!python) {
  console.warn(
    '  skipped help artwork: no Python with Pillow found.\n' +
      '  The copied diagrams are in place; only the rebuilt metal diagram is missing.\n' +
      '  Install Pillow (pip install Pillow) to rebuild it.',
  );
  process.exit(0);
}

for (const [script, label] of STEPS) {
  const file = path.join(root, 'tools', script);
  try {
    execFileSync(python, [file], { stdio: 'inherit', cwd: root });
  } catch (err) {
    console.warn(`  failed to rebuild ${label}: ${err.message}`);
  }
}

console.log('help artwork ready');
