// DOM labels pinned to 3-D points: value tags on arrows, sector names on the points-of-sail wheel, the boat's part
// names (lesson 1) and small gauges. DOM text stays crisp at every size and costs one transform write per label per
// frame; text is only rewritten when it changes. Labels are placed greedily by priority: each tries its preferred
// side, then alternatives, and a label that still overlaps a more important one fades out instead of piling up.
import * as THREE from 'three';

export type LabelKind = 'value' | 'part' | 'sector' | 'tag';

export interface LabelOptions {
  kind?: LabelKind;
  /** CSS colour of the key dot / title. */
  color?: string;
  /** Higher wins when labels overlap. */
  priority?: number;
  /** Draw a leader line from the anchor to the label (part labels). */
  leader?: boolean;
  /** Preferred offset from the anchor (CSS px, label centre). */
  dx?: number;
  dy?: number;
  /** Callout mode: push the label this many px away from the layer's focus point (e.g. the boat's centre). */
  radial?: number;
}

const STYLE_ID = 'ssov-style';
const CSS = `
.ssov-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0;contain:strict;
  font:600 12px/1.25 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#f4f7fb;-webkit-font-smoothing:antialiased}
.ssov-leaders{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ssov-label{position:absolute;left:0;top:0;display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:11.5px;
  padding:2px 8px 2px 6px;border-radius:999px;background:rgba(7,18,33,.64);border:1px solid rgba(255,255,255,.12);
  box-shadow:0 2px 10px rgba(0,8,20,.25);transition:opacity .18s linear}
.ssov-label>i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 6px var(--c)}
.ssov-label>b{font-weight:650;color:var(--c);letter-spacing:.01em}
.ssov-label>span{font-variant-numeric:tabular-nums;color:#fff;opacity:.94;font-weight:600}
.ssov-label>span:empty{display:none}
.ssov-label.part{padding:2px 8px;background:rgba(7,18,33,.72)}
.ssov-label.part>i{display:none}
.ssov-label.part>b{color:var(--c)}
.ssov-label.sector{background:none;border:none;box-shadow:none;padding:0;font-size:11.5px;letter-spacing:.06em;
  text-transform:uppercase;text-shadow:0 1px 3px rgba(0,10,25,.85),0 0 10px rgba(0,10,25,.55)}
.ssov-label.sector>i{display:none}
.ssov-label.sector>b{color:rgba(244,247,251,.9);font-weight:650}
.ssov-label.sector.on>b{color:#fff}
.ssov-label.tag{padding:4px 10px 4px 8px;font-size:12.5px}
`;

interface Entry {
  el: HTMLDivElement;
  title: HTMLElement;
  value: HTMLElement;
  opts: Required<LabelOptions>;
  anchor: THREE.Vector3;
  visible: boolean;
  titleText: string;
  valueText: string;
  color: string;
  // Layout of the current frame.
  sx: number;
  sy: number;
  w: number;
  h: number;
  x: number;
  y: number;
  shown: boolean;
  lastX: number;
  lastY: number;
  lastShown: boolean;
  line: SVGLineElement | null;
  dot: SVGCircleElement | null;
  cls: string;
  /** Tip placement: the label continues the screen direction tail → anchor. */
  tail: THREE.Vector3;
  hasTail: boolean;
  gap: number;
  /** Screen direction tail → tip this frame. */
  tdx: number;
  tdy: number;
  /** Leader line as last written. */
  lx1: number; ly1: number; lx2: number; ly2: number;
}

export class Label {
  constructor(private readonly e: Entry) {}

  /** Title (coloured) and value (white) text; only written to the DOM when they change. */
  text(title: string, value = ''): this {
    const e = this.e;
    if (title !== e.titleText) { e.title.textContent = title; e.titleText = title; }
    if (value !== e.valueText) { e.value.textContent = value; e.valueText = value; }
    return this;
  }

  color(css: string): this {
    if (css !== this.e.color) { this.e.el.style.setProperty('--c', css); this.e.color = css; }
    return this;
  }

