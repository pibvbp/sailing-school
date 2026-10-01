#!/usr/bin/env node
// Several headless screenshots of the app from one browser session (the README pictures are made with it).
// Starts Vite on a free port, opens index.html in the cached Playwright Chromium (Metal/GPU ANGLE backend), and for
// each entry of a JSON recipe runs its `eval` in the page, waits, and saves a picture.
//
//   node scripts/shots.mjs scripts/readme-shots.json snaps/readme
//
// Recipe: [{ name, size?: "1440x900", dpr?: 1, fresh?: true (a new page), wait?: ms,
//            eval?: "JavaScript run in the page; may await", clip?: {x,y,width,height}, type?: 'png'|'jpeg', quality? }]
// The page offers window.__app (setMode, setCamera, setOverlay, setWind, setTimeOfDay, setQuality, scenario,
// startLesson, …). To hide the HUD for a clean picture, set #ui to display:none and dispatch a resize event: the
// cameras then centre the boat in the whole window.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3] ?? 'snaps/shots';
mkdirSync(out, { recursive: true });
const server = await createServer({ root: process.cwd(), logLevel: 'error', clearScreen: false, server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  let ctx = null, page = null, key = '';
  for (const shot of spec) {
    const [w, h] = (shot.size ?? '1440x900').split('x').map(Number);
    const k = `${w}x${h}@${shot.dpr ?? 1}:${shot.fresh ? Math.random() : ''}`;
    if (k !== key) {
      await ctx?.close();
      ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: shot.dpr ?? 1 });
      page = await ctx.newPage();
      page.setDefaultTimeout(120000);
      page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });
      page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
      key = k;
    }
    let result;
    if (shot.eval) result = await page.evaluate(`(async () => { ${shot.eval} })()`);
    await page.waitForTimeout(shot.wait ?? 2500);
    const file = `${out}/${shot.name}.${shot.type === 'jpeg' ? 'jpg' : 'png'}`;
    await page.screenshot({ path: file, type: shot.type ?? 'png', ...(shot.type === 'jpeg' ? { quality: shot.quality ?? 88 } : {}), ...(shot.clip ? { clip: shot.clip } : {}) });
    const info = await page.evaluate(() => ({ ...window.__appInfo, fps: Math.round(window.__stats?.fps ?? 0) }));
    console.log(`${file}  ${JSON.stringify(info)}${result !== undefined ? '  -> ' + JSON.stringify(result) : ''}`);
  }
  await ctx?.close();
} finally {
  await browser.close();
  await server.close();
}
