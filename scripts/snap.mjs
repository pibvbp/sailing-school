#!/usr/bin/env node
// Headless screenshot of any page in this repo.
// Starts Vite programmatically on a free port, opens the page in the cached Playwright Chromium,
// waits for `window.__ready === true` (then --wait ms), optionally evaluates JS, and saves a PNG.
//
//   node scripts/snap.mjs demos/ocean.html snaps/ocean.png --wait 3000 --size 1600x900
//   node scripts/snap.mjs index.html snaps/app.png --eval "window.__stats"      (prints the result)
//   node scripts/snap.mjs demos/boat.html snaps/b.png --perf 3000               (frame-time stats)
//   --swiftshader  use the software GL (slow, deterministic); default is the Metal/GPU ANGLE backend
//   --query "a=1&b=2"  appended to the page URL
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wait: { type: 'string', default: '1500' },
    size: { type: 'string', default: '1280x720' },
    dpr: { type: 'string', default: '1' },
    eval: { type: 'string' },
    query: { type: 'string', default: '' },
    perf: { type: 'string' },
    timeout: { type: 'string', default: '30000' },
    swiftshader: { type: 'boolean', default: false },
  },
});

const [page = 'index.html', out = 'snaps/snap.png'] = positionals;
const [width, height] = values.size.split('x').map(Number);

const server = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  clearScreen: false,
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false },
});
await server.listen();
const addr = server.httpServer.address();
const url = `http://127.0.0.1:${addr.port}/${page.replace(/^\//, '')}${values.query ? `?${values.query}` : ''}`;

const gpuArgs = values.swiftshader
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

let exitCode = 0;
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: gpuArgs });
try {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(values.dpr) });
  const tab = await context.newPage();
  const logs = [];
  tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  tab.on('pageerror', (e) => { logs.push(`[pageerror] ${e.message}`); exitCode = 2; });

  await tab.goto(url, { waitUntil: 'load' });
  try {
    await tab.waitForFunction(() => window.__ready === true, null, { timeout: Number(values.timeout) });
  } catch {
    logs.push('[snap] window.__ready was not set within the timeout');
    exitCode = exitCode || 3;
  }
  await tab.waitForTimeout(Number(values.wait));

  const gl = await tab.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    if (!c) return 'no webgl2';
    const d = c.getExtension('WEBGL_debug_renderer_info');
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl2';
  });
  console.log(`renderer: ${gl}`);

  if (values.perf) {
    const stats = await tab.evaluate((ms) => new Promise((res) => {
      const dts = []; let last = performance.now(); const end = last + ms;
      const tick = (t) => { dts.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else {
        dts.sort((a, b) => a - b);
        res({ frames: dts.length, median: dts[Math.floor(dts.length / 2)], p95: dts[Math.floor(dts.length * 0.95)] });
      } };
      requestAnimationFrame(tick);
    }), Number(values.perf));
    console.log(`perf: ${JSON.stringify(stats)}`);
  }

  if (values.eval) {
    const result = await tab.evaluate(values.eval);
    if (result !== undefined) console.log(`eval: ${JSON.stringify(result)}`);
  }

  mkdirSync(dirname(resolve(out)), { recursive: true });
  await tab.screenshot({ path: out });
  console.log(`saved: ${resolve(out)}`);
  for (const l of logs) console.log(l);
} finally {
  await browser.close();
  await server.close();
}
process.exit(exitCode);
