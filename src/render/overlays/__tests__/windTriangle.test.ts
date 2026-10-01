// The wind triangle stays readable in every camera: the whole upper triangle and the deck-level one inside the safe
// area (the part of the window the HUD leaves free), at a size that reads.
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CameraRig, type CameraFrame } from '../../cameras/CameraRig';
import type { CameraKey } from '../../../lessons/types';
import type { ArrowBatch } from '../arrows';
import { BoatFrame } from '../frames';
import { LabelLayer, defaultSafeInsets } from '../labels';
import type { OverlayView } from '../overlayMaterial';
import { WindTriangle } from '../windTriangle';
import { sail } from './helpers';

beforeAll(() => {
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
});
afterAll(() => vi.unstubAllGlobals());

const W = 1440, H = 900;

function rigFor(mode: CameraKey): { rig: CameraRig; camera: THREE.PerspectiveCamera } {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 40000);
  const dom = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) } as unknown as HTMLElement;
  const rig = new CameraRig(camera, dom);
  rig.setMode(mode);
  return { rig, camera };
}

describe('wind triangle in every camera', () => {
  for (const mode of ['chase', 'top', 'sail', 'helm', 'free'] as const) {
    for (const twa of [45, 90]) {
      it(`${mode} camera, ${twa}° to the wind: both triangles inside the safe area`, () => {
        const { sim } = sail(12, twa, { seconds: 20 });
        const s = sim.snapshot();
        const boat = new THREE.Group();
        boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
        boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
        boat.updateMatrixWorld(true);
        const insets = defaultSafeInsets(W, { top: 0, right: 0, bottom: 0, left: 0 });
        const { rig, camera } = rigFor(mode);
        rig.setSafeArea(insets, W, H);
        const cf: CameraFrame = {
          boatMatrix: boat.matrixWorld, boatPos: boat.position, heading: s.boat.heading, heel: s.boat.heel, twd: s.wind.twd,
          windSide: Math.sin(s.wind.twd - s.boat.heading) >= 0 ? 1 : -1, boomAngle: s.sails.main.boomAngle, waterHeight: () => 0,
        };
        for (let i = 0; i < 240; i++) rig.update(1 / 60, cf);
        camera.updateMatrixWorld(true);
        const drawn: [THREE.Vector3, THREE.Vector3][] = [];
        const arrows = { add: (a: THREE.Vector3, b: THREE.Vector3) => { drawn.push([a.clone(), b.clone()]); } } as unknown as ArrowBatch;
        const tri = new WindTriangle(arrows, new LabelLayer());
        const frame = new BoatFrame();
        frame.update(boat);
        const view: OverlayView = { camera, width: W, height: H, x0: insets.left, y0: insets.top, x1: W - insets.right, y1: H - insets.bottom, scale: 1 };
        for (let i = 0; i < 60; i++) { drawn.length = 0; tri.update(1 / 60, s, frame, view); }
        const px = (p: THREE.Vector3) => { const v = p.clone().project(camera); return { x: (v.x * 0.5 + 0.5) * W, y: (0.5 - v.y * 0.5) * H }; };
        const pts = drawn.flat().map(px);
        const upper = drawn.slice(0, 3).flat().map(px);
        const size = Math.max(...upper.map((p) => Math.hypot(p.x - upper[0]!.x, p.y - upper[0]!.y)));
        // Both triangles drawn (upper and deck), and the upper one large enough to read — except from the free
        // camera, which the learner places (from its default place it sees the masthead triangle nearly edge-on).
        expect(drawn.length).toBe(6);
        if (mode !== 'free') expect(size).toBeGreaterThan(80);
        for (const p of pts) {
          expect(p.x).toBeGreaterThanOrEqual(view.x0);
          expect(p.x).toBeLessThanOrEqual(view.x1);
          expect(p.y).toBeGreaterThanOrEqual(view.y0);
          expect(p.y).toBeLessThanOrEqual(view.y1);
        }
      });
    }
  }
});
