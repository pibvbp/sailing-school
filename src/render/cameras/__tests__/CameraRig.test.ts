// Camera rig: what each view frames, and where it puts its subject when panels cover part of the screen.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as THREE from 'three';
import { CameraRig, type CameraFrame } from '../CameraRig';
import { BOAT } from '../../../shared/boatSpec';

const DEG = Math.PI / 180;
/** Height above the waterline the orbit cameras aim at. */
const AIM_H = 4.6;
const W = 1440, H = 900;

beforeAll(() => {
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
});
afterAll(() => vi.unstubAllGlobals());

interface Rigged { rig: CameraRig; camera: THREE.PerspectiveCamera; wheel(deltaY: number): void }

function makeRig(width = W, height = H): Rigged {
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 40000);
  const listeners = new Map<string, (e: unknown) => void>();
  const dom = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, fn); },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLElement;
  const rig = new CameraRig(camera, dom);
  return { rig, camera, wheel: (deltaY) => listeners.get('wheel')!({ deltaY, preventDefault() {} }) };
}

/** A level boat at the origin heading north; `side` +1 = wind from starboard, boom out to port. */
function frame(side: 1 | -1, boomDeg = 16): CameraFrame {
  return {
    boatMatrix: new THREE.Matrix4(),
    boatPos: new THREE.Vector3(),
    heading: 0,
    heel: 0,
    twd: side * 45 * DEG,
    windSide: side,
    boomAngle: side * boomDeg * DEG,
    waterHeight: () => 0,
  };
}

/** Screen position of a boat-local point (X stbd, Y up, Z aft), in CSS px from the top-left corner. */
function screen(camera: THREE.PerspectiveCamera, x: number, y: number, z: number): { x: number; y: number; behind: boolean } {
  camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  const behind = v.z > 0;
  v.applyMatrix4(camera.projectionMatrix);
  return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, behind };
}

/** Mainsail corners for a boom angle (rad, + to port), in boat-local three coordinates. */
function mainsail(boom: number): Record<'tack' | 'clew' | 'head' | 'middle', [number, number, number]> {
  const g = BOAT.boom.gooseneck, E = BOAT.main.E, P = BOAT.main.P;
  const along = (d: number, h: number): [number, number, number] => [-Math.sin(boom) * d, h, -g.x + Math.cos(boom) * d];
  return { tack: along(0, g.h), clew: along(E, g.h), head: along(0, g.h + P), middle: along(0.3 * E, g.h + 0.4 * P) };
}

function settle(rig: CameraRig, f: CameraFrame, seconds = 4): void {
  for (let i = 0; i < seconds * 60; i++) rig.update(1 / 60, f);
}

describe('CameraRig: sail view', () => {
  for (const side of [1, -1] as const) {
    it(`frames the whole mainsail from the windward side (wind from ${side > 0 ? 'starboard' : 'port'})`, () => {
      const { rig, camera } = makeRig();
      rig.setMode('sail');
      const f = frame(side);
      settle(rig, f);
      const m = mainsail(f.boomAngle!);
      const tack = screen(camera, ...m.tack), clew = screen(camera, ...m.clew);
      const head = screen(camera, ...m.head), middle = screen(camera, ...m.middle);
      for (const p of [tack, clew, head, middle]) expect(p.behind).toBe(false);
      // The head is in the upper half, near the middle; the foot runs along the bottom of the picture.
      expect(head.y).toBeGreaterThan(0);
      expect(head.y).toBeLessThan(0.4 * H);
      expect(Math.abs(head.x - W / 2)).toBeLessThan(0.25 * W);
      expect(tack.y).toBeGreaterThan(0.7 * H);
      expect(clew.y).toBeGreaterThan(0.7 * H);
      // Mast up one side, leech up the other, and the body of the sail in the middle of the picture.
      expect(Math.sign(tack.x - W / 2)).toBe(-Math.sign(clew.x - W / 2));
      expect(Math.abs(middle.x - W / 2)).toBeLessThan(0.2 * W);
      expect(middle.y).toBeGreaterThan(0.2 * H);
      expect(middle.y).toBeLessThan(0.8 * H);
      // The foot is level across the picture: this is the view straight at the sail, not along it.
      expect(Math.abs(tack.y - clew.y)).toBeLessThan(0.12 * H);
    });
  }

  it('mirrors on the other tack (the mast swaps sides)', () => {
    const a = makeRig(), b = makeRig();
    a.rig.setMode('sail');
    b.rig.setMode('sail');
    const fa = frame(1), fb = frame(-1);
    settle(a.rig, fa);
    settle(b.rig, fb);
    const ta = screen(a.camera, ...mainsail(fa.boomAngle!).tack), tb = screen(b.camera, ...mainsail(fb.boomAngle!).tack);
    expect(ta.x - W / 2).toBeCloseTo(-(tb.x - W / 2), 0);
    expect(ta.y).toBeCloseTo(tb.y, 0);
  });

  it('still frames the sail with the boom squared out on a run', () => {
    const { rig, camera } = makeRig();
    rig.setMode('sail');
    const f = frame(1, 75);
    settle(rig, f);
    const m = mainsail(f.boomAngle!);
    const head = screen(camera, ...m.head), middle = screen(camera, ...m.middle);
    expect(head.behind || middle.behind).toBe(false);
    expect(head.y).toBeLessThan(0.4 * H);
    expect(Math.abs(middle.x - W / 2)).toBeLessThan(0.2 * W);
  });

  it('does not shake with a flogging boom', () => {
    const { rig, camera } = makeRig();
    rig.setMode('sail');
    const f = frame(1);
    settle(rig, f);
    const before = camera.position.clone();
    f.boomAngle = (16 + 12) * DEG;      // one swing of a flogging boom, held for a single frame
    rig.update(1 / 60, f);
    expect(camera.position.distanceTo(before)).toBeLessThan(0.08);
  });
});

