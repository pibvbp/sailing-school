// Tag legibility: no two tags overlap, every tag lies inside the safe area (the part of the window the HUD leaves
// free), tags keep off the arrows and out of the disc round the boat — for the bare layout on synthetic piles and
// for the real overlays against a real simulation, in the app's cameras and window sizes.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OVERLAY_KEYS, type ForcePart } from '../../../lessons/types';
import { tierSettings } from '../../core/types';
import { Overlays } from '../Overlays';
import { LabelLayer, defaultSafeInsets, type ArrowSource, type PlacedTag } from '../labels';
import { DEG } from '../../../shared/math';
import {
  TAG_FIXED, TAG_OFFSET, TAG_RADIAL, TAG_TIP, TagLayout, newTagBox, rectsOverlap, segmentHitsRect,
  type ScreenRect, type TagBox, type TagMode,
} from '../tagLayout';
import { bestMeanMs, sail } from './helpers';
import { perfBudget } from '../../../testing/perf';

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return ((s ^ (s >>> 13)) >>> 0) / 4294967296;
  };
}

function tag(sx: number, sy: number, w: number, mode: TagMode, extra: Partial<TagBox> = {}): TagBox {
  return { ...newTagBox(), sx, sy, w, h: 20, mode, ...extra };
}

/** No two shown tags overlap; every shown, movable tag is inside the safe area. */
function expectLegible(tags: readonly TagBox[], L: TagLayout, where = ''): void {
  const shown = tags.filter((t) => t.shown);
  for (let i = 0; i < shown.length; i++) {
    const a = shown[i]!;
    expect(a.x, `${where} tag ${i} left`).toBeGreaterThanOrEqual(L.x0 - 1e-6);
    expect(a.y, `${where} tag ${i} top`).toBeGreaterThanOrEqual(L.y0 - 1e-6);
    expect(a.x + a.w, `${where} tag ${i} right`).toBeLessThanOrEqual(L.x1 + 1e-6);
    expect(a.y + a.h, `${where} tag ${i} bottom`).toBeLessThanOrEqual(L.y1 + 1e-6);
    for (let j = i + 1; j < shown.length; j++) expect(rectsOverlap(a, shown[j]!), `${where} tags ${i} and ${j} overlap`).toBe(false);
  }
}

function layout(width = 1440, height = 900): TagLayout {
  const L = new TagLayout();
  L.setSafe(width, height, defaultSafeInsets(width, { top: 0, right: 0, bottom: 0, left: 0 }));
  L.hasFocus = true;
  L.fx = 0.5 * (L.x0 + L.x1);
  L.fy = 0.5 * (L.y0 + L.y1);
  return L;
}

