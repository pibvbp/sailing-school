// Tag de-cluttering for the label layer: every tag gets a place where it overlaps no other tag, inside the safe
// area (the part of the window the HUD leaves free), as close as possible to where it wants to be. Pure arithmetic on
// plain objects — no DOM, no three.js — so it runs in the unit tests exactly as it does in the browser.
//
// Tags are placed greedily, the most important first. Each tries its own preferred places (beyond its arrow's head
// and fanned around it, or its fixed offset and the mirrored ones), then is pushed away from the layout's focus (the
// boat on screen) ring by ring until it is free — so a crowd of tags fans out round the boat in the order of their
// anchors instead of piling up on it. Every candidate is clamped into the safe area before it is tested; a tag that
// still finds no room is hidden, never stacked. A tag stays where it was put — at the same offset from its anchor, so it
// rides with the thing it names — while that place is free, and moves back to a better place only once that has been
// free for longer than a wave period, so tags do not hop between two places while the boat rocks.
// Tags also keep off the arrows on screen (a tag lying across an arrow hides the very thing it names) and out of a
// small disc round the boat.
//
// Nothing here allocates per frame: the candidate tables are constant and the list of placed tags is reused.

/** Insets of the area tags may use, in CSS px from the viewport edges. */
export interface SafeInsets { top: number; right: number; bottom: number; left: number }

/** A rectangle in viewport CSS px. */
export interface ScreenRect { x: number; y: number; w: number; h: number }

/** Preferred centre offset (dx, dy) from the anchor; the alternatives mirror it. */
export const TAG_OFFSET = 0;
/** At an arrow's head: beyond the tip along the arrow's screen direction (tdx, tdy), `gap` px clear of it. */
export const TAG_TIP = 1;
/** Callout: `radial` px away from the layout's focus, with a leader line. */
export const TAG_RADIAL = 2;
/** Exactly on its anchor (offset dx, dy) or not shown at all — never moved, never clamped. */
export const TAG_FIXED = 3;
export type TagMode = typeof TAG_OFFSET | typeof TAG_TIP | typeof TAG_RADIAL | typeof TAG_FIXED;

/** One tag as the layout sees it. `slot` and `wait` persist between frames; `x`, `y` and `shown` are the result. */
export interface TagBox {
  /** Anchor on screen (CSS px). */
  sx: number;
  sy: number;
  w: number;
  h: number;
  mode: TagMode;
  dx: number;
  dy: number;
  /** Unit screen direction of the arrow (TAG_TIP). */
  tdx: number;
  tdy: number;
  gap: number;
  radial: number;
  /** Candidate the tag used last frame (−1: none). */
  slot: number;
  /** Seconds a better candidate has been free while the tag stayed where it was. */
  wait: number;
  /** Where the tag stood last frame: its box's top-left corner relative to the anchor. */
  kx: number;
  ky: number;
  /** Seconds before a tag that found no room looks for one again. */
  retry: number;
  /** Seconds a place must still stay free before a tag that lost its place shows again. */
  lost: number;
  /** Top-left corner of the tag box. */
  x: number;
  y: number;
  shown: boolean;
}

export function newTagBox(): TagBox {
  return { sx: 0, sy: 0, w: 0, h: 0, mode: TAG_OFFSET, dx: 0, dy: -18, tdx: 0, tdy: -1, gap: 10, radial: 0, slot: -1, wait: 0, kx: 0, ky: 0, retry: 0, lost: 0, x: 0, y: 0, shown: false };
}

