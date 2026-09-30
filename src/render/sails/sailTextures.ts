// Procedural sail textures (spec §9.6), drawn once on 2-D canvases in plan metres (see SailPlan).
//
// Each Dacron sail gets:
//  - base (RGBA DataTexture): RGB = cloth albedo (panels, stitching, tapes, patches, head board);
//    A = cloth thickness in plies / 4 — seams, patches, tapes, battens and the UV strip are extra plies,
//    which the material turns into darker transmission (backlit) and bump (sunlit ridges);
//  - two premultiplied decal textures, one per face: draft stripes, class insignia, sail numbers (starboard
//    numbers sit higher than port ones, as the racing rules require, and each reads correctly from its side).
// Canvas row 0 is plan y0 (the foot), so no texture flip is needed: v = 0 at the foot.
import * as THREE from 'three';
import type { PlanPoint, SailPlan } from './sailMesh';
import type { BattenPlan } from './mainMesh';

/** Plies-canvas grey level of one ply (alpha = plies / 4). */
const PLY = 64;
const CLOTH = [237, 234, 224] as const;
const THREAD = 'rgba(150,146,132,0.55)';
const NAVY_INK = '#141d33';
const STRIPE_INK = '#1b1f27';

export interface SailTextureSet {
  base: THREE.DataTexture;
  decalFront: THREE.Texture;
  decalBack: THREE.Texture;
  dispose(): void;
}

/** Cross-cut seam layout: seams ⟂ `dir` (the clew→head leech line) at origin + k·panel·dir, k ≥ 1. */
export interface SeamLayout { origin: PlanPoint; dir: PlanPoint; panel: number }

export function seamLayout(plan: SailPlan, kind: 'main' | 'jib'): SeamLayout {
  const n = plan.leech.length - 1;
  const clew = plan.leech[0]!, top = plan.leech[n]!;
  const l = Math.hypot(top.x - clew.x, top.y - clew.y) || 1;
  return { origin: clew, dir: { x: (top.x - clew.x) / l, y: (top.y - clew.y) / l }, panel: kind === 'main' ? 0.92 : 0.9 };
}

/**
 * Clear vinyl telltale windows in the jib (rounded rectangles, plan metres): centred just aft of each luff
 * telltale (12 % chord at 25/50/75 % height), so the helmsman sees the leeward telltale from windward.
 */
export interface WindowLayout { centres: PlanPoint[]; half: PlanPoint; radius: number }

export function jibWindows(plan: SailPlan): WindowLayout {
  const centres = [0.25, 0.5, 0.75].map((v) => {
    const { a, b } = plan.rowAt(v);
    return { x: a.x + (b.x - a.x) * 0.12 + 0.035, y: a.y + (b.y - a.y) * 0.12 };
  });
  return { centres, half: { x: 0.07, y: 0.055 }, radius: 0.02 };
}

/** Deterministic LCG so every load draws the same sail. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const sub = (a: PlanPoint, b: PlanPoint): PlanPoint => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: PlanPoint, b: PlanPoint, k = 1): PlanPoint => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const unit = (a: PlanPoint): PlanPoint => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };

/** A canvas whose drawing coordinates are plan metres. */
class PlanCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  readonly plan: SailPlan;
  readonly W: number;
  readonly H: number;

  constructor(plan: SailPlan, W: number, H: number, fill: string | null) {
    this.plan = plan;
    this.W = W;
    this.H = H;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    if (fill) { this.g.fillStyle = fill; this.g.fillRect(0, 0, W, H); }
    this.toPlan();
  }

  toPlan(): void {
    const { plan, W, H } = this;
    this.g.setTransform(W / plan.w, 0, 0, H / plan.h, (-plan.x0 * W) / plan.w, (-plan.y0 * H) / plan.h);
  }

  outlinePath(): void {
    const { g, plan } = this;
    g.beginPath();
    plan.luff.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
    for (let i = plan.leech.length - 1; i >= 0; i--) g.lineTo(plan.leech[i]!.x, plan.leech[i]!.y);
    g.closePath();
  }

  /** Run `fn` clipped to the sail outline. */
  clipped(fn: () => void): void {
    this.g.save();
    this.outlinePath();
    this.g.clip();
    fn();
    this.g.restore();
  }

  polyline(pts: PlanPoint[]): void {
    const g = this.g;
    g.beginPath();
    pts.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
  }

  line(a: PlanPoint, b: PlanPoint, width: number, style: string, dash?: number[]): void {
    const g = this.g;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.lineWidth = width;
    g.strokeStyle = style;
    g.setLineDash(dash ?? []);
    g.stroke();
    g.setLineDash([]);
  }
}

