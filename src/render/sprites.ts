/**
 * Marble sprites, rebuilt from the game's own textures.
 *
 * Opus Magnum does not store marbles as bitmaps. Each one is composited at
 * runtime by a pixel shader (`Content/shaders/MetalAtomPS.glsl`,
 * `GlassAtomPS.glsl`, `QuintessenceAtomPS.glsl`) from a handful of layers
 * in `Content/textures/atoms`:
 *
 *   metals   <m>_lightramp (a 256x1 gradient sampled by the diffuse term)
 *            <m>_rimlight  (an edge glow rotated to face the light)
 *            <m>_symbol    (the alchemical glyph)
 *   glass    elements/<x>_base, _fog, _base2, _shadow
 *            elements/env_lights, specular_highlight
 *   plain    salt/vitae/mors: _diffuse, _shade, _symbol
 *   shared   atom.lighting/{left,right,top,bottom} — directional light
 *            maps, also used to infer each pixel's normal
 *
 * This module reproduces that maths. Layers are accumulated the same way
 * the shaders do — `dst*(1 - src.a) + src.rgb` — which is only consistent
 * if the accumulation is kept premultiplied, so every layer is converted
 * to premultiplied alpha on load and converted back when rasterised.
 */

import { TILE_ORDER, Tile, type TileStyle } from '../tiles.js';

/**
 * Resolution sprites are rasterised at.
 *
 * This is `MARBLE_DIAMETER`, the size a marble is actually drawn at, and it is
 * deliberately close to the source art: the game's atom layers are only 60x60,
 * so rasterising larger only interpolates them up and then back down again on
 * the way to the screen, which is what made marbles look soft. Rendering at the
 * drawn size keeps them on a 1:1 texel-to-pixel footing.
 */
export const SPRITE_SIZE = 56;

/**
 * Direction from the surface towards the light, in the sprite's plane.
 *
 * `PSHeader.glsl` puts the light at
 * `(centreX, (bottom + height) * 1.05, 1200)`, i.e. directly above the
 * card but far enough in front of it that the angle of incidence on a
 * marble at the middle of the board is only about 20 degrees, not the
 * near-grazing angle a 2D reading of "above" suggests. Using a steeper
 * angle drives most of the sphere to the dark end of the light ramp and
 * makes the marble look like it is hanging off its tile, because the lit
 * part ends up in one corner.
 *
 * Computed from a 1080-tall visible area: the light sits ~1140 units
 * above the board centre against a z of 1200.
 */
const LIGHT_DIR: readonly [number, number] = [-0.119, -0.993];

/**
 * How far the rim light is rotated. The rim textures carry their glow at
 * the bottom edge, so they are turned a half-turn to face the light.
 */
const RIM_ANGLE_DEG = 180;

/* ------------------------------------------------------------------ *
 * Layer loading
 * ------------------------------------------------------------------ */

interface Layer {
  width: number;
  height: number;
  /** Premultiplied RGBA, 0..1. */
  data: Float32Array;
}

const ATOM_BASE = 'assets/atoms/';

/** Textures every marble needs, loaded once. */
const SHARED = {
  lightingLeft: `${ATOM_BASE}lighting_left.png`,
  lightingRight: `${ATOM_BASE}lighting_right.png`,
  lightingTop: `${ATOM_BASE}lighting_top.png`,
  lightingBottom: `${ATOM_BASE}lighting_bottom.png`,
  envLights: `${ATOM_BASE}elements/env_lights.png`,
  specular: `${ATOM_BASE}elements/specular_highlight.png`,
  shadow: `${ATOM_BASE}shadow.png`,
} as const;

/** Layer file names for each marble, mirroring the shader inputs. */
interface MarbleLayers {
  kind: 'metal' | 'glass' | 'plain' | 'symbolOnly';
  base?: string;
  base2?: string;
  fog?: string;
  shade?: string;
  lightramp?: string;
  rimlight?: string;
  symbol: string;
}

