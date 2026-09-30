// Procedural textures for the boat (no image assets): hull paint zones, deck plan (non-skid panels,
// margins, baked ambient occlusion), non-skid and gelcoat-fairness normal tiles, varnished wood,
// rope braid and the transom name. Browser-only (canvas).
import * as THREE from 'three';
import { BOAT } from '../../shared/boatSpec';
import { COCKPIT, PLAN_UV, cabinHalfWidth, holeHalfWidth } from './deck';
import { PAINT_UV, X_STEM, X_TRANSOM, deckHalfBeam, sheerH } from './hull';

const CAB = BOAT.cabin;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function canvasTexture(c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Deterministic hash noise in [0, 1). */
function hash(ix: number, iy: number, seed = 0): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable smooth value noise on a period-`p` lattice. */
function valueNoise(x: number, y: number, p: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (a: number) => ((a % p) + p) % p;
  const a = hash(w(ix), w(iy), seed), b = hash(w(ix + 1), w(iy), seed);
  const c = hash(w(ix), w(iy + 1), seed), d = hash(w(ix + 1), w(iy + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Tileable smooth-noise table (TABLE×TABLE, lattice period 16) for the big per-pixel loops: a table
 * lookup is ~20× cheaper than evaluating value noise per pixel of a 2048² canvas.
 */
const TABLE = 256;
const noiseTables = new Map<number, Float32Array>();
function noiseTable(seed: number): Float32Array {
  let t = noiseTables.get(seed);
  if (!t) {
    t = new Float32Array(TABLE * TABLE);
    // Seed −1: white noise (one random value per texel) for speckle.
    for (let y = 0; y < TABLE; y++) for (let x = 0; x < TABLE; x++) t[y * TABLE + x] = seed < 0 ? hash(x, y, 77) : valueNoise(x / 16, y / 16, TABLE / 16, seed);
    noiseTables.set(seed, t);
  }
  return t;
}
/** Smooth noise with features ≈ `scale` pixels (bilinear table lookup, wraps). */
function tableNoise(t: Float32Array, x: number, y: number, scale: number): number {
  const u = (x * 16) / scale, v = (y * 16) / scale;
  const ix = Math.floor(u), iy = Math.floor(v);
  const fx = u - ix, fy = v - iy;
  const x0 = ix & (TABLE - 1), y0 = iy & (TABLE - 1), x1 = (x0 + 1) & (TABLE - 1), y1 = (y0 + 1) & (TABLE - 1);
  const a = t[y0 * TABLE + x0], b = t[y0 * TABLE + x1], c = t[y1 * TABLE + x0], d = t[y1 * TABLE + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Normal map (RGBA8, tangent space) from a tileable height function on an n×n grid. */
function normalMapFromHeights(n: number, height: Float32Array, strength: number): THREE.DataTexture {
  const data = new Uint8Array(n * n * 4);
  const at = (x: number, y: number) => height[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// --- Hull paint ------------------------------------------------------------------------------------

export const PAINT = {
  topsides: '#eeefeb',
  boot: '#16233f',
  cove: '#16233f',
  antifouling: '#2c3034',
};

/** Boot-top band (sprung: a little higher and wider toward the ends, as painted on real boats). */
export function bootStripe(x: number): { lo: number; hi: number } {
  const mid = 0.5 * (BOAT.hull.stemWL.x + BOAT.hull.transomWL.x);
  const s = (x - mid) / (0.5 * BOAT.hull.lwl);
  const s2 = Math.min(1.6, s * s);
  const lo = 0.035 + 0.035 * s2;
  return { lo, hi: lo + 0.075 + 0.02 * s2 };
}

/** Colour map + (R clearcoat, G roughness) map in (x, h) profile coordinates. */
export function hullPaintTextures(size: number): { map: THREE.CanvasTexture; orm: THREE.CanvasTexture } {
  const W = size, Hh = size / 4;
  const [c, ctx] = canvas(W, Hh);
  const [o, octx] = canvas(W, Hh);
  const P = PAINT_UV;
  const px = (x: number) => ((x - P.x0) / (P.x1 - P.x0)) * W;
  const py = (h: number) => (1 - (h - P.h0) / (P.h1 - P.h0)) * Hh;
  const band = (g: CanvasRenderingContext2D, lo: (x: number) => number, hi: (x: number) => number) => {
    g.beginPath();
    const n = 200;
    for (let i = 0; i <= n; i++) {
      const x = P.x0 + (P.x1 - P.x0) * (i / n);
      if (i === 0) g.moveTo(px(x), py(hi(x))); else g.lineTo(px(x), py(hi(x)));
    }
    for (let i = n; i >= 0; i--) {
      const x = P.x0 + (P.x1 - P.x0) * (i / n);
      g.lineTo(px(x), py(lo(x)));
    }
    g.closePath();
    g.fill();
  };
  // Colour.
  ctx.fillStyle = PAINT.topsides;
  ctx.fillRect(0, 0, W, Hh);
  ctx.fillStyle = PAINT.antifouling;
  band(ctx, () => P.h0 - 1, (x) => bootStripe(x).lo);
  ctx.fillStyle = PAINT.boot;
  band(ctx, (x) => bootStripe(x).lo, (x) => bootStripe(x).hi);
  ctx.fillStyle = PAINT.cove;
  band(ctx, (x) => sheerH(x) - 0.082, (x) => sheerH(x) - 0.07);
  // Faint wet/dirty band where the sea surface usually sits (fades above and below the waterline).
  const g = ctx.createLinearGradient(0, py(0.06), 0, py(-0.03));
  g.addColorStop(0, 'rgba(92, 84, 52, 0)');
  g.addColorStop(0.45, 'rgba(92, 84, 52, 0.30)');
  g.addColorStop(0.6, 'rgba(70, 72, 48, 0.34)');
  g.addColorStop(1, 'rgba(70, 72, 48, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, py(0.06), W, py(-0.03) - py(0.06));
  // Faint weathering on the antifouling (sponge marks) so it is not a flat fill.
  const img = ctx.getImageData(0, 0, W, Hh);
  const n3 = noiseTable(3), n4 = noiseTable(4);
  for (let y = 0; y < Hh; y++) {
    const h = P.h0 + (P.h1 - P.h0) * (1 - y / Hh);
    for (let x = 0; x < W; x++) {
      const xx = P.x0 + (P.x1 - P.x0) * (x / W);
      if (h > bootStripe(xx).lo) continue;
      const n = tableNoise(n3, x, y, 24) * 0.6 + tableNoise(n4, x, y, 6) * 0.4;
      const k = 0.9 + 0.2 * n;
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, img.data[i] * k);
      img.data[i + 1] = Math.min(255, img.data[i + 1] * k);
      img.data[i + 2] = Math.min(255, img.data[i + 2] * k);
    }
  }
  ctx.putImageData(img, 0, 0);
  // Clearcoat (R) and roughness (G).
  octx.fillStyle = 'rgb(255, 72, 0)';
  octx.fillRect(0, 0, W, Hh);
  octx.fillStyle = 'rgb(0, 222, 0)';
  band(octx, () => P.h0 - 1, (x) => bootStripe(x).lo);
  octx.fillStyle = 'rgb(255, 60, 0)';
  band(octx, (x) => bootStripe(x).lo, (x) => bootStripe(x).hi);
  return { map: canvasTexture(c, true), orm: canvasTexture(o, false) };
}

// --- Deck plan -------------------------------------------------------------------------------------

export type PlanPt = [number, number];

/** Rounded-corner polygon helper (plan metres) → canvas path. */
function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): PlanPt[] {
  const pts: PlanPt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let k = 0; k <= 6; k++) {
      const a = a0 + (Math.PI / 2) * (k / 6);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  corner(x1 - r, y0 + r, 1.5 * Math.PI);
  return pts;
}

/**
 * Deck plan textures in (x, y) plan coordinates: colour (non-skid panels with smooth gelcoat margins)
 * and ORM (R = ambient occlusion, G = roughness, B = non-skid mask).
 */
export function deckPlanTextures(size: number, pads: PlanPt[][]): { map: THREE.CanvasTexture; orm: THREE.CanvasTexture } {
  const W = size, Hh = size / 2;
  const U = PLAN_UV;
  const px = (x: number) => ((x - U.x0) / (U.x1 - U.x0)) * W;
  const py = (y: number) => (1 - (y - U.y0) / (U.y1 - U.y0)) * Hh;
  const path = (g: CanvasRenderingContext2D, poly: PlanPt[]) => {
    poly.forEach(([x, y], i) => (i === 0 ? g.moveTo(px(x), py(y)) : g.lineTo(px(x), py(y))));
    g.closePath();
  };

  // Non-skid mask (white = non-skid).
  const [, mctx] = canvas(W, Hh);
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, W, Hh);
  mctx.fillStyle = '#fff';
  const margin = 0.055;
  const xAft = X_TRANSOM + 0.06, xTip = X_STEM - 0.32;
  // Deck: between the sheer inset and the opening outset (even-odd with the opening polygon).
  mctx.beginPath();
  const outer: PlanPt[] = [];
  const n = 240;
  for (let i = 0; i <= n; i++) {
    const x = xAft + (xTip - xAft) * (i / n);
    outer.push([x, deckHalfBeam(x) - margin - 0.02]);
  }
  for (let i = n; i >= 0; i--) {
    const x = xAft + (xTip - xAft) * (i / n);
    outer.push([x, -(deckHalfBeam(x) - margin - 0.02)]);
  }
  path(mctx, outer);
  const inner: PlanPt[] = [];
  const xs: number[] = [];
  for (let i = 0; i <= 400; i++) xs.push(X_TRANSOM - 0.5 + (CAB.xFwd + margin + 0.02 - X_TRANSOM + 0.5) * (i / 400));
  const hw = (x: number) => {
    // Opening outset by the margin (sampled with a small look-around so the front stays rounded).
    let w = 0;
    for (let d = -margin; d <= margin; d += margin / 4) w = Math.max(w, holeHalfWidth(x + d));
    return w > 0 ? w + margin : 0;
  };
  for (const x of xs) inner.push([x, hw(x)]);
  for (let i = xs.length - 1; i >= 0; i--) inner.push([xs[i], -hw(xs[i])]);
  path(mctx, inner);
  mctx.fill('evenodd');

  // Cabin top: inset footprint, minus the companionway slide and the fore hatch surround.
  const cabInset = 0.16;
  const top: PlanPt[] = [];
  const cx0 = CAB.xAft + 0.06, cx1 = CAB.xFwd - 0.2;
  for (let i = 0; i <= 120; i++) {
    const x = cx0 + (cx1 - cx0) * (i / 120);
    top.push([x, Math.max(0, cabinHalfWidth(x + 0.1) - cabInset)]);
  }
  for (let i = 120; i >= 0; i--) {
    const x = cx0 + (cx1 - cx0) * (i / 120);
    top.push([x, -Math.max(0, cabinHalfWidth(x + 0.1) - cabInset)]);
  }
  mctx.beginPath();
  path(mctx, top);
  mctx.fill();

  // Cockpit seats and sole.
  const seatIn = COCKPIT.footwellHalf + 0.05, seatOut = COCKPIT.halfWidth - 0.045;
  const seatA = X_TRANSOM + 0.08, seatF = COCKPIT.xFwd - 0.06;
  for (const s of [1, -1]) {
    const [a, b] = s > 0 ? [seatIn, seatOut] : [-seatOut, -seatIn];
    mctx.beginPath(); path(mctx, roundedRect(seatA, a, -2.45, b, 0.03)); mctx.fill();
    mctx.beginPath(); path(mctx, roundedRect(-2.37, a, seatF, b, 0.03)); mctx.fill();
  }
  const sole = COCKPIT.footwellHalf - 0.05;
  mctx.beginPath(); path(mctx, roundedRect(X_TRANSOM + 0.05, -sole, -2.26, sole, 0.03)); mctx.fill();
  mctx.beginPath(); path(mctx, roundedRect(-2.04, -sole, COCKPIT.xFwd - 0.06, sole, 0.03)); mctx.fill();

  // Smooth pads around hardware and hatches.
  mctx.fillStyle = '#000';
  for (const pad of pads) { mctx.beginPath(); path(mctx, pad); mctx.fill(); }

  // Ambient occlusion: dark, blurred strokes along inside corners, drawn at quarter resolution
  // (it is low frequency) and sampled bilinearly below.
  const AO_DIV = 4, AW = W / AO_DIV, AH = Hh / AO_DIV;
  const [, actx] = canvas(AW, AH);
  actx.fillStyle = '#fff';
  actx.fillRect(0, 0, AW, AH);
  const pxPerM = AW / (U.x1 - U.x0);
  const ax = (x: number) => px(x) / AO_DIV, ay = (y: number) => py(y) / AO_DIV;
  const stroke = (poly: PlanPt[], widthM: number, alpha: number, blurM: number) => {
    actx.save();
    actx.filter = `blur(${Math.max(0.5, blurM * pxPerM)}px)`;
    actx.strokeStyle = `rgba(0,0,0,${alpha})`;
    actx.lineWidth = widthM * pxPerM;
    actx.lineJoin = 'round';
    actx.beginPath();
    poly.forEach(([x, y], i) => (i === 0 ? actx.moveTo(ax(x), ay(y)) : actx.lineTo(ax(x), ay(y))));
    actx.stroke();
    actx.restore();
  };
  const cabinLine: PlanPt[] = [];
  for (let i = 0; i <= 200; i++) {
    const x = CAB.xAft + (CAB.xFwd - CAB.xAft) * (i / 200);
    cabinLine.push([x, cabinHalfWidth(x)]);
  }
  const cabinLoop = [...cabinLine, ...cabinLine.slice().reverse().map(([x, y]): PlanPt => [x, -y])];
  stroke(cabinLoop, 0.05, 0.5, 0.035);
  for (const s of [1, -1]) {
    stroke([[X_TRANSOM, s * COCKPIT.footwellHalf], [COCKPIT.xFwd, s * COCKPIT.footwellHalf]], 0.1, 0.55, 0.05);
    stroke([[X_TRANSOM, s * COCKPIT.halfWidth], [COCKPIT.xFwd, s * COCKPIT.halfWidth]], 0.06, 0.35, 0.03);
  }
  stroke([[COCKPIT.xFwd, -COCKPIT.halfWidth], [COCKPIT.xFwd, COCKPIT.halfWidth]], 0.1, 0.5, 0.05);
  // Deep footwell overall darker.
  actx.fillStyle = 'rgba(0,0,0,0.18)';
  actx.fillRect(ax(X_TRANSOM), ay(COCKPIT.footwellHalf), ax(COCKPIT.xFwd) - ax(X_TRANSOM), ay(-COCKPIT.footwellHalf) - ay(COCKPIT.footwellHalf));
  const aoSmall = actx.getImageData(0, 0, AW, AH).data;
  const aoAt = (x: number, y: number) => {
    const u = Math.min(AW - 1.001, Math.max(0, (x + 0.5) / AO_DIV - 0.5)), v = Math.min(AH - 1.001, Math.max(0, (y + 0.5) / AO_DIV - 0.5));
    const iu = u | 0, iv = v | 0, fu = u - iu, fv = v - iv;
    const i00 = (iv * AW + iu) * 4, i01 = i00 + 4, i10 = i00 + AW * 4, i11 = i10 + 4;
    return (aoSmall[i00] * (1 - fu) + aoSmall[i01] * fu) * (1 - fv) + (aoSmall[i10] * (1 - fu) + aoSmall[i11] * fu) * fv;
  };

  // Compose colour and ORM.
  const [c, ctx] = canvas(W, Hh);
  const [o, octx] = canvas(W, Hh);
  const mask = mctx.getImageData(0, 0, W, Hh).data;
  const col = ctx.createImageData(W, Hh);
  const orm = octx.createImageData(W, Hh);
  const smooth = [236, 237, 233], grit = [190, 193, 194];
  // Wear: a little grime settles in inside corners (baked from the AO strokes) and where feet go in
  // the cockpit; warm-grey, low frequency, never more than ~12 %.
  const footX0 = px(X_TRANSOM), footX1 = px(COCKPIT.xFwd), footY0 = py(COCKPIT.halfWidth), footY1 = py(-COCKPIT.halfWidth);
  const n9 = noiseTable(9), n17 = noiseTable(17), rnd = noiseTable(-1);
  const cd = col.data, od = orm.data;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const k = mask[i] / 255;
      const ao = aoAt(x, y);
      const speck = (rnd[((y * 7) & (TABLE - 1)) * TABLE + ((x * 13 + y) & (TABLE - 1))] - 0.5) * 22 * k + (tableNoise(n9, x, y, 40) - 0.5) * 10;
      const inCockpit = x > footX0 && x < footX1 && y > footY0 && y < footY1;
      const dirt = 1 - 0.1 * (1 - ao / 255) - (inCockpit ? 0.06 * tableNoise(n17, x, y * 1.5, 90) * (0.5 + k) : 0);
      cd[i] = (smooth[0] + (grit[0] - smooth[0]) * k + speck) * dirt;
      cd[i + 1] = (smooth[1] + (grit[1] - smooth[1]) * k + speck) * dirt * 0.995;
      cd[i + 2] = (smooth[2] + (grit[2] - smooth[2]) * k + speck) * dirt * 0.985;
      cd[i + 3] = 255;
      od[i] = ao;
      od[i + 1] = (0.16 + 0.64 * k) * 255;
      od[i + 2] = mask[i];
      od[i + 3] = 255;
    }
  }
  ctx.putImageData(col, 0, 0);
  octx.putImageData(orm, 0, 0);
  return { map: canvasTexture(c, true), orm: canvasTexture(o, false) };
}

// --- Tiles -----------------------------------------------------------------------------------------

/** Moulded non-skid: a dense field of small rounded bumps (tile ≈ 0.2 m). */
export function nonSkidNormal(n = 256): THREE.DataTexture {
  const hgt = new Float32Array(n * n);
  const cell = 4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const wx = ((gx % (n / cell)) + n / cell) % (n / cell), wy = ((gy % (n / cell)) + n / cell) % (n / cell);
          const jx = (gx + 0.2 + 0.6 * hash(wx, wy, 11)) * cell, jy = (gy + 0.2 + 0.6 * hash(wx, wy, 12)) * cell;
          const r = Math.hypot(x - jx, y - jy) / (cell * 0.55);
          best = Math.max(best, Math.max(0, 1 - r * r));
        }
      }
      hgt[y * n + x] = best + 0.15 * valueNoise(x / 3, y / 3, n / 3, 13);
    }
  }
  return normalMapFromHeights(n, hgt, 1.6);
}

