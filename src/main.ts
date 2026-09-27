/**
 * Entry point. Boots the app and hides the loading veil once the first
 * frame is on screen.
 */

import { App, audio } from './app/ui.js';
import * as engine from './index.js';
import { mountCalibration } from './app/calibrate.js';

/** Collected for the end-to-end test so it can assert a clean console. */
const errors: string[] = [];
(window as unknown as { __sgErrors: string[] }).__sgErrors = errors;
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

async function main(): Promise<void> {
  const app = new App();
  await app.start();

  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('is-gone');
    window.setTimeout(() => boot.remove(), 600);
  }

  // Expose a little surface for debugging from the console and for tests.
  (window as unknown as { sg: App & { engine: typeof engine; audio: typeof audio } }).sg =
    Object.assign(app, { engine, audio });
  // Marbles are composited from the game's textures, so `start()` can take
  // a moment; tests and tooling wait on this flag rather than guessing.
  (window as unknown as { sgReady: boolean }).sgReady = true;

  // A live nudge for aligning the marbles with the carved tiles. Enabled
  // with `?calibrate`, or from the console with `sgCalibrate()`.
  const calibrate = mountCalibration(app);
  (window as unknown as { sgCalibrate: () => void }).sgCalibrate = calibrate.toggle;
  if (new URLSearchParams(location.search).has('calibrate')) calibrate.show();

  // Console helpers. `sgAudioTest()` plays every effect in turn and reports
  // what could be silencing it, which is the fastest way to diagnose
  // "I can't hear anything".
  (window as unknown as { sgAudioTest: () => string }).sgAudioTest = () => app.audioTest();
}

main().catch((err) => {
  console.error(err);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.innerHTML = `<div class="sg-boot-inner">
      <p class="sg-boot-title">Could not start</p>
      <p class="sg-boot-sub">${String(err?.message ?? err)}</p>
      <p class="sg-boot-sub">Serve this folder over HTTP &mdash; opening index.html directly
      from disk will not work because the game loads textures and audio.</p>
    </div>`;
  }
});