// Candidate tables (flat, so reading them never allocates).
/** Offset alternatives: the preferred side, then mirrored and rotated — factors (x, y) per candidate. */
const OFFSET_X = [1, -1, 1, -1, 0, 0, 1.8, -1.8];
const OFFSET_Y = [1, 1, -1, -1, 1.6, -1.6, 0, 0];
/** Arrow-tip candidates: angle offset from the arrow direction (rad) and extra distance (px). */
const TIP_A = [0, 0.6, -0.6, 1.2, -1.2, 0, 0.5, -0.5, 1.57, -1.57];
const TIP_D = [0, 0, 0, 2, 2, 22, 26, 26, 6, 6];
/** Callout candidates: angle offset from straight out (rad) and leader length factor. */
const RADIAL_A = [0, 0.35, -0.35, 0, 0.7, -0.7, 0.35, -0.35, 1.1, -1.1];
const RADIAL_K = [1, 1, 1, 1.7, 1.2, 1.2, 1.9, 1.9, 1.4, 1.4];
/** Push-apart directions, as angle offsets from "away from the focus"; tried ring by ring. */
const FAN = [0, 0.5, -0.5, 1.05, -1.05, 1.75, -1.75, Math.PI];
const FAN_RINGS = 7;
/** The first ring starts this far beyond the anchor (px); each further ring adds the tag's height plus a gap. */
const FAN_START = 12;
const FAN_GAP = 7;
/** Weight (px) of the tag's own direction in "away from the focus": it decides close to the focus, not far from it. */
const FAN_LEAN = 36;
/** Free space kept between two tags (px) when one is placed, and the least a tag already in place may be left with. */
export const TAG_GAP_X = 4;
export const TAG_GAP_Y = 3;
const TAG_GAP_MIN = 1.5;
/** Seconds a better place must stay free before a tag moves back to it: longer than a wave period. */
const HOLD_S = 4.5;
/**
 * A tag in place follows its candidate's own geometry while that moves less than this per frame (px); a bigger jump
 * (the fan direction swinging round near the focus) leaves the tag where it was relative to its anchor.
 */
const FOLLOW_PX = 6;
/**
 * A tag in place that another tag or a HUD rectangle now touches first edges aside, up to this far (px) in a frame,
 * before it gives up its place: anchors on different parts of the boat sway against each other as she rocks.
 */
const NUDGE_PX = 8;
/** Seconds a tag that found no room waits before searching all its candidates again. */
const RETRY_S = 0.25;
/** Seconds a new place must stay free before a tag that lost its place shows again: longer than the boat's rocking. */
const SHOW_S = 2.5;
/** Most rectangles the tags must keep clear of (HUD parts inside the safe area). */
export const MAX_KEEP_OUT = 8;
/** Most arrows the tags keep off, and the clearance (px) a tag keeps from an arrow's centre line. */
export const MAX_SEGMENTS = 64;
const SEGMENT_PAD = 4;
/**
 * A tag already in place may reach this far (px) into the disc round the boat before it has to move: the boat sways
 * all the time, and tags must not dance with her.
 */
const CLEAR_SLACK = 6;

/** Preferred candidates per mode (indexed by TagMode). */
const PRIMARY = [OFFSET_X.length, TIP_A.length, RADIAL_A.length, 1];

export class TagLayout {
  /** Safe area (CSS px): tags lie inside [x0, x1] × [y0, y1]. */
  x0 = 0;
  y0 = 0;
  x1 = 1;
  y1 = 1;
  /** Screen point the tags are pushed away from (the boat), when set. */
  fx = 0;
  fy = 0;
  hasFocus = false;
  /**
   * Radius (px) of the disc round the focus that tags stay out of, so they stand round the boat instead of on it; a
   * tag anchored inside it is moved out and keeps a leader line. 0: no such disc.
   */
  clearR = 0;
  /**
   * The arrows on screen as segments (x1, y1, x2, y2 each, CSS px): a tag never lies across one — it would hide the
   * very thing it names. Filled by the label layer every frame.
   */
  readonly segs = new Float32Array(4 * MAX_SEGMENTS);
  segCount = 0;
  private readonly placed: TagBox[] = [];
  private count = 0;
  private readonly keepOut: ScreenRect[] = [];
  private keepOutCount = 0;
  /** The rectangle (a placed tag or a keep-out) that made the last `free` fail; null when something else did. */
  private hit: ScreenRect | null = null;

  constructor() {
    for (let i = 0; i < MAX_KEEP_OUT; i++) this.keepOut.push({ x: 0, y: 0, w: 0, h: 0 });
  }

  /** The safe area from the viewport size and the insets; it is never narrower than a third of the viewport. */
  setSafe(width: number, height: number, insets: SafeInsets): void {
    let l = Math.max(0, insets.left), r = Math.max(0, insets.right), t = Math.max(0, insets.top), b = Math.max(0, insets.bottom);
    const minW = width / 3, minH = height / 3;
    if (width - l - r < minW) { const k = (width - minW) / Math.max(l + r, 1e-6); l *= k; r *= k; }
    if (height - t - b < minH) { const k = (height - minH) / Math.max(t + b, 1e-6); t *= k; b *= k; }
    this.x0 = l;
    this.y0 = t;
    this.x1 = width - r;
    this.y1 = height - b;
  }

