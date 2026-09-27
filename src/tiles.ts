/**
 * Tile catalogue for Sigmar's Garden.
 *
 * Every marble in the game is one of 15 kinds. `Empty` is not a marble
 * but is included so a board can be stored as a flat array of tile ids.
 *
 * The visual description of each kind was derived from the game's own
 * help diagrams (`Content/textures/solitaire/help/matching_rules/*.png`),
 * which show the canonical orb colours and alchemical glyphs.
 */

export const enum Tile {
  Empty = 0,
  Salt = 1,
  Air = 2,
  Fire = 3,
  Water = 4,
  Earth = 5,
  Quicksilver = 6,
  Lead = 7,
  Tin = 8,
  Iron = 9,
  Copper = 10,
  Silver = 11,
  Gold = 12,
  Vitae = 13,
  Mors = 14,
}

export const TILE_COUNT = 15;

/** Material family, which drives how an orb is shaded. */
export type Material = 'glass' | 'metal' | 'volatile' | 'organic';

export interface TileStyle {
  /** Deepest shadow colour at the orb's lower-right edge. */
  shadow: string;
  /** Mid-tone body colour. */
  body: string;
  /** Brightest diffused colour, usually the upper-left fill. */
  light: string;
  /** Colour of the glowing glyph. */
  glyph: string;
  /** Soft halo colour bled around the glyph. */
  glow: string;
  material: Material;
}

export interface TileInfo {
  id: Tile;
  /** Stable identifier used in save data and DOM ids. */
  key: string;
  /** English display name, matching the game's own terminology. */
  name: string;
  style: TileStyle;
}

/**
 * Canonical colours. `body`/`light` values are sampled from the help
 * diagrams; shadow and glow are completed to give a smooth glass ramp.
 */
