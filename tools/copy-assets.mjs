/**
 * Copies the assets this replica uses out of the Opus Magnum install and
 * into `public/assets`, transcoding audio to Ogg Vorbis along the way.
 *
 * Only files the game ships in `Content/` are touched; nothing is
 * generated here. Run with:  node tools/copy-assets.mjs
 */
import { mkdirSync, copyFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT =
  process.env.OPUS_MAGNUM_CONTENT ??
  'F:\\SteamLibrary\\steamapps\\common\\Opus Magnum\\Content';

const textures = path.join(CONTENT, 'textures', 'solitaire');
const atomTextures = path.join(CONTENT, 'textures', 'atoms');
const sounds = path.join(CONTENT, 'sounds');
const music = path.join(CONTENT, 'music');

const outTex = path.join(root, 'public', 'assets', 'textures');
const outAudio = path.join(root, 'public', 'assets', 'audio');
const outHelp = path.join(root, 'public', 'assets', 'help');
const outAtom = path.join(root, 'public', 'assets', 'atoms');
const outElem = path.join(root, 'public', 'assets', 'atoms', 'elements');

for (const d of [outTex, outAudio, outHelp, outAtom, outElem]) mkdirSync(d, { recursive: true });

/** [source, destination] pairs for plain file copies. */
const textureFiles = [
  ['board.png', 'board.png'],
  ['board_top.png', 'board_top.png'],
  ['hex_hovered.png', 'hex_hovered.png'],
  ['atom_hovered.png', 'atom_hovered.png'],
  ['atom_spawned.png', 'atom_spawned.png'],
  ['pulse_highlight.png', 'pulse_highlight.png'],
  ['pulse_shadow_0.png', 'pulse_shadow_0.png'],
  ['pulse_shadow_1.png', 'pulse_shadow_1.png'],
  ['pulse_shadow_2.png', 'pulse_shadow_2.png'],
  ['pulse_shadow_3.png', 'pulse_shadow_3.png'],
  ['divider_line.png', 'divider_line.png'],
  ['divider_dot.png', 'divider_dot.png'],
  ['diagram_icon.png', 'diagram_icon.png'],
  ['diagram_icon_hover.png', 'diagram_icon_hover.png'],
];

const helpFiles = [
  ['help/background.png', 'background.png'],
  ['help/grid_rules.png', 'grid_rules.png'],
  ['help/single_line.png', 'single_line.png'],
  ['help/double_line.png', 'double_line.png'],
  ['help/matching_rules/cardinals.png', 'cardinals.png'],
  ['help/matching_rules/salt.png', 'salt.png'],
  ['help/matching_rules/projection.png', 'projection.png'],
  ['help/matching_rules/animismus.png', 'animismus.png'],
  // The shipped metal diagram is not used as-is: tools/build_purification.py
  // rebuilds it to show the quicksilver every metal is paired with. Keep the
  // original alongside so that rebuild can read it, and run the rebuild after
  // this copy (see `npm run assets`).
  ['help/matching_rules/purification.png', 'purification_original.png'],
];

let copied = 0;
let missing = 0;

for (const [from, to] of textureFiles) {
  const src = path.join(textures, from);
  if (!existsSync(src)) {
    console.warn(`  missing texture: ${from}`);
    missing++;
    continue;
  }
  copyFileSync(src, path.join(outTex, to));
  copied++;
}

for (const [from, to] of helpFiles) {
  const src = path.join(textures, from);
  if (!existsSync(src)) {
    console.warn(`  missing help art: ${from}`);
    missing++;
    continue;
  }
  copyFileSync(src, path.join(outHelp, to));
  copied++;
}

/**
 * Marble art. The game renders marbles with a shader over a handful of
 * texture layers rather than from a single bitmap, so every layer has to
 * come across for the composite to look right:
 *
 *   <metal>_lightramp  a 256x1 gradient sampled by the diffuse term
 *   <metal>_rimlight   an edge glow, rotated to the light direction
 *   <metal>_symbol     the alchemical glyph
 *   <salt|vitae|mors>_diffuse   the body colour
 *   <salt|vitae|mors>_shade     a shading overlay
 *   elements/<x>_base           cardinal element body
 *   elements/<x>_shadow         cardinal element inner shading
 *   atom.lighting/{l,r,t,b}     directional lighting, used to infer normals
 */
const atomFiles = [
  'shadow.png',
  'whiteout.png',
  'salt_diffuse.png', 'salt_shade.png', 'salt_symbol.png',
  'vitae_diffuse.png', 'vitae_shade.png', 'vitae_symbol.png',
  'mors_diffuse.png', 'mors_shade.png', 'mors_symbol.png',
  'quicksilver_symbol.png',
  'lead_lightramp.png', 'lead_rimlight.png', 'lead_symbol.png',
  'tin_lightramp.png', 'tin_rimlight.png', 'tin_symbol.png',
  'iron_lightramp.png', 'iron_rimlight.png', 'iron_symbol.png',
  'copper_diffuse.png', 'copper_lightramp.png', 'copper_rimlight.png', 'copper_symbol.png',
  'silver_lightramp.png', 'silver_rimlight.png', 'silver_symbol.png',
  'gold_lightramp.png', 'gold_rimlight.png', 'gold_symbol.png',
];

for (const f of atomFiles) {
  const src = path.join(atomTextures, f);
  if (!existsSync(src)) {
    console.warn(`  missing atom texture: ${f}`);
    missing++;
    continue;
  }
  copyFileSync(src, path.join(outAtom, f));
  copied++;
}

const elementFiles = [
  'air_base.png', 'air_base2.png', 'air_fog.png', 'air_shadow.png', 'air_symbol.png',
  'earth_base.png', 'earth_shadow.png', 'earth_symbol.png',
  'fire_base.png', 'fire_shadow.png', 'fire_symbol.png',
  'water_base.png', 'water_shadow.png', 'water_symbol.png',
  'env_lights.png',
  'specular_highlight.png', 'specular_highlight_output.png',
];

for (const f of elementFiles) {
  const src = path.join(atomTextures, 'elements', f);
  if (!existsSync(src)) {
    console.warn(`  missing element texture: ${f}`);
    missing++;
    continue;
  }
  copyFileSync(src, path.join(outElem, f));
  copied++;
}

for (const f of ['left.png', 'right.png', 'top.png', 'bottom.png']) {
  const src = path.join(atomTextures, 'atom.lighting', f);
  if (!existsSync(src)) {
    console.warn(`  missing lighting texture: ${f}`);
    missing++;
    continue;
  }
  copyFileSync(src, path.join(outAtom, `lighting_${f}`));
  copied++;
}

/** Transcode a .wav to .ogg so the browser payload stays small. */
function transcode(name, outName) {
  const src = path.join(sounds, `${name}.wav`);
  if (!existsSync(src)) {
    console.warn(`  missing sound: ${name}.wav`);
    missing++;
    return;
  }
  const dst = path.join(outAudio, `${outName ?? name}.ogg`);
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', src, '-c:a', 'libvorbis', '-q:a', '4', dst],
      { stdio: 'inherit' },
    );
    copied++;
  } catch {
    // Fall back to a raw copy if ffmpeg is unavailable.
    copyFileSync(src, path.join(outAudio, `${outName ?? name}.wav`));
    copied++;
  }
}

transcode('solitaire_select');
transcode('solitaire_match');
transcode('solitaire_start');
transcode('solitaire_end');
transcode('click_button');
transcode('ui_modal');

// Music: the game's solitaire track, transcoded from the original Ogg.
const musicSrc = path.join(music, 'Solitaire.ogg');
if (existsSync(musicSrc)) {
  copyFileSync(musicSrc, path.join(outAudio, 'solitaire.ogg'));
  copied++;
} else {
  console.warn('  missing music: Solitaire.ogg');
  missing++;
}

function human(bytes) {
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  while (bytes > 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)}${units[i]}`;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

console.log(`\ncopied ${copied} files, ${missing} missing`);
console.log(`assets total: ${human(dirSize(path.join(root, 'public', 'assets')))}`);
