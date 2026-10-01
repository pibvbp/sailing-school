// The sun's light dims when a cloud covers the sun. That is decided on the CPU, from a mirror of the density field
// that the GPU ray-marches into the sky (src/render/env/cloudField.ts against cloudShaders.ts). Two
// implementations of one field can drift apart silently: the boat would go into shade under a visibly clear sun.
// `?suncheck=1` makes the app march a fresh panorama, read it back and compare it with the CPU march along
// 1 700 rays over the hemisphere; this test fails when the two stop agreeing.
import { test, expect } from '@playwright/test';

test('the CPU mirror of the cloud field matches the sky the GPU draws', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('./?suncheck=1');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__sunCheck !== undefined, null, { timeout: 60_000 });
  const check = await page.evaluate(() => window.__sunCheck!);

  // Without float render targets, or if the march's self-test failed, the sky runs the 2-D cloud layer, whose
  // CPU mirror is a different (and far simpler) function: nothing to compare here.
  test.skip(!check.volumetric, `${'skipped' in check ? check.skipped : 'no volumetric clouds'}: the sky runs the 2-D layer, there is no panorama to compare`);
  if (!check.volumetric) return;

  expect(check.rays, 'the check should cover the hemisphere').toBeGreaterThan(1000);
  // The comparison means something only if the rays include both clear sky and cloud.
  expect(check.coveredFraction).toBeGreaterThan(0.15);
  expect(check.coveredFraction).toBeLessThan(0.9);
  // Thresholds sit between two readings taken in this very scenario on an M2 (2026-10-01):
  //   healthy                                      mean |ΔT| 0.0065   same side 99.48 %   correlation 0.9963
  //   one constant wrong on the GPU side only      mean |ΔT| 0.0156   same side 98.62 %   correlation 0.9905
  //   (the billows' carve weight at a cloud's base, 0.6 on the CPU against 0.8 in the GLSL)
  // So a drift of that size between the two implementations fails all three; a smaller one may not.
  expect(check.meanAbsDifference).toBeLessThanOrEqual(0.011);
  expect(check.sameSideOfHalf).toBeGreaterThanOrEqual(0.988);
  expect(check.correlation).toBeGreaterThanOrEqual(0.993);
  expect(errors, errors.join('\n')).toEqual([]);
});