  /** Extra CSS class (e.g. 'on' for the active wheel sector). */
  cls(name: string): this {
    if (name !== this.e.cls) {
      if (this.e.cls) this.e.el.classList.remove(this.e.cls);
      if (name) this.e.el.classList.add(name);
      this.e.cls = name;
    }
    return this;
  }

  /** World-space anchor; the label is shown this frame. */
  at(p: THREE.Vector3, dx?: number, dy?: number): this {
    this.e.anchor.copy(p);
    if (dx !== undefined) this.e.opts.dx = dx;
    if (dy !== undefined) this.e.opts.dy = dy;
    this.e.hasTail = false;
    this.e.visible = true;
    return this;
  }

  /** Label an arrow at its head: placed just beyond `tip`, continuing the on-screen direction from `tail`. */
  tip(tip: THREE.Vector3, tail: THREE.Vector3, gap = 10): this {
    this.e.anchor.copy(tip);
    this.e.tail.copy(tail);
    this.e.hasTail = true;
    this.e.gap = gap;
    this.e.visible = true;
    return this;
  }

  hide(): this {
    this.e.visible = false;
    return this;
  }
}

const tmp = new THREE.Vector3();
const OFFSETS: ReadonlyArray<readonly [number, number]> = [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 1.6], [0, -1.6], [1.8, 0], [-1.8, 0]];
/** Arrow-tip candidates: (angle offset from the arrow direction, extra distance px). */
const TIP: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.6, 0], [-0.6, 0], [1.2, 2], [-1.2, 2], [0, 22], [0.5, 26], [-0.5, 26], [1.57, 6], [-1.57, 6],
];
/** Callout candidates: (angle offset from straight out, leader length factor). */
const RADIAL: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0.35, 1], [-0.35, 1], [0, 1.7], [0.7, 1.2], [-0.7, 1.2], [0.35, 1.9], [-0.35, 1.9], [1.1, 1.4], [-1.1, 1.4],
];

/** Owns the DOM layer; call `frame(camera)` once per frame after updating the labels. */
export class LabelLayer {
  private readonly root: HTMLDivElement | null = null;
  private readonly svg: SVGSVGElement | null = null;
  private readonly entries: Entry[] = [];
  private readonly order: Entry[] = [];
  private readonly placed: Entry[] = [];
  private width = 1;
  private height = 1;
  private readonly focus = new THREE.Vector3();
  private hasFocus = false;
  private fx = 0;
  private fy = 0;

  constructor(parent?: HTMLElement) {
    if (typeof document === 'undefined') return; // headless (unit tests): labels become no-ops
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.root = document.createElement('div');
    this.root.className = 'ssov-layer';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('ssov-leaders');
    this.root.appendChild(this.svg);
    (parent ?? document.body).appendChild(this.root);
  }

  create(opts: LabelOptions = {}): Label {
    const full: Required<LabelOptions> = { kind: 'value', color: '#f4f7fb', priority: 1, leader: false, dx: 0, dy: -18, radial: 0, ...opts };
    const doc = typeof document === 'undefined' ? null : document;
    const el = (doc?.createElement('div') ?? ({ style: { setProperty() {} }, classList: { add() {}, remove() {} } } as unknown)) as HTMLDivElement;
    const title = (doc?.createElement('b') ?? {}) as HTMLElement;
    const value = (doc?.createElement('span') ?? {}) as HTMLElement;
    let line: SVGLineElement | null = null;
    let dot: SVGCircleElement | null = null;
    if (doc && this.root && this.svg) {
      el.className = `ssov-label ${full.kind}`;
      el.append(doc.createElement('i'), title, value);
      el.style.opacity = '0';
      el.style.setProperty('--c', full.color);
      this.root.appendChild(el);
      if (full.leader) {
        line = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('stroke', 'rgba(244,247,251,0.75)');
        line.setAttribute('stroke-width', '1.2');
        dot = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', '2.6');
        dot.setAttribute('fill', '#f4f7fb');
        dot.setAttribute('stroke', 'rgba(7,18,33,.7)');
        dot.setAttribute('stroke-width', '1');
        line.style.display = dot.style.display = 'none';
        this.svg.append(line, dot);
      }
    }
    const e: Entry = {
      el, title, value, opts: full, anchor: new THREE.Vector3(), visible: false, titleText: '', valueText: '', color: full.color,
      sx: 0, sy: 0, w: 0, h: 0, x: 0, y: 0, shown: false, lastX: NaN, lastY: NaN, lastShown: false, line, dot, cls: '',
      tail: new THREE.Vector3(), hasTail: false, gap: 10, tdx: 0, tdy: -1, lx1: NaN, ly1: NaN, lx2: NaN, ly2: NaN,
    };
    this.entries.push(e);
    return new Label(e);
  }