/** Very low-frequency waviness of a gelcoat hull (reflections are never perfectly fair). */
export function fairnessNormal(n = 256): THREE.DataTexture {
  const hgt = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      hgt[y * n + x] = valueNoise(x / 64, y / 64, n / 64, 21) + 0.35 * valueNoise(x / 21.333, y / 21.333, n / 21.333, 22);
    }
  }
  return normalMapFromHeights(n, hgt, 5);
}

/** Varnished teak/ash: warm base with long grain streaks along u. */
export function woodTexture(w = 512, h = 64): THREE.CanvasTexture {
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const grain = 0.5 + 0.5 * Math.sin(y * 0.9 + valueNoise(x / 60, y / 5, 1 << 20, 31) * 6);
      const fine = valueNoise(x / 3, y * 1.5, 1 << 20, 32);
      const k = 0.78 + 0.16 * grain + 0.08 * fine;
      const i = (y * w + x) * 4;
      img.data[i] = 150 * k; img.data[i + 1] = 88 * k; img.data[i + 2] = 44 * k; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c, true);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * 16-plait braid around one circumference (u) and one braid repeat along the rope (v):
 * two helical strand families crossing two-over-two-under. Returns height and which family is on top.
 */
function braid(u: number, v: number): { h: number; strand: number; family: 0 | 1 } {
  const a = u * 8 + v * 4, b = u * 8 - v * 4;
  const ia = Math.floor(a), ib = Math.floor(b);
  const aTop = (Math.floor((ia + ib) / 2) & 1) === 0;
  const pa = Math.sin(Math.PI * (a - ia)), pb = Math.sin(Math.PI * (b - ib));
  const ha = pa * (aTop ? 1 : 0.55), hb = pb * (aTop ? 0.55 : 1);
  return ha >= hb ? { h: ha, strand: ((ia % 8) + 8) % 8, family: 0 } : { h: hb, strand: ((ib % 8) + 8) % 8, family: 1 };
}

