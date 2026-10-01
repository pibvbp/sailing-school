// DOM labels pinned to 3-D points: value tags on arrows, sector names on the points-of-sail wheel, the boat's part
// names (lesson 1) and small gauges. DOM text stays crisp at every size and costs one transform write per label per
// frame; text is only rewritten when it changes.
//
// Legibility rules (see tagLayout.ts): no two tags overlap, every tag lies inside the safe area — the part of the
// window the HUD leaves free — and a tag that had to move away from its anchor keeps a leader line to it. Tags are
// measured in the DOM (only when the shape of their text changes: digits are tabular), so "no overlap" holds for the
// pixels on screen, not for an estimate.
import * as THREE from 'three';
import {
  MAX_SEGMENTS, TAG_FIXED, TAG_OFFSET, TAG_RADIAL, TAG_TIP, TagLayout, newTagBox,
  type SafeInsets, type ScreenRect, type TagBox,
} from './tagLayout';

export type { SafeInsets, ScreenRect } from './tagLayout';

export type LabelKind = 'value' | 'part' | 'sector' | 'tag';

export interface LabelOptions {
  kind?: LabelKind;
  /** CSS colour of the key dot / title. */
  color?: string;
  /** Higher wins when labels compete for a place. */
  priority?: number;
  /**
   * Always draw a leader line and a dot at the anchor: a callout that stands off the thing it names (part labels, the
   * pressure peaks of the flow slice). Other tags get a leader only once the layout has moved them away.
   */
  leader?: boolean;
  /** Preferred offset from the anchor (CSS px, label centre). */
  dx?: number;
  dy?: number;
  /** Callout mode: push the label this many px away from the layer's focus point (e.g. the boat's centre). */
  radial?: number;
}

/** The arrows on screen (an `ArrowBatch`): tags keep off them. */
export interface ArrowSource {
  readonly size: number;
  /** Ends of arrow `i` in world space; false when it is not drawn. */
  read(i: number, a: THREE.Vector3, b: THREE.Vector3): boolean;
}

/** A tag as placed this frame (for tests and debugging). */
export interface PlacedTag extends ScreenRect { title: string; value: string; kind: LabelKind; leader: boolean }