describe('tag layout', () => {
  it('pushes a pile of arrow tags apart: all shown, none overlapping, all inside the safe area', () => {
    const L = layout();
    // Twelve arrows from one centre of effort, like the Forces overlay in the top view: tips within 30 px.
    const r = rng(7);
    const tags: TagBox[] = [];
    for (let i = 0; i < 12; i++) {
      const a = r() * 2 * Math.PI;
      tags.push(tag(L.fx + 30 * Math.cos(a), L.fy + 30 * Math.sin(a), 100 + 60 * r(), TAG_TIP, { tdx: Math.cos(a), tdy: Math.sin(a) }));
    }
    L.place(tags, tags.length, 1 / 60);
    expect(tags.every((t) => t.shown)).toBe(true);
    expectLegible(tags, L);
  });

  it('clamps tags whose anchors lie under the HUD or beyond the window edge into the safe area', () => {
    const L = layout();
    const tags = [
      tag(40, 300, 130, TAG_TIP, { tdx: -1, tdy: 0 }),          // under the lesson dock, arrow pointing further in
      tag(1420, 500, 130, TAG_TIP, { tdx: 1, tdy: 0 }),         // under the trim dock
      tag(700, 10, 130, TAG_TIP, { tdx: 0, tdy: -1 }),          // under the top bar
      tag(700, 890, 130, TAG_OFFSET, { dx: 0, dy: 22 }),        // on the instrument strip
      tag(-60, -40, 130, TAG_OFFSET),                           // off the window altogether
    ];
    L.place(tags, tags.length, 1 / 60);
    expect(tags.every((t) => t.shown)).toBe(true);
    expectLegible(tags, L);
  });

  it('keeps tags off keep-out rectangles, off arrows and out of the disc round the boat', () => {
    const L = layout();
    const dial: ScreenRect = { x: 560, y: 560, w: 180, h: 140 };
    L.setKeepOut([dial]);
    L.clearR = 70;
    // One arrow from the boat to the right; its own tag at the tip, a second tag anchored on its shaft.
    L.segs.set([L.fx, L.fy, L.fx + 200, L.fy]);
    L.segCount = 1;
    const tags = [
      tag(L.fx + 200, L.fy, 120, TAG_TIP, { tdx: 1, tdy: 0 }),
      tag(L.fx + 100, L.fy, 120, TAG_OFFSET, { dx: 0, dy: 0 }),
      tag(L.fx + 5, L.fy + 5, 120, TAG_OFFSET, { dx: 0, dy: 22 }),   // anchored on the boat
      tag(650, 630, 120, TAG_OFFSET, { dx: 0, dy: 0 }),              // anchored on the dial
    ];
    L.place(tags, tags.length, 1 / 60);
    expect(tags.every((t) => t.shown)).toBe(true);
    expectLegible(tags, L);
    for (const t of tags) {
      expect(rectsOverlap(t, dial), 'on the dial').toBe(false);
      expect(segmentHitsRect(L.fx, L.fy, L.fx + 200, L.fy, t.x, t.y, t.x + t.w, t.y + t.h), 'across the arrow').toBe(false);
      const nx = Math.max(t.x, Math.min(L.fx, t.x + t.w)) - L.fx, ny = Math.max(t.y, Math.min(L.fy, t.y + t.h)) - L.fy;
      expect(Math.hypot(nx, ny), 'on the boat').toBeGreaterThanOrEqual(70 - 1e-6);
    }
    // The tip tag kept its preferred place just beyond the arrow head.
    expect(tags[0]!.slot).toBe(0);
    expect(tags[0]!.x).toBeCloseTo(L.fx + 200 + 10, 6);
  });

  it('never moves a fixed tag: it is shown on its anchor or not at all', () => {
    const L = layout();
    const blocker = tag(700, 400, 120, TAG_OFFSET, { dx: 0, dy: 0 });
    const onBlocker = tag(700, 400, 90, TAG_FIXED, { dx: 0, dy: 0 });
    const free = tag(900, 300, 90, TAG_FIXED, { dx: 0, dy: 0 });
    const underDock = tag(100, 300, 90, TAG_FIXED, { dx: 0, dy: 0 });
    const tags = [blocker, onBlocker, free, underDock];
    L.place(tags, tags.length, 1 / 60);
    expect(onBlocker.shown).toBe(false);
    expect(underDock.shown).toBe(false);
    expect(free.shown).toBe(true);
    expect(free.x).toBeCloseTo(900 - 45, 6);
    expect(free.y).toBeCloseTo(300 - 10, 6);
  });

  it('holds a displaced tag in place while its spot is free, and lets it return once the better spot has been free longer than a wave period', () => {
    const L = layout();
    const blocker = tag(700, 400, 140, TAG_OFFSET, { dx: 0, dy: -18 });
    const t = tag(705, 402, 140, TAG_OFFSET, { dx: 0, dy: -18 });
    L.place([blocker, t], 2, 1 / 60);
    expect(t.shown).toBe(true);
    expect(t.slot).toBeGreaterThan(0);
    const displaced = t.slot;
    // The blocker goes away: the tag does not snap back at once …
    L.place([t], 1, 1 / 60);
    expect(t.slot).toBe(displaced);
    // … nor while the boat rocks once (the hold is longer than a wave period) …
    for (let i = 0; i < 4 * 60; i++) L.place([t], 1, 1 / 60);
    expect(t.slot).toBe(displaced);
    // … but does within five seconds.
    for (let i = 0; i < 60; i++) L.place([t], 1, 1 / 60);
    expect(t.slot).toBe(0);
    // A place that becomes blocked is left immediately.
    L.place([blocker, t], 2, 1 / 60);
    expect(t.slot).toBeGreaterThan(0);
    expectLegible([blocker, t], L);
  });

  it('a tag in place rides with its anchor, even where the fan direction swings round (anchor near the focus)', () => {
    const L = layout();
    L.clearR = 0;
    // Displaced by a blocker onto the fan, anchored a few px from the focus: "away from the focus" is ill-defined.
    const blocker = tag(L.fx + 3, L.fy - 20, 160, TAG_OFFSET, { dx: 0, dy: -18 });
    const t = tag(L.fx + 3, L.fy - 2, 120, TAG_OFFSET, { dx: 0, dy: -18 });
    L.place([blocker, t], 2, 1 / 60);
    expect(t.shown).toBe(true);
    const ox = t.x - t.sx, oy = t.y - t.sy;
    // The anchor circles the focus by 4 px (the boat rocking): the tag keeps its offset from it.
    for (let i = 0; i < 600; i++) {
      const a = (i / 60) * 2;
      t.sx = L.fx + 4 * Math.cos(a); t.sy = L.fy + 4 * Math.sin(a);
      blocker.sx = t.sx; blocker.sy = t.sy - 18;
      L.place([blocker, t], 2, 1 / 60);
      expect(t.shown).toBe(true);
      expect(Math.hypot(t.x - t.sx - ox, t.y - t.sy - oy), `frame ${i}`).toBeLessThan(1e-6);
    }
  });

  it('edges a tag in place aside when another tag sways into it, instead of sending it elsewhere', () => {
    const L = layout();
    const a = tag(700, 400, 120, TAG_OFFSET, { dx: 0, dy: 0 });
    const b = tag(700, 426, 120, TAG_OFFSET, { dx: 0, dy: 0 });
    L.place([a, b], 2, 1 / 60);
    expect(b.slot).toBe(0);
    // `a`'s anchor sways 5 px down: `b` steps down with it rather than jumping.
    a.sy += 5;
    L.place([a, b], 2, 1 / 60);
    expect(b.shown).toBe(true);
    expect(b.slot).toBe(0);
    expect(rectsOverlap(a, b)).toBe(false);
    // It was at y = 416; a moved 5 px down, so b moves down by a few px — no more.
    expect(b.y - 416).toBeGreaterThan(0);
    expect(b.y - 416).toBeLessThanOrEqual(5);
  });

  it('a tag that lost its place shows again only once a new one has stayed free for a while, and stops searching every frame meanwhile', () => {
    const L = layout();
    L.setSafe(400, 300, { top: 0, right: 0, bottom: 0, left: 0 });
    L.hasFocus = false;
    // A tag as wide as the safe area: a second one of the same size has room only when the first is gone.
    const big = tag(200, 150, 400, TAG_OFFSET, { h: 300, dx: 0, dy: 0 });
    const t = tag(200, 150, 120, TAG_OFFSET, { dx: 0, dy: 0 });
    L.place([t], 1, 1 / 60);
    expect(t.shown).toBe(true);
    L.place([big, t], 2, 1 / 60);
    expect(t.shown).toBe(false);
    expect(t.retry).toBeGreaterThan(0);
    // The blocker goes: the tag waits before coming back.
    for (let i = 0; i < 60; i++) L.place([t], 1, 1 / 60);
    expect(t.shown).toBe(false);
    for (let i = 0; i < 120; i++) L.place([t], 1, 1 / 60);
    expect(t.shown).toBe(true);
  });

  it('stays legible on random crowds in every mode, in both window sizes (and hides what cannot fit)', () => {
    const r = rng(20261001);
    for (const [W, H] of [[1440, 900], [1280, 800], [390, 780]] as const) {
      const L = layout(W, H);
      for (let scene = 0; scene < 150; scene++) {
        const n = 4 + Math.floor(r() * 36);
        L.clearR = r() < 0.5 ? 0 : 40 + 50 * r();
        L.segCount = Math.floor(r() * 10);
        for (let k = 0; k < L.segCount; k++) {
          const a = r() * 2 * Math.PI, len = 40 + 200 * r();
          L.segs.set([L.fx, L.fy, L.fx + len * Math.cos(a), L.fy + len * Math.sin(a)], 4 * k);
        }
        const tags: TagBox[] = [];
        for (let i = 0; i < n; i++) {
          const mode = [TAG_OFFSET, TAG_TIP, TAG_RADIAL, TAG_FIXED][Math.floor(r() * 4)] as TagMode;
          const a = r() * 2 * Math.PI;
          // Anchors clustered round the boat, some far out or off-screen.
          const spread = r() < 0.7 ? 120 : 900;
          tags.push(tag(L.fx + (r() - 0.5) * spread, L.fy + (r() - 0.5) * spread, 50 + 150 * r(), mode, {
            tdx: Math.cos(a), tdy: Math.sin(a), radial: 40, dx: (r() - 0.5) * 30, dy: (r() - 0.5) * 30, h: r() < 0.2 ? 26 : 20,
          }));
        }
        // Several frames with slowly moving anchors: hysteresis must never break the invariants.
        for (let f = 0; f < 4; f++) {
          for (const t of tags) { t.sx += (r() - 0.5) * 6; t.sy += (r() - 0.5) * 6; }
          L.place(tags, n, 1 / 60);
          expectLegible(tags, L, `${W}×${H} scene ${scene} frame ${f}`);
          for (const t of tags) {
            if (!t.shown) continue;
            for (let k = 0; k < L.segCount; k++) {
              const hit = segmentHitsRect(L.segs[4 * k]!, L.segs[4 * k + 1]!, L.segs[4 * k + 2]!, L.segs[4 * k + 3]!, t.x, t.y, t.x + t.w, t.y + t.h);
              expect(hit, `${W}×${H} scene ${scene}: a tag lies across an arrow`).toBe(false);
            }
          }
        }
        // With room to spare, crowds of up to a dozen movable tags are all shown (nothing is dropped needlessly).
        if (W >= 1280 && n <= 12) expect(tags.filter((t) => t.mode !== TAG_FIXED).every((t) => t.shown), `scene ${scene}`).toBe(true);
      }
    }
  });

  it('hides a tag wider than the safe area instead of letting it overhang', () => {
    const L = new TagLayout();
    L.setSafe(300, 600, { top: 0, right: 0, bottom: 0, left: 0 });
    const wide = tag(150, 300, 320, TAG_OFFSET);
    const fits = tag(150, 200, 120, TAG_OFFSET);
    L.place([wide, fits], 2, 1 / 60);
    expect(wide.shown).toBe(false);
    expect(fits.shown).toBe(true);
    expectLegible([wide, fits], L);
  });

  it('keeps a usable safe area whatever insets it is given', () => {
    const L = new TagLayout();
    L.setSafe(800, 600, { top: 500, right: 500, bottom: 500, left: 500 });
    expect(L.x1 - L.x0).toBeGreaterThanOrEqual(800 / 3 - 1e-6);
    expect(L.y1 - L.y0).toBeGreaterThanOrEqual(600 / 3 - 1e-6);
    L.setSafe(1440, 900, { top: 68, right: 320, bottom: 112, left: 372 });
    expect([L.x0, L.y0, L.x1, L.y1]).toEqual([372, 68, 1120, 788]);
  });

  it('segmentHitsRect: crossing, touching a corner region, and missing', () => {
    expect(segmentHitsRect(0, 0, 10, 10, 4, 4, 6, 6)).toBe(true);
    expect(segmentHitsRect(0, 5, 10, 5, 4, 4, 6, 6)).toBe(true);
    expect(segmentHitsRect(5, 5, 5.5, 5.5, 4, 4, 6, 6)).toBe(true); // wholly inside
    expect(segmentHitsRect(0, 0, 3, 3, 4, 4, 6, 6)).toBe(false);
    expect(segmentHitsRect(0, 9, 9, 0, 6, 6, 8, 8)).toBe(false); // passes the corner outside
    expect(segmentHitsRect(0, 7, 10, 7, 4, 4, 6, 6)).toBe(false);
    expect(segmentHitsRect(5, 0, 5, 3.9, 4, 4, 6, 6)).toBe(false);
  });
});