export const TILES: Record<Exclude<Tile, Tile.Empty>, TileInfo> = {
  [Tile.Salt]: {
    id: Tile.Salt,
    key: 'salt',
    name: 'Salt',
    style: {
      shadow: '#4a4231',
      body: '#7d7359',
      light: '#b3ab8e',
      glyph: '#fff6dd',
      glow: '#ffe9a8',
      material: 'glass',
    },
  },
  [Tile.Air]: {
    id: Tile.Air,
    key: 'air',
    name: 'Air',
    style: {
      shadow: '#1d2530',
      body: '#4a5a78',
      light: '#a9c6e4',
      glyph: '#f2fbff',
      glow: '#bcdcff',
      material: 'glass',
    },
  },
  [Tile.Fire]: {
    id: Tile.Fire,
    key: 'fire',
    name: 'Fire',
    style: {
      shadow: '#3a0d06',
      body: '#8f2a12',
      light: '#e8701f',
      glyph: '#fff0cf',
      glow: '#ffab4d',
      material: 'glass',
    },
  },
  [Tile.Water]: {
    id: Tile.Water,
    key: 'water',
    name: 'Water',
    style: {
      shadow: '#0b2a2c',
      body: '#1c5e5c',
      light: '#4fc7b4',
      glyph: '#ecfff8',
      glow: '#7dffe0',
      material: 'glass',
    },
  },
  [Tile.Earth]: {
    id: Tile.Earth,
    key: 'earth',
    name: 'Earth',
    style: {
      shadow: '#12220a',
      body: '#33591a',
      light: '#7cc22f',
      glyph: '#f4ffe2',
      glow: '#b6ff6e',
      material: 'glass',
    },
  },
  [Tile.Quicksilver]: {
    id: Tile.Quicksilver,
    key: 'quicksilver',
    name: 'Quicksilver',
    style: {
      shadow: '#3b382c',
      body: '#7c7659',
      light: '#d8d0ad',
      glyph: '#fffdf2',
      glow: '#f0e6bd',
      material: 'metal',
    },
  },
  [Tile.Lead]: {
    id: Tile.Lead,
    key: 'lead',
    name: 'Lead',
    style: {
      shadow: '#141c21',
      body: '#3b4a52',
      light: '#8ea3ad',
      glyph: '#eef6fa',
      glow: '#b9d2dd',
      material: 'metal',
    },
  },
  [Tile.Tin]: {
    id: Tile.Tin,
    key: 'tin',
    name: 'Tin',
    style: {
      shadow: '#22261a',
      body: '#585c3c',
      light: '#a8ad84',
      glyph: '#f8fbe6',
      glow: '#d9e0ae',
      material: 'metal',
    },
  },
  [Tile.Iron]: {
    id: Tile.Iron,
    key: 'iron',
    name: 'Iron',
    style: {
      shadow: '#1d1216',
      body: '#4d3236',
      light: '#a97f7c',
      glyph: '#ffeef0',
      glow: '#e2b3ab',
      material: 'metal',
    },
  },
  [Tile.Copper]: {
    id: Tile.Copper,
    key: 'copper',
    name: 'Copper',
    style: {
      shadow: '#3c1608',
      body: '#93482a',
      light: '#e0965f',
      glyph: '#fff3e4',
      glow: '#ffc08a',
      material: 'metal',
    },
  },
  [Tile.Silver]: {
    id: Tile.Silver,
    key: 'silver',
    name: 'Silver',
    style: {
      shadow: '#232a2b',
      body: '#5c6c6d',
      light: '#c3d3d2',
      glyph: '#ffffff',
      glow: '#e6f6f6',
      material: 'metal',
    },
  },
  [Tile.Gold]: {
    id: Tile.Gold,
    key: 'gold',
    name: 'Gold',
    style: {
      shadow: '#4a2c02',
      body: '#b5760d',
      light: '#f6c73f',
      glyph: '#fff8dc',
      glow: '#ffd766',
      material: 'metal',
    },
  },
  [Tile.Vitae]: {
    id: Tile.Vitae,
    key: 'vitae',
    name: 'Vitae',
    style: {
      shadow: '#3d2a20',
      body: '#8a5f42',
      light: '#c9976d',
      glyph: '#ffe9d0',
      glow: '#ffc38a',
      material: 'organic',
    },
  },
  [Tile.Mors]: {
    id: Tile.Mors,
    key: 'mors',
    name: 'Mors',
    style: {
      shadow: '#0d0f0c',
      body: '#2a2f26',
      light: '#5d6a52',
      glyph: '#f2e2a6',
      glow: '#c8b061',
      material: 'organic',
    },
  },
};

/** Iteration order used by the UI's legend, matching the in-game hint bar. */
export const TILE_ORDER: Exclude<Tile, Tile.Empty>[] = [
  Tile.Salt,
  Tile.Air,
  Tile.Fire,
  Tile.Water,
  Tile.Earth,
  Tile.Quicksilver,
  Tile.Lead,
  Tile.Tin,
  Tile.Iron,
  Tile.Copper,
  Tile.Silver,
  Tile.Gold,
  Tile.Vitae,
  Tile.Mors,
];

export function tileInfo(id: number): TileInfo | null {
  return (TILES as Record<number, TileInfo>)[id] ?? null;
}

/** The six metals, ordered by metallicity (lead = 1 … mercury = 7). */
export const METAL_SEQUENCE: Tile[] = [
  Tile.Lead,
  Tile.Tin,
  Tile.Iron,
  Tile.Copper,
  Tile.Silver,
  Tile.Gold,
];

/** Highest metallicity in the standard game (gold). */
export const GOLD = Tile.Gold;

export function isMetal(id: Tile): boolean {
  return id >= Tile.Lead && id <= Tile.Gold;
}

/** Metallicity: lead = 1, tin = 2 … gold = 6. Zero for non-metals. */
export function metallicity(id: Tile): number {
  return isMetal(id) ? id - Tile.Lead + 1 : 0;
}

/**
 * The four cardinal elements plus salt, which is the only group that
 * uses the "match same-with-same" rule.
 */
export function isCardinal(id: Tile): boolean {
  return id >= Tile.Air && id <= Tile.Earth;
}

export function isElemental(id: Tile): boolean {
  return id === Tile.Salt || isCardinal(id);
}
