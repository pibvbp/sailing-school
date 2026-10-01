import { App } from './app/App';
import { CURRICULUM } from './lessons/curriculum';
import { FloatTargetsUnavailableError, WebGL2UnavailableError } from './render/core/renderer';

declare global {
  interface Window { __ready?: boolean }
}

function showFallback(title: string, message: string, reload = false): void {
  const el = document.createElement('div');
  el.className = 'fallback';
  const box = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  box.append(h1, p);
  if (reload) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Reload';
    b.addEventListener('click', () => location.reload());
    box.append(b);
  }
  el.append(box);
  document.body.appendChild(el);
  window.__ready = true;
}

function boot(): void {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const ui = document.getElementById('ui') as HTMLElement;
  try {
    if (new URLSearchParams(location.search).has('forceNoWebGL2')) throw new WebGL2UnavailableError();
    const app = new App(canvas, ui, { lessons: [...CURRICULUM] });
    app.start();
    // A backgrounded phone tab, a driver reset or a GPU switch can take the graphics context away. Baked textures,
    // the wave spectrum and timer queries die with it, so the honest recovery is a fresh start.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      app.stop();
      showFallback('The 3-D view was reset', 'Your browser took the graphics away (this can happen when a tab sits in the background). Reload to carry on; your lesson progress is saved.', true);
    });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  } catch (err) {
    if (err instanceof WebGL2UnavailableError) {
      showFallback('Sailing School needs WebGL 2', 'Your browser or device could not start WebGL 2. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
    } else if (err instanceof FloatTargetsUnavailableError) {
      showFallback('This graphics chip can\u2019t draw the sea', 'Sailing School needs a GPU that can render to floating-point targets (for the ocean waves). Try a recent desktop browser with hardware acceleration enabled, or another device.');
    } else {
      console.error(err);
      showFallback('Something went wrong starting the 3-D scene', err instanceof Error ? err.message : String(err));
    }
  }
}

boot();