  /** Rectangles inside the safe area that tags must keep clear of (copied; at most MAX_KEEP_OUT). */
  setKeepOut(rects: readonly ScreenRect[] | null | undefined): void {
    const n = Math.min(rects?.length ?? 0, MAX_KEEP_OUT);
    for (let i = 0; i < n; i++) {
      const s = rects![i]!, d = this.keepOut[i]!;
      d.x = s.x; d.y = s.y; d.w = s.w; d.h = s.h;
    }
    this.keepOutCount = n;
  }

  /**
   * Place the first `n` tags of `list` (already ordered, the most important first). Sets `x`, `y` and `shown` on
   * each. A tag that is shown overlaps no other shown tag, no keep-out rectangle and no arrow, and lies inside the
   * safe area (TAG_FIXED tags are shown only where they already do).
   */
  place(list: readonly TagBox[], n: number, dt: number): void {
    this.count = 0;
    for (let q = 0; q < n; q++) {
      const e = list[q]!;
      // Wider or taller than the safe area itself: there is no place where it lies inside, so it is not shown.
      if (e.w > this.x1 - this.x0 || e.h > this.y1 - this.y0) { e.slot = -1; e.shown = false; continue; }
      const total = PRIMARY[e.mode]! + (e.mode === TAG_FIXED ? 0 : FAN.length * FAN_RINGS);
      // Where it was, if that place is still free — judged without the comfort margins, so a tag does not shuffle
      // because an arrow swayed a pixel nearer.
      const stay = e.slot >= 0 && e.slot < total && this.kept(e);
      const sx = e.x, sy = e.y;
      /** The tag stands on its own candidate (not left behind by a jump of it). */
      const onSlot = stay && this.candidate(e, e.slot) && Math.abs(e.x - sx) + Math.abs(e.y - sy) < 0.5;
      // The best place that is free now. While it can stay, only a better one matters, and only one of its preferred
      // places, not a nearer ring of the fan — or its own candidate, once a jump of that has left the tag behind.
      let ideal = -1;
      if (stay || e.retry <= 0) {
        const limit = stay ? (onSlot ? Math.min(e.slot, PRIMARY[e.mode]!) : e.slot + 1) : total;
        for (let i = 0; i < limit; i++) {
          if (this.candidate(e, i) && this.free(e, 1)) { ideal = i; break; }
        }
      }
      let use = ideal;
      if (stay) {
        // It moves to a better place only once that has been free for a while.
        if (ideal >= 0) e.wait += dt; else e.wait = 0;
        if (ideal < 0 || e.wait < HOLD_S) { use = e.slot; e.x = sx; e.y = sy; } else e.wait = 0;
        e.retry = 0;
      } else {
        e.wait = 0;
        // No room anywhere: look again in a moment rather than every frame.
        e.retry = ideal >= 0 ? 0 : e.retry > 0 ? e.retry - dt : RETRY_S;
        if (ideal < 0 && e.slot >= 0) e.lost = SHOW_S; // it had a place and lost it
        else if (ideal >= 0 && e.lost > 0) {
          // Back only once the new place has stayed free a while; checked every frame meanwhile.
          e.lost -= dt;
          if (e.lost > 0) use = -1;
        } else if (ideal < 0 && e.lost > 0) e.lost = SHOW_S;
      }
      e.slot = use;
      e.shown = use >= 0;
      if (e.shown) {
        e.kx = e.x - e.sx;
        e.ky = e.y - e.sy;
        this.placed[this.count++] = e;
      }
    }
  }

  /**
   * Can the tag stay where it stood? Sets its box to that place: its own candidate when that has moved only a little
   * since the last frame (so it follows its arrow's head smoothly), else the same offset from the anchor as before.
   */
  private kept(e: TagBox): boolean {
    if (e.mode === TAG_FIXED) return this.candidate(e, e.slot) && this.free(e, 0);
    const kx = this.clampX(e, e.sx + e.kx), ky = this.clampY(e, e.sy + e.ky);
    if (this.candidate(e, e.slot) && Math.abs(e.x - kx) + Math.abs(e.y - ky) <= FOLLOW_PX && this.free(e, 0)) return true;
    e.x = kx;
    e.y = ky;
    return this.free(e, 0) || this.nudge(e);
  }