  /** World point that radial (callout) labels fan out from, this frame. */
  setFocus(p: THREE.Vector3): void {
    this.focus.copy(p);
    this.hasFocus = true;
  }

  /** Hide every label (e.g. before an overlay re-shows the ones it needs this frame). */
  hideAll(filter?: (l: LabelKind) => boolean): void {
    for (const e of this.entries) if (!filter || filter(e.opts.kind)) e.visible = false;
  }

  frame(camera: THREE.Camera): void {
    if (!this.root) return;
    // The layer is `position: fixed; inset: 0`: the window size, without forcing a layout after this frame's writes.
    this.width = innerWidth || 1;
    this.height = innerHeight || 1;
    const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    const near = persp ? (camera as THREE.PerspectiveCamera).near : 0;
    if (this.hasFocus) {
      tmp.copy(this.focus).project(camera);
      this.fx = (tmp.x * 0.5 + 0.5) * this.width;
      this.fy = (0.5 - tmp.y * 0.5) * this.height;
    }
    this.order.length = 0;
    for (const e of this.entries) {
      e.shown = false;
      if (!e.visible) continue;
      tmp.copy(e.anchor).applyMatrix4(camera.matrixWorldInverse);
      if (persp && tmp.z > -near) continue;
      tmp.applyMatrix4(camera.projectionMatrix);
      if (Math.abs(tmp.x) > 1.3 || Math.abs(tmp.y) > 1.3) continue;
      e.sx = (tmp.x * 0.5 + 0.5) * this.width;
      e.sy = (0.5 - tmp.y * 0.5) * this.height;
      if (e.hasTail) {
        tmp.copy(e.tail).project(camera);
        const tx = (tmp.x * 0.5 + 0.5) * this.width, ty = (0.5 - tmp.y * 0.5) * this.height;
        const dx = e.sx - tx, dy = e.sy - ty, l = Math.hypot(dx, dy);
        if (l > 2) { e.tdx = dx / l; e.tdy = dy / l; } else { e.tdx = 0; e.tdy = -1; }
      }
      // Size estimate (no layout read): ~6.7 px per character at 12 px, plus padding and the key dot.
      const chars = e.titleText.length + e.valueText.length;
      const k = e.opts.kind;
      e.w = k === 'sector' ? chars * 8.2 : chars * 6.5 + (k === 'part' ? 18 : e.valueText ? 32 : 26);
      e.h = k === 'sector' ? 16 : k === 'tag' ? 26 : 20;
      this.order.push(e);
    }
    this.order.sort((a, b) => b.opts.priority - a.opts.priority);
    this.placed.length = 0;
    for (const e of this.order) {
      const base = e.opts;
      let ok = false;
      if (e.hasTail) {
        // Beyond the arrowhead, along the arrow; then fanned to either side and further out.
        const a0 = Math.atan2(e.tdy, e.tdx);
        for (let i = 0; i < TIP.length && !ok; i++) {
          const [da, extra] = TIP[i]!;
          const c = Math.cos(a0 + da), sn = Math.sin(a0 + da);
          const ext = Math.abs(c) * e.w * 0.5 + Math.abs(sn) * e.h * 0.5;
          e.x = e.sx + c * (e.gap + extra + ext) - e.w * 0.5;
          e.y = e.sy + sn * (e.gap + extra + ext) - e.h * 0.5;
          ok = !this.overlaps(e);
        }
        if (!ok && base.priority < 6) continue;
        e.shown = true;
        this.placed.push(e);
        continue;
      }
      if (base.radial > 0 && this.hasFocus) {
        // Callouts: away from the focus, trying angles fanned around the preferred direction and a longer leader.
        const a0 = Math.atan2(e.sy - this.fy, e.sx - this.fx);
        for (let i = 0; i < RADIAL.length && !ok; i++) {
          const [da, rk] = RADIAL[i]!;
          const a = a0 + da;
          const r = base.radial * rk;
          e.x = e.sx + Math.cos(a) * (r + e.w * 0.5) - e.w * 0.5;
          e.y = e.sy + Math.sin(a) * (r + e.h * 0.5) - e.h * 0.5;
          ok = !this.overlaps(e);
        }
        if (!ok) continue;
        e.shown = true;
        this.placed.push(e);
        continue;
      }
      for (let i = 0; i < OFFSETS.length && !ok; i++) {
        const [fx, fy] = OFFSETS[i]!;
        // Offsets are defined for the preferred side; alternatives mirror/rotate it.
        const dx = i === 0 ? base.dx : fx * Math.max(Math.abs(base.dx), e.w * 0.5 + 8);
        const dy = i === 0 ? base.dy : fy * Math.max(Math.abs(base.dy), e.h * 0.5 + 6);
        e.x = e.sx + dx - e.w * 0.5;
        e.y = e.sy + dy - e.h * 0.5;
        ok = !this.overlaps(e);
        if (base.kind === 'sector') break; // sector names sit on their sector or not at all
      }
      if (!ok && (base.kind !== 'value' || base.priority < 6)) continue;
      e.shown = true;
      this.placed.push(e);
    }
    for (const e of this.entries) this.write(e);
  }

