/**
 * Sound and music, using the original audio from the game's install.
 *
 * Browsers only allow playback after a user gesture, so everything is
 * created lazily and `unlock()` is called from the first click.
 */

export interface AudioOptions {
  muted: boolean;
  volume: number;
  music: boolean;
}

const SFX = {
  select: 'assets/audio/solitaire_select.ogg',
  match: 'assets/audio/solitaire_match.ogg',
  start: 'assets/audio/solitaire_start.ogg',
  end: 'assets/audio/solitaire_end.ogg',
  button: 'assets/audio/click_button.ogg',
  modal: 'assets/audio/ui_modal.ogg',
} as const;

type SfxName = keyof typeof SFX;

/**
 * Per-effect gain, applied on top of the master volume.
 *
 * These are deliberately up near 1: the music bed is a near-full-scale
 * recording, so effects mixed any lower simply disappear under it. The pick-up
 * and button clicks were previously at 0.4 and 1.0 against a 0.6 master, i.e.
 * roughly a quarter of full scale, and were effectively inaudible.
 */
const GAIN: Record<SfxName, number> = {
  select: 0.75,
  match: 0.9,
  start: 0.85,
  end: 0.95,
  button: 0.7,
  modal: 0.8,
};

/** The music sits under the effects rather than competing with them. */
const MUSIC_GAIN = 0.22;

export class AudioEngine {
  private buffers = new Map<SfxName, HTMLAudioElement>();
  private pool = new Map<SfxName, HTMLAudioElement[]>();
  private music: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;

  options: AudioOptions = { muted: false, volume: 0.85, music: true };

  /** Preloads the effects. Safe to call before any gesture. */
  preload(): void {
    for (const [name, src] of Object.entries(SFX) as [SfxName, string][]) {
      const a = new Audio(src);
      a.preload = 'auto';
      this.buffers.set(name, a);
      // Two extra voices so rapid clicks do not cut each other off.
      this.pool.set(name, [a, new Audio(src), new Audio(src)]);
      for (const v of this.pool.get(name)!) v.preload = 'auto';
    }
    this.music = new Audio('assets/audio/solitaire.ogg');
    this.music.loop = true;
    this.music.volume = MUSIC_GAIN * this.options.volume;
  }

  /** True when the music should be audible right now. */
  private get musicWanted(): boolean {
    return this.options.music && !this.options.muted;
  }

  /** Called on the first user gesture to satisfy autoplay policies. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    }
    void this.ctx?.resume();
    // Start the music only if it is actually wanted and not already running.
    // Two bugs lived here: this ignored `muted` entirely, so turning sound off
    // still started the music on the next click, and it re-issued play() on
    // every click, restarting the track.
    if (this.musicWanted && this.music && this.music.paused) {
      void this.music.play().catch(() => undefined);
    }
  }

  play(name: SfxName, gain = 1): void {
    if (this.options.muted) return;
    const voices = this.pool.get(name);
    if (!voices || voices.length === 0) return;
    const voice = voices.find((v) => v.paused || v.ended) ?? voices[0];
    try {
      voice.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
    voice.volume = Math.max(0, Math.min(1, this.options.volume * GAIN[name] * gain));
    const started = voice.play();
    if (started) {
      started.catch((err: unknown) => {
        // Surfacing this matters: a rejected play() is silent otherwise, and
        // "no sound at all" is impossible to diagnose from the outside.
        this.lastError = `${name}: ${(err as Error)?.name ?? 'error'}`;
        console.warn('[audio] playback refused for', name, err);
      });
    }
  }

  /** Last playback refusal, for the diagnostics readout. */
  lastError: string | null = null;

  setOptions(opts: Partial<AudioOptions>): void {
    this.options = { ...this.options, ...opts };
    if (this.music) {
      this.music.volume = MUSIC_GAIN * this.options.volume;
      if (this.musicWanted) {
        if (this.music.paused) void this.music.play().catch(() => undefined);
      } else {
        this.music.pause();
      }
    }
  }

  /**
   * A snapshot of everything that can silence the game, for the diagnostics
   * line in the UI.
   */
  diagnose(): string {
    const el = this.music;
    return [
      `muted=${this.options.muted}`,
      `music=${this.options.music}`,
      `volume=${this.options.volume}`,
      `ctx=${this.ctx ? this.ctx.state : 'none'}`,
      `track=${el ? (el.paused ? 'paused' : 'playing') : 'none'}`,
      this.lastError ? `lastError=${this.lastError}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
}

export const audio = new AudioEngine();
