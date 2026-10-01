import { describe, expect, it } from 'vitest';
import { cloudNoise } from '../cloudNoise';
import {
  CLOUD_BASE_M, CLOUD_MAX_DISTANCE_M, CLOUD_TOP_M, CloudField, EARTH_RADIUS_M, OPAQUE_CLOUD_SUN, cloudAreaFraction,
  cloudFieldForCover, panoDirection, panoDisc, panoUv, rayAltitude, shellDistance, sunLightThrough,
} from '../cloudField';

const noise = cloudNoise();

/** Fraction of the sky with cloud overhead (optical depth straight up above `tau`), on a grid over one tile. */
function skyCover(field: CloudField, tau = 0.5, n = 64): number {
  const tile = field.params.weatherTile;
  let covered = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (field.opticalDepth(((i + 0.5) / n) * tile, 0, ((j + 0.5) / n) * tile, 0, 1, 0, 24) > tau) covered++;
    }
  }
  return covered / (n * n);
}

describe('cover mapping', () => {
  it('maps cover to an area fraction that only ever grows, from nothing to more than everything', () => {
    expect(cloudAreaFraction(0)).toBe(0);
    let last = 0;
    for (let c = 0.01; c <= 1.0001; c += 0.01) {
      const a = cloudAreaFraction(c);
      expect(a).toBeGreaterThan(last);
      last = a;
    }
    // A full overcast needs overlapping outlines to close the last gaps.
    expect(cloudAreaFraction(1)).toBeGreaterThan(1);
    expect(cloudAreaFraction(-3)).toBe(0);
    expect(cloudAreaFraction(7)).toBe(cloudAreaFraction(1));
  });

  it('gives a clear sky at zero cover', () => {
    const field = new CloudField(noise, 0);
    expect(field.params.threshold).toBeGreaterThan(1);
    expect(skyCover(field, 0, 24)).toBe(0);
    expect(field.sunTransmittance(0, 2, 0, 0.3, 0.8, 0.5)).toBe(1);
  });

  it('covers the fraction of the sky that the cover says, across the range', () => {
    const field = new CloudField(noise);
    let last = 0;
    for (const cover of [0.2, 0.35, 0.6, 0.9]) {
      field.setCover(cover);
      const measured = skyCover(field);
      expect(Math.abs(measured - cover)).toBeLessThan(0.05);
      expect(measured).toBeGreaterThan(last);
      last = measured;
    }
    field.setCover(1);
    expect(skyCover(field, 3)).toBeGreaterThan(0.995); // overcast: opaque everywhere
  });

  it('turns towering fair-weather cumulus into a lower, flatter deck as the cover closes', () => {
    const fair = cloudFieldForCover(0.35);
    const deck = cloudFieldForCover(0.9);
    expect(fair.base).toBe(CLOUD_BASE_M);
    expect(fair.top).toBe(CLOUD_TOP_M);
    expect(deck.heightScale).toBeLessThan(fair.heightScale * 0.7);
    expect(deck.erosion).toBeLessThan(fair.erosion);
    expect(deck.threshold).toBeLessThan(fair.threshold);
  });
});

