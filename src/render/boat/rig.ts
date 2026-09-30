// Rig (spec §6): tapered anodised mast with luff track, halyard exits, gooseneck and pole ring;
// swept spreaders with tip boots; masthead casting with tangs and spinnaker crane; 1×19 standing
// rigging to toggles and turnbuckles; roller-furling drum, foil and swivel on the forestay; split
// backstay; the boom assembly (gooseneck, rigid vang with tackle, outhaul, reef lines, sheet bail
// and block) and the spinnaker pole. Moving parts are built in their own group frames.
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { cabinTopH } from './deck';
import { HARDWARE, block, frame, lathe, loc, onDeck, roundedBox, turnbuckle, v3 } from './fittings';
import { ROPE, rod, ropeGeometry, tube } from './lines';
import type { BuildContext, Part } from './materials';

type V3 = THREE.Vector3;
const M = BOAT.mast;
const SP = BOAT.spreaders;
const BM = BOAT.boom;
const Y = new THREE.Vector3(0, 1, 0);

/** Key rig points in the boat-local frame. */
export const RIG = {
  mastTop: loc(M.x, 0, M.topH),
  gooseneck: loc(BM.gooseneck.x, 0, BM.gooseneck.h),
  forestayTack: loc(BOAT.forestay.tack.x, 0, BOAT.forestay.tack.h),
  forestayHead: loc(BOAT.forestay.head.x, 0, BOAT.forestay.head.h),
  backstayTop: loc(BOAT.backstay.top.x, 0, BOAT.backstay.top.h),
  backstayJunction: loc(-2.78, 0, 2.45),
  poleInboard: loc(M.x + M.sectionBase[0] / 2 + 0.03, 0, BOAT.spinnaker.poleMastH),
  poleLiftMast: loc(M.x + 0.05, 0, 7.2),
  foreguyDeck: onDeck(2.75, 0, 0.03),
  /** Mainsheet bail under the boom (boom-group frame). */
  sheetBail: v3(0, -0.105, BM.sheetAttach),
  /** Where the jib halyard swivel sits on the foil. */
  furlTop: BOAT.jib.head.h + 0.06,
  drumTop: BOAT.jib.tack.h,
};

/** Mast half-sections (athwart, fore-aft) at height h: constant to the hounds' region, then tapered. */
function mastHalf(h: number): [number, number] {
  const t = Math.min(1, Math.max(0, (h - 6.4) / (M.topH - 6.4)));
  const s = t * t * (3 - 2 * t);
  return [
    (M.sectionBase[1] + (M.sectionTop[1] - M.sectionBase[1]) * s) / 2,
    (M.sectionBase[0] + (M.sectionTop[0] - M.sectionBase[0]) * s) / 2,
  ];
}

function superellipse(n: number, e: number): Array<[number, number]> {
  const p: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    p.push([Math.sign(c) * Math.pow(Math.abs(c), 2 / e), Math.sign(s) * Math.pow(Math.abs(s), 2 / e)]);
  }
  return p;
}

/** Point on a straight stay a→b at height h. */
function onStay(a: V3, b: V3, y: number): V3 {
  const t = (y - a.y) / (b.y - a.y);
  return a.clone().lerp(b, t);
}

export interface RigBuild {
  staticParts: Part[];
  boomParts: Part[];
  poleParts: Part[];
  /** Furled-jib roll around the foil at full size (scaled by the furl amount). */
  furlGeometry: THREE.BufferGeometry;
  furlBase: V3;
  furlDir: V3;
}