const LAYERS: Record<number, MarbleLayers> = {
  [Tile.Lead]: { kind: 'metal', lightramp: 'lead_lightramp.png', rimlight: 'lead_rimlight.png', symbol: 'lead_symbol.png' },
  [Tile.Tin]: { kind: 'metal', lightramp: 'tin_lightramp.png', rimlight: 'tin_rimlight.png', symbol: 'tin_symbol.png' },
  [Tile.Iron]: { kind: 'metal', lightramp: 'iron_lightramp.png', rimlight: 'iron_rimlight.png', symbol: 'iron_symbol.png' },
  [Tile.Copper]: { kind: 'metal', base: 'copper_diffuse.png', lightramp: 'copper_lightramp.png', rimlight: 'copper_rimlight.png', symbol: 'copper_symbol.png' },
  [Tile.Silver]: { kind: 'metal', lightramp: 'silver_lightramp.png', rimlight: 'silver_rimlight.png', symbol: 'silver_symbol.png' },
  [Tile.Gold]: { kind: 'metal', lightramp: 'gold_lightramp.png', rimlight: 'gold_rimlight.png', symbol: 'gold_symbol.png' },
  [Tile.Quicksilver]: { kind: 'symbolOnly', symbol: 'quicksilver_symbol.png' },
  [Tile.Air]: { kind: 'glass', base: 'elements/air_base.png', base2: 'elements/air_base2.png', fog: 'elements/air_fog.png', symbol: 'elements/air_symbol.png' },
  [Tile.Earth]: { kind: 'glass', base: 'elements/earth_base.png', symbol: 'elements/earth_symbol.png' },
  [Tile.Fire]: { kind: 'glass', base: 'elements/fire_base.png', symbol: 'elements/fire_symbol.png' },
  [Tile.Water]: { kind: 'glass', base: 'elements/water_base.png', symbol: 'elements/water_symbol.png' },
  [Tile.Salt]: { kind: 'plain', base: 'salt_diffuse.png', shade: 'salt_shade.png', symbol: 'salt_symbol.png' },
  [Tile.Vitae]: { kind: 'plain', base: 'vitae_diffuse.png', shade: 'vitae_shade.png', symbol: 'vitae_symbol.png' },
  [Tile.Mors]: { kind: 'plain', base: 'mors_diffuse.png', shade: 'mors_shade.png', symbol: 'mors_symbol.png' },
};

const layerCache = new Map<string, Promise<Layer>>();

