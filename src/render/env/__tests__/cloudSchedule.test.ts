import { describe, expect, it } from 'vitest';
import { cloudQualityFor, GENERATION_SECONDS, MAX_TILES_PER_FRAME, panoTiles, tilesDue } from '../volumetricClouds';
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
  });
});

describe('tile schedule', () => {
  const tiles = panoTiles(1024, 128).length;
  /** Tiles marched over `seconds` of frames `dt` long, and the most in any one frame. */
  const run = (dt: number, seconds: number): { total: number; most: number } => {
    let credit = 0;
    let total = 0;
    let most = 0;
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      const due = tilesDue(credit, dt, tiles);
      credit = due.credit;
      total += due.tiles;
      most = Math.max(most, due.tiles);
    }
    return { total, most };
  };

  it('marches a generation a second at any frame rate', () => {
    for (const fps of [30, 60, 90, 120, 144]) {
      const { total } = run(1 / fps, 10);
      expect(Math.abs(total - (10 * tiles) / GENERATION_SECONDS)).toBeLessThanOrEqual(2);
    }
    expect(run(1 / 60, 5).most).toBe(1);
    expect(run(1 / 30, 5).most).toBe(2);
    expect(run(1 / 120, 5).most).toBe(1);
  });

  it('never lets a slow frame pile work on the next', () => {
    // A half-second hitch owes 30 tiles; it gets the cap, and the debt is dropped, not carried.
    const hitch = tilesDue(0, 0.5, tiles);
    expect(hitch.tiles).toBe(MAX_TILES_PER_FRAME);
    expect(hitch.credit).toBeLessThan(1);
    expect(tilesDue(hitch.credit, 1 / 60, tiles).tiles).toBeLessThanOrEqual(1);
    // At 10 fps the cap holds every frame: the generation simply takes longer.
    expect(run(0.1, 5).most).toBe(MAX_TILES_PER_FRAME);
    expect(tilesDue(0, 0, tiles)).toEqual({ tiles: 0, credit: 0 });
    expect(tilesDue(0.4, -1, tiles).tiles).toBe(0);
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