describe('density field', () => {
  const field = new CloudField(noise, 0.5);
  const tile = field.params.weatherTile;

  it('stays within 0…1 and is empty outside the slab', () => {
    let seen = 0;
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 0.618034) % 1) * tile;
      const z = ((i * 0.754878) % 1) * tile;
      const alt = CLOUD_BASE_M + ((i * 0.569840) % 1) * (CLOUD_TOP_M - CLOUD_BASE_M);
      const d = field.density(x, alt, z);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
      if (d > 0) seen++;
      expect(field.density(x, CLOUD_BASE_M - 1, z)).toBe(0);
      expect(field.density(x, CLOUD_TOP_M + 1, z)).toBe(0);
    }
    expect(seen).toBeGreaterThan(100);
  });

  it('has flat bases at a common altitude: clouds start within 150 m of the base', () => {
    const lowest: number[] = [];
    for (let i = 0; i < 600 && lowest.length < 40; i++) {
      const x = ((i * 0.618034) % 1) * tile;
      const z = ((i * 0.754878) % 1) * tile;
      // Only solid cloud columns: a wisp at the edge of a cloud can float anywhere.
      if (field.opticalDepth(x, 0, z, 0, 1, 0, 24) < 6) continue;
      for (let alt = CLOUD_BASE_M; alt < CLOUD_TOP_M; alt += 10) {
        if (field.density(x, alt, z) > 0.2) { lowest.push(alt - CLOUD_BASE_M); break; }
      }
    }
    expect(lowest.length).toBeGreaterThan(20);
    lowest.sort((a, b) => a - b);
    expect(lowest[Math.floor(lowest.length / 2)]!).toBeLessThan(80);
    expect(lowest[Math.floor(lowest.length * 0.9)]!).toBeLessThan(150);
  });

  it('moves with the drift: the same clouds, displaced by the wind', () => {
    const still = new CloudField(noise, 0.5);
    const moved = new CloudField(noise, 0.5);
    moved.drift.x = 1234.5;
    moved.drift.z = -987.25;
    for (let i = 0; i < 300; i++) {
      const x = ((i * 0.618034) % 1) * 9000;
      const z = ((i * 0.754878) % 1) * 9000;
      const alt = CLOUD_BASE_M + 100 + ((i * 0.569840) % 1) * 900;
      expect(moved.density(x + 1234.5, alt, z - 987.25)).toBeCloseTo(still.density(x, alt, z), 6);
    }
  });

  it('repeats only at the weather tile: no visible tiling at the scale of the noise', () => {
    // The billow noise repeats every `shapeTile`, but the layout does not: one shape tile on, the sky differs.
    const p = field.params;
    let same = 0;
    let both = 0;
    for (let i = 0; i < 2000; i++) {
      const x = ((i * 0.618034) % 1) * tile;
      const z = ((i * 0.754878) % 1) * tile;
      const a = field.opticalDepth(x, 0, z, 0, 1, 0, 16) > 0.5;
      const b = field.opticalDepth(x + p.shapeTile * 3, 0, z, 0, 1, 0, 16) > 0.5;
      if (a === b) same++;
      if (a && b) both++;
    }
    // Independent columns at 50 % cover agree half the time.
    expect(same / 2000).toBeLessThan(0.7);
    expect(both).toBeGreaterThan(0);
  });
});