const STYLE_ID = 'ssov-style';
const CSS = `
.ssov-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0;contain:strict;
  font:600 12px/1.25 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#f4f7fb;-webkit-font-smoothing:antialiased}
.ssov-leaders{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ssov-leaders line{stroke-width:1.5;stroke-linecap:round}
.ssov-leaders line.case{stroke:rgba(4,12,24,.55);stroke-width:3.5}
.ssov-label{position:absolute;left:0;top:0;display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:11.5px;
  padding:2px 8px 2px 6px;border-radius:999px;background:rgba(7,18,33,.72);border:1px solid rgba(255,255,255,.14);
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

/** A leader appears once the tag's box is this far (px) from its anchor — beyond the arrow-tip gap for tip tags. */
const LEADER_MIN = 17;
const LEADER_TIP_EXTRA = 9;
/** Time constant (s) of the glide when a tag changes place. */
const GLIDE_S = 0.09;

interface Entry extends TagBox {
  el: HTMLDivElement;
  title: HTMLElement;
  value: HTMLElement;
  opts: Required<LabelOptions>;
  anchor: THREE.Vector3;
  visible: boolean;
  titleText: string;
  valueText: string;
  /** Hash of the value text with every digit counted as "0": the box only changes size when this changes. */
  valueShape: number;
  sizeDirty: boolean;
  color: string;
  cls: string;
  /** Tip placement: the label continues the screen direction tail → anchor. */
  tail: THREE.Vector3;
  hasTail: boolean;
  // What is on screen: the box glides from where it was to where the layout put it.
  ox: number;
  oy: number;
  px: number;
  py: number;
  lead: boolean;
  lastX: number;
  lastY: number;
  lastShown: boolean;
  lastLead: boolean;
  line: SVGLineElement | null;
  casing: SVGLineElement | null;
  dot: SVGCircleElement | null;
  /**
   * The leader's coordinates as SVG lengths, kept so a frame writes plain numbers and creates nothing:
   * line x1 y1 x2 y2, casing x1 y1 x2 y2, then the dot's cx cy (part labels).
   */
  len: SVGLength[] | null;
  /** Leader end on the box this frame, and both ends (and the dot) as last written. */
  ex: number; ey: number;
  lx1: number; ly1: number; lx2: number; ly2: number;
  dotX: number; dotY: number;
}

/** Hash of a text in which all digits count as the same character (tabular digits are equally wide). */
function shapeOf(s: string): number {
  let h = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = (Math.imul(h, 31) + (c >= 48 && c <= 57 ? 48 : c)) | 0;
  }
  return h;
}

export class Label {
  constructor(private readonly e: Entry) {}

  /** Title (coloured) and value (white) text; only written to the DOM when they change. */
  text(title: string, value = ''): this {
    const e = this.e;
    if (title !== e.titleText) { e.title.textContent = title; e.titleText = title; e.sizeDirty = true; }
    if (value !== e.valueText) {
      e.value.textContent = value;
      e.valueText = value;
      const shape = shapeOf(value);
      if (shape !== e.valueShape) { e.valueShape = shape; e.sizeDirty = true; }
    }
    return this;
  }

  color(css: string): this {
    const e = this.e;
    if (css !== e.color) {
      e.el.style.setProperty('--c', css);
      if (e.line && e.opts.kind !== 'part') e.line.style.stroke = css;
      if (e.dot && e.opts.kind !== 'part') e.dot.setAttribute('fill', css);
      e.color = css;
    }
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
    const e = this.e;
    e.anchor.copy(p);
    if (dx !== undefined) e.opts.dx = dx;
    if (dy !== undefined) e.opts.dy = dy;
    e.hasTail = false;
    e.visible = true;
    return this;
  }

  /** Label an arrow at its head: placed just beyond `tip`, continuing the on-screen direction from `tail`. */
  tip(tip: THREE.Vector3, tail: THREE.Vector3, gap = 10): this {
    const e = this.e;
    e.anchor.copy(tip);
    e.tail.copy(tail);
    e.hasTail = true;
    e.gap = gap;
    e.visible = true;
    return this;
  }

  hide(): this {
    this.e.visible = false;
    return this;
  }
}

/**
 * Insets used until the app reports the real ones (`Overlays.setSafeArea`): the desktop HUD with both docks open —
 * top bar, lesson dock and trim dock with their tabs, instrument strip and wind dial — or the compact layout's bars.
 */
export function defaultSafeInsets(width: number, out: SafeInsets): SafeInsets {
  if (width > 900) {
    const left = width > 1440 ? 348 : width > 1300 ? 332 : width > 1099 ? 316 : 300;
    const right = width > 1440 ? 296 : width > 1199 ? 284 : 272;
    out.top = 68;
    out.left = 12 + left + 36;
    out.right = 12 + right + 36;
    out.bottom = width > 1199 ? 206 : 186;
  } else {
    out.top = 60;
    out.left = 8;
    out.right = 8;
    out.bottom = 200;
  }
  return out;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/** Owns the DOM layer; call `frame(camera, dt)` once per frame after updating the labels. */
export class LabelLayer {
  /** The safe area and the placing of the tags. */
  readonly layout = new TagLayout();
  private readonly root: HTMLDivElement | null = null;
  private readonly svg: SVGSVGElement | null = null;
  private readonly entries: Entry[] = [];
  private readonly order: Entry[] = [];
  private width = 1280;
  private height = 720;
  private fixedViewport = false;
  private readonly focus = new THREE.Vector3();
  private hasFocus = false;
  private insets: SafeInsets | null = null;
  private readonly applied: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(parent?: HTMLElement) {
    if (typeof document === 'undefined') return; // headless (unit tests): no DOM, the layout still runs
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
    let casing: SVGLineElement | null = null;
    let dot: SVGCircleElement | null = null;
    let len: SVGLength[] | null = null;
    if (doc && this.root && this.svg) {
      el.className = `ssov-label ${full.kind}`;
      el.append(doc.createElement('i'), title, value);
      el.style.opacity = '0';
      el.style.setProperty('--c', full.color);
      this.root.appendChild(el);
      if (full.kind !== 'sector') {
        const ns = 'http://www.w3.org/2000/svg';
        casing = doc.createElementNS(ns, 'line');
        casing.classList.add('case');
        line = doc.createElementNS(ns, 'line');
        // Part names point with a white line; value tags with a line of their own colour.
        const stroke = full.kind === 'part' ? 'rgba(244,247,251,0.8)' : full.color;
        line.style.stroke = stroke;
        if (full.leader) {
          dot = doc.createElementNS(ns, 'circle');
          dot.setAttribute('r', full.kind === 'part' ? '2.6' : '3.2');
          dot.setAttribute('fill', full.kind === 'part' ? '#f4f7fb' : full.color);
          dot.setAttribute('stroke', 'rgba(7,18,33,.7)');
          dot.setAttribute('stroke-width', '1');
          dot.style.display = 'none';
        }
        line.style.display = casing.style.display = 'none';
        this.svg.append(casing, line);
        if (dot) this.svg.append(dot);
        len = [line.x1.baseVal, line.y1.baseVal, line.x2.baseVal, line.y2.baseVal, casing.x1.baseVal, casing.y1.baseVal, casing.x2.baseVal, casing.y2.baseVal];
        if (dot) len.push(dot.cx.baseVal, dot.cy.baseVal);
      }
    }
    const e: Entry = {
      ...newTagBox(),
      el, title, value, opts: full, anchor: new THREE.Vector3(), visible: false, titleText: '', valueText: '', valueShape: 0, sizeDirty: true,
      color: full.color, cls: '', tail: new THREE.Vector3(), hasTail: false,
      ox: 0, oy: 0, px: 0, py: 0, lead: false, lastX: NaN, lastY: NaN, lastShown: false, lastLead: false,
      line, casing, dot, len, ex: 0, ey: 0, lx1: NaN, ly1: NaN, lx2: NaN, ly2: NaN, dotX: NaN, dotY: NaN,
    };
    this.entries.push(e);
    return new Label(e);
  }

  /** World point the tags are pushed away from and callouts fan out from, this frame (the boat's centre). */
  setFocus(p: THREE.Vector3): void {
    this.focus.copy(p);
    this.hasFocus = true;
  }

  /**
   * The area tags may use: insets in CSS px from the viewport edges, plus rectangles inside it to keep clear of
   * (e.g. the wind dial). `null` goes back to the built-in defaults.
   */
  setSafeArea(insets: SafeInsets | null, keepOut?: readonly ScreenRect[] | null): void {
    if (insets) {
      this.insets ??= { top: 0, right: 0, bottom: 0, left: 0 };
      this.insets.top = insets.top; this.insets.right = insets.right; this.insets.bottom = insets.bottom; this.insets.left = insets.left;
    } else {
      this.insets = null;
    }
    this.layout.setKeepOut(keepOut);
  }

  /** Lay out for this viewport size instead of the window's (tests, or a canvas that does not fill the window). */
  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.fixedViewport = true;
  }

  /**
   * Bring the viewport size and the safe area (`layout.x0 … y1`) up to date; `frame` does it too, but overlays that
   * place themselves inside the safe area are updated before it.
   */
  sync(): void {
    if (!this.fixedViewport && typeof innerWidth === 'number') {
      // The layer is `position: fixed; inset: 0`: the window size, without forcing a layout after this frame's writes.
      this.width = innerWidth || 1;
      this.height = innerHeight || 1;
    }
    this.layout.setSafe(this.width, this.height, this.insets ?? defaultSafeInsets(this.width, this.applied));
  }

  get viewWidth(): number { return this.width; }
  get viewHeight(): number { return this.height; }

  /** Hide every label (e.g. before an overlay re-shows the ones it needs this frame). */
  hideAll(filter?: (l: LabelKind) => boolean): void {
    for (const e of this.entries) if (!filter || filter(e.opts.kind)) e.visible = false;
  }

  /** The tags as placed in the last `frame` (allocates: tests and debugging only). */
  placed(): PlacedTag[] {
    const out: PlacedTag[] = [];
    for (const e of this.entries) {
      if (e.shown) out.push({ x: e.x, y: e.y, w: e.w, h: e.h, title: e.titleText, value: e.valueText, kind: e.opts.kind, leader: e.lead });
    }
    return out;
  }

  /** Lay the tags out and write them to the DOM. `arrows`: the arrows drawn this frame, which tags must not cover. */
  frame(camera: THREE.Camera, dt = 1 / 60, arrows?: ArrowSource): void {
    if (!this.root && !this.fixedViewport) return; // headless and no viewport given: nothing to lay out
    this.sync();
    const L = this.layout;
    const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    const near = persp ? (camera as THREE.PerspectiveCamera).near : 0;
    L.hasFocus = this.hasFocus;
    if (this.hasFocus) {
      tmp.copy(this.focus).project(camera);
      L.fx = (tmp.x * 0.5 + 0.5) * this.width;
      L.fy = (0.5 - tmp.y * 0.5) * this.height;
    }
    // The arrows as screen segments (those wholly in front of the camera).
    L.segCount = 0;
    const nArrows = arrows ? Math.min(arrows.size, MAX_SEGMENTS) : 0;
    for (let i = 0; i < nArrows; i++) {
      if (!arrows!.read(i, tmp, tmp2)) continue;
      tmp.applyMatrix4(camera.matrixWorldInverse);
      tmp2.applyMatrix4(camera.matrixWorldInverse);
      if (persp && (tmp.z > -near || tmp2.z > -near)) continue;
      tmp.applyMatrix4(camera.projectionMatrix);
      tmp2.applyMatrix4(camera.projectionMatrix);
      const k = 4 * L.segCount;
      L.segs[k] = (tmp.x * 0.5 + 0.5) * this.width;
      L.segs[k + 1] = (0.5 - tmp.y * 0.5) * this.height;
      L.segs[k + 2] = (tmp2.x * 0.5 + 0.5) * this.width;
      L.segs[k + 3] = (0.5 - tmp2.y * 0.5) * this.height;
      if (Number.isFinite(L.segs[k]! + L.segs[k + 1]! + L.segs[k + 2]! + L.segs[k + 3]!)) L.segCount++;
    }
    let n = 0;
    const entries = this.entries;
    for (let q = 0; q < entries.length; q++) {
      const e = entries[q]!;
      e.shown = false;
      if (!e.visible) continue;
      tmp.copy(e.anchor).applyMatrix4(camera.matrixWorldInverse);
      if (persp && tmp.z > -near) continue;
      tmp.applyMatrix4(camera.projectionMatrix);
      if (!(Math.abs(tmp.x) <= 1.3 && Math.abs(tmp.y) <= 1.3)) continue;
      e.sx = (tmp.x * 0.5 + 0.5) * this.width;
      e.sy = (0.5 - tmp.y * 0.5) * this.height;
      const o = e.opts;
      if (e.hasTail) {
        tmp.copy(e.tail).project(camera);
        const tx = (tmp.x * 0.5 + 0.5) * this.width, ty = (0.5 - tmp.y * 0.5) * this.height;
        const dx = e.sx - tx, dy = e.sy - ty, l = Math.sqrt(dx * dx + dy * dy);
        if (l > 2 && Number.isFinite(l)) { e.tdx = dx / l; e.tdy = dy / l; } else { e.tdx = 0; e.tdy = -1; }
        e.mode = TAG_TIP;
      } else {
        e.mode = o.kind === 'sector' ? TAG_FIXED : o.radial > 0 ? TAG_RADIAL : TAG_OFFSET;
        e.dx = o.dx;
        e.dy = o.dy;
        e.radial = o.radial;
      }
      if (e.sizeDirty) this.measure(e);
      // Insert by priority (stable; the list is rebuilt in creation order, so this is a short insertion sort).
      let i = n++;
      const order = this.order;
      while (i > 0 && order[i - 1]!.opts.priority < o.priority) { order[i] = order[i - 1]!; i--; }
      order[i] = e;
    }
    L.place(this.order, n, dt);
    for (let q = 0; q < entries.length; q++) this.write(entries[q]!, dt);
  }

  dispose(): void {
    this.root?.remove();
    this.entries.length = 0;
    this.order.length = 0;
  }

  /** Box size: read from the DOM (one layout, only on frames where a tag's text changed shape), else estimated. */
  private measure(e: Entry): void {
    e.sizeDirty = false;
    const k = e.opts.kind;
    if (this.root) {
      // `offsetWidth` rounds to whole pixels and a pill is 20.4 px high: take the layout box and round it up.
      const w = e.el.offsetWidth, h = e.el.offsetHeight;
      if (w > 0 && h > 0) { e.w = w + 1; e.h = h + 1; return; }
    }
    // No DOM (or not laid out yet): ~6.5 px per character at 11.5 px, plus padding and the key dot.
    const chars = e.titleText.length + e.valueText.length;
    e.w = k === 'sector' ? chars * 8.2 : chars * (k === 'tag' ? 7.1 : 6.5) + (k === 'part' ? 18 : e.valueText ? 32 : 26);
    e.h = k === 'sector' ? 16 : k === 'tag' ? 26 : 20;
    if (this.root) e.sizeDirty = true; // try again next frame
  }

  private write(e: Entry, dt: number): void {
    const L = this.layout;
    if (e.shown) {
      // Glide: the box keeps its place relative to the anchor and eases to the new one when the layout moves it.
      const tx = e.x - e.sx, ty = e.y - e.sy;
      if (!e.lastShown) { e.ox = tx; e.oy = ty; }
      else {
        const k = 1 - Math.exp(-dt / GLIDE_S);
        e.ox += (tx - e.ox) * k;
        e.oy += (ty - e.oy) * k;
        if (Math.abs(tx - e.ox) < 0.3) e.ox = tx;
        if (Math.abs(ty - e.oy) < 0.3) e.oy = ty;
      }
      e.px = e.sx + e.ox;
      e.py = e.sy + e.oy;
      if (e.mode !== TAG_FIXED) {
        e.px = Math.max(L.x0, Math.min(e.px, L.x1 - e.w));
        e.py = Math.max(L.y0, Math.min(e.py, L.y1 - e.h));
      }
      // Leader from the anchor to the nearest point of the box, once the tag stands away from its anchor.
      const cx = Math.min(Math.max(e.sx, e.px), e.px + e.w);
      const cy = Math.min(Math.max(e.sy, e.py), e.py + e.h);
      const away = Math.sqrt((cx - e.sx) * (cx - e.sx) + (cy - e.sy) * (cy - e.sy));
      e.lead = e.line !== null && (e.dot !== null || away > (e.mode === TAG_TIP ? e.gap + LEADER_TIP_EXTRA : LEADER_MIN));
      e.ex = cx;
      e.ey = cy;
    } else {
      e.lead = false;
    }
    if (!this.root) return;
    if (e.shown !== e.lastShown) {
      e.el.style.opacity = e.shown ? '1' : '0';
      if (e.dot) e.dot.style.display = e.shown ? '' : 'none';
      e.lastShown = e.shown;
    }
    if (e.line && e.casing && e.lead !== e.lastLead) {
      e.line.style.display = e.casing.style.display = e.lead ? '' : 'none';
      e.lastLead = e.lead;
    }
    if (!e.shown) return;
    const x = Math.round(e.px * 2) / 2, y = Math.round(e.py * 2) / 2;
    if (x !== e.lastX || y !== e.lastY) {
      e.el.style.transform = `translate3d(${x}px,${y}px,0)`;
      e.lastX = x;
      e.lastY = y;
    }
    const len = e.len;
    if (!len) return;
    // Leader and dot: written as numbers (SVG lengths), and only when an end moved half a pixel.
    const ax = Math.round(e.sx * 2) / 2, ay = Math.round(e.sy * 2) / 2;
    if (len.length > 8 && (ax !== e.dotX || ay !== e.dotY)) {
      len[8]!.value = ax; len[9]!.value = ay;
      e.dotX = ax; e.dotY = ay;
    }
    if (!e.lead) return;
    const bx = Math.round(e.ex * 2) / 2, by = Math.round(e.ey * 2) / 2;
    if (ax !== e.lx1 || ay !== e.ly1) {
      len[0]!.value = ax; len[1]!.value = ay; len[4]!.value = ax; len[5]!.value = ay;
      e.lx1 = ax; e.ly1 = ay;
    }
    if (bx !== e.lx2 || by !== e.ly2) {
      len[2]!.value = bx; len[3]!.value = by; len[6]!.value = bx; len[7]!.value = by;
      e.lx2 = bx; e.ly2 = by;
    }
  }
}