describe('CameraRig: helm view', () => {
  it('crosses the cockpit in a tack instead of jumping', () => {
    const { rig, camera } = makeRig();
    rig.setMode('helm');
    const f = frame(1);
    settle(rig, f);
    expect(camera.position.x).toBeCloseTo(0.6, 2);
    f.windSide = -1;
    rig.update(1 / 60, f);
    expect(camera.position.x).toBeGreaterThan(0.5);       // one frame later it has barely moved
    let maxStep = 0, prev = camera.position.x;
    for (let i = 0; i < 180; i++) {
      rig.update(1 / 60, f);
      maxStep = Math.max(maxStep, Math.abs(camera.position.x - prev));
      prev = camera.position.x;
    }
    expect(maxStep).toBeLessThan(0.1);                    // no frame moves it more than 10 cm
    expect(camera.position.x).toBeCloseTo(-0.6, 1);       // and three seconds later it is across
  });

  it('a new scenario starts on the right side at once', () => {
    const { rig, camera } = makeRig();
    rig.setMode('helm');
    settle(rig, frame(1));
    rig.snap();
    rig.update(1 / 60, frame(-1));
    expect(camera.position.x).toBeCloseTo(-0.6, 2);
  });
});

describe('CameraRig: the unobstructed part of the view', () => {
  const insets = { top: 72, right: 308, bottom: 190, left: 20 };
  const cx = W / 2 + (insets.left - insets.right) / 2, cy = H / 2 + (insets.top - insets.bottom) / 2;

  it('chase view: the boat sits in the middle of the uncovered area, and the horizon stays level', () => {
    const { rig, camera } = makeRig();
    const f = frame(1);
    settle(rig, f);
    const centred = screen(camera, 0, AIM_H, 0);
    expect(centred.x).toBeCloseTo(W / 2, 0);
    expect(centred.y).toBeCloseTo(H / 2, 0);
    rig.setSafeArea(insets, W, H);
    settle(rig, f);
    const p = screen(camera, 0, AIM_H, 0);
    expect(Math.abs(p.x - cx)).toBeLessThan(6);
    expect(Math.abs(p.y - cy)).toBeLessThan(6);
    // Level horizon: the camera's right-hand axis has no vertical part.
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    expect(Math.abs(right.y)).toBeLessThan(1e-6);
  });

  it('top view: the boat slides to the middle of the uncovered area without turning the chart', () => {
    const { rig, camera } = makeRig();
    rig.setMode('top');
    const f = frame(1);
    settle(rig, f);
    const upBefore = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    rig.setSafeArea(insets, W, H);
    settle(rig, f);
    const p = screen(camera, 0, 0, 0);
    expect(Math.abs(p.x - cx)).toBeLessThan(2);
    expect(Math.abs(p.y - cy)).toBeLessThan(2);
    camera.updateMatrixWorld(true);
    expect(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).distanceTo(upBefore)).toBeLessThan(1e-6);
  });

  it('eases to a new area rather than jumping, and null restores the centre', () => {
    const { rig, camera } = makeRig();
    const f = frame(1);
    settle(rig, f);
    rig.setSafeArea(insets, W, H);
    rig.update(1 / 60, f);
    const first = screen(camera, 0, AIM_H, 0);
    expect(Math.abs(first.x - W / 2)).toBeLessThan(0.3 * Math.abs(cx - W / 2));
    settle(rig, f);
    rig.setSafeArea(null, W, H);
    settle(rig, f);
    const back = screen(camera, 0, AIM_H, 0);
    expect(back.x).toBeCloseTo(W / 2, 0);
    expect(back.y).toBeCloseTo(H / 2, 0);
  });

  /** Screen y (CSS px) of a point `h` metres above the waterline at the boat's centre. */
  const heightPx = (camera: THREE.PerspectiveCamera, h: number, viewH: number): number => {
    camera.updateMatrixWorld(true);
    return (1 - (new THREE.Vector3(0, h, 0).project(camera).y * 0.5 + 0.5)) * viewH;
  };

  for (const [name, w, h, frameInsets] of [
    ['a desktop window', 1440, 900, { top: 68, right: 330, bottom: 215, left: 34 }],
    ['a phone', 390, 844, { top: 68, right: 0, bottom: 202, left: 0 }],
    ['a short window', 1280, 620, { top: 68, right: 318, bottom: 215, left: 350 }],
  ] as const) {
    it(`chase view: the whole rig shows between the panels on ${name}`, () => {
      const { rig, camera } = makeRig(w, h);
      rig.setSafeArea(frameInsets, w, h);
      settle(rig, frame(1));
      expect(heightPx(camera, BOAT.mast.topH, h)).toBeGreaterThan(frameInsets.top);
      expect(heightPx(camera, 0, h)).toBeLessThan(h - frameInsets.bottom);
      // …and it is not a speck: the rig fills at least 70 % of the uncovered height.
      const rigPx = heightPx(camera, 0, h) - heightPx(camera, BOAT.mast.topH, h);
      expect(rigPx).toBeGreaterThan(0.7 * (h - frameInsets.top - frameInsets.bottom));
    });
  }

  it('chase view: with room to spare it keeps its own distance', () => {
    const plain = makeRig(2560, 1440), roomy = makeRig(2560, 1440);
    const f = frame(1);
    settle(plain.rig, f);
    roomy.rig.setSafeArea({ top: 68, right: 330, bottom: 215, left: 34 }, 2560, 1440);
    settle(roomy.rig, f);
    expect(roomy.camera.position.length()).toBeCloseTo(plain.camera.position.length(), 0);
  });

  it('chase view: once the learner zooms, the distance is theirs', () => {
    const { rig, camera, wheel } = makeRig();
    const f = frame(1);
    rig.setSafeArea({ top: 68, right: 330, bottom: 215, left: 34 }, W, H);
    settle(rig, f);
    wheel(-400);                              // zoom in
    settle(rig, f);
    const chosen = camera.position.length();
    rig.setSafeArea({ top: 68, right: 330, bottom: 500, left: 34 }, W, H);   // a panel opens
    settle(rig, f);
    expect(camera.position.length()).toBeCloseTo(chosen, 1);
    rig.setMode('chase');                     // choosing the view again fits it again
    settle(rig, f);
    expect(camera.position.length()).toBeGreaterThan(chosen * 1.2);
  });

  it('a lesson can set the distance of the top view; choosing the view again resets it', () => {
    const { rig, camera } = makeRig();
    const f = frame(1);
    rig.setMode('top');
    settle(rig, f);
    expect(camera.position.y).toBeCloseTo(70, 1);
    rig.setDistance(38);
    settle(rig, f);
    expect(camera.position.y).toBeCloseTo(38, 1);
    rig.setDistance(5);                                   // closer than the view allows
    settle(rig, f);
    expect(camera.position.y).toBeCloseTo(25, 1);
    rig.setMode('top');
    settle(rig, f);
    expect(camera.position.y).toBeCloseTo(70, 1);
    rig.setMode('helm');
    settle(rig, f);
    const eye = camera.position.clone();
    rig.setDistance(38);                                  // first-person views have no distance
    settle(rig, f);
    expect(camera.position.distanceTo(eye)).toBeLessThan(1e-6);
  });

  it('never pushes the subject further than a fifth of the view off centre', () => {
    const { rig, camera } = makeRig();
    const f = frame(1);
    rig.setSafeArea({ top: 0, right: 1200, bottom: 0, left: 0 }, W, H);
    settle(rig, f);
    const p = screen(camera, 0, AIM_H, 0);
    expect(W / 2 - p.x).toBeLessThan(0.2 * W + 6);
    expect(W / 2 - p.x).toBeGreaterThan(0.2 * W - 6);
  });
});
