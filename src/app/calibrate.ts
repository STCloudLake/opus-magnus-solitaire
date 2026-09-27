/**
 * Live alignment panel.
 *
 * The marble sprites are composited from the game's texture layers, and the
 * resulting lattice does not seat perfectly on the carved tiles — the
 * residual is a small offset that is easiest to dial in by eye against the
 * artwork rather than fit from pixel statistics.
 *
 * This panel nudges every marble relative to the board on both axes and
 * reports the values, so the right numbers can be read off and baked into
 * `cellCentrePx`. It is developer tooling, not part of the game: reachable
 * with `?calibrate` or `sgCalibrate()` from the console.
 */

import type { App } from './ui.js';

/** Range the sliders cover, in board pixels. */
const LIMIT = 80;

interface Control {
  value: number;
  input: HTMLInputElement;
  number: HTMLInputElement;
  readout: HTMLElement;
}

export interface Calibration {
  show: () => void;
  hide: () => void;
  toggle: () => void;
  read: () => { x: number; y: number };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function mountCalibration(app: App): Calibration {
  const panel = document.createElement('div');
  panel.className = 'sg-calib';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="sg-calib-head">
      <strong>Marble alignment</strong>
      <span class="sg-calib-hint">board pixels &middot; <kbd>Alt</kbd>+arrows nudge by 1</span>
      <button type="button" class="sg-calib-close" title="Hide">&#10005;</button>
    </div>
    <div class="sg-calib-row" data-axis="x">
      <label data-label="Horizontal">Horizontal</label>
      <button type="button" data-nudge="-1">&#8722;</button>
      <button type="button" data-nudge="-0.1">&#8722;.1</button>
      <input type="range" min="${-LIMIT}" max="${LIMIT}" step="0.1" value="0" />
      <button type="button" data-nudge="0.1">+.1</button>
      <button type="button" data-nudge="1">+</button>
      <input type="number" step="0.1" value="0" />
    </div>
    <div class="sg-calib-row" data-axis="y">
      <label data-label="Vertical">Vertical</label>
      <button type="button" data-nudge="-1">&#8722;</button>
      <button type="button" data-nudge="-0.1">&#8722;.1</button>
      <input type="range" min="${-LIMIT}" max="${LIMIT}" step="0.1" value="0" />
      <button type="button" data-nudge="0.1">+.1</button>
      <button type="button" data-nudge="1">+</button>
      <input type="number" step="0.1" value="0" />
    </div>
    <div class="sg-calib-foot">
      <button type="button" data-action="reset">Reset</button>
      <button type="button" data-action="copy" class="sg-calib-primary">Copy values</button>
      <output class="sg-calib-out">x = 0, y = 0</output>
    </div>`;

  document.body.appendChild(panel);

  const controls: Record<'x' | 'y', Control> = {} as never;
  for (const row of Array.from(panel.querySelectorAll<HTMLElement>('.sg-calib-row'))) {
    const axis = row.dataset.axis as 'x' | 'y';
    const input = row.querySelector<HTMLInputElement>('input[type="range"]')!;
    const number = row.querySelector<HTMLInputElement>('input[type="number"]')!;
    const readout = row.querySelector<HTMLElement>('label')!;
    controls[axis] = { value: 0, input, number, readout };
  }
  const output = panel.querySelector<HTMLElement>('.sg-calib-out')!;

  const apply = (axis: 'x' | 'y', value: number, syncInputs = true): void => {
    const clamped = Math.max(-LIMIT, Math.min(LIMIT, round1(value)));
    const c = controls[axis];
    c.value = clamped;
    if (syncInputs) {
      c.input.value = String(clamped);
      c.number.value = String(clamped);
    }
    c.readout.textContent =
      `${c.readout.dataset.label}  ${clamped >= 0 ? '+' : ''}${clamped}`;
    app.setCalibration(controls.x.value, controls.y.value);
    const { x, y } = app.getCalibration();
    output.textContent = `x = ${x}, y = ${y}`;
  };

  for (const axis of ['x', 'y'] as const) {
    const c = controls[axis];
    c.input.addEventListener('input', () => apply(axis, Number(c.input.value)));
    c.number.addEventListener('input', () => {
      const v = Number(c.number.value);
      if (Number.isFinite(v)) apply(axis, v);
    });
    for (const btn of Array.from(
      panel.querySelectorAll<HTMLButtonElement>(`.sg-calib-row[data-axis="${axis}"] [data-nudge]`),
    )) {
      btn.addEventListener('click', () => apply(axis, c.value + Number(btn.dataset.nudge)));
    }
  }

  panel.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    apply('x', 0);
    apply('y', 0);
  });

  panel.querySelector('[data-action="copy"]')!.addEventListener('click', async (event) => {
    const { x, y } = app.getCalibration();
    const text = `{ x: ${x}, y: ${y} }`;
    const btn = event.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = `Copied  ${text}`;
    } catch {
      // Clipboard can be blocked; the value is on screen and in the log.
      btn.textContent = text;
    }
    console.log('[calibration]', text);
    window.setTimeout(() => {
      btn.textContent = 'Copy values';
    }, 2200);
  });

  panel.querySelector('.sg-calib-close')!.addEventListener('click', () => hide());

  const onKey = (e: KeyboardEvent): void => {
    if (!e.altKey || panel.hidden) return;
    const step = e.shiftKey ? 10 : 1;
    const map: Record<string, ['x' | 'y', number]> = {
      ArrowLeft: ['x', -step],
      ArrowRight: ['x', step],
      ArrowUp: ['y', -step],
      ArrowDown: ['y', step],
    };
    const hit = map[e.key];
    if (!hit) return;
    e.preventDefault();
    apply(hit[0], controls[hit[0]].value + hit[1]);
  };
  window.addEventListener('keydown', onKey);

  const read = () => app.getCalibration();

  function show(): void {
    panel.hidden = false;
    apply('x', controls.x.value);
    apply('y', controls.y.value);
  }
  function hide(): void {
    panel.hidden = true;
  }

  return { show, hide, toggle: () => (panel.hidden ? show() : hide()), read };
}
