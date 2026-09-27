/**
 * The application shell: canvas board, legend, toolbar, help and options.
 *
 * Everything is built in code so `index.html` stays a thin host page.
 */

import {
  BOARD_SIZE,
  VALID_CELLS,
  cellCentrePx,
} from '../grid.js';
import { TILE_ORDER, Tile, tileInfo } from '../tiles.js';
import { Session, type AppliedMove } from './session.js';
import { audio } from './audio.js';

export { audio };
import {
  BOARD_IMAGE_HEIGHT,
  BOARD_IMAGE_WIDTH,
  BoardRenderer,
  MARBLE_DIAMETER,
  type Pulse,
  type RenderState,
} from '../render/board.js';
import { buildLegendSprites } from '../render/sprites.js';
import { DIFFICULTIES, VARIANTS, canPair, type Variant } from '../game.js';
import type { Difficulty } from '../solver.js';

const PULSE_LIFE = 620;
const SPAWN_MS = 260;
const CLEAR_MS = 320;

interface UiElements {
  canvas: HTMLCanvasElement;
  legend: HTMLElement;
  statusBar: HTMLElement;
  message: HTMLElement;
  overlay: HTMLElement;
  overlayBody: HTMLElement;
  winsLabel: HTMLElement;
  hintButton: HTMLButtonElement;
  undoButton: HTMLButtonElement;
  solveButton: HTMLButtonElement;
  newButton: HTMLButtonElement;
  variantSelect: HTMLSelectElement;
  difficultySelect: HTMLSelectElement;
  muteButton: HTMLButtonElement;
  musicButton: HTMLButtonElement;
  helpButton: HTMLButtonElement;
  legendChips: Map<number, { root: HTMLElement; count: HTMLElement; chip: HTMLElement }>;
}

export class App {
  private session = new Session();
  private renderer!: BoardRenderer;
  private els!: UiElements;

  /**
   * The legend's current highlight state, plus the marble tallies.
   *
   * Exposed for the `test:metals` suite, which compares it against an
   * independent recomputation of the placement and transmutation rules — so a
   * mistake in the method that drives the legend cannot hide behind itself.
   */
  legendState(): { lit: number[]; tallies: Record<number, number> } {
    const lit: number[] = [];
    for (const [id, parts] of this.els.legendChips) {
      if (parts.root.classList.contains('is-playable')) lit.push(id);
    }
    return { lit: lit.sort((a, b) => a - b), tallies: this.session.tally() };
  }

  /**
   * What the board is currently highlighting, and the state of the solution
   * player. Exposed for the `test:hint-solution` suite so the hint's highlight
   * and the auto-player can be observed rather than inferred.
   */
  debugState(): {
    hinted: number[];
    legendHighlight: number[];
    solutionQueued: number;
    showSolution: boolean;
    solutionSteps: number;
  } {
    return {
      hinted: [...this.hinted].sort((a, b) => a - b),
      legendHighlight: [...this.tileHighlight].sort((a, b) => a - b),
      solutionQueued: this.solutionMoves.length,
      showSolution: this.showSolution,
      solutionSteps: this.solutionSteps,
    };
  }

  private pulses: Pulse[] = [];
  private clearing = new Map<number, number>();
  private spawning = new Map<number, number>();
  private hoverCell: number | null = null;
  private lastFrame = performance.now();
  private dpr = 1;

  /**
   * When true, deal/clear animations are skipped. Honours the platform
   * reduced-motion preference, and can be forced with `?motion=off` for
   * deterministic screenshots and tests.
   */
  private reduceMotion =
    (typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches) ||
    new URLSearchParams(location.search).get('motion') === 'off';

  private wins = 0;
  private showSolution = false;
  private solutionMoves: { a: number; b: number }[] = [];
  private solutionTimer: number | null = null;
  private solutionSteps = 0;

  /**
   * Plays each effect in turn. Exposed as `sgAudioTest()` so "I hear nothing"
   * can be narrowed down from the console without guessing.
   */
  audioTest: () => string = () => 'audio not ready';

  private assets: {
    board: HTMLImageElement;
    hexHovered: HTMLImageElement;
    atomHovered: HTMLImageElement;
    atomSpawned: HTMLImageElement;
    pulseHighlight: HTMLImageElement;
    pulseShadow: HTMLImageElement[];
  };

