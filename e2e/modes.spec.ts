// The seams between the modes, the lessons and the view, in the built app with real input:
// the Sail lab's controls, what a lesson leaves behind when it ends, and where the camera puts the boat.
import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('./');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90_000 });
  return errors;
}

/** Drag a range input from its middle to a fraction of its width (beyond 0…1 = past the end). */
async function dragSlider(page: Page, slider: ReturnType<Page['getByRole']>, toFraction: number): Promise<void> {
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toFraction, y, { steps: 6 });
  await page.mouse.up();
}

test('Sail lab: the boat is towed, manoeuvres are off and the tow stays under the wind speed', async ({ page }) => {
  const errors = await boot(page);
  await page.getByRole('radio', { name: 'Sail lab' }).click();
  const lab = page.getByRole('region', { name: 'Sail lab' });
  await expect(lab).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__app!.sim.towed !== null)).toBe(true);

  // The towed boat holds its heading: Tack and Gybe are off, and T does nothing.
  await expect(page.getByRole('button', { name: 'Tack', exact: true }).first()).toBeDisabled();
  await page.keyboard.press('t');
  expect(await page.evaluate(() => window.__app!.controls.command ?? null)).toBeNull();

  // Lowest wind, then the tow slider pushed to its end: the speed shown and used is 95 % of the wind.
  const value = (name: string) => lab.getByRole('slider', { name }).evaluate((el) => el.closest('.sx-slider')!.querySelector('.sx-slider-value')!.textContent);
  await dragSlider(page, lab.getByRole('slider', { name: 'True wind' }), -0.05);
  await dragSlider(page, lab.getByRole('slider', { name: 'Tow speed' }), 1.05);
  expect(await value('True wind')).toBe('4.0 kn');
  expect(await value('Tow speed')).toBe('3.8 kn');
  expect(await lab.getByRole('slider', { name: 'Tow speed' }).inputValue()).toBe('3.8');
  expect(await page.evaluate(() => +(window.__app!.sim.towed!.speed / 0.514444).toFixed(1))).toBe(3.8);
  await expect(lab.getByText(/Held just under the wind speed/)).toBeVisible();

  // The panel scrolls inside itself, and its heading stays put.
  const scroller = lab.locator('.sx-panel-scroll');
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  await expect(lab.getByRole('heading', { name: 'Sail lab' })).toBeVisible();

  // Back to the lessons: the catalogue sits over a sailing boat, not the towed one.
  await page.getByRole('radio', { name: 'Lessons' }).click();
  await expect.poll(() => page.evaluate(() => window.__app!.sim.towed === null)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a lesson gives back the overlays and the camera the learner had when it ends', async ({ page }) => {
  await boot(page);
  const view = () => page.evaluate(() => ({ overlays: window.__app!.overlays(), camera: window.__app!.cameraMode() }));
  await page.evaluate(() => {
    window.__app!.setOverlay('wheel', true);
    window.__app!.setCamera('free');
  });
  const before = await view();
  // Lesson 1 turns the part labels on and takes the chase camera.
  await page.evaluate(() => window.__app!.startLesson(window.__app!.lessonIds()[0]!));
  await expect.poll(async () => (await view()).overlays.labels).toBe(true);
  expect((await view()).camera).toBe('chase');
  await page.getByRole('radio', { name: 'Free sail' }).click();
  await expect.poll(view).toEqual(before);
});

/** Screen position (CSS px) of a point `h` metres above the waterline at the boat's centre. */
async function boatPoint(page: Page, h: number): Promise<{ x: number; y: number }> {
  return page.evaluate((height) => {
    const app = window.__app!;
    // The boat root's position is a three.js Vector3: borrow its constructor instead of bundling three.js here.
    const V = app.boatRoot.position.constructor as new (x: number, y: number, z: number) => typeof app.boatRoot.position;
    app.boatRoot.updateMatrixWorld();
    const p = new V(0, height, 0).applyMatrix4(app.boatRoot.matrixWorld).project(app.camera);
    return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (1 - (p.y * 0.5 + 0.5)) * innerHeight };
  }, h);
}

for (const [name, width, height] of [['a desktop window', 1440, 900], ['a phone', 390, 844]] as const) {
  test(`the chase camera shows the whole boat between the panels on ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await boot(page);
    await page.getByRole('radio', { name: 'Free sail' }).click();
    await page.waitForTimeout(2500); // the camera eases to its place
    const masthead = await boatPoint(page, 10.2), waterline = await boatPoint(page, 0);
    const topBar = (await page.locator('.sx-top').boundingBox())!;
    const strip = (await page.locator('.sx-cluster .sx-cells').first().boundingBox())!;
    expect(masthead.y, 'masthead below the top bar').toBeGreaterThan(topBar.y + topBar.height);
    expect(waterline.y, 'waterline above the instruments').toBeLessThan(strip.y);
    // On a desktop the trim dock is open on the right: the boat is in the middle of what is left.
    if (width > 900) {
      const dock = (await page.locator('.sx-dock-right').boundingBox())!;
      expect(Math.abs((masthead.x + waterline.x) / 2 - dock.x / 2)).toBeLessThan(0.12 * width);
    }
  });
}