function newCanvas(size = SPRITE_SIZE): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Reads an image into a premultiplied float layer. */
function readLayer(img: HTMLImageElement | HTMLCanvasElement): Layer {
  const w = (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width;
  const h = (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height;
  const c = newCanvas(w);
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  const src = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = src[i * 4 + 3] / 255;
    // Canvas hands back straight alpha; premultiply so compositing is a
    // plain weighted sum.
    data[i * 4] = (src[i * 4] / 255) * a;
    data[i * 4 + 1] = (src[i * 4 + 1] / 255) * a;
    data[i * 4 + 2] = (src[i * 4 + 2] / 255) * a;
    data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

function loadLayer(src: string): Promise<Layer> {
  let p = layerCache.get(src);
  if (!p) {
    p = new Promise<Layer>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(readLayer(img));
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
    layerCache.set(src, p);
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * Compositing
 * ------------------------------------------------------------------ */

function cloneLayer(l: Layer): Layer {
  return { width: l.width, height: l.height, data: new Float32Array(l.data) };
}

/**
 * `dst = dst * (1 - src.a) + src.rgb`, the blend every atom shader uses.
 * Both sides are premultiplied, so this is a straight weighted sum and the
 * destination never picks up colour from transparent source pixels.
 */
function over(dst: Layer, src: Layer): void {
  const n = dst.width * dst.height;
  const d = dst.data;
  const s = src.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const sa = s[o + 3];
    if (sa === 0) continue;
    const inv = 1 - sa;
    d[o] = s[o] + d[o] * inv;
    d[o + 1] = s[o + 1] + d[o + 1] * inv;
    d[o + 2] = s[o + 2] + d[o + 2] * inv;
    d[o + 3] = sa + d[o + 3] * inv;
  }
}

/** `RotatedTexCoord`: rotate a layer about its centre. */
function rotateLayer(l: Layer, degrees: number): Layer {
  const c = newCanvas(l.width);
  c.height = l.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const tmp = newCanvas(l.width);
  tmp.height = l.height;
  const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
  const back = new ImageData(l.width, l.height);
  // Un-premultiply for the drawImage, which expects straight alpha.
  for (let i = 0; i < l.width * l.height; i++) {
    const a = l.data[i * 4 + 3];
    back.data[i * 4 + 3] = Math.round(a * 255);
    if (a > 1e-6) {
      back.data[i * 4] = Math.min(255, Math.round((l.data[i * 4] / a) * 255));
      back.data[i * 4 + 1] = Math.min(255, Math.round((l.data[i * 4 + 1] / a) * 255));
      back.data[i * 4 + 2] = Math.min(255, Math.round((l.data[i * 4 + 2] / a) * 255));
    }
  }
  tctx.putImageData(back, 0, 0);
  ctx.translate(l.width / 2, l.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(tmp, -l.width / 2, -l.height / 2);
  return readLayer(c);
}

/** Samples the 256x1 light ramp at the pixel's diffuse term. */
function rampColour(ramp: Layer, nx: number, ny: number, nz: number): [number, number, number] {
  const [lx, ly] = LIGHT_DIR;
  const lz = Math.sqrt(Math.max(0, 1 - lx * lx - ly * ly));
  const diffuse = Math.max(0, Math.min(1, 0.5 + 0.5 * (nx * lx + ny * ly + nz * lz)));
  const idx = Math.round(diffuse * (ramp.width - 1));
  const o = idx * 4;
  const a = ramp.data[o + 3] || 1;
  // The ramp is opaque; divide out the premultiply to get its colour.
  return [ramp.data[o] / a, ramp.data[o + 1] / a, ramp.data[o + 2] / a];
}

/**
 * MetalAtomPS: infer a normal from the four directional light maps, look
 * up the ramp with the diffuse term, then lay the rim light and glyph on
 * top. Alpha comes from the same maps, which is what shapes the sphere.
 *
 * The four maps are named for the side of the sprite they light, so the
 * surface normal points *towards* the brighter side: `left - right` and
 * `bottom - top`. Getting these signs the wrong way round turns the
 * marble inside out — the lit side ends up facing away from the light and
 * the body goes black.
 */
function buildMetal(ramp: Layer, rim: Layer, symbol: Layer, light: {
  left: Layer; right: Layer; top: Layer; bottom: Layer;
}): Layer {
  const { width, height } = light.left;
  const out: Layer = { width, height, data: new Float32Array(width * height * 4) };
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    // Brightness is `dot(normal, lightToSurface)`, so the normal must
    // point towards the lit side. These maps light the named side of the
    // sprite, hence `left - right` / `bottom - top`.
    let nx = light.left.data[o] - light.right.data[o];
    let ny = light.bottom.data[o] - light.top.data[o];
    let nz = Math.sqrt(Math.max(0, 1 - (nx * nx + ny * ny)));
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const [r, g, b] = rampColour(ramp, nx, ny, nz);
    const a = light.left.data[o + 3];
    out.data[o] = r * a;
    out.data[o + 1] = g * a;
    out.data[o + 2] = b * a;
    out.data[o + 3] = a;
  }
  over(out, rotateLayer(rim, RIM_ANGLE_DEG));
  over(out, symbol);
  return out;
}

/**
 * GlassAtomPS: base, fog, base2, environment lights, rotating specular
 * highlight, then the glyph. The base carries the sphere's alpha.
 */
function buildGlass(base: Layer, extras: Layer[], symbol: Layer): Layer {
  const out = cloneLayer(base);
  for (const e of extras) over(out, e);
  over(out, symbol);
  return out;
}

/** Salt, vitae and mors: diffuse, shade, symbol. */
function buildPlain(base: Layer, shade: Layer | null, symbol: Layer): Layer {
  const out = cloneLayer(base);
  if (shade) over(out, shade);
  over(out, symbol);
  return out;
}

/* ------------------------------------------------------------------ *
 * Rasterisation
 * ------------------------------------------------------------------ */

/** Draws a premultiplied layer into a canvas at the requested size. */
function rasterise(layer: Layer, size: number): HTMLCanvasElement {
  const c = newCanvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const { width: w, height: h, data } = layer;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / size));
      const s = (sy * w + sx) * 4;
      const d = (y * size + x) * 4;
      const a = Math.min(1, Math.max(0, data[s + 3]));
      const inv = a > 1e-6 ? 1 / a : 0;
      img.data[d] = Math.min(255, Math.round(data[s] * inv * 255));
      img.data[d + 1] = Math.min(255, Math.round(data[s + 1] * inv * 255));
      img.data[d + 2] = Math.min(255, Math.round(data[s + 2] * inv * 255));
      img.data[d + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface SpriteSet {
  marbles: Map<number, HTMLCanvasElement>;
  /**
   * The same marbles, faded and desaturated, for locked ones.
   *
   * Pre-compositing this is what makes the two states read differently at a
   * glance. Dimming with `globalAlpha` alone left the locked marble at full
   * colour, so it still looked like a marble you could pick up and the contrast
   * between playable and locked was barely there.
   */
  locked: Map<number, HTMLCanvasElement>;
  shadow: HTMLCanvasElement;
  glow: HTMLCanvasElement;
}

/**
 * How far locked marbles are pulled back.
 *
 * These want to read as *faded*, not dark. Multiplying the colour down turned
 * them into flat grey discs, which loses the glassy shading that makes a marble
 * look like a sphere sitting in the tile; dropping the alpha instead keeps the
 * shading and lets the carving show through, which is the transparent look the
 * original has. Desaturation is what does most of the work of separating the
 * two states.
 */
const LOCKED_DESATURATE = 0.8;
const LOCKED_BRIGHTNESS = 0.88;
const LOCKED_ALPHA = 0.42;

/**
 * Builds the faded, desaturated counterpart of a marble.
 *
 * The alpha is scaled rather than the colour flattened, so a locked marble
 * keeps its shading and still reads as a sphere sitting in the tile — it just
 * recedes instead of competing with the marbles you can actually take.
 */
function buildLocked(sprite: HTMLCanvasElement, size = SPRITE_SIZE): HTMLCanvasElement {
  const c = newCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sprite, 0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a === 0) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Toward grey...
    const gr = r + (lum - r) * LOCKED_DESATURATE;
    const gg = g + (lum - g) * LOCKED_DESATURATE;
    const gb = b + (lum - b) * LOCKED_DESATURATE;
    // ...then down.
    d[i] = Math.min(255, gr * LOCKED_BRIGHTNESS);
    d[i + 1] = Math.min(255, gg * LOCKED_BRIGHTNESS);
    d[i + 2] = Math.min(255, gb * LOCKED_BRIGHTNESS);
    d[i + 3] = Math.min(255, d[i + 3] * LOCKED_ALPHA);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function buildMarble(id: number): Promise<HTMLCanvasElement> {
  const spec = LAYERS[id];
  if (!spec) throw new Error(`No marble layers for tile ${id}`);

  if (spec.kind === 'metal') {
    const [ramp, rim, symbol, left, right, top, bottom] = await Promise.all([
      loadLayer(ATOM_BASE + spec.lightramp!),
      loadLayer(ATOM_BASE + spec.rimlight!),
      loadLayer(ATOM_BASE + spec.symbol),
      loadLayer(SHARED.lightingLeft),
      loadLayer(SHARED.lightingRight),
      loadLayer(SHARED.lightingTop),
      loadLayer(SHARED.lightingBottom),
    ]);
    return rasterise(buildMetal(ramp, rim, symbol, { left, right, top, bottom }), SPRITE_SIZE);
  }

  if (spec.kind === 'glass') {
    const extraFiles: string[] = [];
    if (spec.fog) extraFiles.push(ATOM_BASE + spec.fog);
    if (spec.base2) extraFiles.push(ATOM_BASE + spec.base2);
    const [base, symbol, env, spec_hl, ...extras] = await Promise.all([
      loadLayer(ATOM_BASE + spec.base!),
      loadLayer(ATOM_BASE + spec.symbol),
      loadLayer(SHARED.envLights),
      loadLayer(SHARED.specular),
      ...extraFiles.map((f) => loadLayer(f)),
    ]);
    const layers = [...extras, env, rotateLayer(spec_hl, RIM_ANGLE_DEG)];
    return rasterise(buildGlass(base, layers, symbol), SPRITE_SIZE);
  }

  if (spec.kind === 'plain') {
    const [base, symbol, shade] = await Promise.all([
      loadLayer(ATOM_BASE + spec.base!),
      loadLayer(ATOM_BASE + spec.symbol),
      spec.shade ? loadLayer(ATOM_BASE + spec.shade) : Promise.resolve(null),
    ]);
    return rasterise(buildPlain(base, shade, symbol), SPRITE_SIZE);
  }

  // Quicksilver ships only a glyph; the surface comes from the lighting
  // maps plus the specular highlight, which is how the game draws it.
  const [symbol, light, spec_hl] = await Promise.all([
    loadLayer(ATOM_BASE + spec.symbol),
    loadLayer(SHARED.lightingLeft),
    loadLayer(SHARED.specular),
  ]);
  const base = cloneLayer(light);
  // Give the sphere a soft metallic body so the glyph has something to sit on.
  const [r, g, b] = [0.62, 0.6, 0.5];
  for (let i = 0; i < base.width * base.height; i++) {
    const o = i * 4;
    const a = base.data[o + 3];
    base.data[o] = r * a;
    base.data[o + 1] = g * a;
    base.data[o + 2] = b * a;
  }
  over(base, rotateLayer(spec_hl, RIM_ANGLE_DEG));
  over(base, symbol);
  return rasterise(base, SPRITE_SIZE);
}

/** Soft contact shadow, taken from the game's own atom shadow texture. */
async function buildShadow(size = SPRITE_SIZE): Promise<HTMLCanvasElement> {
  const layer = await loadLayer(SHARED.shadow);
  return rasterise(layer, size);
}

function buildGlow(size = SPRITE_SIZE): HTMLCanvasElement {
  const c = newCanvas(size);
  const ctx = c.getContext('2d')!;
  const mid = size / 2;
  const g = ctx.createRadialGradient(mid, mid, 0, mid, mid, size * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,238,190,0.45)');
  g.addColorStop(1, 'rgba(255,214,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

let cache: SpriteSet | null = null;
let legendCache: SpriteSet | null = null;

/** Builds every marble from the game's textures. */
export async function buildSpriteSheet(): Promise<SpriteSet> {
  if (cache) return cache;
  const marbles = new Map<number, HTMLCanvasElement>();
  const locked = new Map<number, HTMLCanvasElement>();
  const built = await Promise.all(TILE_ORDER.map((id) => buildMarble(id)));
  TILE_ORDER.forEach((id, i) => {
    marbles.set(id, built[i]);
    locked.set(id, buildLocked(built[i]));
  });
  cache = { marbles, locked, shadow: await buildShadow(), glow: buildGlow() };
  return cache;
}

/** Smaller sprites for the legend chips. */
export async function buildLegendSprites(size = 34): Promise<SpriteSet> {
  if (legendCache) return legendCache;
  const full = await buildSpriteSheet();
  const marbles = new Map<number, HTMLCanvasElement>();
  const locked = new Map<number, HTMLCanvasElement>();
  for (const [id, sprite] of full.marbles) {
    const c = newCanvas(size);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite, 0, 0, size, size);
    marbles.set(id, c);
    locked.set(id, buildLocked(sprite, size));
  }
  legendCache = { marbles, locked, shadow: full.shadow, glow: full.glow };
  return legendCache;
}

export { LIGHT_DIR, RIM_ANGLE_DEG };
