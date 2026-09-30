// The lofted hull must honour BOAT.hull (spec §6): waterline length, beam and draft within 2 %.
// Measured on the actual render geometry (edges crossing the waterplane), not on the design curves.
import { describe, expect, it } from 'vitest';
import { BOAT } from '../../../shared/boatSpec';
import { buildKeelGeometry, buildRudderBlade } from '../appendages';
import { X_STEM, X_TRANSOM, buildHullGeometry, deckHalfBeam, hullLines, keelH, measureHull, sheerH } from '../hull';

const H = BOAT.hull;
const within = (value: number, target: number, tol = 0.02) => {
  expect(Math.abs(value - target) / Math.abs(target)).toBeLessThanOrEqual(tol);
};

describe.each([
  ['high', { hullStations: 140, hullSectionPoints: 28 }],
  ['low', { hullStations: 70, hullSectionPoints: 16 }],
])('Kestrel 25 hull (%s detail)', (_tier, detail) => {
  const geo = buildHullGeometry(hullLines(detail));
  const m = measureHull(geo);

  it('waterline length and its ends match BOAT.hull', () => {
    within(m.lwl, H.lwl);
    expect(m.wlFwd).toBeCloseTo(H.stemWL.x, 1);
    expect(m.wlAft).toBeCloseTo(H.transomWL.x, 1);
  });

  it('maximum beam and waterline beam', () => {
    within(m.beam, H.beam);
    within(m.bwl, H.bwl);
  });

  it('canoe-body draft', () => {
    within(m.canoeDraft, H.canoeDraft);
  });

  it('overall length from transom to stem head', () => {
    within(m.loa, H.loa);
  });
});

describe('Kestrel 25 appendages and sheer', () => {
  it('keel reaches the spec draft (keel tip at BOAT.keel.tipH)', () => {
    const keel = buildKeelGeometry();
    keel.computeBoundingBox();
    within(-keel.boundingBox!.min.y, H.draft);
  });

  it('rudder tip at BOAT.rudder.tipH and the blade top stays under the hull', () => {
    const blade = buildRudderBlade();
    blade.computeBoundingBox();
    within(-blade.boundingBox!.min.y, -BOAT.rudder.tipH);
    // Blade frame: origin on the stock, Z aft. Every vertex keeps ≥ 1 cm clearance under the canoe body.
    const p = blade.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = BOAT.rudder.stockX - p.getZ(i);
      expect(p.getY(i)).toBeLessThanOrEqual(keelH(x) - 0.01);
    }
  });

  it('freeboards at bow, mast, low point and stern', () => {
    const f = H.freeboard;
    expect(sheerH(X_STEM)).toBeCloseTo(f.bow, 3);
    expect(sheerH(BOAT.mast.x)).toBeCloseTo(f.mast, 3);
    expect(sheerH(f.minX)).toBeCloseTo(f.min, 3);
    expect(sheerH(X_TRANSOM)).toBeCloseTo(f.stern, 3);
    for (let x = X_TRANSOM; x <= X_STEM; x += 0.05) expect(sheerH(x)).toBeGreaterThanOrEqual(f.min - 1e-6);
  });

  it('deck line peaks at BOAT.hull.maxBeamX', () => {
    let best = -Infinity, at = 0;
    for (let x = -2; x <= 1.5; x += 0.01) if (deckHalfBeam(x) > best) { best = deckHalfBeam(x); at = x; }
    expect(best).toBeCloseTo(H.beam / 2, 4);
    expect(Math.abs(at - H.maxBeamX)).toBeLessThan(0.15);
  });
});
