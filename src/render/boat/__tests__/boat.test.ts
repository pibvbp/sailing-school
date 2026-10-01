// Whole-model regression guards (review Minor 12): triangle budget per tier (≤ 120 k at `high`), indexed
// merged buckets, thin lines never cast shadows, no rebuild for an unchanged pose, per-camera helmsman
// hide, optional pose fields. Canvas textures are mocked (Node has no canvas); geometry is real.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { tierSettings, type QualityTier } from '../../core/types';
import { BoatModel, type BoatPose } from '../BoatModel';
import { guyBlock, quarterBlock } from '../fittings';

vi.mock('../textures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../textures')>();
  const T = await import('three');
  const tex = () => new T.DataTexture(new Uint8Array(4), 1, 1);
  const pair = () => ({ map: tex(), orm: tex() });
  return {
    ...actual, hullPaintTextures: pair, deckPlanTextures: pair, nonSkidNormal: tex, fairnessNormal: tex, woodTexture: tex,
    ropeBraidNormal: tex, ropeBraid: tex, clothNormal: tex, brushedNormal: tex, furlTexture: tex, nameDecal: tex,
  };
});

function stats(boat: BoatModel) {
  let triangles = 0, meshes = 0, casters = 0;
  const nonIndexed: string[] = [];
  boat.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    if (m.castShadow) casters++;
    const g = m.geometry;
    if (!g.index) nonIndexed.push(m.name);
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { triangles, meshes, casters, nonIndexed };
}

const pose = (over: Partial<BoatPose> = {}): BoatPose => ({
  boomAngle: 0.2, rudder: 0.05, jibClew: { x: 0.6, y: -0.7, z: -1.45 }, jibFurl: 0,
  spin: { visible: false, poleAngle: 0, poleTipH: 2.2, tack: { x: 3, y: 0, z: -2 }, clew: { x: 0, y: 0, z: -2 } },
  crewY: 1, heel: -0.2, sheets: { main: 0.8, jib: 0.8, spin: 0.5 }, ...over,
});

describe('BoatModel budgets and structure', () => {
  it.each(['ultra', 'high', 'medium', 'low'] as QualityTier[])('%s tier builds within budget, all buckets indexed', (tier) => {
    const boat = new BoatModel(tierSettings(tier));
    const s = stats(boat);
    if (tier === 'high') expect(s.triangles).toBeLessThanOrEqual(120_000);
    expect(s.triangles).toBeLessThanOrEqual(130_000);
    expect(s.nonIndexed).toEqual([]);
    expect(s.meshes).toBeLessThanOrEqual(45);
    boat.dispose();
  });

  it('draws no furled-jib roll unless asked (SailsView owns the sail cloth)', () => {
    const boat = new BoatModel(tierSettings('high'));
    expect(boat.root.getObjectByName('furled-jib')).toBeUndefined();
    boat.dispose();
    const demo = new BoatModel(tierSettings('high'), { furledJib: true });
    const roll = demo.root.getObjectByName('furled-jib') as THREE.Mesh;
    expect(roll).toBeTruthy();
    demo.setPose(pose({ jibFurl: 1 }));
    demo.update(1 / 60);
    expect(roll.visible).toBe(true);
    demo.setPose(pose({ jibFurl: 0 }));
    demo.update(1 / 60);
    expect(roll.visible).toBe(false);
    demo.dispose();
  });

  it('thin wires, lifelines and ropes never cast shadows; glass receives them', () => {
    const boat = new BoatModel(tierSettings('high'));
    for (const name of ['boat-wire', 'boat-lifeline', 'running-rigging']) {
      const m = boat.root.getObjectByName(name) as THREE.Mesh;
      expect(m, name).toBeTruthy();
      expect(m.castShadow, name).toBe(false);
    }
    expect((boat.root.getObjectByName('boat-glass') as THREE.Mesh).receiveShadow).toBe(true);
    boat.dispose();
  });
});