describe('sun transmittance', () => {
  it('falls monotonically from 1 in clear air to a floor under opaque cloud', () => {
    expect(sunLightThrough(0)).toBe(1);
    expect(sunLightThrough(-1)).toBe(1);
    let last = 1;
    for (let tau = 0.1; tau < 40; tau += 0.1) {
      const t = sunLightThrough(tau);
      expect(t).toBeLessThan(last);
      expect(t).toBeGreaterThanOrEqual(OPAQUE_CLOUD_SUN);
      last = t;
    }
    expect(sunLightThrough(40)).toBeCloseTo(OPAQUE_CLOUD_SUN, 6);
  });

  it('agrees with what is seen: the light is full where the disc is clear, and dim where a cloud covers it', () => {
    const field = new CloudField(noise, 0.5);
    const sun = { x: 0.32, y: 0.68, z: -0.657 };
    const len = Math.hypot(sun.x, sun.y, sun.z);
    const [sx, sy, sz] = [sun.x / len, sun.y / len, sun.z / len];
    let clear = 0;
    let hidden = 0;
    for (let i = 0; i < 400; i++) {
      const ox = ((i * 0.618034) % 1) * 20000;
      const oz = ((i * 0.754878) % 1) * 20000;
      const tau = field.opticalDepth(ox, 2, oz, sx, sy, sz);
      const seen = field.viewTransmittance(ox, 2, oz, sx, sy, sz);
      const light = field.sunTransmittance(ox, 2, oz, sx, sy, sz);
      expect(seen).toBeCloseTo(Math.exp(-tau), 12);
      expect(light).toBeCloseTo(sunLightThrough(tau), 12);
      // The light never dims more than the disc does (forward scattering), and never without a cloud.
      expect(light).toBeGreaterThanOrEqual(seen - 1e-12);
      if (tau === 0) { expect(light).toBe(1); clear++; }
      if (seen < 0.05) { expect(light).toBeLessThan(0.25); hidden++; }
    }
    expect(clear).toBeGreaterThan(40);
    expect(hidden).toBeGreaterThan(40);
  });

  it('is continuous as the clouds drift past the sun: no jumps in the light', () => {
    const field = new CloudField(noise, 0.5);
    const [sx, sy, sz] = [0.4472, 0.8, -0.4];
    let last = field.sunTransmittance(0, 2, 0, sx, sy, sz);
    let range = 0;
    let lo = 1;
    let hi = 0;
    // 12 m/s of drift sampled at 60 Hz for 200 s.
    for (let i = 0; i < 12000; i++) {
      field.drift.x += 0.2;
      const t = field.sunTransmittance(0, 2, 0, sx, sy, sz);
      range = Math.max(range, Math.abs(t - last));
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
      last = t;
    }
    expect(range).toBeLessThan(0.05);
    expect(hi - lo).toBeGreaterThan(0.5); // clouds did pass in front of the sun
  });

  it('can open a session in sunlight: the field shifts so that the sun sits in a gap', () => {
    // Midday (64°) and the 17:00 default (24°) under scattered cumulus: full sun, and a gap wide enough to last.
    for (const cover of [0.2, 0.35]) {
      for (const [sx, sy, sz] of [[0.3, 0.9, 0.3], [-0.85, 0.41, 0.33]] as const) {
        const field = new CloudField(noise, cover);
        const len = Math.hypot(sx, sy, sz);
        const light = field.openSkyToward(10, 2, -20, sx / len, sy / len, sz / len);
        expect(light).toBeGreaterThan(0.95);
        // What the per-frame light will read (it marches more finely than the search does).
        expect(field.sunTransmittance(10, 2, -20, sx / len, sy / len, sz / len)).toBeGreaterThan(0.9);
        // Still sunny a few hundred metres of drift later, whichever way the wind blows.
        for (const [dx, dz] of [[300, 0], [-300, 0], [0, 300], [0, -300]] as const) {
          expect(field.sunTransmittance(10 + dx, 2, -20 + dz, sx / len, sy / len, sz / len)).toBeGreaterThan(0.6);
        }
        // A shift of a few kilometres at most.
        expect(Math.hypot(field.drift.x, field.drift.z)).toBeLessThan(3300);
      }
    }
    // A low sun behind many clouds, or a broken deck, may offer no gap: then the search never makes it worse.
    for (const cover of [0.6, 0.9]) {
      for (const [sx, sy, sz] of [[-0.85, 0.41, 0.33], [0.6, 0.12, -0.79]] as const) {
        const field = new CloudField(noise, cover);
        const len = Math.hypot(sx, sy, sz);
        const light = (): number => sunLightThrough(field.opticalDepth(10, 2, -20, sx / len, sy / len, sz / len, 24));
        const before = light();
        expect(field.openSkyToward(10, 2, -20, sx / len, sy / len, sz / len)).toBeGreaterThanOrEqual(before);
        expect(light()).toBeGreaterThanOrEqual(before);
      }
    }
    // Nothing to do under a clear sky, and no march toward a sun on the horizon.
    const clear = new CloudField(noise, 0);
    expect(clear.openSkyToward(0, 2, 0, 0, 1, 0)).toBe(1);
    expect(clear.drift.x).toBe(0);
  });

  it('is clear for a sun on or below the horizon (no march along the ground)', () => {
    const field = new CloudField(noise, 0.9);
    expect(field.opticalDepth(0, 2, 0, 1, 0, 0)).toBe(0);
    expect(field.sunTransmittance(0, 2, 0, 0.9, -0.2, 0.3)).toBe(1);
  });
});

