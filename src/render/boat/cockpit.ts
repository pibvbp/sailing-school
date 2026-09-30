// Cockpit (spec §6): self-draining well from the cabin to an open transom — sole, central footwell,
// seats outboard, low coamings up to the side decks, all moulded with small radii; the traveller
// bridge, the rudder-stock bearing, and the transom face (with the cockpit cut-out and the boat name).
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { COCKPIT, deckH, planU, planV } from './deck';
import { lathe, loc, planarFace, place, roundedBox, v3 } from './fittings';
import { PAINT_UV, X_TRANSOM, deckHalfBeam } from './hull';
import { filletPath, tube } from './lines';
import type { BuildContext, Part } from './materials';

type V3 = THREE.Vector3;

/**
 * Cockpit cross-section at station x, port coaming top → sole → starboard coaming top, as (y, h).
 * Aft of the seats (spec cockpit x −3.45) the seat level rises to small quarter decks either side of the
 * open-transom walkway.
 */
function crossSection(x: number, quarterDeck: boolean): V3[] {
  const C = COCKPIT;
  const top = deckH(x, C.halfWidth);
  const seat = quarterDeck ? top - 0.004 : C.seatH;
  const half = [
    v3(0, C.soleH, 0),
    v3(C.footwellHalf, C.soleH, 0),
    v3(C.footwellHalf, seat, 0),
    v3(C.halfWidth, seat, 0),
    v3(C.halfWidth, top, 0),
  ];
  const full = [...half.slice(1).reverse().map((p) => v3(-p.x, p.y, 0)), ...half.slice(1)];
  // Round the moulded corners (sole/footwell, seat front edge, seat/coaming).
  return filletPath(full, 0.022, 4);
}

const TRAVELLER = BOAT.boom.traveler;