  /**
   * Edge the tag just clear of the rectangle it touches, the shortest way first, by at most NUDGE_PX; true when one
   * of the four ways leaves it free (the box is then there), else the box is put back.
   */
  private nudge(e: TagBox): boolean {
    const o = this.hit;
    if (!o) return false;
    const x = e.x, y = e.y;
    // Shifts that put the box just clear of `o` to its left, right, top and bottom.
    const d0 = o.x - TAG_GAP_X - (x + e.w), d1 = o.x + o.w + TAG_GAP_X - x;
    const d2 = o.y - TAG_GAP_Y - (y + e.h), d3 = o.y + o.h + TAG_GAP_Y - y;
    let tried = 0;
    for (;;) {
      let best = NUDGE_PX, way = -1;
      if (!(tried & 1) && -d0 <= best) { best = -d0; way = 0; }
      if (!(tried & 2) && d1 <= best) { best = d1; way = 1; }
      if (!(tried & 4) && -d2 <= best) { best = -d2; way = 2; }
      if (!(tried & 8) && d3 <= best) { best = d3; way = 3; }
      if (way < 0) break;
      tried |= 1 << way;
      e.x = way === 0 ? this.clampX(e, x + d0) : way === 1 ? this.clampX(e, x + d1) : x;
      e.y = way === 2 ? this.clampY(e, y + d2) : way === 3 ? this.clampY(e, y + d3) : y;
      if (this.free(e, 0)) return true;
    }
    e.x = x;
    e.y = y;
    return false;
  }

  private clampX(e: TagBox, x: number): number { return Math.max(this.x0, Math.min(x, this.x1 - e.w)); }
  private clampY(e: TagBox, y: number): number { return Math.max(this.y0, Math.min(y, this.y1 - e.h)); }

  /** Candidate `i` of a tag: writes its box position; false when this tag has no such candidate. */
  private candidate(e: TagBox, i: number): boolean {
    const primary = PRIMARY[e.mode]!;
    let cx: number, cy: number; // box centre
    if (i >= primary) {
      // Pushed apart: away from the focus (else along the tag's own preferred direction), ring by ring — round the
      // anchor, or round the nearest point of the safe area when the anchor lies outside it (the rings then spread
      // along the edge instead of all collapsing onto one clamped spot).
      const k = i - primary;
      const ring = Math.floor(k / FAN.length) + 1;
      const bx = Math.max(this.x0, Math.min(e.sx, this.x1)), by = Math.max(this.y0, Math.min(e.sy, this.y1));
      let ax = 0, ay = 0;
      if (this.hasFocus) { ax = bx - this.fx; ay = by - this.fy; }
      // Close to the focus "away from it" swings about with every pixel the anchor moves: lean on the tag's own
      // direction there (its arrow's, or its preferred offset's).
      const px = e.mode === TAG_TIP ? e.tdx : e.dx, py = e.mode === TAG_TIP ? e.tdy : e.dy;
      const pl = Math.sqrt(px * px + py * py);
      if (pl > 1e-6) { ax += (FAN_LEAN * px) / pl; ay += (FAN_LEAN * py) / pl; }
      if (Math.abs(ax) + Math.abs(ay) < 1e-3) { ax = 0; ay = -1; }
      const a = Math.atan2(ay, ax) + FAN[k % FAN.length]!;
      const c = Math.cos(a), s = Math.sin(a);
      const reach = FAN_START + ring * (e.h + FAN_GAP) + boxReach(e, c, s);
      cx = bx + c * reach;
      cy = by + s * reach;
    } else if (e.mode === TAG_TIP) {
      const a = Math.atan2(e.tdy, e.tdx) + TIP_A[i]!;
      const c = Math.cos(a), s = Math.sin(a);
      const reach = e.gap + TIP_D[i]! + boxReach(e, c, s);
      cx = e.sx + c * reach;
      cy = e.sy + s * reach;
    } else if (e.mode === TAG_RADIAL) {
      if (!this.hasFocus) return false;
      const a = Math.atan2(e.sy - this.fy, e.sx - this.fx) + RADIAL_A[i]!;
      const r = e.radial * RADIAL_K[i]!;
      cx = e.sx + Math.cos(a) * (r + e.w * 0.5);
      cy = e.sy + Math.sin(a) * (r + e.h * 0.5);
    } else if (e.mode === TAG_FIXED) {
      e.x = e.sx + e.dx - e.w * 0.5;
      e.y = e.sy + e.dy - e.h * 0.5;
      return e.x >= this.x0 && e.y >= this.y0 && e.x + e.w <= this.x1 && e.y + e.h <= this.y1;
    } else {
      cx = e.sx + (i === 0 ? e.dx : OFFSET_X[i]! * Math.max(Math.abs(e.dx), e.w * 0.5 + 8));
      cy = e.sy + (i === 0 ? e.dy : OFFSET_Y[i]! * Math.max(Math.abs(e.dy), e.h * 0.5 + 6));
    }
    // Inside the safe area, wherever the anchor is.
    e.x = this.clampX(e, cx - e.w * 0.5);
    e.y = this.clampY(e, cy - e.h * 0.5);
    return true;
  }