// ---- the real overlays -----------------------------------------------------------------------------------------

/** The app's chase camera (CameraRig: `dist` m astern, yaw 0.45, pitch 0.22, 50° lens) for a snapshot. */
function chaseCamera(heading: number, boat: THREE.Vector3, aspect: number, dist = 17): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 40000);
  const a = heading + Math.PI + 0.45, horiz = dist * Math.cos(0.22);
  cam.position.set(boat.x + Math.sin(a) * horiz, 2 + dist * Math.sin(0.22), boat.z - Math.cos(a) * horiz);
  cam.lookAt(boat.x, 3.2, boat.z);
  cam.updateMatrixWorld();
  return cam;
}

/** The app's top camera: 70 m straight above, the wind at the top of the screen, 35° lens. */
function topCamera(twd: number, boat: THREE.Vector3, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(35, aspect, 0.1, 40000);
  cam.position.set(boat.x, 70, boat.z);
  cam.up.set(Math.sin(twd), 0, -Math.cos(twd));
  cam.lookAt(boat.x, 0, boat.z);
  cam.updateMatrixWorld();
  return cam;
}

function expectTagsLegible(tags: readonly PlacedTag[], safe: ScreenRect, where: string): void {
  for (let i = 0; i < tags.length; i++) {
    const a = tags[i]!;
    if (a.kind !== 'sector') {
      expect(a.x, `${where}: "${a.title}" left`).toBeGreaterThanOrEqual(safe.x - 1e-6);
      expect(a.y, `${where}: "${a.title}" top`).toBeGreaterThanOrEqual(safe.y - 1e-6);
    }
    expect(a.x + a.w, `${where}: "${a.title}" right`).toBeLessThanOrEqual(safe.x + safe.w + 1e-6);
    expect(a.y + a.h, `${where}: "${a.title}" bottom`).toBeLessThanOrEqual(safe.y + safe.h + 1e-6);
    for (let j = i + 1; j < tags.length; j++) {
      expect(rectsOverlap(a, tags[j]!), `${where}: "${a.title}" overlaps "${tags[j]!.title}"`).toBe(false);
    }
  }
}

