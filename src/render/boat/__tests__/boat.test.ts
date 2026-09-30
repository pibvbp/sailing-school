// Whole-model regression guards (review Minor 12): triangle budget per tier (≤ 120 k at `high`), indexed
// merged buckets, thin lines never cast shadows, no rebuild for an unchanged pose, per-camera helmsman
// hide, optional pose fields. Canvas textures are mocked (Node has no canvas); geometry is real.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { tierSettings, type QualityTier } from '../../core/types';
import { BoatModel, type BoatPose } from '../BoatModel';

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
    boat.dispose();
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