  /**
   * Is the tag's box free where it stands? `margin` = 1 asks for the full clearances (a new place); 0 only that it
   * touches nothing (the place it already has).
   */
  private free(e: TagBox, margin: number): boolean {
    this.hit = null;
    if (this.clearR > 0 && this.hasFocus && e.mode !== TAG_FIXED) {
      // Nearest point of the box to the focus inside the disc: the tag would sit on the boat.
      const nx = Math.max(e.x, Math.min(this.fx, e.x + e.w)) - this.fx;
      const ny = Math.max(e.y, Math.min(this.fy, e.y + e.h)) - this.fy;
      const r = this.clearR - (1 - margin) * CLEAR_SLACK;
      if (nx * nx + ny * ny < r * r) return false;
    }
    const gx = TAG_GAP_MIN + margin * (TAG_GAP_X - TAG_GAP_MIN), gy = TAG_GAP_MIN + margin * (TAG_GAP_Y - TAG_GAP_MIN);
    for (let i = 0; i < this.count; i++) {
      const o = this.placed[i]!;
      if (e.x < o.x + o.w + gx && e.x + e.w + gx > o.x && e.y < o.y + o.h + gy && e.y + e.h + gy > o.y) {
        this.hit = o;
        return false;
      }
    }
    for (let i = 0; i < this.keepOutCount; i++) {
      const o = this.keepOut[i]!;
      if (e.x < o.x + o.w && e.x + e.w > o.x && e.y < o.y + o.h && e.y + e.h > o.y) {
        this.hit = o;
        return false;
      }
    }
    // A new place keeps clear of the arrows; a tag in place moves once an arrow's centre line reaches its box.
    const sg = this.segs;
    const pad = margin * SEGMENT_PAD;
    const rx0 = e.x - pad, ry0 = e.y - pad, rx1 = e.x + e.w + pad, ry1 = e.y + e.h + pad;
    for (let i = 0, k = 0; i < this.segCount; i++, k += 4) {
      if (segmentHitsRect(sg[k]!, sg[k + 1]!, sg[k + 2]!, sg[k + 3]!, rx0, ry0, rx1, ry1)) return false;
    }
    return true;
  }
}

/** Does the segment (x1, y1) → (x2, y2) pass through the rectangle [rx0, rx1] × [ry0, ry1]? (Liang–Barsky clipping.) */
export function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, rx0: number, ry0: number, rx1: number, ry1: number): boolean {
  // Both ends on the outer side of one edge: no.
  if ((x1 < rx0 && x2 < rx0) || (x1 > rx1 && x2 > rx1) || (y1 < ry0 && y2 < ry0) || (y1 > ry1 && y2 > ry1)) return false;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  if (dx !== 0) {
    const a = (rx0 - x1) / dx, b = (rx1 - x1) / dx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (dy !== 0) {
    const a = (ry0 - y1) / dy, b = (ry1 - y1) / dy;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
}

/**
 * Distance from a box's centre to its edge along the unit direction (c, s): a box placed that far (plus a gap) from
 * a point along the direction touches the gap with its nearest edge, however wide it is.
 */
function boxReach(e: TagBox, c: number, s: number): number {
  const ac = Math.abs(c), as = Math.abs(s);
  const rx = ac > 1e-6 ? (e.w * 0.5) / ac : Infinity;
  const ry = as > 1e-6 ? (e.h * 0.5) / as : Infinity;
  return Math.min(rx, ry);
}

/** True when two rectangles overlap (what the layout guarantees never holds for two shown tags). */
export function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
