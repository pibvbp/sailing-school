// Smoke tests for the deployed app: it boots, draws a real picture, stays free of console errors, starts a
// lesson, shows the no-WebGL2 fallback, and keeps the canvas matched to the viewport on resize.
import { test, expect, type Page } from '@playwright/test';

interface Booted { errors: string[] }

async function boot(page: Page, query = ''): Promise<Booted> {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(query ? `./?${query}` : './');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90_000 });
  return { errors };
}

/** Luminance statistics of the canvas as it appears on screen (decoded in the page from a screenshot). */
async function canvasStats(page: Page): Promise<{ mean: number; std: number; litFrac: number }> {
  const png = await page.locator('#scene').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sum2 = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4 * 61) {
      const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      n++;
      sum += l;
      sum2 += l * l;
      if (l > 24) lit++;
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), litFrac: lit / n };
  }, png.toString('base64'));
}

test('boots, renders a real scene and logs no errors', async ({ page }) => {
  const { errors } = await boot(page);
  // Let the sea, sky and exposure settle for a moment.
  await page.waitForTimeout(1500);
  const s = await canvasStats(page);
  expect(s.mean, 'canvas should not be black').toBeGreaterThan(30);
  expect(s.litFrac, 'most of the canvas should be lit').toBeGreaterThan(0.6);
  expect(s.std, 'canvas should not be a flat colour').toBeGreaterThan(6);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a lesson starts and its first step renders', async ({ page }) => {
  const { errors } = await boot(page);
  const first = await page.evaluate(() => window.__app?.lessonIds()[0] ?? null);
  expect(first, 'the app should expose at least one lesson').not.toBeNull();
  await page.evaluate((id) => window.__app!.startLesson(id!), first);
  const lesson = page.getByRole('region', { name: 'Lesson' });
  await expect(lesson).toBeVisible();
  await expect(lesson.getByRole('img', { name: /^Step 1 of \d+$/ })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('switching mode ends the running lesson and unlocks the controls', async ({ page }) => {
  await boot(page);
  const first = await page.evaluate(() => window.__app!.lessonIds()[0]!);
  await page.evaluate((id) => window.__app!.startLesson(id), first);
  await expect.poll(() => page.evaluate(() => window.__app!.activeLesson())).toBe(first);
  // Lesson 1 locks the sheets; the mainsheet slider is disabled while it runs.
  const sheet = page.getByRole('slider', { name: /^Sheet/ }).first();
  await expect(sheet).toBeDisabled();
  await page.getByText('Free sail', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app!.activeLesson())).toBeNull();
  await expect(sheet).toBeEnabled();
});

test('shows the fallback when WebGL 2 is unavailable', async ({ page }) => {
  await boot(page, 'forceNoWebGL2=1');
  await expect(page.getByRole('heading', { name: /needs WebGL 2/ })).toBeVisible();
});

test('keeps the canvas matched to the viewport on resize', async ({ page }) => {
  await boot(page);
  for (const [w, h] of [[900, 640], [1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForFunction(([W, H]) => {
      const c = document.getElementById('scene') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const ratio = c.width / Math.max(1, r.width);
      return Math.abs(r.width - W) < 1 && Math.abs(r.height - H) < 1 && Math.abs(c.height / Math.max(1, r.height) - ratio) < 0.02;
    }, [w, h] as const, { timeout: 10_000 });
  }
});