  constructor() {
    this.assets = {
      board: loadImage('assets/textures/board.png'),
      hexHovered: loadImage('assets/textures/hex_hovered.png'),
      atomHovered: loadImage('assets/textures/atom_hovered.png'),
      atomSpawned: loadImage('assets/textures/atom_spawned.png'),
      pulseHighlight: loadImage('assets/textures/pulse_highlight.png'),
      pulseShadow: [0, 1, 2, 3].map((i) => loadImage(`assets/textures/pulse_shadow_${i}.png`)),
    };
    this.wins = Number(localStorage.getItem('sg.wins') ?? 0) || 0;
  }

  async start(): Promise<void> {
    // Marbles are composited from the game's texture layers, so the
    // renderer is only ready once those have loaded.
    this.renderer = await BoardRenderer.create(this.assets);
    this.els = this.buildUi();
    this.bindSession();
    this.bindInput();
    this.bindWindow();

    audio.preload();
    audio.setOptions({
      muted: localStorage.getItem('sg.muted') === '1',
      // 0.85 matches the engine's own default; keep the two in step.
      volume: Number(localStorage.getItem('sg.volume') ?? 0.85),
      music: localStorage.getItem('sg.music') !== '0',
    });

    await Promise.all(Object.values(this.assets).flat().map(waitForImage));

    // Deterministic deals for testing: `?seed=1234`. `?difficulty=hard` picks
    // the faithful support shape, `?help` opens the rules panel and
    // `?solution` starts auto-solving.
    const params = new URLSearchParams(location.search);
    const difficultyParam = params.get('difficulty');
    if (difficultyParam === 'easy' || difficultyParam === 'hard') {
      this.els.difficultySelect.value = difficultyParam;
    }
    const seedParam = params.get('seed');
    this.newGame(seedParam !== null ? Number(seedParam) >>> 0 : undefined);

    if (params.has('help')) this.showHelp();
    if (params.has('solution')) this.startSolution();

    requestAnimationFrame(this.frame);
  }

  /* ---------------------------------------------------------------- *
   * Session wiring
   * ---------------------------------------------------------------- */

  private bindSession(): void {
    this.session.on('change', () => this.syncUi());
    this.session.on('move', (m) => this.onMove(m));
    // Pick-up sound belongs to a *successful* selection. It used to hang off
    // `reject`, which meant a normal tap was silent and only mis-clicks were
    // audible.
    this.session.on('select', () => audio.play('select'));
    this.session.on('reject', (cell) => {
      this.shake(cell);
    });
    this.session.on('win', (stats) => this.onWin(stats));
    this.session.on('deadEnd', () => this.onDeadEnd());
  }

  private newGame(seed?: number): void {
    const variant = this.els.variantSelect.value as Variant;
    const difficulty = this.els.difficultySelect.value as Difficulty;
    if (this.session.variant !== variant) this.session.variant = variant;
    this.pulses = [];
    this.clearing.clear();
    this.spawning.clear();
    this.hoverCell = null;
    this.stopSolution();
    this.session.newGame(seed, variant, difficulty);

    // Stagger the deal animation outward from the centre.
    if (this.reduceMotion) {
      this.spawning.clear();
    } else {
      const centre = cellCentrePx(5, 5);
      const cells = VALID_CELLS.slice().sort((a, b) => {
        const ca = cellCentrePx(a % BOARD_SIZE, Math.floor(a / BOARD_SIZE));
        const cb = cellCentrePx(b % BOARD_SIZE, Math.floor(b / BOARD_SIZE));
        const da = Math.hypot(ca.x - centre.x, ca.y - centre.y);
        const db = Math.hypot(cb.x - centre.x, cb.y - centre.y);
        return da - db;
      });
      cells.forEach((cell, i) => {
        if (this.session.board[cell] === Tile.Empty) return;
        this.spawning.set(cell, -i * 9);
      });
    }
    audio.play('start');
    this.hideOverlay();
    this.syncUi();
  }

  private onMove(m: AppliedMove): void {
    audio.play('match');
    const cells = m.b === m.a ? [m.a] : [m.a, m.b];
    for (const c of cells) this.clearing.set(c, 0);
    this.pulses.push({
      cell: m.a,
      age: 0,
      life: PULSE_LIFE,
      frame: 0,
    });
    if (m.b !== m.a) {
      this.pulses.push({ cell: m.b, age: 0, life: PULSE_LIFE, frame: 0 });
      // Show the shadow frame on the second cell too.
      this.pulses[this.pulses.length - 1].frame = 1;
    }
  }

