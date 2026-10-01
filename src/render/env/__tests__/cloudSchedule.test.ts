import { describe, expect, it } from 'vitest';
import { cloudQualityFor, panoTiles } from '../volumetricClouds';
import { planBake } from '../envBake';
import { panoDisc } from '../cloudField';
import { TIER_ORDER } from '../../core/types';

describe('panorama tiles', () => {
  it('cover every texel the dome can sample exactly once, and skip the corners', () => {
    for (const [size, tile] of [[1024, 128], [768, 96], [1536, 128], [512, 64]] as const) {
      const tiles = panoTiles(size, tile);
      const hits = new Uint8Array(size * size);
      for (const t of tiles) {
        expect(t.x + t.w).toBeLessThanOrEqual(size);
        expect(t.y + t.h).toBeLessThanOrEqual(size);
        for (let y = t.y; y < t.y + t.h; y++) hits.fill(1, y * size + t.x, y * size + t.x + t.w);
      }
      let area = 0;
      for (const t of tiles) area += t.w * t.h;
      let marked = 0;
      for (const h of hits) marked += h;
      expect(marked).toBe(area); // no overlap
      // Everything within the disc plus its filtering margin is marched.
      const reach = (panoDisc(size) * size) / 2 + 2;
      for (let y = 0; y < size; y += 3) {
        for (let x = 0; x < size; x += 3) {
          if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= reach) expect(hits[y * size + x]).toBe(1);
        }
      }
      // The four corner tiles lie outside the disc.
      expect(tiles.length).toBeLessThan((size / tile) ** 2);
      expect(hits[0]).toBe(0);
      expect(hits[size * size - 1]).toBe(0);
    }
  });
});

describe('cloud quality tiers', () => {
  it('keeps the 2-D layer on the low tier and spends more as the tier rises', () => {
    expect(cloudQualityFor('low')).toBeNull();
    let lastTexels = 0;
    let lastSteps = 0;
    for (const tier of TIER_ORDER) {
      const q = cloudQualityFor(tier);
      if (!q) continue;
      expect(q.size % q.tile).toBe(0);
      expect(q.size * q.size).toBeGreaterThan(lastTexels);
      expect(q.steps * q.subSteps).toBeGreaterThan(lastSteps);
      lastTexels = q.size * q.size;
      lastSteps = q.steps * q.subSteps;
    }
    // One tile a frame on the default tier: a generation takes about a second at 60 fps.
    const high = cloudQualityFor('high')!;
    expect(high.tilesPerFrame).toBe(1);
    const frames = panoTiles(high.size, high.tile).length / high.tilesPerFrame;
    expect(frames).toBeGreaterThan(30);
    expect(frames).toBeLessThan(90);
  });
});

describe('environment bake plan', () => {
  // three's PMREM levels for a 256² cube: 256, 128, 64, 32, 16 and six more at 16.
  const sizes = [256, 128, 64, 32, 16, 16, 16, 16, 16, 16, 16];

  it('filters every row of every level exactly once, in level order', () => {
    const units = planBake(sizes, 8192);
    expect(units[0]).toEqual({ lod: 0, row: 0, rows: 0 });
    let lod = 1;
    let row = 0;
    for (const u of units.slice(1)) {
      if (u.lod !== lod) {
        expect(row).toBe(2 * sizes[lod]!); // the level before was finished
        expect(u.lod).toBe(lod + 1);
        lod = u.lod;
        row = 0;
      }
      expect(u.row).toBe(row);
      expect(u.rows).toBeGreaterThan(0);
      row += u.rows;
    }
    expect(lod).toBe(sizes.length - 1);
    expect(row).toBe(2 * sizes[lod]!);
  });

  it('keeps each unit near the texel budget, so no frame carries the whole bake', () => {
    const budget = 8192;
    const units = planBake(sizes, budget);
    for (const u of units.slice(1)) expect(3 * sizes[u.lod]! * u.rows).toBeLessThanOrEqual(budget * 1.1);
    // The first filtered level alone is 98 304 texels: it must be split into about a dozen units.
    expect(units.filter((u) => u.lod === 1).length).toBeGreaterThanOrEqual(12);
  });
});