/** Braid bump for the rope normal map (repeat 8 × 1 over the atlas UVs). */
export function ropeBraidNormal(n = 64): THREE.DataTexture {
  const hgt = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) hgt[y * n + x] = braid(x / n, y / n).h;
  return normalMapFromHeights(n, hgt, 2.2);
}

/** Rope colours (base, tracer) per atlas cell; see materials.ROPE. */
const ROPE_COLOURS: Array<[string, string]> = [
  ['#1d4fa8', '#f2f2ee'], // main sheet: blue, white fleck
  ['#f0efea', '#c8202a'], // port jib sheet: white, red fleck
  ['#f0efea', '#1f8a3c'], // starboard jib sheet: white, green fleck
  ['#f06a14', '#1b1b1b'], // spinnaker sheets and guys: signal orange, black tracer
  ['#f3f2ee', '#2a55b8'], // halyards: white, blue fleck
  ['#34373b', '#d9c21e'], // control lines: charcoal, yellow fleck
  ['#161718', '#e8e8e8'], // furling line, adjusters: black, white fleck
  ['#a9adb0', '#5d6166'], // bare Dyneema: grey
];

/** Colour atlas: 8 cells across (one per rope colour), each one circumference × one braid repeat. */
export function ropeAtlas(): THREE.CanvasTexture {
  const cw = 64, ch = 128, cells = ROPE_COLOURS.length;
  const [c, ctx] = canvas(cw * cells, ch);
  const img = ctx.createImageData(cw * cells, ch);
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let k = 0; k < cells; k++) {
    const base = rgb(ROPE_COLOURS[k][0]), tracer = rgb(ROPE_COLOURS[k][1]);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const b = braid(x / cw, y / ch);
        const isTracer = b.family === 0 && (b.strand === 0 || b.strand === 4);
        const col = isTracer ? tracer : base;
        const shade = 0.5 + 0.5 * b.h + (hash(x + k * 97, y, 41) - 0.5) * 0.08;
        const i = (y * cw * cells + k * cw + x) * 4;
        img.data[i] = col[0] * shade; img.data[i + 1] = col[1] * shade; img.data[i + 2] = col[2] * shade; img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c, true);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Fine brushing streaks along u (brushed stainless). */