/** The four canvases of a Dacron sail, drawn in parallel. */
class DacronLayers {
  readonly albedo: PlanCanvas;
  readonly plies: PlanCanvas;
  readonly stbd: PlanCanvas;
  readonly port: PlanCanvas;
  readonly rand: () => number;

  constructor(readonly plan: SailPlan, W: number, H: number, seed: number) {
    this.albedo = new PlanCanvas(plan, W, H, `rgb(${CLOTH.join(',')})`);
    this.plies = new PlanCanvas(plan, W, H, `rgb(${PLY},${PLY},${PLY})`);
    this.plies.g.globalCompositeOperation = 'lighter';
    // Decals (stripes, insignia, numbers) are bold shapes: half resolution is ample and halves their memory.
    const dw = Math.max(64, Math.round(W / 2)), dh = Math.max(64, Math.round(H / 2));
    this.stbd = new PlanCanvas(plan, dw, dh, null);
    this.port = new PlanCanvas(plan, dw, dh, null);
    this.rand = rng(seed);
  }

  /** Grey level adding `n` plies (the plies canvas composites additively). */
  static ply(n: number): string {
    const v = Math.round(PLY * n);
    return `rgb(${v},${v},${v})`;
  }

  /** Cross-cut panels perpendicular to the leech, each a slightly different roll of cloth, with seams. */
  crossCut(layout: SeamLayout): void {
    const { origin: clew, dir: L, panel } = layout;
    const S = { x: -L.y, y: L.x };
    const span = this.plan.h + this.plan.w + 3;
    const { albedo } = this;
    albedo.clipped(() => {
      for (let k = -2; k * panel < span; k++) {
        const a = add(clew, L, k * panel), b = add(clew, L, (k + 1) * panel);
        const shade = (this.rand() - 0.5) * 5, warm = (this.rand() - 0.5) * 2.5;
        const g = albedo.g;
        g.beginPath();
        g.moveTo(a.x - S.x * 9, a.y - S.y * 9);
        g.lineTo(a.x + S.x * 9, a.y + S.y * 9);
        g.lineTo(b.x + S.x * 9, b.y + S.y * 9);
        g.lineTo(b.x - S.x * 9, b.y - S.y * 9);
        g.closePath();
        g.fillStyle = `rgb(${CLOTH[0] + shade + warm},${CLOTH[1] + shade},${CLOTH[2] + shade - warm})`;
        g.fill();
      }
    });
    for (let k = 1; k * panel < span; k++) this.seam(add(clew, L, k * panel), S);
  }

  /** A seam across the sail through `p` along `dir`: 18 mm overlap (2 plies) and two zig-zag stitch rows. */
  seam(p: PlanPoint, dir: PlanPoint, overlap = 0.018): void {
    const a = add(p, dir, -9), b = add(p, dir, 9);
    const n = { x: -dir.y, y: dir.x };
    this.plies.clipped(() => this.plies.line(a, b, overlap, DacronLayers.ply(1)));
    this.albedo.clipped(() => {
      this.albedo.line(a, b, overlap, 'rgba(255,255,250,0.10)');
      for (const s of [-0.0055, 0.0055]) {
        this.albedo.line(add(a, n, s), add(b, n, s), 0.0026, THREAD, [0.005, 0.0035]);
      }
    });
  }

  /** Edge tape of `width` inside the outline along a polyline, `n` extra plies, stitched on its inner edge. */
  tape(pts: PlanPoint[], width: number, n: number, colour?: string): void {
    this.plies.clipped(() => {
      this.plies.polyline(pts);
      this.plies.g.lineWidth = width * 2;
      this.plies.g.strokeStyle = DacronLayers.ply(n);
      this.plies.g.stroke();
    });
    this.albedo.clipped(() => {
      const g = this.albedo.g;
      if (colour) {
        this.albedo.polyline(pts);
        g.lineWidth = width * 2;
        g.strokeStyle = colour;
        g.stroke();
      }
      // Stitch row just inside the tape's inner edge.
      this.albedo.polyline(pts);
      g.lineWidth = width * 2 - 0.012;
      g.strokeStyle = THREAD;
      g.setLineDash([0.005, 0.0035]);
      g.globalCompositeOperation = 'source-over';
      g.stroke();
      g.setLineDash([]);
      this.albedo.polyline(pts);
      g.lineWidth = width * 2 - 0.018;
      g.strokeStyle = colour ?? `rgb(${CLOTH.join(',')})`;
      g.stroke();
    });
  }