describe('panorama projection', () => {
  const disc = panoDisc(1024);

  it('puts the zenith at the centre and the horizon on the rim', () => {
    const uv = { u: 0, v: 0 };
    panoUv(0, 1, 0, disc, uv);
    expect(uv.u).toBeCloseTo(0.5, 6);
    expect(uv.v).toBeCloseTo(0.5, 6);
    panoUv(1, 0, 0, disc, uv);
    expect(uv.u).toBeCloseTo(0.5 + 0.5 * disc, 6);
    expect(uv.v).toBeCloseTo(0.5, 6);
    // Below the horizon clamps to the rim; the rim leaves two texels of margin for filtering.
    panoUv(0, -0.5, -1, disc, uv);
    expect(uv.v).toBeCloseTo(0.5 - 0.5 * disc, 6);
    expect((1 - disc) * 1024).toBeCloseTo(4, 6);
  });

  it('round-trips directions over the hemisphere', () => {
    const uv = { u: 0, v: 0 };
    const d = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 2000; i++) {
      const y = (i + 0.5) / 2000;
      const a = i * 2.39996;
      const h = Math.sqrt(1 - y * y);
      panoUv(Math.cos(a) * h, y, Math.sin(a) * h, disc, uv);
      panoDirection(uv.u, uv.v, disc, d);
      expect(d.x).toBeCloseTo(Math.cos(a) * h, 5);
      expect(d.y).toBeCloseTo(y, 5);
      expect(d.z).toBeCloseTo(Math.sin(a) * h, 5);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
    }
  });

  it('spends more of the radius on the horizon than an equal-area map would', () => {
    const uv = { u: 0, v: 0 };
    const radius = (elevationDeg: number): number => {
      const e = (elevationDeg * Math.PI) / 180;
      panoUv(Math.cos(e), Math.sin(e), 0, disc, uv);
      return (uv.u - 0.5) / (0.5 * disc);
    };
    let last = 1.0001;
    for (let e = 0; e <= 90; e += 2) {
      const r = radius(e);
      expect(r).toBeLessThan(last);
      last = r;
    }
    // Equal-area: 1 − sqrt(1 − sin 10°) = 0.091 of the radius for the lowest 10°; the warp nearly doubles it.
    expect(1 - radius(10)).toBeGreaterThan(0.15);
  });
});

describe('ray geometry', () => {
  it('reaches the cloud shells at the right distances', () => {
    expect(shellDistance(1, 0, 1000)).toBeCloseTo(1000, 3);
    expect(shellDistance(1, 200, 1000)).toBeCloseTo(800, 3);
    expect(shellDistance(0.5, 0, 1000)).toBeGreaterThan(1990);
    expect(shellDistance(0.5, 0, 1000)).toBeLessThan(2000); // the Earth curves away: a little nearer than flat
    // At the horizon the shell is where the tangent ray meets it.
    expect(shellDistance(0, 0, 1000)).toBeCloseTo(Math.sqrt(1000 * (2 * EARTH_RADIUS_M + 1000)), 0);
    expect(shellDistance(0, 0, CLOUD_BASE_M)).toBeGreaterThan(CLOUD_MAX_DISTANCE_M);
    expect(shellDistance(0.3, 500, 400)).toBe(0);
  });

  it('gives back the shell altitude along the ray', () => {
    for (const dy of [1, 0.7, 0.3, 0.1, 0.04]) {
      for (const alt of [CLOUD_BASE_M, CLOUD_TOP_M]) {
        const t = shellDistance(dy, 3, alt);
        expect(Math.abs(rayAltitude(t, dy, 3) - alt)).toBeLessThan(1);
      }
    }
  });
});