describe('BoatModel pose updates', () => {
  it('an unchanged pose while paused rewrites neither ropes nor crew', () => {
    const boat = new BoatModel(tierSettings('high'));
    boat.setPose(pose());
    boat.update(1 / 60);
    const ropes = (boat.root.getObjectByName('running-rigging') as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute;
    const crew = (boat.root.getObjectByName('crew') as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute;
    const rv = ropes.version, cv = crew.version;
    for (let k = 0; k < 5; k++) { boat.setPose(pose()); boat.update(0); }
    expect(ropes.version).toBe(rv);
    expect(crew.version).toBe(cv);
    boat.dispose();
  });

  it('the helmsman can be hidden per camera (his shadow stays)', () => {
    const boat = new BoatModel(tierSettings('high'));
    const helm = boat.root.getObjectByName('helmsman') as THREE.Mesh;
    const cam = new THREE.PerspectiveCamera();
    const call = () => helm.onBeforeRender(null as never, null as never, cam, helm.geometry, helm.material as THREE.Material, null as never);
    call();
    expect(helm.geometry.drawRange.count).toBe(Infinity);
    cam.userData[BoatModel.HIDE_HELMSMAN] = true;
    call();
    expect(helm.geometry.drawRange.count).toBe(0);
    // The shadow pass never calls onBeforeRender, so the range must be whole again once the hidden draw is over —
    // otherwise the helmsman casts no shadow in the helm view and a flickering one while the telltale cam runs.
    helm.onAfterRender(null as never, null as never, cam, helm.geometry, helm.material as THREE.Material, null as never);
    expect(helm.geometry.drawRange.count).toBe(Infinity);
    boat.dispose();
  });

  describe('spinnaker sheet and guy', () => {
    const ropeBuffer = (boat: BoatModel) =>
      (boat.root.getObjectByName('running-rigging') as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute;
    /** Shortest distance from any rope vertex to a boat-local point. */
    const reach = (buf: THREE.BufferAttribute, p: THREE.Vector3): number => {
      let best = Infinity;
      for (let i = 0; i < buf.count; i++) best = Math.min(best, Math.hypot(buf.getX(i) - p.x, buf.getY(i) - p.y, buf.getZ(i) - p.z));
      return best;
    };
    // Body frame (x forward, y starboard, z down). The pole is 2.9 m long from the mast at x = 1.05.
    const poleTip = (y: number) => ({ x: 1.05 + Math.sqrt(Math.max(2.9 ** 2 - y ** 2, 0.1)), y, z: -2.2 });

    it('lead from the kite\'s own corners: the guy by the windward guy block, the sheet by the leeward quarter block', () => {
      const boat = new BoatModel(tierSettings('high'));
      const tack = poleTip(2.3), clew = { x: 1.0, y: -2.6, z: -2.0 };
      boat.setPose(pose({ spin: { visible: true, poleAngle: 0, poleTipH: 2.2, tack, clew, foot: { tack, clew } } }));
      boat.update(1 / 60);
      const buf = ropeBuffer(boat);
      expect(reach(buf, guyBlock(1))).toBeLessThan(0.08);        // guy: pole side (starboard)
      expect(reach(buf, quarterBlock(-1))).toBeLessThan(0.08);   // sheet: the other side
      expect(reach(buf, guyBlock(-1))).toBeGreaterThan(0.3);
      // Both start at the cloth's corners (boat-local: X = y, Y = −z, Z = −x).
      expect(reach(buf, new THREE.Vector3(tack.y, -tack.z, -tack.x))).toBeLessThan(0.02);
      expect(reach(buf, new THREE.Vector3(clew.y, -clew.z, -clew.x))).toBeLessThan(0.02);
      boat.dispose();
    });

    it('keep to their own sides while the pole swings across in a gybe (no rope jumps over the boat)', () => {
      const boat = new BoatModel(tierSettings('high'));
      const buf = ropeBuffer(boat);
      // The gybe has relabelled the kite: its new tack is the corner to port, where the pole is heading.
      const foot = { tack: poleTip(-2.4), clew: poleTip(2.4) };
      let prev: Float32Array | null = null, maxStep = 0;
      const steps = 240;                                          // 4 s at 60 Hz for 4.8 m of pole travel
      for (let k = 0; k <= steps; k++) {
        const tip = poleTip(2.4 - 4.8 * (k / steps));
        boat.setPose(pose({ spin: { visible: true, poleAngle: 0, poleTipH: 2.2, tack: tip, clew: foot.clew, foot } }));
        boat.update(1 / 60);
        const now = Float32Array.from(buf.array as Float32Array);
        if (prev) for (let i = 0; i < now.length; i++) maxStep = Math.max(maxStep, Math.abs(now[i]! - prev[i]!));
        prev = now;
      }
      expect(maxStep).toBeLessThan(0.2);
      // Once the pole has arrived the port line is the guy, and the starboard one a sheet.
      expect(reach(buf, guyBlock(-1))).toBeLessThan(0.08);
      expect(reach(buf, quarterBlock(1))).toBeLessThan(0.08);
      boat.dispose();
    });

    it('without the cloth\'s corners they lead from the pole tip and the clew, as before', () => {
      const boat = new BoatModel(tierSettings('high'));
      const tack = poleTip(-2.3), clew = { x: 1.0, y: 2.6, z: -2.0 };
      boat.setPose(pose({ spin: { visible: true, poleAngle: 0, poleTipH: 2.2, tack, clew } }));
      boat.update(1 / 60);
      const buf = ropeBuffer(boat);
      expect(reach(buf, guyBlock(-1))).toBeLessThan(0.08);
      expect(reach(buf, quarterBlock(1))).toBeLessThan(0.08);
      boat.dispose();
    });
  });

  it('optional pose fields move the jib-lead cars and the traveller car', () => {
    const boat = new BoatModel(tierSettings('high'));
    boat.setPose(pose({ jibLead: 1, travelerCarY: 0.5 }));
    boat.update(1 / 60);
    const lead = boat.root.getObjectByName('jib-lead-cars')!;
    const car = boat.root.getObjectByName('traveller-car')!;
    // Forward (−Z) by half the track length; car to starboard.
    expect(lead.position.z).toBeCloseTo(-0.3, 3);
    expect(car.position.x).toBeCloseTo(0.5, 3);
    boat.setPose(pose({ jibLead: -1 }));
    boat.update(1 / 60);
    expect(lead.position.z).toBeCloseTo(0.3, 3);
    boat.dispose();
  });
});