describe('overlay tags against a real simulation', () => {
  const cases: { name: string; tws: number; twa: number; keys: readonly (typeof OVERLAY_KEYS)[number][]; parts?: ForcePart[] }[] = [
    { name: 'forces, close-hauled', tws: 12, twa: 45, keys: ['forces'] },
    { name: 'forces + wind + x-ray, close reach', tws: 12, twa: 60, keys: ['forces', 'windTriangle', 'xray'] },
    { name: 'forces + slice + AoA, beam reach', tws: 10, twa: 90, keys: ['forces', 'flowSlice', 'aoa'] },
    { name: 'lift and drag only', tws: 10, twa: 90, keys: ['forces', 'aoa'], parts: ['liftDrag'] },
    { name: 'heeling force and keel lift, hard pressed', tws: 16, twa: 45, keys: ['forces', 'xray'], parts: ['heel', 'keel'] },
    { name: 'every overlay', tws: 14, twa: 100, keys: OVERLAY_KEYS },
  ];

  for (const c of cases) {
    it(`${c.name}: no tag overlaps another or leaves the safe area, in the chase and top cameras at 1440×900 and 1280×800`, () => {
      const { sim } = sail(c.tws, c.twa, { seconds: 20 });
      for (const [W, H] of [[1440, 900], [1280, 800]] as const) {
        for (const view of ['chase', 'top'] as const) {
          const scene = new THREE.Scene();
          const boat = new THREE.Group();
          scene.add(boat);
          const ov = new Overlays(scene, boat, tierSettings('low'));
          ov.setViewport(W, H);
          ov.setMarks([{ id: 'W', e: 0, n: 300, kind: 'windward' }]);
          ov.setForceParts(c.parts ?? null);
          for (const k of c.keys) ov.set(k, true);
          let shownMost = 0;
          for (let i = 0; i < 150; i++) {
            sim.step(); sim.step();
            const s = sim.snapshot();
            boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
            boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
            const cam = view === 'chase' ? chaseCamera(s.boat.heading, boat.position, W / H) : topCamera(s.wind.twd, boat.position, W / H);
            ov.update(1 / 60, s, cam);
            const tags = ov.placedTags();
            shownMost = Math.max(shownMost, tags.length);
            expectTagsLegible(tags, ov.safeRect(), `${c.name}, ${view} ${W}×${H}, frame ${i}`);
          }
          // The overlays really had tags on screen (the invariants above are not vacuous).
          expect(shownMost, `${c.name}, ${view} ${W}×${H}`).toBeGreaterThanOrEqual(c.parts ? 2 : 3);
          ov.dispose();
        }
      }
    });
  }

  // The boat rocks (pitch ±0.5°, roll ±1.5°, heave ±0.25 m): tags must not hop between places with her.
  for (const [keys, most] of [[['forces', 'windTriangle', 'xray'], 6], [['forces', 'windTriangle', 'xray', 'labels'], 12]] as const) {
    it(`keeps its tags in place while the boat rocks: at most ${most} changes of place in 12 s with ${keys.join(' + ')}`, () => {
      const { sim } = sail(12, 60, { seconds: 20 });
      const scene = new THREE.Scene();
      const boat = new THREE.Group();
      scene.add(boat);
      const ov = new Overlays(scene, boat, tierSettings('low'));
      ov.setViewport(1440, 900);
      for (const k of keys) ov.set(k, true);
      const entries = (ov as unknown as { labels: { entries: (TagBox & { visible: boolean })[] } }).labels.entries;
      const last = new Map<TagBox, { ox: number; oy: number; shown: boolean }>();
      let changes = 0;
      const settle = 120, frames = settle + 30 * 60;
      for (let i = 0; i < frames; i++) {
        sim.step(); sim.step();
        const s = sim.snapshot();
        const t = i / 60;
        boat.position.set(s.boat.pos.x, 0.25 * Math.sin((2 * Math.PI * t) / 3.1), -s.boat.pos.y);
        const pitch = 0.5 * DEG * Math.sin((2 * Math.PI * t) / 3.1), roll = 1.5 * DEG * Math.sin((2 * Math.PI * t) / 4.3);
        boat.rotation.set(pitch, -s.boat.heading, -s.boat.heel + roll, 'YXZ');
        ov.update(1 / 60, s, chaseCamera(s.boat.heading, boat.position, 1440 / 900, 19.5));
        if (i < settle) continue;
        for (const e of entries) {
          const p = last.get(e);
          const ox = e.x - e.sx, oy = e.y - e.sy;
          // A change of place: the box jumps more than 12 px relative to its anchor, or the tag blinks out or in.
          if (p && ((p.shown && e.shown && Math.hypot(ox - p.ox, oy - p.oy) > 12) || (p.shown !== e.shown && e.visible))) changes++;
          last.set(e, { ox, oy, shown: e.shown });
        }
      }
      expect((changes * 12) / 30).toBeLessThanOrEqual(most);
      ov.dispose();
    });
  }

  it('glides a tag that changes place instead of jumping, and lands it exactly', () => {
    const layer = new LabelLayer();
    layer.setViewport(1440, 900);
    layer.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
    const cam = new THREE.OrthographicCamera(-720, 720, 450, -450, 0.1, 100);
    cam.position.set(720, -450, 10);
    cam.updateMatrixWorld();
    // World x, −y = screen px.
    const blocker = layer.create({ priority: 9, dx: 0, dy: 0 });
    const t = layer.create({ priority: 1, dx: 0, dy: 0 });
    const e = (t as unknown as { e: TagBox & { px: number; py: number } }).e;
    t.text('Glide').at(new THREE.Vector3(700, -400, 0));
    layer.frame(cam, 1 / 60);
    const x0 = e.px, y0 = e.py;
    // A tag of higher priority takes the place: the box sets off toward its new place and gets there.
    blocker.text('Blocker, wide enough').at(new THREE.Vector3(700, -400, 0));
    layer.frame(cam, 1 / 60);
    const tx = e.x, ty = e.y;
    expect(Math.hypot(tx - x0, ty - y0)).toBeGreaterThan(12);
    const d1 = Math.hypot(e.px - tx, e.py - ty);
    expect(d1).toBeGreaterThan(0);
    expect(d1).toBeLessThan(Math.hypot(tx - x0, ty - y0));
    for (let i = 0; i < 60; i++) layer.frame(cam, 1 / 60);
    expect(e.px).toBe(e.x);
    expect(e.py).toBe(e.y);
    layer.dispose();
  });

  it('places fixed tags (the wheel\'s sector names) before movable ones, whatever their priority', () => {
    const layer = new LabelLayer();
    layer.setViewport(1440, 900);
    layer.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
    const cam = new THREE.OrthographicCamera(-720, 720, 450, -450, 0.1, 100);
    cam.position.set(720, -450, 10);
    cam.updateMatrixWorld();
    const p = new THREE.Vector3(700, -400, 0);
    const value = layer.create({ priority: 9, dx: 0, dy: 0 });
    const sector = layer.create({ kind: 'sector', priority: 1, dx: 0, dy: 0 });
    value.text('Heeling force', '1.20 kN').at(p);
    sector.text('No-go').at(p);
    for (let i = 0; i < 3; i++) layer.frame(cam, 1 / 60);
    const placed = layer.placed();
    expect(placed.map((t) => t.title).sort()).toEqual(['Heeling force', 'No-go']);
    expect(rectsOverlap(placed[0]!, placed[1]!)).toBe(false);
    layer.dispose();
  });

  it('follows setSafeArea: tags move into the area given, and out of the rectangles to keep clear of', () => {
    const { sim } = sail(12, 60, { seconds: 20 });
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    scene.add(boat);
    const ov = new Overlays(scene, boat, tierSettings('low'));
    ov.setViewport(1440, 900);
    for (const k of ['forces', 'windTriangle'] as const) ov.set(k, true);
    const run = (): PlacedTag[] => {
      for (let i = 0; i < 90; i++) {
        sim.step(); sim.step();
        const s = sim.snapshot();
        boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
        boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
        ov.update(1 / 60, s, chaseCamera(s.boat.heading, boat.position, 1440 / 900));
      }
      return ov.placedTags();
    };
    // Free sail: the lesson dock is collapsed, so the area reaches the left edge.
    ov.setSafeArea({ top: 68, right: 340, bottom: 100, left: 44 });
    expect(ov.safeRect()).toEqual({ x: 44, y: 68, w: 1440 - 340 - 44, h: 900 - 100 - 68 });
    const wide = run();
    expectTagsLegible(wide, ov.safeRect(), 'wide');
    // A narrow area with the wind dial to keep clear of.
    const dial: ScreenRect = { x: 560, y: 560, w: 190, h: 200 };
    ov.setSafeArea({ top: 120, right: 500, bottom: 140, left: 420 }, [dial]);
    const narrow = run();
    expect(narrow.length).toBeGreaterThan(3);
    expectTagsLegible(narrow, ov.safeRect(), 'narrow');
    for (const t of narrow) expect(rectsOverlap(t, dial), `"${t.title}" on the dial`).toBe(false);
    // Back to the defaults.
    ov.setSafeArea(null);
    const d = defaultSafeInsets(1440, { top: 0, right: 0, bottom: 0, left: 0 });
    expect(ov.safeRect()).toEqual({ x: d.left, y: d.top, w: 1440 - d.left - d.right, h: 900 - d.top - d.bottom });
    ov.dispose();
  });

  it('names what a lesson step talks about: lift, drag, the apparent wind and the angle of attack — and nothing else', () => {
    const { sim } = sail(10, 90, { seconds: 20, controls: { jibFurl: 1 } });
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    scene.add(boat);
    const ov = new Overlays(scene, boat, tierSettings('low'));
    ov.setViewport(1440, 900);
    ov.set('forces', true);
    ov.set('aoa', true);
    const titles = (parts: ForcePart[] | null): string[] => {
      ov.setForceParts(parts);
      for (let i = 0; i < 60; i++) {
        sim.step(); sim.step();
        const s = sim.snapshot();
        boat.position.set(s.boat.pos.x, 0, -s.boat.pos.y);
        boat.rotation.set(0, -s.boat.heading, -s.boat.heel, 'YXZ');
        ov.update(1 / 60, s, topCamera(s.wind.twd, boat.position, 1440 / 900));
      }
      return ov.placedTags().map((t) => t.title).sort();
    };
    expect(titles(['liftDrag'])).toEqual(['Angle of attack', 'Apparent wind', 'Drag', 'Lift']);
    expect(titles(['drive'])).toEqual(['Angle of attack', 'Apparent wind', 'Drive']);
    expect(titles(['total', 'drive'])).toEqual(['Aerodynamic force', 'Drive']);
    expect(titles(['heel', 'keel'])).toEqual(['Heeling force', 'Keel lift']);
    const all = titles(null);
    for (const t of ['Aerodynamic force', 'Drive', 'Heeling force', 'Keel lift', 'Main lift']) expect(all).toContain(t);
    expect(all).not.toContain('Angle of attack');
    ov.dispose();
  });

  it('lays the tags out without allocating: the heap does not grow while thousands of frames are placed', { retry: 2 }, () => {
    const { sim } = sail(12, 60);
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    scene.add(boat);
    const ov = new Overlays(scene, boat, tierSettings('low'));
    ov.setViewport(1440, 900);
    for (const k of ['forces', 'windTriangle', 'xray', 'labels', 'wheel'] as const) ov.set(k, true);
    const s0 = sim.snapshot();
    boat.position.set(s0.boat.pos.x, 0, -s0.boat.pos.y);
    boat.rotation.set(0, -s0.boat.heading, -s0.boat.heel, 'YXZ');
    const cam = chaseCamera(s0.boat.heading, boat.position, 1440 / 900);
    for (let i = 0; i < 300; i++) ov.update(1 / 60, s0, cam);
    expect(ov.placedTags().length).toBeGreaterThan(25);
    // The label layer alone: projection, ordering, the arrows to keep off, the layout, leaders (no DOM here).
    const priv = ov as unknown as { labels: LabelLayer; arrows: ArrowSource };
    const frame = (): void => priv.labels.frame(cam, 0.016, priv.arrows);
    for (let i = 0; i < 4000; i++) frame(); // let the JIT settle: interpreted code boxes every number
    let least = Infinity;
    for (let rep = 0; rep < 4; rep++) {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 4000; i++) frame();
      least = Math.min(least, (process.memoryUsage().heapUsed - before) / 4000);
    }
    // One `Math.hypot` per tag would already show as ~1 kB per frame.
    expect(least, 'bytes allocated per frame').toBeLessThan(24);
    ov.dispose();
  });

  // Timing: best-of-N already filters scheduler noise; the retry covers a machine that is busy for seconds.
  it('lays out the tags of every overlay within the CPU budget (median frame, node)', { retry: 2 }, () => {
    const { sim } = sail(12, 60);
    const scene = new THREE.Scene();
    const boat = new THREE.Group();
    scene.add(boat);
    const ov = new Overlays(scene, boat, tierSettings('high'));
    ov.setViewport(1440, 900);
    ov.setMarks([{ id: 'W', e: 0, n: 300, kind: 'windward' }]);
    for (const k of OVERLAY_KEYS) if (k !== 'flow' && k !== 'flowSlice') ov.set(k, true);
    const s0 = sim.snapshot();
    boat.position.set(s0.boat.pos.x, 0, -s0.boat.pos.y);
    boat.rotation.set(0, -s0.boat.heading, -s0.boat.heel, 'YXZ');
    const cam = chaseCamera(s0.boat.heading, boat.position, 1440 / 900);
    for (let i = 0; i < 60; i++) ov.update(1 / 60, s0, cam);
    expect(ov.placedTags().length).toBeGreaterThan(20);
    // Everything with tags on (no flow fields): arrows, lines and the layout of ~50 tags.
    const ms = bestMeanMs(() => ov.update(1 / 60, s0, cam), 40, 6);
    expect(ms).toBeLessThan(perfBudget(0.6));
    ov.dispose();
  });
});

describe('default safe area', () => {
  it('matches the desktop HUD with both docks open, and shrinks for the compact layout', () => {
    const out = { top: 0, right: 0, bottom: 0, left: 0 };
    expect(defaultSafeInsets(1920, out)).toEqual({ top: 68, left: 396, right: 344, bottom: 206 });
    expect(defaultSafeInsets(1440, out)).toEqual({ top: 68, left: 380, right: 332, bottom: 206 });
    expect(defaultSafeInsets(1280, out)).toEqual({ top: 68, left: 364, right: 332, bottom: 206 });
    expect(defaultSafeInsets(390, out)).toEqual({ top: 60, left: 8, right: 8, bottom: 200 });
  });
});