  /**
   * Layered radial corner patch, built like a real one: each layer is a fan of cloth strips radiating
   * from the corner with pointed, staggered finger ends; every layer adds a ply, its outline and the radial
   * seams between strips are stitched.
   */
  cornerPatch(corner: PlanPoint, dirA: PlanPoint, dirB: PlanPoint, radii: number[]): void {
    const a0 = Math.atan2(dirA.y, dirA.x);
    let da = Math.atan2(dirB.y, dirB.x) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const at = (ang: number, r: number): PlanPoint => ({ x: corner.x + Math.cos(ang) * r, y: corner.y + Math.sin(ang) * r });
    radii.forEach((r, layer) => {
      const strips = Math.max(3, Math.round((Math.abs(da) * r) / 0.2));
      const outline: PlanPoint[] = [corner];
      const seams: Array<[PlanPoint, PlanPoint]> = [];
      for (let k = 0; k < strips; k++) {
        const s0 = a0 + (da * k) / strips, s1 = a0 + (da * (k + 1)) / strips, sm = (s0 + s1) / 2;
        const rk = r * ((k + layer) % 2 === 0 ? 1 : 0.84);
        outline.push(at(s0, rk * 0.8), at(sm, rk), at(s1, rk * 0.8));
        if (k > 0) seams.push([at(s0, 0.06), at(s0, rk * 0.8)]);
      }
      const path = (g: CanvasRenderingContext2D) => {
        g.beginPath();
        outline.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
        g.closePath();
      };
      this.plies.clipped(() => { path(this.plies.g); this.plies.g.fillStyle = DacronLayers.ply(1); this.plies.g.fill(); });
      this.albedo.clipped(() => {
        const g = this.albedo.g;
        path(g);
        const shade = -1.5 - layer;
        g.fillStyle = `rgb(${CLOTH[0] + shade},${CLOTH[1] + shade},${CLOTH[2] + shade - 1.5})`;
        g.fill();
        g.lineWidth = 0.0024;
        g.strokeStyle = 'rgba(150,146,132,0.45)';
        g.setLineDash([0.005, 0.0035]);
        g.stroke();
        for (const [a, b] of seams) this.albedo.line(a, b, 0.0022, 'rgba(150,146,132,0.3)', [0.005, 0.0035]);
        g.setLineDash([]);
      });
    });
  }

  /** Round reinforcement (reef cringles): stacked discs, each a ply with a stitched edge. */
  roundPatch(p: PlanPoint, radii: number[]): void {
    radii.forEach((r, layer) => {
      const circle = (g: CanvasRenderingContext2D) => { g.beginPath(); g.ellipse(p.x, p.y, r * 1.25, r, 0, 0, Math.PI * 2); };
      this.plies.clipped(() => { circle(this.plies.g); this.plies.g.fillStyle = DacronLayers.ply(0.8); this.plies.g.fill(); });
      this.albedo.clipped(() => {
        const g = this.albedo.g;
        circle(g);
        g.fillStyle = `rgb(${CLOTH[0] - 1 - layer},${CLOTH[1] - 1 - layer},${CLOTH[2] - 2 - layer})`;
        g.fill();
        g.lineWidth = 0.0022; g.strokeStyle = 'rgba(150,146,132,0.4)';
        g.setLineDash([0.005, 0.0035]); g.stroke(); g.setLineDash([]);
      });
    });
  }

  /** Stainless ring (cringle) pressed into the corner. */
  cringle(p: PlanPoint, r = 0.022): void {
    const pg = this.plies.g;
    pg.beginPath(); pg.arc(p.x, p.y, r * 1.4, 0, Math.PI * 2); pg.fillStyle = DacronLayers.ply(3.5); pg.fill();
    const g = this.albedo.g;
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.lineWidth = r * 0.55; g.strokeStyle = 'rgb(118,121,126)'; g.stroke();
    g.beginPath(); g.arc(p.x, p.y, r * 1.05, -2.4, -1.2);
    g.lineWidth = r * 0.18; g.strokeStyle = 'rgb(225,227,230)'; g.stroke();
  }

  /** Faint horizontal fold creases from being flaked on the boom (bump only). */
  creases(y0: number, y1: number, spacing: number): void {
    const g = this.plies.g;
    for (let y = y0 + spacing * 0.5; y < y1; y += spacing * (0.85 + 0.3 * this.rand())) {
      const tilt = (this.rand() - 0.5) * 0.08;
      g.beginPath();
      g.moveTo(this.plan.x0, y - tilt);
      g.lineTo(this.plan.x0 + this.plan.w, y + tilt);
      g.lineWidth = 0.005;
      g.strokeStyle = 'rgb(7,7,7)';
      g.stroke();
    }
  }

  /** Draft stripe along the row at height fraction v, on both faces. */
  draftStripe(v: number, insetLuff: number, insetLeech: number): void {
    const { a, b } = this.plan.rowAt(v);
    const d = unit(sub(b, a));
    const p0 = add(a, d, insetLuff), p1 = add(b, d, -insetLeech);
    for (const c of [this.stbd, this.port]) c.line(p0, p1, 0.034, STRIPE_INK);
  }

  /** Per-pixel cloth grain on the albedo. */
  grain(amount: number): void {
    const { g, W, H } = this.albedo;
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (this.rand() - 0.5) * amount;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }

  build(): SailTextureSet {
    const base = packBase(this.albedo, this.plies);
    const decalFront = decalTexture(this.stbd.canvas);
    const decalBack = decalTexture(this.port.canvas);
    return { base, decalFront, decalBack, dispose() { base.dispose(); decalFront.dispose(); decalBack.dispose(); } };
  }
}

function packBase(albedo: PlanCanvas, plies: PlanCanvas): THREE.DataTexture {
  const { W, H } = albedo;
  const a = albedo.g.getImageData(0, 0, W, H).data;
  const p = plies.g.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = a[i * 4]!;
    data[i * 4 + 1] = a[i * 4 + 1]!;
    data[i * 4 + 2] = a[i * 4 + 2]!;
    data[i * 4 + 3] = p[i * 4]!;
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function decalTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = true;
  t.anisotropy = 8;
  return t;
}

/**
 * Draw text centred at (cx, cy) with its digits `height` metres tall; `mirror` for the starboard face
 * (seen from starboard the plan's +x — aft — runs to the viewer's left).
 */
function drawNumber(c: PlanCanvas, text: string, cx: number, cy: number, height: number, mirror: boolean, colour: string): void {
  const g = c.g;
  g.save();
  g.translate(cx, cy);
  // Plan y is up but canvas glyphs are drawn y-down: flip vertically (and horizontally for starboard).
  const px = 200;
  g.font = `bold ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const m = g.measureText(text);
  const glyphH = (m.actualBoundingBoxAscent || px * 0.72) + (m.actualBoundingBoxDescent || 0);
  const k = height / glyphH;
  g.scale(mirror ? -k : k, -k);
  g.fillStyle = colour;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText(text, 0, glyphH / 2 - (m.actualBoundingBoxDescent || 0));
  g.restore();
}

/** Stylised kestrel in flight (class insignia), facing the luff (−x), `size` metres wide. */
function drawKestrel(c: PlanCanvas, cx: number, cy: number, size: number, body: string, accent: string): void {
  const g = c.g;
  g.save();
  g.translate(cx, cy);
  g.scale(size / 2, size / 2);
  // Swept, pointed falcon wings raised in a shallow V, long tail, small hooked head.
  g.beginPath();
  g.moveTo(-0.98, 0.1);                                  // beak
  g.quadraticCurveTo(-0.9, 0.2, -0.75, 0.2);              // crown
  g.quadraticCurveTo(-0.55, 0.22, -0.38, 0.16);           // nape → shoulder
  g.bezierCurveTo(-0.2, 0.45, 0.15, 0.8, 0.62, 0.98);     // leading edge of the near wing
  g.bezierCurveTo(0.35, 0.72, 0.18, 0.45, 0.08, 0.18);    // trailing edge back to the body
  g.bezierCurveTo(0.3, 0.14, 0.55, 0.1, 0.98, 0.14);      // back → tail tip (upper)
  g.lineTo(0.94, -0.02);                                  // square tail end
  g.bezierCurveTo(0.6, -0.04, 0.3, -0.08, 0.05, -0.1);    // tail underside
  g.bezierCurveTo(-0.25, -0.12, -0.55, -0.05, -0.8, -0.02); // belly → throat
  g.quadraticCurveTo(-0.92, 0.0, -0.98, 0.1);
  g.closePath();
  g.fillStyle = body;
  g.fill();
  // Far wing, half hidden behind the body.
  g.beginPath();
  g.moveTo(-0.3, 0.12);
  g.bezierCurveTo(-0.28, 0.4, -0.12, 0.62, 0.12, 0.76);
  g.bezierCurveTo(0.02, 0.5, -0.02, 0.3, -0.05, 0.14);
  g.closePath();
  g.fill();
  // Signal-orange swoosh under the bird.
  g.beginPath();
  g.moveTo(-0.95, -0.28);
  g.bezierCurveTo(-0.4, -0.2, 0.3, -0.2, 0.95, -0.36);
  g.bezierCurveTo(0.3, -0.3, -0.4, -0.33, -0.95, -0.28);
  g.lineWidth = 0.055;
  g.strokeStyle = accent;
  g.stroke();
  g.restore();
}

/** Height fraction v of plan height y (plan rows are evenly spaced up the luff). */
function vAtY(plan: SailPlan, y: number): number {
  const n = plan.luff.length - 1;
  const y0 = plan.luff[0]!.y, y1 = plan.luff[n]!.y;
  return Math.min(Math.max((y - y0) / (y1 - y0), 0), 1);
}

function midAt(plan: SailPlan, y: number): number {
  const { a, b } = plan.rowAt(vAtY(plan, y));
  return (a.x + b.x) / 2;
}

/** Texture size for a plan: `longSide` along its long axis, the short side proportionally (×1.25 for detail). */
function texSize(plan: SailPlan, scale: number, longSide = 2048): [number, number] {
  const tall = plan.h >= plan.w;
  const L = Math.round(longSide * scale);
  const ratio = Math.min(plan.w, plan.h) / Math.max(plan.w, plan.h);
  const S = Math.max(64, Math.min(L, Math.round((L * ratio * 1.25) / 64) * 64));
  return tall ? [S, L] : [L, S];
}

// ---------------------------------------------------------------------------------------------------------

export function makeMainTextures(plan: SailPlan, battens: BattenPlan[], scale = 1): SailTextureSet {
  const [W, H] = texSize(plan, scale);
  const L = new DacronLayers(plan, W, H, 2517);
  const n = plan.luff.length - 1;
  const tack = plan.luff[0]!, clew = plan.leech[0]!, head = plan.luff[n]!, headAft = plan.leech[n]!;
  const yTop = head.y;

  L.crossCut(seamLayout(plan, 'main'));
  L.creases(0.2, yTop - 0.3, 0.6);
  L.tape(plan.luff, 0.045, 1, 'rgb(229,226,216)');
  L.tape(plan.luff, 0.012, 1); // bolt rope sewn into the luff tape
  L.tape(plan.leech, 0.024, 1);
  L.tape([tack, clew], 0.032, 1);

  // Leech line inside the tabling (shows only in transmission).
  L.plies.clipped(() => {
    L.plies.polyline(plan.leech.map((p) => ({ x: p.x - 0.012, y: p.y })));
    L.plies.g.lineWidth = 0.004; L.plies.g.strokeStyle = DacronLayers.ply(0.6); L.plies.g.stroke();
  });

  // Battens: pocket (2 plies), the batten itself (nearly opaque), leech-end patch with elastic.
  for (const b of battens) {
    const dir = unit(sub(b.inner, b.leech));
    const nrm = { x: -dir.y, y: dir.x };
    const inner = add(b.inner, dir, -0.02);
    L.plies.clipped(() => {
      L.plies.line(b.leech, inner, 0.056, DacronLayers.ply(1));
      L.plies.line(add(b.leech, dir, 0.035), add(inner, dir, -0.03), 0.022, DacronLayers.ply(1.4));
    });
    L.albedo.clipped(() => {
      for (const s of [-0.028, 0.028]) L.albedo.line(add(b.leech, nrm, s), add(inner, nrm, s), 0.0026, THREAD, [0.005, 0.0035]);
      L.albedo.line(b.leech, inner, 0.05, 'rgba(250,248,240,0.12)');
    });
    const pp = [add(add(b.leech, nrm, -0.05), dir, 0), add(add(b.leech, nrm, 0.05), dir, 0), add(add(b.leech, nrm, 0.05), dir, 0.16), add(add(b.leech, nrm, -0.05), dir, 0.16)];
    L.plies.clipped(() => { L.plies.polyline(pp); L.plies.g.closePath(); L.plies.g.fillStyle = DacronLayers.ply(1); L.plies.g.fill(); });
    L.albedo.clipped(() => {
      const g = L.albedo.g;
      L.albedo.polyline(pp); g.closePath();
      g.fillStyle = 'rgb(232,229,219)'; g.fill();
      g.lineWidth = 0.0026; g.strokeStyle = THREAD; g.stroke();
      L.albedo.line(add(add(b.leech, dir, 0.05), nrm, -0.04), add(add(b.leech, dir, 0.05), nrm, 0.04), 0.018, 'rgb(96,98,104)');
    });
  }

  // Corner patches and rings.
  const up = (p: PlanPoint, q: PlanPoint) => unit(sub(q, p));
  L.cornerPatch(clew, up(clew, tack), up(clew, plan.leech[Math.round(n * 0.08)]!), [0.3, 0.48, 0.68]);
  L.cornerPatch(tack, up(tack, clew), up(tack, plan.luff[Math.round(n * 0.08)]!), [0.24, 0.4, 0.58]);
  L.cornerPatch(head, up(head, plan.luff[Math.round(n * 0.9)]!), up(head, plan.leech[Math.round(n * 0.9)]!), [0.3, 0.5, 0.74]);

  // Reef: luff and leech cringles with patches, eyelets along the reef line.
  const reefY = 1.2;
  const rL = plan.rowAt(vAtY(plan, reefY)).a, rT = plan.rowAt(vAtY(plan, reefY + 0.22)).b;
  const reefLuff = add(rL, { x: 1, y: 0 }, 0.06), reefLeech = add(rT, { x: -1, y: 0 }, 0.06);
  L.roundPatch(reefLuff, [0.07, 0.11]);
  L.roundPatch(reefLeech, [0.07, 0.11]);
  L.cringle(reefLuff, 0.02); L.cringle(reefLeech, 0.02);
  const reefDir = sub(reefLeech, reefLuff);
  for (let t = 0.12; t < 0.95; t += 0.45 / Math.hypot(reefDir.x, reefDir.y)) {
    const p = add(reefLuff, reefDir, t);
    L.cringle(p, 0.009);
  }

  // Head board: riveted aluminium plate.
  const hb = [head, headAft, add(headAft, { x: -0.02, y: -1 }, 0.12), add(head, { x: 0, y: -1 }, 0.16)];
  L.plies.clipped(() => { L.plies.polyline(hb); L.plies.g.closePath(); L.plies.g.fillStyle = DacronLayers.ply(6); L.plies.g.fill(); });
  L.albedo.clipped(() => {
    const g = L.albedo.g;
    L.albedo.polyline(hb); g.closePath(); g.fillStyle = 'rgb(172,176,181)'; g.fill();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      g.beginPath(); g.arc(head.x + 0.03 + i * 0.04, head.y - 0.04 - j * 0.05, 0.005, 0, Math.PI * 2);
      g.fillStyle = 'rgb(110,113,118)'; g.fill();
    }
  });
  L.cringle(tack); L.cringle(clew); L.cringle(add(head, { x: 0.05, y: -0.06 }), 0.016);

  // Luff slide webbing every 0.55 m.
  for (let y = 0.35; y < yTop - 0.3; y += 0.55) {
    const p = plan.rowAt(vAtY(plan, y)).a;
    L.plies.g.fillStyle = DacronLayers.ply(1.5);
    L.plies.g.fillRect(p.x, p.y - 0.012, 0.05, 0.024);
    L.albedo.g.fillStyle = 'rgb(205,203,196)';
    L.albedo.g.fillRect(p.x, p.y - 0.012, 0.05, 0.024);
  }

  // Handling marks: slightly greyer low on the luff and foot.
  L.albedo.clipped(() => {
    const g = L.albedo.g;
    const grad = g.createLinearGradient(0, 0, 0, 1.6);
    grad.addColorStop(0, 'rgba(110,100,85,0.06)');
    grad.addColorStop(1, 'rgba(110,100,85,0)');
    g.fillStyle = grad;
    g.fillRect(plan.x0, plan.y0, plan.w, 1.7);
  });
  L.grain(5);

  // Decals: draft stripes, insignia (back to back), numbers (starboard higher).
  for (const v of [0.25, 0.5, 0.75]) L.draftStripe(v, 0.12, 0.09);
  const insigniaY = 5.36;
  for (const c of [L.stbd, L.port]) drawKestrel(c, midAt(plan, insigniaY) - 0.02, insigniaY, 0.78, '#1a2b5e', '#ec5a24');
  drawNumber(L.stbd, '25', midAt(plan, 4.38), 4.38, 0.5, true, NAVY_INK);
  drawNumber(L.port, '25', midAt(plan, 3.58), 3.58, 0.5, false, NAVY_INK);
  return L.build();
}

export function makeJibTextures(plan: SailPlan, scale = 1): SailTextureSet {
  const [W, H] = texSize(plan, scale);
  const L = new DacronLayers(plan, W, H, 911);
  const n = plan.luff.length - 1;
  const tack = plan.luff[0]!, clew = plan.leech[0]!, head = plan.luff[n]!;

  L.crossCut(seamLayout(plan, 'jib'));
  L.creases(0.3, head.y - 0.4, 0.55);
  // Furler luff tape (pale blue), leech tabling with leech line, foot tape.
  L.tape(plan.luff, 0.05, 1, 'rgb(203,212,222)');
  L.tape(plan.leech, 0.022, 1);
  L.tape([tack, clew], 0.028, 1);
  L.plies.clipped(() => {
    L.plies.polyline(plan.leech.map((p) => ({ x: p.x - 0.011, y: p.y })));
    L.plies.g.lineWidth = 0.004; L.plies.g.strokeStyle = DacronLayers.ply(0.6); L.plies.g.stroke();
  });

  // UV cover along leech and foot on the starboard face: acrylic, opaque (blocks transmission both ways).
  const uvBand = (c: PlanCanvas, style: string, widthLeech: number, widthFoot: number) => c.clipped(() => {
    const g = c.g;
    c.polyline(plan.leech); g.lineWidth = widthLeech * 2; g.strokeStyle = style; g.stroke();
    c.polyline([tack, clew]); g.lineWidth = widthFoot * 2; g.stroke();
  });
  uvBand(L.plies, DacronLayers.ply(2.4), 0.15, 0.12);
  uvBand(L.stbd, '#22314f', 0.15, 0.12);
  L.stbd.clipped(() => {
    const g = L.stbd.g;
    L.stbd.polyline(plan.leech); g.lineWidth = 0.15 * 2 - 0.02; g.strokeStyle = 'rgba(210,214,222,0.35)';
    g.setLineDash([0.005, 0.004]); g.stroke(); g.setLineDash([]);
    L.stbd.polyline(plan.leech); g.lineWidth = 0.15 * 2 - 0.026; g.strokeStyle = '#22314f'; g.stroke();
  });

  const up = (p: PlanPoint, q: PlanPoint) => unit(sub(q, p));
  L.cornerPatch(clew, up(clew, tack), up(clew, plan.leech[Math.round(n * 0.08)]!), [0.28, 0.46, 0.64]);
  L.cornerPatch(tack, up(tack, clew), up(tack, plan.luff[Math.round(n * 0.08)]!), [0.24, 0.4, 0.56]);
  L.cornerPatch(head, up(head, plan.luff[Math.round(n * 0.9)]!), up(head, plan.leech[Math.round(n * 0.9)]!), [0.26, 0.44, 0.62]);
  L.cringle(tack); L.cringle(clew); L.cringle(add(head, up(head, plan.luff[Math.round(n * 0.95)]!), 0.08), 0.016);

  // Telltale windows: clear vinyl (cut out in the shader) in a stitched Dacron frame.
  const win = jibWindows(plan);
  for (const c of win.centres) {
    const rect = (g: CanvasRenderingContext2D, grow: number) => {
      g.beginPath();
      g.roundRect(c.x - win.half.x - grow, c.y - win.half.y - grow, 2 * (win.half.x + grow), 2 * (win.half.y + grow), win.radius + grow);
    };
    rect(L.plies.g, 0.014); L.plies.g.fillStyle = DacronLayers.ply(1); L.plies.g.fill();
    const g = L.albedo.g;
    rect(g, 0.014); g.fillStyle = 'rgb(214,214,210)'; g.fill();
    rect(g, 0.007); g.lineWidth = 0.0022; g.strokeStyle = THREAD; g.setLineDash([0.005, 0.0035]); g.stroke(); g.setLineDash([]);
    rect(g, 0); g.fillStyle = 'rgb(120,126,132)'; g.fill();
  }
  L.grain(5);
  // Draft stripes at ¼ ½ ¾ run just below the telltale windows (13 cm lower), clear of the telltales.
  const below = 0.13 / Math.max(plan.luff[plan.luff.length - 1]!.y - plan.luff[0]!.y, 1);
  for (const v of [0.25, 0.5, 0.75]) L.draftStripe(v - below, 0.1, 0.2);
  return L.build();
}

// ---------------------------------------------------------------------------------------------------------
// Spinnaker: bold horizontal nylon panels, a tri-radial head, radial corner patches, white edge tapes.

const SPIN_BANDS: ReadonlyArray<{ v0: number; v1: number; rgb: readonly [number, number, number] }> = [
  { v0: 0.0, v1: 0.16, rgb: [28, 44, 86] },     // navy foot
  { v0: 0.16, v1: 0.23, rgb: [244, 244, 238] }, // white
  { v0: 0.23, v1: 0.47, rgb: [255, 88, 26] },   // signal orange
  { v0: 0.47, v1: 0.55, rgb: [244, 244, 238] }, // white
  { v0: 0.55, v1: 1.01, rgb: [28, 44, 86] },    // navy head
];

export function makeSpinTextures(plan: SailPlan, scale = 1): SailTextureSet {
  const [W, H] = texSize(plan, scale, 1536);
  const rand = rng(77);
  const albedo = new PlanCanvas(plan, W, H, 'rgb(244,244,238)');
  const plies = new PlanCanvas(plan, W, H, `rgb(${PLY},${PLY},${PLY})`);
  plies.g.globalCompositeOperation = 'lighter';
  const n = plan.luff.length - 1;
  const SL = plan.luff[n]!.y;
  const head = { x: (plan.luff[n]!.x + plan.leech[n]!.x) / 2, y: SL };
  const radialFrom = 0.62;

  // Colour bands (dyed through: the same on both faces).
  for (const b of SPIN_BANDS) {
    albedo.g.fillStyle = `rgb(${b.rgb.join(',')})`;
    albedo.g.fillRect(plan.x0, b.v0 * SL, plan.w, (b.v1 - b.v0) * SL + 0.002);
  }
  const seamAt = (a: PlanPoint, b: PlanPoint) => {
    plies.clipped(() => plies.line(a, b, 0.014, DacronLayers.ply(1)));
    albedo.clipped(() => {
      albedo.line(a, b, 0.016, 'rgba(0,0,0,0.07)');
      const d = unit(sub(b, a)), nn = { x: -d.y, y: d.x };
      for (const s of [-0.004, 0.004]) albedo.line(add(a, nn, s), add(b, nn, s), 0.002, 'rgba(255,255,255,0.18)', [0.004, 0.003]);
    });
  };
  // Horizontal panels in the body, a vertical centre seam, radial panels in the head.
  for (let y = 0.9; y < radialFrom * SL; y += 0.9) seamAt({ x: plan.x0, y }, { x: plan.x0 + plan.w, y });
  seamAt({ x: 0, y: 0 }, { x: 0, y: radialFrom * SL });
  const rowR = plan.rowAt(radialFrom);
  for (let k = 0; k <= 8; k++) {
    const x = rowR.a.x + ((rowR.b.x - rowR.a.x) * k) / 8;
    seamAt(head, { x, y: radialFrom * SL });
  }
  for (const b of SPIN_BANDS) seamAt({ x: plan.x0, y: b.v0 * SL }, { x: plan.x0 + plan.w, y: b.v0 * SL });

  // Radial corner patches (extra plies, a touch lighter).
  const fan = (corner: PlanPoint, dA: PlanPoint, dB: PlanPoint, radii: number[]) => {
    const a0 = Math.atan2(dA.y, dA.x);
    let da = Math.atan2(dB.y, dB.x) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (const r of radii) {
      const path = (g: CanvasRenderingContext2D) => {
        g.beginPath(); g.moveTo(corner.x, corner.y);
        const f = Math.max(5, Math.round((Math.abs(da) * r) / 0.09));
        for (let k = 0; k <= f * 2; k++) {
          const ang = a0 + (da * k) / (f * 2), rr = r * (k % 2 ? 0.82 : 1);
          g.lineTo(corner.x + Math.cos(ang) * rr, corner.y + Math.sin(ang) * rr);
        }
        g.closePath();
      };
      plies.clipped(() => { path(plies.g); plies.g.fillStyle = DacronLayers.ply(1); plies.g.fill(); });
      albedo.clipped(() => {
        path(albedo.g); albedo.g.fillStyle = 'rgba(255,255,255,0.05)'; albedo.g.fill();
        albedo.g.lineWidth = 0.003; albedo.g.strokeStyle = 'rgba(255,255,255,0.25)'; albedo.g.stroke();
      });
    }
  };
  const tack = plan.luff[0]!, clew = plan.leech[0]!;
  fan(tack, unit(sub(clew, tack)), unit(sub(plan.luff[12]!, tack)), [0.35, 0.55]);
  fan(clew, unit(sub(tack, clew)), unit(sub(plan.leech[12]!, clew)), [0.35, 0.55]);
  fan(head, unit(sub(plan.luff[n - 12]!, head)), unit(sub(plan.leech[n - 12]!, head)), [0.35, 0.6]);

  // White edge tapes (2 plies).
  for (const pts of [plan.luff, plan.leech, [tack, clew]]) {
    plies.clipped(() => { plies.polyline(pts); plies.g.lineWidth = 0.05; plies.g.strokeStyle = DacronLayers.ply(1); plies.g.stroke(); });
    albedo.clipped(() => { albedo.polyline(pts); albedo.g.lineWidth = 0.05; albedo.g.strokeStyle = 'rgb(240,240,236)'; albedo.g.stroke(); });
  }
  // Nylon grain.
  const img = albedo.g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const k = (rand() - 0.5) * 4;
    img.data[i] += k; img.data[i + 1] += k; img.data[i + 2] += k;
  }
  albedo.g.putImageData(img, 0, 0);

  const base = packBase(albedo, plies);
  const none = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  none.needsUpdate = true;
  return { base, decalFront: none, decalBack: none, dispose() { base.dispose(); none.dispose(); } };
}

// ---------------------------------------------------------------------------------------------------------

/** Burgee: navy pennant with a signal-orange and white diagonal (u along the fly, v across the hoist). */
export function makeBurgeeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b2c5a'; g.fillRect(0, 0, 256, 128);
  g.beginPath(); g.moveTo(40, 128); g.lineTo(120, 0); g.lineTo(170, 0); g.lineTo(90, 128); g.closePath();
  g.fillStyle = '#f4f4ef'; g.fill();
  g.beginPath(); g.moveTo(58, 128); g.lineTo(138, 0); g.lineTo(152, 0); g.lineTo(72, 128); g.closePath();
  g.fillStyle = '#ff5a1f'; g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Rolled jib: UV-cover navy with the spiral of the wraps. */
export function makeFurlTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#243352'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(8,12,24,0.55)'; g.lineWidth = 3;
  for (let k = -64; k < 128; k += 16) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 64, 64); g.stroke(); }
  g.strokeStyle = 'rgba(200,210,230,0.18)'; g.lineWidth = 1;
  for (let k = -64; k < 128; k += 16) { g.beginPath(); g.moveTo(k + 3, 0); g.lineTo(k + 67, 64); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 40);
  return t;
}