  dispose(): void {
    this.root?.remove();
    this.entries.length = 0;
  }

  private overlaps(e: Entry): boolean {
    for (const o of this.placed) {
      if (e.x < o.x + o.w + 3 && e.x + e.w + 3 > o.x && e.y < o.y + o.h + 2 && e.y + e.h + 2 > o.y) return true;
    }
    return false;
  }

  private write(e: Entry): void {
    if (e.shown !== e.lastShown) {
      e.el.style.opacity = e.shown ? '1' : '0';
      if (e.line && e.dot) e.line.style.display = e.dot.style.display = e.shown ? '' : 'none';
      e.lastShown = e.shown;
    }
    if (!e.shown) return;
    const x = Math.round(e.x * 2) / 2, y = Math.round(e.y * 2) / 2;
    if (x !== e.lastX || y !== e.lastY) {
      e.el.style.transform = `translate3d(${x}px,${y}px,0)`;
      e.lastX = x;
      e.lastY = y;
    }
    if (e.line && e.dot) {
      // Leader from the anchor to the nearest point of the label box (rewritten only when it moved half a pixel).
      const cx = Math.min(Math.max(e.sx, e.x), e.x + e.w);
      const cy = Math.min(Math.max(e.sy, e.y), e.y + e.h);
      const ax = Math.round(e.sx * 2) / 2, ay = Math.round(e.sy * 2) / 2, bx = Math.round(cx * 2) / 2, by = Math.round(cy * 2) / 2;
      if (ax !== e.lx1 || ay !== e.ly1 || bx !== e.lx2 || by !== e.ly2) {
        e.line.setAttribute('x1', String(ax));
        e.line.setAttribute('y1', String(ay));
        e.line.setAttribute('x2', String(bx));
        e.line.setAttribute('y2', String(by));
        e.dot.setAttribute('cx', String(ax));
        e.dot.setAttribute('cy', String(ay));
        e.lx1 = ax; e.ly1 = ay; e.lx2 = bx; e.ly2 = by;
      }
    }
  }
}