export function buildCockpit(ctx: BuildContext): Part[] {
  const parts: Part[] = [];
  const C = COCKPIT;
  const n = Math.max(8, Math.round(26 * ctx.detail.deck));
  const rows: V3[][] = [];
  // Quarter decks aft of the seats: two stations 5 mm apart make the seat end a vertical step.
  rows.push(crossSection(X_TRANSOM, true).map((p) => loc(X_TRANSOM, p.x, p.y)));
  rows.push(crossSection(C.xSeatAft - 0.0025, true).map((p) => loc(C.xSeatAft - 0.0025, p.x, p.y)));
  for (let i = 0; i <= n; i++) {
    const x = C.xSeatAft + 0.0025 + (C.xFwd - C.xSeatAft - 0.0025) * (i / n);
    rows.push(crossSection(x, false).map((p) => loc(x, p.x, p.y)));
  }
  // Sweep: rows along x (toward the bow), columns port → starboard; faces point into the well.
  const nc = rows[0].length;
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  rows.forEach((row) => row.forEach((p) => { pos.push(p.x, p.y, p.z); uv.push(planU(-p.z), planV(p.x)); }));
  for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < nc - 1; j++) {
    const a = i * nc + j, b = (i + 1) * nc + j, c = (i + 1) * nc + j + 1, d = i * nc + j + 1;
    index.push(a, c, b, a, d, c);
  }
  const well = new THREE.BufferGeometry();
  well.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  well.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  well.setIndex(index);
  well.computeVertexNormals();
  parts.push({ geometry: well, mat: 'deck', shadow: true });

  // Front wall (faces aft) closing the well under the cabin's aft face.
  const xf = C.xFwd;
  const front = rows[rows.length - 1];
  const topLine: V3[] = [];
  for (let k = 1; k < 8; k++) {
    const y = C.halfWidth - (2 * C.halfWidth * k) / 8;
    topLine.push(loc(xf, y, deckH(xf, y)));
  }
  parts.push({
    geometry: planarFace([...front, ...topLine], [], v3(0, 0, 1), (p) => new THREE.Vector2(p.x, p.y), (p) => [planU(xf), planV(p.x)]),
    mat: 'deck', shadow: true,
  });

  // Transom: hull section at the transom around the cockpit cut-out (open transom), paint-mapped.
  const st = ctx.lines.stations[0];
  const m = st.y.length;
  const contour: V3[] = [];
  for (let j = m - 1; j >= 0; j--) contour.push(loc(X_TRANSOM, -st.y[j], st.h[j]));
  for (let j = 1; j < m; j++) contour.push(loc(X_TRANSOM, st.y[j], st.h[j]));
  const bs = deckHalfBeam(X_TRANSOM);
  for (let k = 1; k < 6; k++) {
    const y = bs - ((bs - C.halfWidth) * k) / 6;
    contour.push(loc(X_TRANSOM, y, deckH(X_TRANSOM, y)));
  }
  const back = rows[0];
  for (let j = nc - 1; j >= 0; j--) contour.push(back[j]);
  for (let k = 1; k < 6; k++) {
    const y = -(C.halfWidth + ((bs - C.halfWidth) * k) / 6);
    contour.push(loc(X_TRANSOM, y, deckH(X_TRANSOM, y)));
  }
  const P = PAINT_UV;
  parts.push({
    geometry: planarFace(contour, [], v3(0, 0, 1), (p) => new THREE.Vector2(p.x, p.y),
      (p) => [(X_TRANSOM - P.x0) / (P.x1 - P.x0), (p.y - P.h0) / (P.h1 - P.h0)], (p) => [p.x * 0.5, p.y]),
    mat: 'hull', shadow: true,
  });

  // Transom name on the band below the cut-out.
  const nameH = 0.5 * (st.h[0] + C.soleH) + 0.01;
  const decal = new THREE.PlaneGeometry(1.02, 0.16);
  parts.push({ geometry: place(decal, v3(0, nameH, -X_TRANSOM + 0.002)), mat: 'decal' });

  // Traveller bridge across the footwell at seat height (its track is a fitting).
  const bridge = roundedBox(2 * C.footwellHalf + 0.02, 0.085, 0.13, 0.02);
  place(bridge, loc(TRAVELLER.x, 0, C.seatH - 0.0425));
  planUV(bridge);
  parts.push({ geometry: bridge, mat: 'deck', shadow: true });

  // Rudder tube: moulded post from the sole with a filleted foot, stainless bearing cap on top.
  const tubeTop = BOAT.tiller.headH - 0.1;
  const post = lathe([[0.1, 0], [0.085, 0.006], [0.07, 0.02], [0.064, 0.05], [0.062, tubeTop - C.soleH - 0.01], [0.058, tubeTop - C.soleH], [0, tubeTop - C.soleH]], ctx.detail.lathe);
  place(post, loc(BOAT.rudder.stockX, 0, C.soleH - 0.001));
  planUV(post);
  parts.push({ geometry: post, mat: 'deck', shadow: true });
  const cap = lathe([[0, 0], [0.07, 0], [0.07, 0.01], [0.05, 0.018], [0.036, 0.022], [0, 0.022]], ctx.detail.lathe);
  parts.push({ geometry: place(cap, loc(BOAT.rudder.stockX, 0, tubeTop)), mat: 'polished', shadow: true });

  // Cockpit drains are not needed (open transom); add the sole's aft lip as a rounded edge.
  const lip = tube([loc(X_TRANSOM + 0.004, -C.footwellHalf + 0.02, C.soleH - 0.006), loc(X_TRANSOM + 0.004, C.footwellHalf - 0.02, C.soleH - 0.006)], {
    radius: 0.008, radial: 6, capStart: true, capEnd: true,
  });
  planUV(lip);
  parts.push({ geometry: lip, mat: 'deck' });

  ctx.pads.push(
    // Smooth margin around the bridge and the bearing on the sole.
    [[TRAVELLER.x - 0.11, -C.footwellHalf], [TRAVELLER.x + 0.11, -C.footwellHalf], [TRAVELLER.x + 0.11, C.footwellHalf], [TRAVELLER.x - 0.11, C.footwellHalf]],
    circle(BOAT.rudder.stockX, 0, 0.12),
  );
  return parts;
}

/** Plan-projected UVs for small mouldings that use the deck material. */
export function planUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = planU(-p.getZ(i)); uv[i * 2 + 1] = planV(p.getX(i)); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

export function circle(x: number, y: number, r: number, n = 16): Array<[number, number]> {
  return Array.from({ length: n }, (_, k) => [x + r * Math.cos((2 * Math.PI * k) / n), y + r * Math.sin((2 * Math.PI * k) / n)] as [number, number]);
}