export function brushedNormal(n = 128): THREE.DataTexture {
  const hgt = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) hgt[y * n + x] = hash(0, y, 51) * 0.7 + valueNoise(x / 32, y, n / 32, 52) * 0.3;
  return normalMapFromHeights(n, hgt, 0.8);
}

/**
 * Furled jib seen from outside: the sun-faded acrylic UV strip wraps the roll; thin pale lines show
 * where the leech spirals round (u around the roll, v along it, ~1 m per repeat).
 */
export function furlTexture(): THREE.CanvasTexture {
  const w = 128, h = 256;
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const spiral = ((x / w) + (y / h) * 7) % 1;
      const edge = Math.exp(-Math.pow((spiral - 0.5) / 0.02, 2));
      const fold = 0.93 + 0.07 * Math.sin((x / w) * Math.PI * 2 * 3 + y * 0.05) + (hash(x, y, 61) - 0.5) * 0.05;
      const i = (y * w + x) * 4;
      const base = [58, 80, 104];
      const pale = [214, 214, 206];
      for (let k = 0; k < 3; k++) img.data[i + k] = (base[k] * (1 - edge) + pale[k] * edge) * fold;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c, true);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Boat name for the transom (transparent background). */
export function nameDecal(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 160);
  ctx.clearRect(0, 0, 1024, 160);
  ctx.fillStyle = PAINT.boot;
  ctx.font = '600 118px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const letters = text.split('').join(String.fromCharCode(8202));
  ctx.fillText(letters, 512, 84);
  return canvasTexture(c, true);
}