  private onWin(stats: { moves: number; elapsed: number }): void {
    this.wins += 1;
    localStorage.setItem('sg.wins', String(this.wins));
    audio.play('end');
    this.els.winsLabel.textContent = String(this.wins);
    const secs = (stats.elapsed / 1000).toFixed(1);
    this.showOverlay(
      'The garden is clear',
      `<p>You cleared the board in <strong>${stats.moves}</strong> moves and <strong>${secs}s</strong>.</p>
       <p class="muted">Games won: ${this.wins}</p>`,
      [{ label: 'New game', primary: true, action: () => this.newGame() }],
    );
  }

  private onDeadEnd(): void {
    audio.play('modal');
    this.showOverlay(
      'No moves left',
      `<p>No legal move remains, but <strong>${this.session.marbleCount}</strong> marbles are still on the board.</p>
       <p class="muted">You can undo your last move and try a different order.</p>`,
      [
        { label: 'Undo last move', primary: true, action: () => this.session.undo() },
        { label: 'New game', action: () => this.newGame() },
      ],
    );
  }

  /* ---------------------------------------------------------------- *
   * UI construction and sync
   * ---------------------------------------------------------------- */

  private buildUi(): UiElements {
    const root = document.getElementById('app')!;
    root.innerHTML = '';

    const header = el('header', 'sg-header');
    const title = el('div', 'sg-title');
    title.innerHTML = `<span class="sg-title-main">Sigmar&rsquo;s Garden</span>
      <span class="sg-title-sub">a replica of the Opus Magnum solitaire</span>`;
    header.appendChild(title);

    const stats = el('div', 'sg-stats');
    stats.innerHTML = `
      <div class="sg-stat"><span class="sg-stat-label">Games won</span><span id="sg-wins" class="sg-stat-value">0</span></div>
      <div class="sg-stat"><span class="sg-stat-label">Marbles left</span><span id="sg-left" class="sg-stat-value">0</span></div>
      <div class="sg-stat"><span class="sg-stat-label">Moves</span><span id="sg-moves" class="sg-stat-value">0</span></div>`;
    header.appendChild(stats);
    root.appendChild(header);

    const main = el('main', 'sg-main');

    const boardWrap = el('div', 'sg-board-wrap');
    const canvas = document.createElement('canvas');
    canvas.className = 'sg-canvas';
    canvas.setAttribute('aria-label', "Sigmar's Garden board");
    boardWrap.appendChild(canvas);
    const message = el('div', 'sg-message');
    message.hidden = true;
    boardWrap.appendChild(message);
    main.appendChild(boardWrap);

    const side = el('aside', 'sg-side');
    const legendTitle = el('h2', 'sg-panel-title');
    legendTitle.textContent = 'Marbles';
    side.appendChild(legendTitle);

    const legend = el('div', 'sg-legend');
    side.appendChild(legend);

    /**
     * Live state panel. This fills the lower half of the sidebar, which
     * otherwise sat empty beside the board: what is takeable now, what the next
     * metal is, and how far along the game is.
     */
    const statePanel = el('section', 'sg-state');
    statePanel.innerHTML = `
      <h2 class="sg-panel-title">Next move</h2>
      <div class="sg-state-next" id="sg-next"></div>
      <dl class="sg-state-grid">
        <div><dt>Playable</dt><dd id="sg-playable">0</dd></div>
        <div><dt>Marbles</dt><dd id="sg-remaining">0</dd></div>
        <div><dt>Moves</dt><dd id="sg-movecount">0</dd></div>
        <div><dt>Time</dt><dd id="sg-time">0:00</dd></div>
      </dl>
      <div class="sg-state-progress"><span id="sg-progress"></span></div>
      <p class="sg-hint-note">Click a marble kind above to reveal every one of
      that kind on the board in blue.</p>`;
    side.appendChild(statePanel);

    main.appendChild(side);
    root.appendChild(main);

    const toolbar = el('div', 'sg-toolbar');
    const newButton = button('New game', 'primary');
    const undoButton = button('Undo');
    const hintButton = button('Hint');
    const solveButton = button('Show solution');
    toolbar.append(newButton, undoButton, hintButton, solveButton);

    const spacer = el('div', 'sg-spacer');
    toolbar.appendChild(spacer);

    const variantLabel = el('label', 'sg-field');
    variantLabel.textContent = 'Rules';
    const variantSelect = document.createElement('select');
    variantSelect.className = 'sg-select';
    for (const [key, v] of Object.entries(VARIANTS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = v.name;
      variantSelect.appendChild(opt);
    }
    variantLabel.appendChild(variantSelect);
    toolbar.appendChild(variantLabel);

    /**
     * How the board is dealt. `easy` spreads the orbits out, so many marbles are
     * playable from the start; `hard` grows them as one connected blob the way
     * the game's own layouts are shaped, which closes the board up.
     */
    const difficultyLabel = el('label', 'sg-field');
    difficultyLabel.textContent = 'Difficulty';
    const difficultySelect = document.createElement('select');
    difficultySelect.className = 'sg-select';
    for (const [key, d] of Object.entries(DIFFICULTIES)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = d.name;
      opt.title = d.blurb;
      difficultySelect.appendChild(opt);
    }
    difficultySelect.value = 'easy';
    difficultyLabel.appendChild(difficultySelect);
    toolbar.appendChild(difficultyLabel);
    difficultySelect.addEventListener('change', () => this.newGame());

    const muteButton = button('Sound: on');
    const musicButton = button('Music: on');
    const helpButton = button('How to play');
    toolbar.append(muteButton, musicButton, helpButton);
    root.appendChild(toolbar);

    const statusBar = el('div', 'sg-status');
    root.appendChild(statusBar);

    const overlay = el('div', 'sg-overlay');
    overlay.hidden = true;
    const overlayBody = el('div', 'sg-overlay-body');
    overlay.appendChild(overlayBody);
    root.appendChild(overlay);

    // Legend chips. The marble images are composited asynchronously, so
    // the frames go up first and the art is slotted in when it is ready.
    const legendChips = new Map<number, { root: HTMLElement; count: HTMLElement; chip: HTMLElement }>();
    for (const id of TILE_ORDER) {
      const info = tileInfo(id);
      if (!info) continue;
      const row = el('button', 'sg-legend-row') as HTMLButtonElement;
      row.type = 'button';
      row.title = `${info.name} — click to highlight on the board`;

      const chip = el('span', 'sg-legend-chip');
      const label = el('span', 'sg-legend-label');
      label.textContent = info.name;
      const count = el('span', 'sg-legend-count');
      count.textContent = '0';

      row.append(chip, label, count);
      row.addEventListener('click', () => this.highlightTile(id));
      legend.appendChild(row);
      legendChips.set(id, { root: row, count, chip });
    }

    void buildLegendSprites().then((sprites) => {
      for (const [id, parts] of legendChips) {
        const sprite = sprites.marbles.get(id);
        if (!sprite) continue;
        const img = new Image();
        img.src = sprite.toDataURL();
        img.alt = tileInfo(id)?.name ?? '';
        parts.chip.replaceChildren(img);
      }
    });

    const winsLabel = stats.querySelector('#sg-wins') as HTMLElement;
    winsLabel.textContent = String(this.wins);

    newButton.addEventListener('click', () => {
      audio.unlock();
      audio.play('button');
      this.newGame();
    });
    undoButton.addEventListener('click', () => {
      audio.play('button');
      this.session.undo();
    });
    hintButton.addEventListener('click', () => {
      audio.play('button');
      const move = this.session.hint();
      if (!move) {
        this.flashMessage('No moves available');
        return;
      }
      // The renderer draws its highlight from the UI's own set, not the
      // session's, so the hint has to be copied across. Leaving it only on the
      // session meant the button marked nothing and looked dead.
      this.hinted = new Set([move.a, move.b]);
      this.pulses.push({ cell: move.a, age: 0, life: PULSE_LIFE, frame: 2 });
      if (move.b !== move.a) {
        this.pulses.push({ cell: move.b, age: 0, life: PULSE_LIFE, frame: 2 });
      }
      this.syncUi();
    });
    solveButton.addEventListener('click', () => {
      audio.play('button');
      if (this.showSolution) this.stopSolution();
      else this.startSolution();
    });
    variantSelect.addEventListener('change', () => this.newGame());
    helpButton.addEventListener('click', () => {
      audio.play('button');
      this.showHelp();
    });

    const updateMute = () => {
      const muted = audio.options.muted;
      muteButton.textContent = muted ? 'Sound: off' : 'Sound: on';
      muteButton.classList.toggle('is-off', muted);
      // The music is audible only when both switches allow it, so the music
      // button reflects that rather than just its own stored flag.
      const musicOn = audio.options.music && !muted;
      musicButton.textContent = musicOn ? 'Music: on' : 'Music: off';
      musicButton.classList.toggle('is-off', !musicOn);
    };
    muteButton.addEventListener('click', () => {
      audio.unlock();
      const muted = !audio.options.muted;
      audio.setOptions({ muted });
      localStorage.setItem('sg.muted', muted ? '1' : '0');
      updateMute();
    });
    // A separate music switch. Previously the stored `sg.music` flag had no
    // control at all, and `unlock()` started the music on every click
    // regardless of it.
    musicButton.addEventListener('click', () => {
      audio.unlock();
      const music = !audio.options.music;
      audio.setOptions({ music });
      localStorage.setItem('sg.music', music ? '1' : '0');
      updateMute();
    });
    updateMute();

    // Double-clicking the sound button reports what is silencing the game.
    muteButton.addEventListener('dblclick', () => {
      const text = audio.diagnose();
      console.log('[audio]', text);
      this.flashMessage(text);
    });

    /**
     * Plays every effect in turn so it is obvious from the outside whether the
     * sounds are audible and whether the music is drowning them out.
     * Reachable from the console as `sgAudioTest()`.
     */
    this.audioTest = (): string => {
      audio.unlock();
      const names = ['select', 'match', 'button', 'modal', 'start', 'end'] as const;
      names.forEach((name, i) => {
        window.setTimeout(() => console.log(`[audio] ${name}  (${audio.diagnose()})`), i * 700);
        window.setTimeout(() => audio.play(name), i * 700);
      });
      const report = `playing ${names.join(', ')} — ${audio.diagnose()}`;
      console.log('[audio]', report);
      return report;
    };

    return {
      canvas,
      legend,
      statusBar,
      message,
      overlay,
      overlayBody,
      winsLabel,
      hintButton,
      undoButton,
      solveButton,
      newButton,
      variantSelect,
      difficultySelect,
      muteButton,
      musicButton,
      helpButton,
      legendChips,
    };
  }

  private syncUi(): void {
    const board = this.session.board;
    // "Playable now" must mean the same thing the board means by it: pickable
    // this instant, transmutation order included.
    const playable = this.session.selectableCells();
    // Kinds that are loose *and* have a legal partner. Lighting a marble up just
    // because it is loose is wrong for metals: tin cannot be taken while lead
    // remains, however loose it is.
    const playableKinds = this.session.playableKinds();
    const tally = this.session.tally();

    for (const [id, chip] of this.els.legendChips) {
      const n = tally[id] ?? 0;
      chip.count.textContent = String(n);
      chip.root.classList.toggle('is-empty', n === 0);
      chip.root.classList.toggle('is-playable', playableKinds.has(id));
    }

    (document.getElementById('sg-left') as HTMLElement).textContent = String(
      this.session.marbleCount,
    );
    (document.getElementById('sg-moves') as HTMLElement).textContent = String(
      this.session.moveCount,
    );

    this.els.undoButton.disabled = this.session.history.length === 0;
    this.els.solveButton.textContent = this.showSolution ? 'Stop solution' : 'Show solution';

    const lowest = this.session.lowestMetal();
    const bits: string[] = [];
    bits.push(`<span>Variant: <strong>${VARIANTS[this.session.variant].name}</strong></span>`);
    bits.push(`<span>Seed: <strong>${this.session.seed}</strong></span>`);
    if (this.session.variant === 'quicksilver') {
      const info = lowest === Tile.Empty ? null : tileInfo(lowest);
      bits.push(
        info
          ? `<span>Next metal: <strong>${info.name}</strong> — pair it with quicksilver</span>`
          : '<span>All metals transmuted</span>',
      );
    } else {
      bits.push('<span>Metals pair with a matching metal</span>');
    }
    bits.push(`<span>Playable now: <strong>${playable.size}</strong></span>`);
    this.els.statusBar.innerHTML = bits.join('<span class="sg-dot">&middot;</span>');

    this.syncStatePanel(lowest, playable.size);
  }

  /**
   * Fills the sidebar's live state panel.
   *
   * The "next move" line is the one piece of rules state a player actually needs
   * in front of them: under the quicksilver rules the next metal is the only one
   * that can be transmuted, and the board's highlight already enforces it, so
   * naming it here explains why the other metals are dark.
   */
  private syncStatePanel(lowest: number, playableCount: number): void {
    const next = document.getElementById('sg-next');
    if (next) {
      if (this.session.variant === 'colvan') {
        next.innerHTML = 'Metals pair with a <strong>matching metal</strong>.';
      } else if (lowest === Tile.Empty) {
        next.innerHTML =
          'All metals transmuted &mdash; <strong>gold</strong> is last.';
      } else {
        const info = tileInfo(lowest as Tile);
        next.innerHTML = info
          ? `Transmute <strong>${info.name}</strong> with
             <strong>quicksilver</strong>.`
          : '';
      }
    }
    const put = (id: string, value: string) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    };
    put('sg-playable', String(playableCount));
    put('sg-remaining', String(this.session.marbleCount));
    put('sg-movecount', String(this.session.moveCount));
    const secs = Math.floor(this.session.elapsed / 1000);
    put('sg-time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);

    // Progress through the 27 pairs plus gold.
    const done = 55 - this.session.marbleCount;
    const bar = document.getElementById('sg-progress');
    if (bar) bar.style.width = `${Math.min(100, (done / 55) * 100)}%`;
  }

  private highlightTile(id: number): void {
    audio.play('select');
    const cells = new Set<number>();
    for (const c of VALID_CELLS) if (this.session.board[c] === id) cells.add(c);
    this.tileHighlight = cells;
    this.hinted = new Set();
    for (const c of cells) this.pulses.push({ cell: c, age: 0, life: PULSE_LIFE, frame: 3 });
  }

  private hinted = new Set<number>();
  private tileHighlight = new Set<number>();

  private shake(cell: number): void {
    const c = this.renderer.cellToCss(cell);
    void c;
    this.els.canvas.classList.remove('sg-shake');
    void this.els.canvas.offsetWidth;
    this.els.canvas.classList.add('sg-shake');
  }

  /* ---------------------------------------------------------------- *
   * Marble calibration
   * ---------------------------------------------------------------- */

  /** Current global marble nudge, in board pixels. */
  getCalibration(): { x: number; y: number } {
    return { ...this.renderer.marbleOffset };
  }

  /**
   * Nudges every marble relative to the board, in board pixels. Applied to
   * drawing and hit-testing together.
   */
  setCalibration(x: number, y: number): void {
    this.renderer.marbleOffset = { x, y };
  }

  /* ---------------------------------------------------------------- *
   * Solution playback
   * ---------------------------------------------------------------- */
  private startSolution(): void {
    this.solutionMoves = this.session.solveNow();
    if (this.solutionMoves.length === 0) {
      this.flashMessage('No solution found from here');
      return;
    }
    this.showSolution = true;
    this.syncUi();
    this.stepSolution();
  }

  private stepSolution = (): void => {
    const next = this.solutionMoves.shift();
    if (!next) {
      this.stopSolution();
      return;
    }
    const a = next.a;
    const b = next.b;
    // Drive the session the way a player does: first click selects, second click
    // commits. The old code called `click(a)` twice, which is a click *on the
    // already-selected marble* — that deselects rather than moving, so the
    // auto-player consumed the whole queue without ever playing a move. Gold is
    // the exception: it clears on a single click.
    this.session.selected = null;
    if (a === b) {
      this.session.click(a);
    } else {
      this.session.click(a);
      this.session.click(b);
    }
    this.solutionSteps += 1;
    this.solutionTimer = window.setTimeout(this.stepSolution, 260);
  };

  private stopSolution(): void {
    if (this.solutionTimer !== null) {
      clearTimeout(this.solutionTimer);
      this.solutionTimer = null;
    }
    this.showSolution = false;
    this.solutionMoves = [];
    if (this.els?.solveButton) {
      this.els.solveButton.textContent = 'Show solution';
    }
  }

  /* ---------------------------------------------------------------- *
   * Overlays
   * ---------------------------------------------------------------- */

  private showOverlay(
    title: string,
    html: string,
    actions: { label: string; primary?: boolean; action: () => void }[],
  ): void {
    const body = this.els.overlayBody;
    body.innerHTML = `<h2>${title}</h2>${html}`;
    const row = el('div', 'sg-overlay-actions');
    for (const a of actions) {
      const b = button(a.label, a.primary ? 'primary' : undefined);
      b.addEventListener('click', () => {
        audio.play('button');
        this.hideOverlay();
        a.action();
      });
      row.appendChild(b);
    }
    body.appendChild(row);
    this.els.overlay.hidden = false;
    this.els.overlay.classList.add('is-visible');
  }

  private hideOverlay(): void {
    this.els.overlay.hidden = true;
    this.els.overlay.classList.remove('is-visible');
  }

  private showHelp(): void {
    this.showOverlay(
      'How to play',
      `
      <p><strong>Goal.</strong> Clear every marble from the board. Marbles are removed two at a
      time; gold is the single exception and may be taken on its own.</p>

      <p><strong>Which marbles can you take?</strong> A marble comes loose only when at least
      <strong>three of the six spaces around it are empty</strong>, and those three must be
      <em>contiguous</em>. Spaces beyond the edge of the board count as empty, so the rim opens up first.</p>

      <div class="sg-help-pair">
        <figure>
          <img src="assets/help/cardinals.png" alt="The four cardinal elements match with their own kind">
          <figcaption>The four cardinal elements match with their own kind.</figcaption>
        </figure>
        <figure>
          <img src="assets/help/salt.png" alt="Salt matches with any cardinal element or with itself">
          <figcaption>Salt matches with any cardinal element, or with another salt.</figcaption>
        </figure>
      </div>

      <div class="sg-help-pair">
        <figure>
          <img src="assets/help/purification.png" alt="Each metal paired with quicksilver, in order from lead to gold">
          <figcaption>Metals pair with <strong>quicksilver</strong>, but only in
          transmutation order. Each formula gives the metal that is next in line: lead, tin,
          iron, copper, then silver &mdash; and gold last, taken on its own.</figcaption>
        </figure>
        <figure>
          <img src="assets/help/animismus.png" alt="Vitae and Mors pair with each other">
          <figcaption>Vitae and Mors pair with each other.</figcaption>
        </figure>
      </div>

      <p class="muted">The <em>House Colvan</em> variant changes the metal rule: metals pair with
      another marble of the same metal instead of with quicksilver.</p>

      <p><strong>Tips.</strong> Click a marble to select it, then click its partner. Every legal
      partner is outlined once something is selected. Use <em>Hint</em> when stuck, or the legend
      on the right to highlight every marble of a kind.</p>

      <details class="sg-details">
        <summary>About this replica</summary>
        <p>The board, tiles, sound and music come from the original game. The marble sprites are
        redrawn procedurally, because the game renders its marbles with a shader rather than from
        bitmaps — their colours and alchemical symbols were sampled from the game's own help
        diagrams.</p>
        <p>Every deal is generated and verified by the built-in solver, so it can always be
        cleared. The board is a 93-cell hexagon holding 55 marbles; the placement rule below the
        board shows how many are loose at any moment.</p>
      </details>`,
      [{ label: 'Back', primary: true, action: () => undefined }],
    );
  }

  private flashMessage(text: string): void {
    this.els.message.textContent = text;
    this.els.message.hidden = false;
    this.els.message.classList.add('is-visible');
    window.setTimeout(() => {
      this.els.message.classList.remove('is-visible');
      window.setTimeout(() => {
        this.els.message.hidden = true;
      }, 220);
    }, 1400);
  }

  /* ---------------------------------------------------------------- *
   * Input and frame loop
   * ---------------------------------------------------------------- */

  private bindInput(): void {
    const canvas = this.els.canvas;

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hoverCell = this.renderer.cellAtPoint(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = this.hoverCell === null ? 'default' : 'pointer';
    });

    canvas.addEventListener('pointerleave', () => {
      this.hoverCell = null;
    });

    canvas.addEventListener('pointerdown', (e) => {
      audio.unlock();
      const rect = canvas.getBoundingClientRect();
      const cell = this.renderer.cellAtPoint(e.clientX - rect.left, e.clientY - rect.top);
      if (cell === null) return;
      this.tileHighlight = new Set();
      this.hinted = new Set();
      this.session.click(cell);
    });

    // Keyboard shortcuts.
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLSelectElement) return;
      switch (e.key.toLowerCase()) {
        case 'n':
          this.newGame();
          break;
        case 'u':
          this.session.undo();
          break;
        case 'h':
          this.session.hint();
          break;
        case 'escape':
          this.session.deselect();
          this.hideOverlay();
          break;
        default:
          break;
      }
    });
  }

  private bindWindow(): void {
    window.addEventListener('resize', () => this.resize());

    // The canvas lives in a flex layout whose size can settle after the
    // first frame. A ResizeObserver keeps the backing store in step with
    // the CSS size; without it the canvas is stretched and everything
    // drawn drifts out of place.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      const wrap = this.els.canvas.parentElement;
      if (wrap) this.resizeObserver.observe(wrap);
    }
    this.resize();
  }

  private resizeObserver: ResizeObserver | null = null;

  /** Records every resize for diagnostics (`window.sg.layoutLog`). */
  layoutLog: { w: number; h: number; cw: number; ch: number }[] = [];

  private resize(): void {
    const canvas = this.els.canvas;
    const rect = canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width * this.dpr));
    const h = Math.max(1, Math.floor(rect.height * this.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.renderer.layout(rect.width, rect.height);
    this.layoutLog.push({ w: Math.round(rect.width), h: Math.round(rect.height), cw: canvas.width, ch: canvas.height });
    if (this.layoutLog.length > 40) this.layoutLog.shift();
  }

  private frame = (now: number): void => {
    const dt = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;

    // Advance animations.
    for (const [cell, age] of this.clearing) {
      const next = age + dt;
      if (next >= CLEAR_MS) this.clearing.delete(cell);
      else this.clearing.set(cell, next);
    }
    for (const [cell, age] of this.spawning) {
      const next = age + dt;
      if (next >= SPAWN_MS) this.spawning.delete(cell);
      else this.spawning.set(cell, next);
    }
    for (const p of this.pulses) {
      p.age += dt;
      p.frame = Math.floor((p.age / p.life) * 4);
    }
    this.pulses = this.pulses.filter((p) => p.age < p.life);

    this.draw(now);
    requestAnimationFrame(this.frame);
  };

  private draw(now: number): void {
    const canvas = this.els.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    const rect = canvas.getBoundingClientRect();
    const board = this.session.board;
    // Only marbles that can actually be picked up glow. Using the raw placement
    // rule here was the "metal lights before its tier" bug: a metal with three
    // free neighbours was drawn playable even when the transmutation order still
    // barred it, so the board promised a click it would reject.
    const playable = new Set(this.session.playable().filter((c) => this.session.isSelectable(c)));

    const matchable = new Set<number>();
    if (this.session.selected !== null) {
      const sel = this.session.selected;
      const tile = board[sel] as Tile;
      const lowest = this.session.variant === 'colvan' ? Tile.Empty : this.session.lowestMetal();
      for (const c of playable) {
        if (c === sel) continue;
        if (
          canPairLocal(tile, board[c] as Tile, this.session.variant, lowest)
        ) {
          matchable.add(c);
        }
      }
    }

    const hinted = new Set<number>([...this.hinted, ...this.tileHighlight]);

    const state: RenderState = {
      board,
      time: now,
      hoverCell: this.hoverCell,
      selected: this.session.selected,
      playable,
      hinted,
      matchable,
      clearing: this.clearing,
      spawning: this.spawning,
      pulses: this.pulses,
      interactive: !this.session.isFinished,
    };

    this.renderer.draw(ctx, state, rect.width, rect.height);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function canPairLocal(a: Tile, b: Tile, variant: Variant, lowest: Tile): boolean {
  return canPair(a, b, variant, lowest);
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function button(label: string, variant?: 'primary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sg-button' + (variant ? ` sg-button--${variant}` : '');
  b.textContent = label;
  return b;
}

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}

function waitForImage(img: HTMLImageElement | HTMLSelectElement): Promise<void> {
  if (!(img instanceof HTMLImageElement)) return Promise.resolve();
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}