export function buildRig(ctx: BuildContext): RigBuild {
  const d = ctx.detail;
  const seg = d.lathe;
  const rad = d.radial;
  const parts: Part[] = [];

  // Mast: superelliptic extrusion (luff groove aft is a separate dark strip).
  const heights = [M.baseH - 0.02, M.baseH + 0.1, 1.8, 2.2, 5.4, 5.8, 6.4, 7.1, 7.8, 8.5, 9.1, 9.6, 10.0, M.topH];
  const mastPath = heights.map((h) => loc(M.x, 0, h));
  parts.push({
    geometry: tube(mastPath, {
      radius: 1, radial: 24, profile: superellipse(Math.max(16, rad * 3), 2.4),
      profileScale: (i) => mastHalf(heights[i]), seedNormal: v3(1, 0, 0), capEnd: true, vScale: 0.5,
    }),
    mat: 'aluminium', shadow: true,
  });
  // Luff track and halyard exits on the aft face; pole ring on the front face.
  const aftFace = (h: number) => loc(M.x - mastHalf(h)[1] + 0.001, 0, h);
  parts.push({ geometry: tube([aftFace(BM.gooseneck.h + 0.08), aftFace(9.95)], { radius: 1, radial: 4, profile: [[-1, -1], [1, -1], [1, 1], [-1, 1]], profileScale: () => [0.006, 0.004], seedNormal: v3(1, 0, 0) }), mat: 'darkMetal' });
  for (const [h, s] of [[1.52, 1], [1.46, -1], [1.6, 1], [1.4, 0]] as const) {
    const [ha, hf] = mastHalf(h);
    const p = s === 0 ? loc(M.x - hf, 0, h) : loc(M.x, s * ha, h);
    const n = s === 0 ? v3(0, 0, 1) : v3(s, 0, 0);
    parts.push({ geometry: roundedBox(0.026, 0.07, 0.006, 0.004).applyMatrix4(frame(p, Y, n)), mat: 'darkMetal' });
    parts.push({ geometry: roundedBox(0.01, 0.045, 0.004, 0.002).applyMatrix4(frame(p.clone().addScaledVector(n, 0.003), Y, n)), mat: 'black' });
  }
  const ring = new THREE.TorusGeometry(0.018, 0.005, 6, 12);
  parts.push({ geometry: ring.applyMatrix4(frame(RIG.poleInboard.clone().add(v3(0, 0, 0.012)), v3(0, 0, 1))), mat: 'polished' });
  parts.push({ geometry: roundedBox(0.035, 0.08, 0.02, 0.006).applyMatrix4(frame(loc(M.x + mastHalf(1.9)[1], 0, BOAT.spinnaker.poleMastH), Y)), mat: 'darkMetal' });
  // Gooseneck bracket and vang tang on the aft face.
  parts.push({ geometry: roundedBox(0.05, 0.12, 0.03, 0.008).applyMatrix4(frame(aftFace(BM.gooseneck.h).add(v3(0, 0, 0.012)), Y)), mat: 'darkMetal', shadow: true });
  parts.push({ geometry: roundedBox(0.04, 0.07, 0.03, 0.008).applyMatrix4(frame(aftFace(1.28).add(v3(0, 0, 0.012)), Y)), mat: 'darkMetal', shadow: true });

  // Masthead: casting, forestay/backstay tangs, spinnaker crane with block.
  const top = RIG.mastTop;
  parts.push({ geometry: roundedBox(0.075, 0.09, 0.14, 0.015).applyMatrix4(frame(top.clone().add(v3(0, 0.02, 0.0)), Y)), mat: 'darkMetal', shadow: true });
  const crane = [top.clone().add(v3(0, 0.03, -0.05)), loc(BOAT.spinnaker.head.x + 0.02, 0, M.topH + 0.03)];
  parts.push({ geometry: tube(crane, { radius: 1, radial: 4, profile: [[-1, -1], [1, -1], [1, 1], [-1, 1]], profileScale: () => [0.012, 0.018], seedNormal: v3(1, 0, 0), capEnd: true }), mat: 'darkMetal', shadow: true });
  parts.push(...block(0.035, frame(loc(BOAT.spinnaker.head.x + 0.03, 0, M.topH - 0.02), v3(0, -1, 0), v3(0, 0, -1)), 1, 12, 'black'));
  parts.push({ geometry: roundedBox(0.006, 0.05, 0.05, 0.004).applyMatrix4(frame(RIG.forestayHead.clone().add(v3(0, 0.01, 0.015)), Y)), mat: 'brushed' });
  parts.push({ geometry: roundedBox(0.006, 0.05, 0.05, 0.004).applyMatrix4(frame(RIG.backstayTop.clone().add(v3(0, 0.0, -0.01)), Y)), mat: 'brushed' });

  // Spreaders: aerofoil struts swept aft, tilted to bisect the cap shroud, with tip boots.
  const hounds = (s: number) => loc(M.x, s * mastHalf(9.9)[0], 9.9);
  const capPlate = (s: number) => onDeck(HARDWARE.capChainplate.x, s * HARDWARE.capChainplate.y, 0.058);
  const lowerPlate = (s: number) => onDeck(HARDWARE.lowerChainplate.x, s * HARDWARE.lowerChainplate.y, 0.058);
  const sweep = SP.sweepDeg * (Math.PI / 180);
  /** Spreader tip: swept aft, tilted up so it bisects the angle the cap shroud makes over it. */
  const tipOf = (s: number) => {
    const root = loc(M.x, s * mastHalf(SP.h)[0], SP.h);
    const reach = SP.length - mastHalf(SP.h)[0];
    const flat = root.clone().add(loc(-Math.sin(sweep), s * Math.cos(sweep), 0).multiplyScalar(reach));
    const inAbove = Math.atan2(Math.abs(flat.x) - Math.abs(hounds(s).x), hounds(s).y - flat.y);
    const outBelow = Math.atan2(Math.abs(capPlate(s).x) - Math.abs(flat.x), flat.y - capPlate(s).y);
    const tilt = 0.5 * (inAbove + outBelow);
    const lateral = flat.clone().sub(root).setY(0);
    return root.clone().addScaledVector(lateral, Math.cos(tilt)).add(v3(0, reach * Math.sin(tilt), 0));
  };
  const aerofoil = superellipse(12, 2).map(([a, b]) => [a * (b > 0 ? 1 : 0.8), b] as [number, number]);
  for (const s of [-1, 1]) {
    const root = loc(M.x, s * mastHalf(SP.h)[0], SP.h);
    const tip = tipOf(s);
    parts.push({ geometry: tube([root, tip], { radius: 1, radial: 12, profile: aerofoil, profileScale: (i) => (i === 0 ? [0.011, 0.028] : [0.008, 0.019]), seedNormal: Y, capEnd: true }), mat: 'aluminium', shadow: true });
    parts.push({ geometry: roundedBox(0.03, 0.06, 0.07, 0.008).applyMatrix4(frame(root.clone().add(v3(s * 0.008, 0, 0)), Y)), mat: 'darkMetal', shadow: true });
    const boot = new THREE.CapsuleGeometry(0.017, 0.07, 4, 10);
    boot.applyMatrix4(frame(tip.clone().add(tip.clone().sub(root).normalize().multiplyScalar(-0.015)), tip.clone().sub(root).normalize()));
    parts.push({ geometry: boot, mat: 'lifeline', shadow: true });
  }

  // Standing rigging (1×19) with turnbuckles at the chainplates.
  const wire = (pts: V3[], r = 0.0025) => parts.push({ geometry: tube(pts, { radius: r, radial: 6 }), mat: 'wire' });
  const tbLen = 0.2;
  for (const s of [-1, 1]) {
    const tip = tipOf(s);
    const cp = capPlate(s);
    const tbDir = tip.clone().sub(cp).normalize();
    parts.push(...turnbuckle(tbLen, frame(cp, tbDir, v3(0, 0, 1)), rad));
    wire([hounds(s), tip, cp.clone().addScaledVector(tbDir, tbLen)]);
    const lowerTang = loc(M.x - 0.01, s * mastHalf(5.45)[0], 5.45);
    const lp = lowerPlate(s);
    const lDir = lowerTang.clone().sub(lp).normalize();
    parts.push(...turnbuckle(tbLen, frame(lp, lDir, v3(0, 0, 1)), rad));
    wire([lowerTang, lp.clone().addScaledVector(lDir, tbLen)], 0.0022);
    for (const t of [hounds(s), lowerTang]) parts.push({ geometry: roundedBox(0.012, 0.05, 0.03, 0.004).applyMatrix4(frame(t.clone().add(v3(s * 0.004, 0, 0)), Y)), mat: 'brushed' });
  }

  // Forestay: stem fitting → toggle → furling drum, aluminium foil to the top swivel, wire above.
  const fsT = RIG.forestayTack.clone(), fsH = RIG.forestayHead.clone();
  const fsDir = fsH.clone().sub(fsT).normalize();
  const drumBase = fsT.clone().add(v3(0, 0.02, 0));
  parts.push({ geometry: lathe([[0, 0], [0.012, 0], [0.012, 0.02], [0.05, 0.022], [0.052, 0.03], [0.04, 0.035], [0.04, 0.06], [0.052, 0.065], [0.05, 0.075], [0.02, 0.078], [0.016, 0.1], [0, 0.1]], seg).applyMatrix4(frame(drumBase, fsDir)), mat: 'black', shadow: true });
  parts.push({ geometry: lathe([[0.0405, 0.036], [0.0405, 0.059]], seg).applyMatrix4(frame(drumBase, fsDir)), mat: 'darkMetal' });
  const foil0 = onStay(fsT, fsH, RIG.drumTop + 0.08), foil1 = onStay(fsT, fsH, RIG.furlTop);
  parts.push({ geometry: tube([foil0, foil1], { radius: 1, radial: 10, profile: superellipse(10, 2).map(([a, b]) => [a, b * 1.3] as [number, number]), profileScale: () => [0.0115, 0.0115], seedNormal: v3(1, 0, 0) }), mat: 'aluminium', shadow: true });
  const swivel = onStay(fsT, fsH, RIG.furlTop);
  parts.push({ geometry: lathe([[0, 0], [0.02, 0], [0.024, 0.02], [0.024, 0.06], [0.02, 0.08], [0, 0.08]], seg).applyMatrix4(frame(swivel, fsDir)), mat: 'darkMetal', shadow: true });
  wire([swivel.clone().addScaledVector(fsDir, 0.08), fsH], 0.003);
  wire([fsT, drumBase.clone().add(v3(0, 0.02, 0))], 0.004);

  // Split backstay: masthead → junction block → legs to the quarter chainplates.
  const junction = RIG.backstayJunction;
  wire([RIG.backstayTop, junction], 0.0022);
  parts.push(...block(0.04, frame(junction.clone().add(v3(0, -0.03, 0)), v3(0, 1, 0), v3(1, 0, 0)), 1, 12, 'black'));
  for (const s of [-1, 1]) {
    const bl = HARDWARE.backstayLeg;
    const cp = onDeck(bl.x, s * bl.y, 0.058);
    const dir = junction.clone().sub(cp).normalize();
    parts.push(...turnbuckle(0.16, frame(cp, dir, v3(1, 0, 0)), rad));
    wire([junction.clone().add(v3(s * 0.01, -0.05, 0)), cp.clone().addScaledVector(dir, 0.16)], 0.002);
  }
  // Backstay adjuster tail on the port leg: a small tackle line down to a cleat on the port quarter.
  {
    const cp = onDeck(HARDWARE.backstayLeg.x, -HARDWARE.backstayLeg.y, 0.058);
    const a = junction.clone().lerp(cp, 0.55);
    parts.push({ geometry: ropeGeometry([a, a.clone().lerp(cp, 0.5).add(v3(0.03, 0, -0.02)), onDeck(-3.3, -0.9, 0.03)], 0.0035, ROPE.black, 6), mat: 'rope' });
  }

  // --- Boom (group frame: origin at the gooseneck pivot, +Z along the boom) ---------------------
  const boomParts: Part[] = [];
  const bl = BM.length;
  const bPath = [v3(0, 0, 0.05), v3(0, 0, 0.4), v3(0, 0, bl - 0.12), v3(0, 0, bl - 0.03)];
  boomParts.push({
    geometry: tube(bPath, { radius: 1, radial: 20, profile: superellipse(Math.max(16, rad * 2), 2.6), profileScale: () => [0.033, 0.053], seedNormal: v3(1, 0, 0), vScale: 0.5 }),
    mat: 'aluminium', shadow: true,
  });
  boomParts.push({ geometry: roundedBox(0.07, 0.11, 0.13, 0.02).translate(0, 0, bl - 0.03), mat: 'black', shadow: true });
  boomParts.push({ geometry: roundedBox(0.075, 0.1, 0.09, 0.015).translate(0, 0, 0.04), mat: 'darkMetal', shadow: true });
  boomParts.push({ geometry: rod(v3(0, -0.06, 0.0), v3(0, 0.06, 0.0), 0.009, 10), mat: 'polished' });
  // Mainsheet bail and the double block hanging from it.
  const bail: V3[] = [];
  for (let k = 0; k <= 8; k++) { const a = Math.PI * (k / 8); bail.push(v3(Math.cos(a) * 0.036, -0.03 - Math.sin(a) * 0.045, BM.sheetAttach)); }
  boomParts.push({ geometry: tube(bail, { radius: 0.0045, radial: 6 }), mat: 'polished' });
  boomParts.push(...block(0.055, frame(RIG.sheetBail.clone(), v3(0, -1, 0), v3(1, 0, 0)), 2, 16, 'black'));
  // Outhaul car on the boom top with its line into the end casting.
  boomParts.push({ geometry: roundedBox(0.03, 0.02, 0.08, 0.008).translate(0, 0.062, bl - 0.28), mat: 'darkMetal', shadow: true });
  boomParts.push({ geometry: ropeGeometry([v3(0, 0.068, bl - 0.24), v3(0, 0.07, bl - 0.12), v3(0, 0.05, bl - 0.08)], 0.003, ROPE.control, 6), mat: 'rope' });
  // Reef lines and outhaul tail: out of the boom's port side near the gooseneck, down to the mast base.
  const baseY = cabinTopH(M.x, 0) - BM.gooseneck.h;
  for (let k = 0; k < 3; k++) {
    const ex = v3(-0.034, 0.02 - 0.02 * k, 0.32 + 0.05 * k);
    boomParts.push({ geometry: roundedBox(0.004, 0.012, 0.04, 0.002).translate(-0.033, 0.02 - 0.02 * k, 0.32 + 0.05 * k), mat: 'black' });
    const cells = [ROPE.control, ROPE.grey, ROPE.halyard];
    boomParts.push({ geometry: ropeGeometry([ex, ex.clone().add(v3(-0.03, -0.08, -0.06)), v3(-0.07 - 0.015 * k, baseY * 0.6, 0.06), v3(-0.055 - 0.02 * k, baseY + 0.03, -0.1)], 0.0035, cells[k], 6), mat: 'rope' });
  }
  // Rigid vang: gas strut from the mast-base tang to the boom, with a 4:1 tackle alongside.
  const vLow = v3(0, 1.28 - BM.gooseneck.h, 0.02), vHigh = v3(0, -0.058, BM.vangAttach);
  const vDir = vHigh.clone().sub(vLow).normalize();
  const vLen = vHigh.distanceTo(vLow);
  boomParts.push({ geometry: tube([vLow.clone().addScaledVector(vDir, 0.04), vLow.clone().addScaledVector(vDir, vLen * 0.55)], { radius: 0.021, radial: 12, capStart: true, capEnd: true }), mat: 'aluminium', shadow: true });
  boomParts.push({ geometry: tube([vLow.clone().addScaledVector(vDir, vLen * 0.5), vHigh.clone().addScaledVector(vDir, -0.04)], { radius: 0.013, radial: 10, capEnd: true }), mat: 'polished', shadow: true });
  for (const p of [vLow, vHigh]) boomParts.push({ geometry: roundedBox(0.03, 0.05, 0.03, 0.008).applyMatrix4(frame(p, vDir)), mat: 'black', shadow: true });
  const off = v3(0.042, 0, 0);
  const tb0 = vLow.clone().addScaledVector(vDir, 0.12).add(off), tb1 = vHigh.clone().addScaledVector(vDir, -0.1).add(off);
  boomParts.push(...block(0.04, frame(tb0, vDir.clone().negate(), v3(1, 0, 0)), 2, 12, 'black'));
  boomParts.push(...block(0.04, frame(tb1, vDir, v3(1, 0, 0)), 2, 12, 'black'));
  for (let k = 0; k < 4; k++) {
    const dx = -0.012 + 0.008 * k;
    boomParts.push({ geometry: tube([tb0.clone().add(v3(dx, 0, 0)).addScaledVector(vDir, 0.035), tb1.clone().add(v3(dx, 0, 0)).addScaledVector(vDir, -0.035)], { radius: 0.0028, radial: 5 }), mat: 'rope' });
  }
  boomParts.push({ geometry: ropeGeometry([tb0.clone().add(v3(0.01, -0.03, 0)), tb0.clone().add(v3(0.02, -0.12, -0.05)), v3(0.05, baseY + 0.02, -0.08)], 0.0028, ROPE.control, 5), mat: 'rope' });

  // --- Spinnaker pole (group frame: inboard end at origin, +Z to the outboard end, unit 2.9 m) --
  const poleParts: Part[] = [];
  const PL = BOAT.spinnaker.poleLength;
  poleParts.push({ geometry: tube([v3(0, 0, 0.06), v3(0, 0, PL - 0.06)], { radius: 0.027, radial: 14 }), mat: 'aluminium', shadow: true });
  for (const z of [0.0, PL - 0.1]) {
    poleParts.push({ geometry: tube([v3(0, 0, z), v3(0, 0, z + 0.1)], { radius: 0.03, radial: 14, capStart: true, capEnd: true }), mat: 'black', shadow: true });
    poleParts.push({ geometry: roundedBox(0.01, 0.05, 0.05, 0.006).translate(0, 0.02, z < 0.05 ? -0.01 : PL + 0.01), mat: 'darkMetal' });
  }
  for (const z of [PL * 0.35, PL * 0.65]) {
    const eye = new THREE.TorusGeometry(0.009, 0.0025, 6, 10);
    eye.rotateY(Math.PI / 2);
    poleParts.push({ geometry: eye.translate(0, 0.034, z), mat: 'polished' });
  }
  poleParts.push({ geometry: tube([v3(0, 0.034, PL * 0.35), v3(0, 0.06, PL * 0.5), v3(0, 0.034, PL * 0.65)], { radius: 0.0022, radial: 5 }), mat: 'wire' });

  // Furled jib: roll of cloth (UV cover outside) around the foil, fattest low down.
  const furlBase = onStay(fsT, fsH, RIG.drumTop + 0.1);
  const furlTop = onStay(fsT, fsH, RIG.furlTop - 0.05);
  const fl = furlBase.distanceTo(furlTop);
  const fPath: V3[] = [];
  for (let k = 0; k <= 16; k++) fPath.push(v3(0, 0, (fl * k) / 16));
  const furlGeometry = tube(fPath, {
    radius: (_i, s) => 0.014 + 0.036 * Math.pow(Math.max(0, 1 - s / fl), 1.3) * Math.min(1, (s / fl) * 14 + 0.3),
    radial: 12, capStart: true, capEnd: true, vScale: 1,
  });
  return {
    staticParts: parts, boomParts, poleParts,
    furlGeometry, furlBase, furlDir: furlTop.clone().sub(furlBase).normalize(),
  };
}
