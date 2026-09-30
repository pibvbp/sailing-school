import { App } from './app/App';
import { CURRICULUM } from './lessons/curriculum';
import { WebGL2UnavailableError } from './render/core/renderer';

declare global {
  interface Window { __ready?: boolean }
}

function showFallback(title: string, message: string): void {
  const el = document.createElement('div');
  el.className = 'fallback';
  const box = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  box.append(h1, p);
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
  } catch (err) {
    if (err instanceof WebGL2UnavailableError) {
      showFallback('Sailing School needs WebGL 2', 'Your browser or device could not start WebGL 2. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
    } else {
      console.error(err);
      showFallback('Something went wrong starting the 3-D scene', err instanceof Error ? err.message : String(err));
    }
  }
}

boot();
