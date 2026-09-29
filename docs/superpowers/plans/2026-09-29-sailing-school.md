# Sailing School v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship a photoreal, physics-driven 3D sailing school in the browser (public repo `pibvbp/sailing-school`, live on GitHub Pages).

**Architecture:** A pure-TypeScript deterministic simulation (`src/sim`, `src/flow`) steps at 120 Hz and publishes a `SimSnapshot`; a three.js r186 WebGL2 renderer (FFT ocean, procedural boat, dynamic sails, overlays) and a vanilla-TS DOM UI + lessons engine consume it. Render/UI modules are built in parallel against the snapshot contract, each with a standalone demo page verified by headless screenshots, then integrated.

**Tech Stack:** TypeScript (strict), Vite 8, three 0.186.x, Vitest 5, playwright-core / @playwright/test 1.62.1 (uses the cached Chromium 1234), pnpm 9, Node 22, GitHub Actions + Pages.

**Spec:** `docs/superpowers/specs/2026-09-29-sailing-school-design.md` (read it first — §5 conventions and §7 physics are binding).

## Global Constraints

- three pinned `0.186.x`; `WebGLRenderer` + WebGL2 + GLSL (no WebGPU/TSL paths in v1).
- Runtime dependencies: `three@0.186.x` and `postprocessing@6.39.x` only (spec §9.7). No runtime network fetches of assets; textures are procedural. Adapted open-source code (ABYSSAL ocean, wave-riders readback/wake) keeps its MIT header and is listed in `THIRD_PARTY_NOTICES.md`.
- Frames/signs/units exactly as spec §5: body x fwd / y stbd / z down; heel > 0 starboard down; TWA/AWA > 0 wind from starboard; boom/clew angles > 0 out to port; world North = −Z, East = +X; compass clockwise; TWD = from.
- `src/sim`, `src/flow`, `src/shared` never import `three` or touch the DOM.
- Fixed sim step 1/120 s; the app loop runs at most 12 sim steps per rendered frame.
- Performance budget spec §9.2 (60 fps @ M1 Air, default tier `high`).
- Vite `base: '/sailing-school/'` for production builds; dev server serves `demos/*.html`.
- Every `localStorage` access wrapped in try/catch; the app must work without it.
- Commits: conventional-commit subject, small, pushed at milestones; `pnpm typecheck && pnpm test && pnpm build` green before every push.
- Agents never run git; the lead commits after review. Agents don't add dependencies.

## Review Focus

1. **Frame hitches / hidden tab** — after the tab regains focus a 30 s gap must not explode the sim; the loop clamps to 12 steps and resumes smoothly. Test in Task 16 (`loop.test.ts`: `advance(30)` runs exactly 12 steps).
2. **Extreme but legal inputs** — 25 kn TWS, spinnaker up at TWA 100°, everything sheeted hard: the boat must round up/broach, stay finite (no NaN), |heel| < 90°, and recover. Test in Task 7 (`simulation.test.ts › stays finite in 25 kn broach`).
3. **Command spam / overlapping manoeuvres** — tack pressed during a gybe, hoist/douse toggled rapidly: state machines stay consistent, last command wins. Test in Task 8 (`autocrew.test.ts › ignores tack during gybe`, `spinnaker hoist/douse toggle`).
4. **No WebGL2 / no float render targets** — a readable fallback message, or automatic drop to the half-float/low tier; never a blank page. Test in Task 20 e2e (`?forceNoWebGL2=1` shows the fallback).
5. **Resize / DPR / orientation change** — canvas and post buffers resize, no stretching, panels reflow. Test in Task 20 e2e (resize viewport, assert canvas size matches).

---

## File Structure

```
package.json, pnpm-lock.yaml, tsconfig.json, vite.config.ts, index.html, LICENSE, README.md,
THIRD_PARTY_NOTICES.md, .gitignore, .github/workflows/ci.yml, .github/workflows/pages.yml
scripts/snap.mjs            headless screenshot of any page (starts Vite programmatically)
scripts/polars.mjs          regenerates src/sim/data/polars.json from the VPP
demos/index.html            links to every demo page; demos/<area>.html + demos/<area>.ts per render area
src/main.ts                 bootstrap (renderer, App, fallback message)
src/shared/math.ts          Vec2/Vec3 helpers, clamp/lerp/smoothstep/wrapPi, DEG, KN
src/shared/coords.ts        body↔boat-local↔world conversions
src/shared/boatSpec.ts      every Kestrel 25 dimension (spec §6) + derived geometry
src/sim/types.ts            Controls, WindSettings, SimSnapshot and sub-types (the contract)
src/sim/rng.ts              mulberry32 + gaussian
src/sim/wind.ts             WindField: gradient, puffs, shifts
src/sim/apparent.ts         air velocity at body points, AWA/TWA helpers
src/sim/aero.ts             sail coefficient model (luff/attached/stall), induced drag
src/sim/sails/common.ts     section evaluation (geometry + air → force), interaction, blanketing
src/sim/sails/main.ts       mainsail + boom dynamics, traveler/sheet/vang/shape
src/sim/sails/jib.ts        jib + clew dynamics, sheets, backing, furl, whisker pole
src/sim/sails/spinnaker.ts  spinnaker, pole geometry, hoist/douse, curl/collapse
src/sim/hydro.ts            hull resistance, foils (keel/rudder), cross-flow, windage, righting
src/sim/simulation.ts       Simulation class: state, step(), scenario API
src/sim/snapshot.ts         builds SimSnapshot
src/sim/events.ts           event detection
src/sim/autocrew.ts         crew hiking, auto-trim, tack/gybe/hoist sequences
src/sim/autopilot.ts        helm modes (heading/TWA/AWA hold)
src/sim/vpp.ts              steady-state solver + bestSpeed
src/sim/polarTable.ts       loads polars.json, interpolation, optimal VMG angles
src/sim/data/polars.json    generated
src/flow/*                  2-D vortex-lattice slice solver + velocity grids
src/render/core/*           renderer, post chain, quality tiers + governor
src/render/env/*            sky, clouds, lighting, land, marks, ocean/* (FFT, mesh, material, sampler, wake)
src/render/boat/*           procedural boat + materials/textures + animated parts
src/render/sails/*          sail meshes, cloth material, telltales, windex, burgee
src/render/overlays/*       vectors, wheel, labels, flow particles/slice, laylines, track, x-ray
src/render/cameras/*        chase, helm, top, sail-view, free
src/ui/*                    hud, instruments, trim panel, top bar, toasts, settings, help, input
src/lessons/engine.ts       runner; src/lessons/curriculum/*.ts content; src/lessons/glossary.ts
src/audio/*                 procedural soundscape
src/app/*                   App (modes), loop, scenario API, wiring
e2e/*.spec.ts               Playwright smoke
```

---

## Wave 0 — foundation (lead, sequential)

### Task 1: Scaffold, tooling, public repo, CI, Pages

**Files:** Create `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`,
`src/styles/base.css`, `demos/index.html`, `scripts/snap.mjs`, `.gitignore`, `LICENSE` (MIT, "2026
Philip — sailing-school contributors"), `README.md` (stub), `THIRD_PARTY_NOTICES.md`,
`.github/workflows/ci.yml`, `.github/workflows/pages.yml`, `src/__tests__/smoke.test.ts`.

**Interfaces:** Produces the scripts every later task uses: `pnpm dev`, `pnpm build`,
`pnpm typecheck`, `pnpm test`, `node scripts/snap.mjs <page> <out.png> [--wait ms] [--size WxH] [--eval js]`.

- [ ] **Step 1: package.json + install**

```json
{
  "name": "sailing-school",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "snap": "node scripts/snap.mjs",
    "polars": "node --experimental-strip-types scripts/polars.mjs",
    "e2e": "playwright test"
  }
}
```

Run: `pnpm add three@0.186.1 postprocessing@6.39 && pnpm add -D typescript vite vitest @types/three@0.186.0 playwright-core@1.62.1 @playwright/test@1.62.1 @types/node`
(If TypeScript 7 breaks anything in `tsc --noEmit`, pin `typescript@5.9`.)

- [ ] **Step 2: tsconfig + vite config**

`tsconfig.json`: `target ES2022`, `module ESNext`, `moduleResolution bundler`, `strict`, `noUncheckedIndexedAccess false`, `lib ["ES2022","DOM","DOM.Iterable"]`, `types ["vite/client","node"]`, `include ["src","demos","scripts","e2e","vite.config.ts"]`, `allowImportingTsExtensions` off, `skipLibCheck true`.

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sailing-school/' : '/',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5180, strictPort: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
```

- [ ] **Step 3: placeholder app** — `index.html` (full-viewport canvas, `<div id="ui">`), `src/main.ts` creates a `WebGLRenderer`, a sky-blue background and a rotating cube, sets `window.__ready = true` after the first frame; shows a readable message if WebGL2 is unavailable.

- [ ] **Step 4: `scripts/snap.mjs`** — starts Vite via `createServer({ server: { port: 0 } })`, launches `chromium` from `playwright-core` headless with `--use-angle=metal` (fallback `--use-angle=swiftshader --enable-unsafe-swiftshader` via `--swiftshader` flag), opens the page at `--size` (default 1280x720, deviceScaleFactor 1), waits for `window.__ready` (15 s max) then `--wait` ms, runs `--eval` if given, screenshots to `<out.png>`, prints console errors/warnings and page errors, exits non-zero on page errors.

- [ ] **Step 5: smoke test** — `src/__tests__/smoke.test.ts`: `expect(1 + 1).toBe(2)` (keeps `vitest run` green before real tests exist).

- [ ] **Step 6: verify** — Run: `pnpm typecheck && pnpm test && pnpm build && node scripts/snap.mjs index.html /tmp/ss-scaffold.png --wait 500`. Expected: all pass; screenshot shows the cube on blue.

- [ ] **Step 7: CI + Pages workflows** — `ci.yml`: on push/PR to main: checkout, pnpm setup, Node 22, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`; job `e2e` (after Task 20 adds specs): `pnpm exec playwright install --with-deps chromium`, `pnpm e2e`. `pages.yml`: on push to main: build, `actions/upload-pages-artifact` (dist), `actions/deploy-pages`.

- [ ] **Step 8: commit, create public repo, push, enable Pages**

```bash
git add -A && git commit -m "chore: scaffold sailing-school (vite, ts, three r186, vitest, snap tool, CI)"
gh repo create pibvbp/sailing-school --public --source . --remote origin --description "Interactive 3D sailing school: see how wind drives a sailboat — photoreal ocean, real sail physics, lessons from points of sail to spinnaker." --push
gh api -X POST repos/pibvbp/sailing-school/pages -f build_type=workflow
```

### Task 2: Shared contracts

**Files:** Create `src/shared/math.ts`, `src/shared/units.ts`, `src/shared/coords.ts`,
`src/shared/boatSpec.ts`, `src/sim/types.ts`; tests `src/shared/__tests__/math.test.ts`,
`src/shared/__tests__/coords.test.ts`.

**Interfaces (produced, used by every later task):**

```ts
// src/shared/math.ts
export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export const DEG: number;            // π/180
export const KN: number;             // 0.514444 m/s
export function vec3(x?: number, y?: number, z?: number): Vec3;
export function add3(a: Vec3, b: Vec3): Vec3;  export function sub3(a: Vec3, b: Vec3): Vec3;
export function scale3(a: Vec3, s: number): Vec3; export function dot3(a: Vec3, b: Vec3): number;
export function cross3(a: Vec3, b: Vec3): Vec3; export function len3(a: Vec3): number; export function norm3(a: Vec3): Vec3;
export function rotX(v: Vec3, a: number): Vec3; // right-handed about x; body→heading frame uses +heel
export function rotZ(v: Vec3, a: number): Vec3; // right-handed about z (body z down: +a turns fwd→stbd)
export function clamp(x: number, lo: number, hi: number): number;
export function lerp(a: number, b: number, t: number): number;
export function smoothstep(e0: number, e1: number, x: number): number;
export function wrapPi(a: number): number;     // to (−π, π]
// src/shared/coords.ts
export function bodyToLocal(p: Vec3): Vec3;     // (y, −z, −x)  → three boat-local X stbd, Y up, Z aft
export function localToBody(p: Vec3): Vec3;     // inverse
export function hz(h: number): number;          // height above WL → body z (= −h)
export function worldToThreeXZ(e: number, n: number): { x: number; z: number }; // (e, −n)
export function bearingToEN(b: number): { e: number; n: number };             // (sin b, cos b)
export function headingToRotationY(psi: number): number;                      // −psi
// src/shared/units.ts
export const toKn: (ms: number) => number; export const fromKn: (kn: number) => number;
export const toDeg: (rad: number) => number; export const fromDeg: (deg: number) => number;
```

`boatSpec.ts` exports `BOAT` (readonly, `as const`) with every number from spec §6, grouped:
`hull {loa,lwl,beam,bwl,canoeDraft,draft,stemDeckX,stemWLX,transomDeckX,transomWLX,freeboard{bow,mast,min,minX,stern},wettedArea}`,
`mass {boat,crew,total,cgH,ixx,izz,addedSurge,addedSway}`, `gz: [deg, m][]`,
`cabin{...}`, `cockpit{...}`, `mast{x,baseH,topH,sectionBase,sectionTop}`, `spreaders{h,len,sweepDeg}`,
`forestay{tack:{x,h},head:{x,h}}`, `backstay{top,bottom}`, `boom{goosenecKX,goosenecKH,length,sheetX,travelerX,travelerWidth}`,
`main{P,E,area,battens:4,camberBase:0.11}`, `jib{tack:{x,h},luff,LP,area,leadX:[0.2,-0.4],leadY:0.75,camberBase:0.12}`,
`spinnaker{SL,foot,halfWidth,area,poleLength,poleMastH,poleTipH:[1.6,3.4],sheetBlock:{x,y,h},guyBlock:{x,y,h}}`,
`keel{rootChord,rootH,tipChord,tipH,sweepDeg,rootLEX,area,cp:{x,h},arEff:2.85,stallDeg:14}`,
`rudder{stockX,rootChord,rootH,tipChord,tipH,area,cp:{x,h},arEff:4.5,stallDeg:22,maxAngleDeg:35,rateDegS:60}`, `tiller{length}`.

`src/sim/types.ts` (the contract — complete):

```ts
import type { Vec2, Vec3 } from '../shared/math';
export type SailId = 'main' | 'jib' | 'spinnaker';
export type HelmMode = 'manual' | 'heading' | 'twa' | 'awa';
export interface Controls {
  helmMode: HelmMode; tiller: number; helmTarget: number;          // tiller −1..1 (+ = bow to starboard)
  mainSheet: number; traveler: number; vang: number; outhaul: number; cunningham: number; backstay: number;
  jibSheet: number; jibLead: number; jibFurl: number; jibBacked: boolean; jibWhisker: boolean;
  spinHoist: boolean; spinPole: number; spinPoleHeight: number; spinSheet: number;
  crewHike: 'auto' | number;
  autoTrim: { main: boolean; jib: boolean; spinnaker: boolean };
  command: null | 'tack' | 'gybe';                                   // consumed by the sim
}
export interface WindSettings { tws: number; twd: number; gustiness: number; shiftAmplitude: number; shiftPeriod: number; seed: number }
export interface Puff { id: number; e: number; n: number; radiusAlong: number; radiusAcross: number; strength: number; dirOffset: number; envelope: number }
export type TelltaleState = 'streaming' | 'lifting' | 'stalled' | 'fluttering';
export interface Telltale { id: string; pos: Vec3; side: 'port' | 'stbd' | 'leech'; state: TelltaleState; intensity: number }
export interface SailSection { h: number; luff: Vec3; chordDir: Vec3; chord: number; camber: number; draft: number; leewardY: number; aoa: number; luffing: number; stall: number; cl: number; cd: number; q: number }
export interface SailState {
  id: SailId; set: boolean; area: number; tack: Vec3; clew: Vec3; head: Vec3;
  sections: SailSection[]; force: Vec3; ce: Vec3; lift: number; drag: number; drive: number; heelForce: number;
  telltales: Telltale[];
}
export interface MainState extends SailState { boomAngle: number; boomRate: number; twistDeg: number }
export interface JibState extends SailState { clewAngle: number; furl: number; backed: boolean; whisker: boolean }
export interface SpinnakerState extends SailState { hoist: number; poleAngle: number; poleTip: Vec3; poleHeight: number; collapsed: number; curl: number }
export interface ForceAt { force: Vec3; point: Vec3 }
export interface ForceReport {
  aero: ForceAt; drive: number; sideForce: number; keel: ForceAt; rudder: ForceAt;
  resistance: number; heelingMoment: number; rightingMoment: number; crewMoment: number; cg: Vec3; cb: Vec3;
}
export type SimEventType = 'crashGybe' | 'inIrons' | 'tackComplete' | 'gybeComplete' | 'spinCollapse' | 'spinRefill' | 'roundUp' | 'luffing' | 'backwinded';
export interface SimEvent { type: SimEventType; t: number; data?: Record<string, number> }
export interface SimSnapshot {
  t: number;
  boat: { pos: Vec2; heading: number; heel: number; yawRate: number; rollRate: number; u: number; v: number; speed: number; cog: number; leeway: number; rudder: number; vmg: number; crewHike: number };
  wind: { tws: number; twd: number; twa: number; aws: number; awa: number; awsDeck: number; awaDeck: number; puffs: Puff[] };
  sails: { main: MainState; jib: JibState; spinnaker: SpinnakerState };
  forces: ForceReport;
  events: SimEvent[];
  maneuver: null | 'tack' | 'gybe' | 'hoist' | 'douse';
  towed: boolean;
}
export interface BoatState { e: number; n: number; psi: number; u: number; v: number; r: number; phi: number; p: number; rudder: number; crewY: number }
export interface ScenarioInit { wind: WindSettings; boat?: Partial<BoatState>; controls?: Partial<Controls>; spinnakerSet?: boolean; towed?: { speed: number } | null }
export function defaultControls(): Controls;
```

- [ ] **Step 1: failing tests**

```ts
// src/shared/__tests__/coords.test.ts
import { describe, it, expect } from 'vitest';
import { bodyToLocal, localToBody, bearingToEN, worldToThreeXZ } from '../coords';
import { rotX, wrapPi, DEG } from '../math';
describe('frames', () => {
  it('body forward maps to three -Z, starboard to +X, up to +Y', () => {
    expect(bodyToLocal({ x: 1, y: 0, z: 0 })).toEqual({ x: 0, y: -0, z: -1 });
    expect(bodyToLocal({ x: 0, y: 1, z: 0 })).toEqual({ x: 1, y: -0, z: -0 });
    expect(bodyToLocal({ x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 1, z: -0 });
  });
  it('localToBody inverts bodyToLocal', () => {
    const p = { x: 1.2, y: -3.4, z: 5.6 };
    const q = localToBody(bodyToLocal(p));
    expect(q.x).toBeCloseTo(p.x); expect(q.y).toBeCloseTo(p.y); expect(q.z).toBeCloseTo(p.z);
  });
  it('positive heel tilts the masthead to starboard', () => {
    const top = rotX({ x: 0, y: 0, z: -10 }, 20 * DEG);
    expect(top.y).toBeGreaterThan(3); expect(top.z).toBeLessThan(-9);
  });
  it('bearings: east is +e, north is +n; north maps to three -Z', () => {
    const e = bearingToEN(90 * DEG); expect(e.e).toBeCloseTo(1); expect(e.n).toBeCloseTo(0);
    expect(worldToThreeXZ(0, 5)).toEqual({ x: 0, z: -5 });
  });
  it('wrapPi maps into (-π, π]', () => {
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI); expect(wrapPi(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapPi(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });
});
```

- [ ] **Step 2: run, expect FAIL** — `pnpm vitest run src/shared` → "Cannot find module '../coords'".
- [ ] **Step 3: implement** the files with exactly the interfaces above (`defaultControls()` returns: helm manual, tiller 0, helmTarget 0, mainSheet 0.7, traveler 0, vang 0.3, outhaul 0.5, cunningham 0.2, backstay 0.3, jibSheet 0.7, jibLead 0, jibFurl 0, flags false, spinPole 0.5, spinPoleHeight 0.5, spinSheet 0.5, crewHike 'auto', autoTrim all true, command null).
- [ ] **Step 4: run, expect PASS** — `pnpm vitest run src/shared && pnpm typecheck`.
- [ ] **Step 5: commit** — `git add src/shared src/sim/types.ts && git commit -m "feat(shared): frames, math, boat spec and sim snapshot contract"`.

---

## Wave 1 — parallel build

The lead implements Tasks 3–9 (simulation) in order. Tasks 10–15 go to subagents **at the same
time**, each confined to its own directories, working from mock snapshots, verified with
`scripts/snap.mjs` screenshots. Subagent brief template (prepend to every task 10–15):

> Read `docs/superpowers/specs/2026-09-29-sailing-school-design.md` (§5 conventions, §6 boat, §9
> rendering) and `src/sim/types.ts`, `src/shared/*`. Work ONLY in the files listed for your task. No
> git, no new dependencies. Verify with `pnpm exec tsc --noEmit` (fix errors in your files; ignore
> other areas that are mid-build), your Vitest tests, and screenshots:
> `node scripts/snap.mjs demos/<area>.html <scratch>/x.png --wait 4000` then look at the PNG. Iterate
> until it looks like a photograph of the real thing (compare with your memory of real
> photos: open water, keelboats, Dacron sails). Report: files, what you verified, screenshots paths,
> known gaps, and the per-frame cost you measured (use `renderer.info` and `performance.now()`).

### Task 3: Wind field and apparent wind (lead)

**Files:** Create `src/sim/rng.ts`, `src/sim/wind.ts`, `src/sim/apparent.ts`; tests
`src/sim/__tests__/wind.test.ts`, `src/sim/__tests__/apparent.test.ts`.

**Interfaces:**

```ts
// rng.ts
export function mulberry32(seed: number): () => number;          // [0,1)
export function gaussian(rand: () => number): number;
// wind.ts
export function gradientFactor(h: number): number;               // ln(max(h,0.3)/0.005)/ln(10/0.005)
export class WindField {
  constructor(s: WindSettings); settings: WindSettings; puffs: Puff[]; t: number;
  step(dt: number, boatE: number, boatN: number): void;
  baseDirection(): number;                                         // TWD(t) incl. shifts
  sample(e: number, n: number, h: number): { speed: number; dir: number };   // dir = FROM, compass rad
  velocity(e: number, n: number, h: number): { e: number; n: number };       // air velocity (towards)
}
// apparent.ts
export interface Kinematics { heading: number; heel: number; u: number; v: number; r: number; p: number }
export function airVelocityBody(rB: Vec3, k: Kinematics, windEN: { e: number; n: number }): Vec3;
export function awaAws(aB: Vec3): { awa: number; aws: number };  // rig-plane, + = from starboard
export function twaOf(heading: number, twd: number): number;     // wrapPi(twd − heading)
```

- [ ] **Step 1: failing tests**

```ts
// src/sim/__tests__/wind.test.ts
import { describe, it, expect } from 'vitest';
import { WindField, gradientFactor } from '../wind';
const base = { tws: 6, twd: 0, gustiness: 0, shiftAmplitude: 0, shiftPeriod: 120, seed: 7 };
describe('wind', () => {
  it('log profile: 1 at 10 m, ~0.774 at 1.8 m, finite at 0', () => {
    expect(gradientFactor(10)).toBeCloseTo(1, 6);
    expect(gradientFactor(1.8)).toBeCloseTo(0.774, 2);
    expect(gradientFactor(0)).toBeGreaterThan(0.3);
  });
  it('north wind blows toward the south', () => {
    const w = new WindField(base); const v = w.velocity(0, 0, 10);
    expect(v.e).toBeCloseTo(0, 6); expect(v.n).toBeCloseTo(-6, 6);
  });
  it('no puffs when gustiness is 0; puffs upwind and drifting downwind when 1', () => {
    const calm = new WindField(base); for (let i = 0; i < 600; i++) calm.step(0.1, 0, 0);
    expect(calm.puffs.length).toBe(0);
    const g = new WindField({ ...base, gustiness: 1 }); for (let i = 0; i < 600; i++) g.step(0.1, 0, 0);
    expect(g.puffs.length).toBeGreaterThan(2);
    const p = g.puffs[0]!; const n0 = p.n; g.step(1, 0, 0);
    expect(g.puffs.find(q => q.id === p.id)!.n).toBeLessThan(n0);
  });
  it('is deterministic for a seed', () => {
    const a = new WindField({ ...base, gustiness: 1 }), b = new WindField({ ...base, gustiness: 1 });
    for (let i = 0; i < 900; i++) { a.step(0.1, 10, 20); b.step(0.1, 10, 20); }
    expect(a.sample(15, 30, 10)).toEqual(b.sample(15, 30, 10));
  });
  it('shifts stay within amplitude', () => {
    const w = new WindField({ ...base, shiftAmplitude: 0.2, shiftPeriod: 60 });
    let max = 0; for (let i = 0; i < 1200; i++) { w.step(0.1, 0, 0); max = Math.max(max, Math.abs(w.baseDirection())); }
    expect(max).toBeGreaterThan(0.1); expect(max).toBeLessThan(0.26);
  });
});
```

```ts
// src/sim/__tests__/apparent.test.ts
import { describe, it, expect } from 'vitest';
import { airVelocityBody, awaAws, twaOf } from '../apparent';
import { DEG } from '../../shared/math';
const still = { heading: 0, heel: 0, u: 0, v: 0, r: 0, p: 0 };
describe('apparent wind', () => {
  it('stationary boat, wind from east (starboard) → AWA +90°', () => {
    const a = airVelocityBody({ x: 0, y: 0, z: -5 }, still, { e: -5, n: 0 });
    const { awa, aws } = awaAws(a); expect(awa / DEG).toBeCloseTo(90, 3); expect(aws).toBeCloseTo(5, 6);
  });
  it('head to wind while moving adds boat speed', () => {
    const k = { ...still, u: 5 }; const { awa, aws } = awaAws(airVelocityBody({ x: 0, y: 0, z: -5 }, k, { e: 0, n: -5 }));
    expect(awa).toBeCloseTo(0, 6); expect(aws).toBeCloseTo(10, 6);
  });
  it('beam reach at wind speed → AWA 45°, √2 speed', () => {
    const k = { ...still, u: 5 }; const { awa, aws } = awaAws(airVelocityBody({ x: 0, y: 0, z: -5 }, k, { e: -5, n: 0 }));
    expect(awa / DEG).toBeCloseTo(45, 3); expect(aws).toBeCloseTo(Math.SQRT2 * 5, 5);
  });
  it('heel reduces the cross-flow component by cos φ', () => {
    const k = { ...still, heel: 30 * DEG }; const a = airVelocityBody({ x: 0, y: 0, z: -5 }, k, { e: -5, n: 0 });
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(5 * Math.cos(30 * DEG), 5);
  });
  it('rolling to starboard adds wind from starboard at the masthead', () => {
    const k = { ...still, p: 0.5 }; const a = airVelocityBody({ x: 0, y: 0, z: -10 }, k, { e: 0, n: 0 });
    expect(a.y).toBeLessThan(-4.9);  // air moves to port relative to a mast moving to starboard
  });
  it('TWA sign: heading north, wind from east is +90°', () => { expect(twaOf(0, 90 * DEG) / DEG).toBeCloseTo(90, 6); });
});
```

- [ ] **Step 2: run** `pnpm vitest run src/sim/__tests__/wind.test.ts src/sim/__tests__/apparent.test.ts` → FAIL (modules missing).
- [ ] **Step 3: implement** per spec §7.1–7.2. Puffs: spawn when fewer than `round(6·gustiness)` active: position = boat + upwind distance U(400, 900) m along TWD + lateral U(−350, 350) m; radiusAlong U(40,120)·(1+gustiness), radiusAcross ×1.8; strength: 70 % gusts U(0.15, 0.45)·gustiness, 30 % lulls −U(0.10, 0.30)·gustiness; dirOffset U(−12°, +12°) biased +4° (veer); life U(90, 240) s; envelope = smoothstep over first/last 20 s; drift velocity = base wind velocity at 10 m × 0.9; remove when > 500 m downwind of the boat or expired. `sample` = base speed·gradient·(1 + Σ strength·w) with w = envelope·exp(−(d_along²/ra² + d_across²/rc²)), direction = base + Σ dirOffset·w / max(1, Σw).
- [ ] **Step 4: run** → PASS. **Step 5: commit** `feat(sim): wind field with log gradient, puffs, shifts; apparent wind`.

### Task 4: Sail aerodynamic coefficients (lead)

**Files:** `src/sim/aero.ts`; test `src/sim/__tests__/aero.test.ts`.

**Interfaces:**

```ts
export interface SailAeroParams { clSlope: number; alphaLuff0: number; draftLuffGain: number; luffWidth: number;
  stallBase: number; stallCamberGain: number; stallWidth: number; cd0: number; kpp: number; cdFlog: number;
  cnMax: number; cn90: number; cnPeakAlpha: number }
export const MAIN_AERO: SailAeroParams; export const JIB_AERO: SailAeroParams; export const SPIN_AERO: SailAeroParams;
export interface Coeffs { cl: number; cd: number; luffing: number; stall: number }
export function alphaLuff(p: SailAeroParams, camber: number, draft: number): number;
export function alphaStall(p: SailAeroParams, camber: number, draft: number): number;
export function sailCoefficients(p: SailAeroParams, alpha: number, camber: number, draft: number): Coeffs;
export function kheff(awaAbs: number): number;                 // ORC Fig 5.14: 1.0@0,1.45@20°,0.8@≥80°
export function inducedDragCoeff(cl: number, area: number, hEff: number): number; // cl²·A/(π·hEff²)
```

- [ ] **Step 1: failing tests** — continuity (max |Δcl| < 0.03 per 0.1° over [0, π] for camber 0.06–0.18), luffing (`alpha < alphaLuff − luffWidth` ⇒ `cl < 0.02`, `luffing === 1`, `cd ≈ cdFlog ± 0.02`), attached slope within 5 % of `clSlope` mid-groove, stall (`cl(50°) < cl(alphaStall)`), 90° (`|cl| < 0.15`, `cd` within 0.1 of `cn90`), camber monotonicity (`cl` at 8° grows with camber; groove width `alphaStall − alphaLuff` grows with camber), `kheff(20°) ≈ 1.45`, `kheff(90°) ≈ 0.8`.
- [ ] **Step 2: run → FAIL.** **Step 3: implement** per spec §7.3 (smooth blends via smoothstep; stall blends attached → normal-force `Cn(α)` peaking `cnMax` at `cnPeakAlpha` easing to `cn90` at 90°, `cl = Cn cos α`, `cd = Cn sin α + cd0`; symmetric for α ∈ [π/2, π] using π − α with sign-flipped lift).
- [ ] **Step 4: run → PASS.** **Step 5: commit** `feat(sim): sail coefficient model (luff/attached/stall, induced drag)`.

### Task 5: Sails — geometry, forces, mechanics (lead)

**Files:** `src/sim/sails/common.ts`, `main.ts`, `jib.ts`, `spinnaker.ts`; tests
`src/sim/__tests__/sails.test.ts`, `src/sim/__tests__/orc-envelope.test.ts`.

**Interfaces:**

```ts
// common.ts
export interface AirContext { kin: Kinematics; windAt: (h: number) => { e: number; n: number }; uniform?: boolean }
export interface SectionGeom { h: number; luff: Vec3; chordDir: Vec3; chord: number; height: number; camber: number; draft: number }
export interface SectionResult extends SailSection { force: Vec3; point: Vec3 }
export function evaluateSections(geom: SectionGeom[], p: SailAeroParams, air: AirContext, alphaShift: (h: number) => number, blanket: number): SectionResult[];
export function sumForces(r: SectionResult[], about: Vec3): { force: Vec3; moment: Vec3; ce: Vec3; area: number; cl: number };
export function interactionShifts(clMain: number, clJib: number, aMain: number, aJib: number, sameSide: boolean): { jib: number; main: (h: number, luffRegion: boolean) => number };
export function blanketFactor(kind: 'jibByMain' | 'spinByMain', awaAbs: number, boomAngle: number, offsetAcross: number): number;
// main.ts / jib.ts / spinnaker.ts
export class MainModel { beta: number; betaDot: number; geometry(c: Controls, leewardY: number): SectionGeom[]; step(dt: number, c: Controls, air: AirContext, heel: number, alphaShift: (h: number, luffRegion: boolean) => number): MainState }
export class JibModel { gamma: number; gammaDot: number; activeSide: -1 | 1; geometry(c: Controls): SectionGeom[]; step(dt: number, c: Controls, air: AirContext, heel: number, alphaShift: number, blanket: number): JibState }
export class SpinnakerModel { hoist: number; collapsed: number; curl: number; geometry(c: Controls, windwardY: number): SectionGeom[]; step(dt: number, c: Controls, air: AirContext, heel: number, blanket: number): SpinnakerState }
```

- [ ] **Step 1: failing tests** (`sails.test.ts`): boom weathervanes to ≈0 and luffs with sheet 0 at AWA 0°; settles on its sheet limit (+Δ to port) at AWA +90°; **crash gybe** (run, sheet 0.1, wind flips side ⇒ `|betaDot| > 1.5` at impact and a `crashGybe` flag) vs **controlled** (sheet 0.9 ⇒ no flag); gravity swings a free boom to the low side at 20° heel; jib leeward limit `γ ≤ 10° + 35°(1−sheet)^1.3`; backed jib holds −15° against the wind; jib side switch + 2.5 s haul; furl 1 ⇒ area 0; spinnaker hoist 6 s ⇒ `hoist` 0→1, collapse after 0.6 s with α below `α_curl − 4°`, refill 1 s after recovery; blanketing: dead run with main at 80° ⇒ jib factor < 0.5.
- [ ] **Step 2: failing ORC calibration test** (`orc-envelope.test.ts`, stationary boat, `uniform` wind, no heel, no interaction): for each AWA in the ORC tables sweep the trim (boom/clew/pole+sheet) and take the max total Cl (normalised by area·q) ⇒ within ±15 % of: main {7: 0.86, 12: 1.16, 28: 1.35, 60: 1.35, 90: 1.27, 120: 0.93, 150: 0.39}; jib {15: 1.00, 20: 1.375, 27: 1.45, 50: 1.45, 60: 1.25, 100: 0.40}; spinnaker {41: 0.66, 60: 0.99, 75: 1.03, 100: 0.92, 130: 0.64, 150: 0.36}; and |Cl| < 0.2 at 180° for all.
- [ ] **Step 3: run → FAIL. Step 4: implement** spec §7.3–7.4 (sections: main 8, jib 8, spin 6; CE at 38 % chord + 0.7·depth to leeward). **Step 5: tune params until PASS. Step 6: commit** `feat(sim): sail geometry, strip forces, boom/jib/spinnaker mechanics (ORC-calibrated)`.

### Task 6: Hull and appendages (lead)

**Files:** `src/sim/hydro.ts`; test `src/sim/__tests__/hydro.test.ts`.

**Interfaces:**

```ts
export function frictionCf(V: number): number;
export function hullResistance(V: number, heel: number): { rf: number; rr: number; rh: number; total: number };
export interface FoilSpec { area: number; arEff: number; chord: number; tc: number; stallDeg: number; cn90: number; point: Vec3 }
export function foilForce(f: FoilSpec, waterRelB: Vec3, deflection: number): { force: Vec3; cl: number; alpha: number; stalled: boolean };
export function crossFlow(v: number, r: number): { Y: number; N: number };
export function windage(airB: Vec3): Vec3;
export function rightingMoment(heel: number): number;   // N·m about x, opposes heel
export const KEEL: FoilSpec; export const RUDDER: FoilSpec;
```

- [ ] **Step 1: failing tests** — `frictionCf(2.88)` ≈ 0.00255 ± 3 %; `hullResistance(2.88,0).total` ∈ [260, 380] N; monotonic in V; `R(3.4)/R(2.88) > 1.8` (hull-speed wall); sliding to starboard (`waterRelB = (−3, −0.2, 0)`) ⇒ keel `force.y < 0`; reversed flow with deflection flips the sign vs forward flow; `|cl(30°)| < |cl(14°)|` for the keel; `rightingMoment(20°) ≈ −4988 ± 5 %` and odd-symmetric; `crossFlow(0.5, 0)` opposes v; windage at AWA 0 pushes aft.
- [ ] **Step 2: FAIL. Step 3: implement** spec §7.5. **Step 4: PASS. Step 5: commit** `feat(sim): hull resistance, keel/rudder foils, cross-flow, windage, righting`.

### Task 7: Simulation class, integration, snapshot, events (lead)

**Files:** `src/sim/simulation.ts`, `src/sim/snapshot.ts`, `src/sim/events.ts`; test
`src/sim/__tests__/simulation.test.ts`.

**Interfaces:**

```ts
// BoatState and ScenarioInit come from src/sim/types.ts (Task 2)
export class Simulation {
  constructor(init: ScenarioInit);
  controls: Controls; wind: WindField; boat: BoatState; t: number;
  step(dt?: number): void;                  // default 1/120
  snapshot(): SimSnapshot;                  // fresh object; events drained
  reset(init: ScenarioInit): void; setWind(p: Partial<WindSettings>): void; setTowed(t: { speed: number } | null): void;
}
```

- [ ] **Step 1: failing tests** — beam reach 12 kn TWS, hold TWA 90° (autopilot from Task 8 stubbed as a simple PD in the test) for 60 s ⇒ speed 5.5–7.5 kn, `heel < 0` (to port), `leeway < 0` (to port), `rudder < 0` and `|rudder| < 8°` (weather helm); tiller +1 at 5 kn ⇒ `r > 0`; head-to-wind from rest ⇒ `u < 0` after 10 s and an `inIrons` event; **stays finite in 25 kn broach** (spinnaker, TWA 100°, sheets 1.0, 120 s: no NaN, |heel| < 90°, a `roundUp` event); determinism (same seed ⇒ identical `boat` after 30 s); performance (10 000 steps < 500 ms).
- [ ] **Step 2: FAIL. Step 3: implement** spec §7.6 (forces at body points → heading frame via `rotX(·, heel)`, moments about CG; righting + crew moments; rudder rate limit; events per §7.7). **Step 4: PASS. Step 5: commit** `feat(sim): rigid-body simulation, snapshot and events`.

### Task 8: Autopilot, auto-trim, manoeuvres, crew (lead)

**Files:** `src/sim/autopilot.ts`, `src/sim/autocrew.ts`; test `src/sim/__tests__/autocrew.test.ts`.

**Interfaces:**

```ts
export function helmCommand(mode: HelmMode, target: number, snap: { heading: number; twa: number; awa: number; r: number; speed: number }): number; // rudder target (rad)
export class AutoCrew { maneuver: null | 'tack' | 'gybe' | 'hoist' | 'douse'; update(dt: number, sim: Simulation): void }
```

- [ ] **Step 1: failing tests** — hold TWA +45° in 12 kn for 60 s ⇒ |TWA−45°| < 3°, speed > 4.5 kn; `tack` from starboard close-hauled at speed ⇒ within 20 s TWA ∈ −45° ± 5°, jib `activeSide` flipped, speed ≥ 60 % of entry 10 s later, one `tackComplete`; `gybe` from TWA 150° ⇒ −150° ± 8°, no `crashGybe`; **ignores tack during gybe**; **hoist/douse toggle** 10× in 2 s ends in the last requested state with no NaN; spinnaker auto-trim at TWA 135° for 60 s ⇒ no `spinCollapse`, pole ≈ |AWA|−90° ± 10°; crew hikes to windward (|crewY| > 0.8) when heel > 10°.
- [ ] **Step 2: FAIL. Step 3: implement** spec §7.7. **Step 4: PASS. Step 5: commit** `feat(sim): autopilot, auto-trim, tack/gybe/hoist sequences, crew hiking`.

### Task 9: VPP and polars (lead)

**Files:** `src/sim/vpp.ts`, `src/sim/polarTable.ts`, `scripts/polars.mjs`, `src/sim/data/polars.json`;
test `src/sim/__tests__/vpp.test.ts`.

**Interfaces:**

```ts
export interface SteadyResult { converged: boolean; speed: number; leeway: number; heel: number; rudder: number; awa: number; aws: number }
export function solveSteady(tws: number, twa: number, trim: TrimVector): SteadyResult;
export function bestSpeed(tws: number, twa: number): SteadyResult & { trim: TrimVector; sails: 'jib' | 'spinnaker' };
export interface PolarTable { tws: number[]; twa: number[]; speed: number[][]; beat: { twa: number; vmg: number }[]; run: { twa: number; vmg: number }[] }
export function targetSpeed(t: PolarTable, tws: number, twaAbs: number): number;
```

- [ ] **Step 1: failing tests** — convergence at TWS {6,12,20} × TWA {45,90,150}; speeds within ±12 % of spec §7.8 targets; optimal beat TWA ∈ [38°, 46°]; VMG(30°) < 0.6·VMG(optimal); dynamic sim (auto-trim, hold TWA 90°, 12 kn, 90 s) within 8 % of `bestSpeed(12 kn, 90°)`.
- [ ] **Step 2: FAIL. Step 3: implement** Newton (numerical Jacobian, damped, ≤ 50 iterations) on (V, leeway, heel, rudder) + coarse-to-fine trim search. **Step 4: tune `rr` table / aero params until PASS; `pnpm polars`. Step 5: commit** `feat(sim): VPP steady-state solver and generated polars`.

### Task 10: Render core, sky, light, land, marks (subagent A)

**Files:** `src/render/core/{renderer.ts,post.ts,quality.ts}`, `src/render/env/{sky.ts,clouds.ts,lighting.ts,land.ts,marks.ts}`, `demos/env.html`, `demos/env.ts`, tests `src/render/core/__tests__/quality.test.ts`.

**Interfaces:**

```ts
export interface QualitySettings { tier: 'ultra' | 'high' | 'medium' | 'low'; renderScale: number; oceanFFTSize: 128 | 256; oceanCascades: 2 | 3; oceanMeshDetail: number; reflections: 'off' | 'half' | 'full'; shadowMapSize: 0 | 1024 | 2048 | 4096; bloom: boolean; particleScale: number; sailResolution: number }
export function tierSettings(tier: QualitySettings['tier']): QualitySettings;
export class QualityGovernor { constructor(start: QualitySettings['tier']); settings: QualitySettings; sample(frameMs: number, nowMs: number): boolean /* changed */; lock(tier | null): void }
export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer;   // WebGL2 check throws a typed error
export class PostChain { constructor(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, q: QualitySettings); setSize(w: number, h: number): void; render(dt: number): void; setQuality(q: QualitySettings): void }
export interface SkyState { sunDirection: THREE.Vector3; sunColor: THREE.Color; envMap: THREE.Texture | null; fogColor: THREE.Color; horizonColor: THREE.Color }
export class SkySystem implements SkyState { constructor(r: THREE.WebGLRenderer, scene: THREE.Scene, q: QualitySettings); setTimeOfDay(hours: number): void; setCloudCover(c: number): void; update(dt: number, camera: THREE.Camera, windFromRad: number, windSpeed: number): void; /* SkyState fields */ }
export class Lighting { constructor(scene: THREE.Scene, sky: SkyState, q: QualitySettings); follow(target: THREE.Object3D): void; update(): void; sun: THREE.DirectionalLight }
export class Land { constructor(scene: THREE.Scene, sky: SkyState) }                 // islands + lighthouse 2–6 km
export class Marks { constructor(scene: THREE.Scene); add(id: string, e: number, n: number, kind: 'windward' | 'leeward' | 'start'): void; remove(id: string): void; update(t: number, heightAt: (e: number, n: number) => number): void }
```

Implementation notes: sky = three r186 `three/addons/objects/Sky.js` (Preetham + its built-in cloud
uniforms `cloudCoverage/cloudDensity/cloudElevation/cloudScale/cloudSpeed/time`); env map via
`PMREMGenerator.fromScene` of a sky-only scene, regenerated only when the sun or cloud cover changes;
`PostChain` uses pmndrs `postprocessing` (`EffectComposer` with HalfFloat buffers, one `EffectPass`
holding `BloomEffect` (mipmap blur, high luminance threshold), `ToneMappingEffect` (AgX default),
`SMAAEffect`, subtle `VignetteEffect`); renderer `toneMapping = NoToneMapping` because the effect does
it. Governor modelled on ABYSSAL `core/Quality.js` (MIT) — read it with
`gh api -H "Accept: application/vnd.github.raw" repos/Token-Gremlin/natural-disasters/contents/src/core/Quality.js`.

Acceptance: `demos/env.html` shows sky at 3 times of day (query `?hour=`), clouds, sun, a flat
stand-in water plane, distant islands with aerial perspective, two marks; governor unit tests
(step-down after sustained 25 ms frames, step-up after 10 s under 12 ms, hysteresis). Screenshots
must read as a real seascape horizon. Cost at `high` ≤ 1 ms sky+clouds.

### Task 11: FFT ocean (subagent B)

**Files:** `src/render/env/ocean/{spectrum.ts,fft.ts,cascades.ts,oceanMesh.ts,oceanMaterial.ts,sampler.ts,wake.ts,shaders/*.glsl.ts}`, `demos/ocean.html`, `demos/ocean.ts`, tests `src/render/env/ocean/__tests__/{spectrum,sampler}.test.ts`.

**Interfaces:**

```ts
export interface OceanParams { windSpeed: number; windFrom: number; fetchKm: number; swellHeight: number; swellFrom: number; swellPeriod: number; choppiness: number }
export interface PuffPatch { e: number; n: number; radiusAlong: number; radiusAcross: number; strength: number; windFrom: number }
export interface OceanSampler { heightAt(e: number, n: number, t: number): number; normalAt(e: number, n: number, t: number): { x: number; y: number; z: number } }
export class Ocean {
  constructor(r: THREE.WebGLRenderer, scene: THREE.Scene, sky: SkyState, q: QualitySettings);
  setParams(p: OceanParams): void; setPuffs(p: PuffPatch[]): void;
  setBoat(b: { e: number; n: number; heading: number; speed: number; heel: number } | null): void;
  setXray(on: boolean): void; setQuality(q: QualitySettings): void;
  update(dt: number, t: number, camera: THREE.Camera): void;
  readonly sampler: OceanSampler;
}
```

Source to adapt (MIT — keep the copyright header, add a "adapted for sailing-school" note, list in
`THIRD_PARTY_NOTICES.md`): Token-Gremlin/natural-disasters `src/ocean/OceanFFT.js`, `OceanMesh.js`,
`OceanSampleGLSL.js` (+ whatever of `src/gfx/*GLSL.js` they need), and developmentation/wave-riders
`src/game/WaveField.js` (async height readback) and `src/game/Wake.js` (Kelvin wake). Read them with
`gh api -H "Accept: application/vnd.github.raw" repos/<owner>/<repo>/contents/<path>`. Port to
TypeScript for three r186, remove the disaster fields (tsunami/whirlpool/waterspout raymarch), take
sun/sky/fog from our `SkyState` (env map for reflections) instead of their atmosphere LUTs, keep their
projected grid, cascades, foam accumulation and shading. `OceanSampler` = height grid around the boat
rendered by the ocean displacement shader into a small float target and read back with
`renderer.readRenderTargetPixelsAsync` one frame late (never a synchronous read).

Acceptance: 3 cascades (no visible tiling), choppy displacement, Jacobian whitecaps above ≈ 12 kn,
GGX sun glitter, Fresnel sky reflection, SSS crests, horizon correct, gust patches darker/rougher,
wake + bow foam trail behind a moving boat, x-ray translucency around the boat; a floating test buoy in
the demo rides the surface with no visible offset (sampler correctness); unit tests for spectrum
parameter mapping (wind → Hs/Tp ranges plausible: 12 kn ⇒ Hs 0.3–0.8 m) and sampler bilinear lookup;
`demos/ocean.html` query params `?wind=12&hour=17&boat=1`. Cost at `high` ≤ 4 ms GPU.

### Task 12: Procedural boat (subagent C)

**Files:** `src/render/boat/{BoatModel.ts,hull.ts,deck.ts,cabin.ts,cockpit.ts,appendages.ts,rig.ts,fittings.ts,lines.ts,crew.ts,materials.ts,textures.ts}`, `demos/boat.html`, `demos/boat.ts`, test `src/render/boat/__tests__/hull.test.ts` (waterline length, beam, draft within 2 % of `BOAT`).

**Interfaces:**

```ts
export interface BoatPose { boomAngle: number; rudder: number; jibClew: Vec3; jibFurl: number; spin: { visible: boolean; poleAngle: number; poleTipH: number; tack: Vec3; clew: Vec3 } ; crewY: number; heel: number; sheets: { main: number; jib: number; spin: number } }
export class BoatModel {
  readonly root: THREE.Group;                       // boat-local frame, origin per spec §5
  constructor(q: QualitySettings);
  setPose(p: BoatPose): void;                       // boom, tiller/rudder, sheets, pole, crew
  update(dt: number): void;
  readonly anchors: { mastTop: THREE.Vector3; gooseneck: THREE.Vector3; forestayTack: THREE.Vector3; forestayHead: THREE.Vector3; boomEnd(angle: number): THREE.Vector3 };
}
```

Acceptance: lofted hull matching spec §6 (fine bow, firm bilge, flat run aft, open transom), deck,
cockpit, cabin with windows, hatches, stanchions/lifelines/pulpits, winches, tracks, traveler, mast
with spreaders, shrouds, forestay with furler, backstay, boom + vang, sheets with sag, spinnaker pole,
tiller; PBR materials (clearcoat gelcoat, non-skid, anodised mast, stainless, rope, varnish,
antifouling, boot stripe); 3 simple crew figures that shift to `crewY`. Demo under an env map
(three `Sky` + PMREM) with orbit controls; screenshots at 4 angles must pass as a photo of a real
25 ft keelboat. ≤ 120 k triangles at `high`.

### Task 13: Sails, telltales, windex, burgee (subagent D)

**Files:** `src/render/sails/{SailsView.ts,sailMesh.ts,mainMesh.ts,jibMesh.ts,spinMesh.ts,clothMaterial.ts,sailTextures.ts,telltales.ts,windex.ts,burgee.ts}`, `demos/sails.html`, `demos/sails.ts` (mock snapshot generator with sliders: AWA, boom/clew angle, camber, twist, luffing, stall, spinnaker curl/collapse/hoist), test `src/render/sails/__tests__/sailMesh.test.ts`.

**Interfaces:**

```ts
export class SailsView {
  readonly root: THREE.Group;                       // boat-local frame
  constructor(q: QualitySettings);
  update(dt: number, t: number, sails: SimSnapshot['sails'], wind: { awa: number; aws: number; awaDeck: number; awsDeck: number }): void;
  setColouring(mode: 'none' | 'aoa'): void;
  setPressureTexture(sail: 'main' | 'jib', tex: THREE.Texture | null): void;
  readonly telltaleAnchors: THREE.Object3D[];       // for the telltale cam
}
```

Acceptance: surfaces built from `sections` (spec §9.6) with roach, battens, luff/foot attachments;
per-vertex spring–damper following the target; luffing travelling waves, flogging, tack flip,
spinnaker curl and collapse; translucent Dacron with panels, corner patches, draft stripes,
insignia "25"; nylon spinnaker panels with sheen; telltales per snapshot state; windex; burgee.
Sheets/pole are drawn by the boat (Task 12). Screenshots from inside and outside the sails in sun
must look like real sailcloth. ≤ 0.8 ms CPU for all sails at `high`.

### Task 14: UI shell and lessons engine (subagent E)

**Files:** `src/ui/{Hud.ts,instruments.ts,windDial.ts,trimPanel.ts,topBar.ts,overlayBar.ts,toasts.ts,settings.ts,help.ts,input.ts,polarChart.ts,dom.ts,styles.css}`, `src/lessons/{engine.ts,types.ts,glossary.ts}`, `src/ui/lessonPanel.ts`, `demos/ui.html`, `demos/ui.ts` (fake snapshot stream), tests `src/lessons/__tests__/engine.test.ts`, `src/ui/__tests__/input.test.ts`.

**Interfaces:**

```ts
export interface AppApi {
  setMode(m: 'lessons' | 'free' | 'lab'): void; setCamera(c: 'chase' | 'helm' | 'top' | 'sail' | 'free'): void;
  setOverlay(k: OverlayKey, on: boolean): void; overlays(): Record<OverlayKey, boolean>;
  setWind(p: Partial<WindSettings>): void; setTimeOfDay(h: number): void; setTimeScale(s: number): void; togglePause(): void;
  setQuality(t: QualitySettings['tier'] | 'auto'): void; setSound(on: boolean): void;
  scenario(init: ScenarioInit): void; startLesson(id: string): void; controls: Controls;
}
export type OverlayKey = 'windTriangle' | 'forces' | 'wheel' | 'flow' | 'flowSlice' | 'aoa' | 'xray' | 'labels' | 'laylines' | 'track' | 'telltaleCam';
export class Hud { constructor(root: HTMLElement, app: AppApi); update(s: SimSnapshot, dt: number): void; toast(msg: string, lessonId?: string): void }
export class InputController { constructor(app: AppApi, target: Window); update(dt: number): void }
// lessons
export interface LessonCtx { app: AppApi; snap: SimSnapshot; t: number; data: Record<string, unknown> }
export interface Step { title: string; body: string; task?: { check(c: LessonCtx): boolean | number; holdSeconds?: number; label: string }; hint?(c: LessonCtx): string | null; camera?: string; overlays?: Partial<Record<OverlayKey, boolean>>; controls?: string[]; onEnter?(c: LessonCtx): void; onExit?(c: LessonCtx): void }
export interface Lesson { id: string; module: string; title: string; summary: string; setup(c: LessonCtx): void; steps: Step[]; quiz?: { q: string; options: string[]; correct: number; why: string }[] }
export class LessonRunner { constructor(lessons: Lesson[], app: AppApi, panel: LessonPanel); start(id: string): void; update(s: SimSnapshot, dt: number): void; progress(): Record<string, boolean> }
```

Acceptance: layout per spec §3.2 (glassy navy panels, tabular numerals, responsive to 375 px),
keyboard map per §3.3 with key-hold rates (sheet 0.35/s, traveler 0.5/s, tiller slew 2/s,
self-centre), touch sliders on small screens; lesson runner tests: advances on success with
`holdSeconds`, shows hints, persists progress with try/catch'd storage, quiz scoring.

### Task 15: Flow solver (subagent F)

**Files:** `src/flow/{vortexLattice.ts,slices.ts,grid.ts}`, tests `src/flow/__tests__/{thinAirfoil,twoElement,grid}.test.ts`.

**Interfaces:**

```ts
export interface Element2D { points: { x: number; y: number }[] }          // camber line LE→TE, rig-plane coords (m)
export interface SliceSolution { gammas: number[][]; panels: { x: number; y: number; nx: number; ny: number; ds: number }[][]; uInf: { x: number; y: number }; cl: number[] }
export function solveSlice(elements: Element2D[], uInf: { x: number; y: number }): SliceSolution;
export function scaleToLift(sol: SliceSolution, targetCl: number[], chords: number[]): SliceSolution;
export function velocityAt(sol: SliceSolution, x: number, y: number, core?: number): { x: number; y: number };
export function deltaCp(sol: SliceSolution): number[][];
export class VelocityGrid { constructor(bounds: { x0: number; y0: number; x1: number; y1: number }, nx: number, ny: number); fill(sol: SliceSolution): void; sample(x: number, y: number): { x: number; y: number } }
```

Acceptance: flat plate `cl = 2πα ± 3 %` (α ≤ 6°); parabolic camber f/c = 0.1 ⇒ `α0 ≈ −2f/c ± 5 %`; two
elements (jib ahead of main): main's lift decreases and jib's increases vs isolated (downwash/upwash
signs); 2 elements × 20 panels solve < 1 ms; grid 64×48 fill < 5 ms.

---

## Wave 2 — integration and content

### Task 16: App integration, loop, cameras (lead)

**Files:** `src/app/{App.ts,loop.ts,scenario.ts,wiring.ts}`, `src/render/cameras/{CameraRig.ts,chase.ts,helm.ts,top.ts,sailView.ts,free.ts}`, `src/main.ts`; test `src/app/__tests__/loop.test.ts`.

**Interfaces:** `class FixedStepLoop { constructor(step: (dt: number) => void, dt = 1/120, maxSteps = 12); advance(realDt: number, timeScale: number): { steps: number; alpha: number } }`; `class App implements AppApi`.

- [ ] Test: `advance(30, 1)` runs exactly 12 steps; `advance(1/60, 1)` runs 2; `alpha ∈ [0,1)`; time scale 0.25 runs proportionally fewer steps.
- [ ] Wire: sim → boat pose (interpolated heading/heel + ocean sampler heave/pitch/roll via spring-damper) → BoatModel/SailsView/Ocean.setBoat/setPuffs → cameras → post; UI ← snapshot; lessons; resize + DPR; quality governor; WebGL2 fallback page.
- [ ] Telltale cam: picture-in-picture second render (scissored viewport, 320×200, 20 Hz) from the helm position looking at the jib luff telltales (`SailsView.telltaleAnchors`), toggled by the `telltaleCam` overlay key.
- [ ] Verify with `snap.mjs index.html` in each camera; commit `feat(app): integrate sim, ocean, boat, sails, UI and cameras`.

### Task 17: Overlays (subagent G)

**Files:** `src/render/overlays/{Overlays.ts,arrows.ts,windTriangle.ts,forces.ts,wheel.ts,labels.ts,flowParticles.ts,flowSlice.ts,laylines.ts,track.ts,xray.ts}`; demo `demos/overlays.html` (uses the real `Simulation`).

**Interfaces:** `class Overlays { constructor(scene: THREE.Scene, boatRoot: THREE.Object3D, q: QualitySettings); set(k: OverlayKey, on: boolean): void; update(dt: number, s: SimSnapshot, camera: THREE.Camera): void; setSliceHeight(h: number): void }`.

Acceptance: spec §8 in full; arrows readable at all camera distances (screen-space scaled);
particles coloured by speed ratio; slice with streamlines + pressure map; ≤ 1.5 ms CPU with flow on.

### Task 18: Lessons content, Free sail, Sail lab (lead + subagent H for text)

**Files:** `src/lessons/curriculum/{01-meet-the-boat.ts … 18-sailing-smart.ts,index.ts}`, `src/app/modes/{free.ts,lab.ts}`; test `src/lessons/__tests__/curriculum.test.ts` (every lesson's `setup` + each step's `check` runs without throwing against a real `Simulation` for 5 s; every step has a task or is explicitly narrative; every glossary term referenced exists).

Content per spec §11.2. Scenario presets per lesson (wind, heading, trim, overlays, camera, locked controls). Sail lab = `sim.setTowed({ speed })` + AWA slider + Cl/Cd chart.

### Task 19: Audio (subagent I)

**Files:** `src/audio/{Soundscape.ts,noise.ts}`; `demos/audio.html`. `class Soundscape { constructor(); start(): Promise<void>; setEnabled(on: boolean): void; update(s: SimSnapshot, cameraYaw: number): void }` per spec §10. Acceptance: no clicks/pops, CPU < 0.3 ms/frame, starts only after a user gesture.

### Task 20: Polish, performance, e2e, README, deploy (lead)

- [ ] e2e (`e2e/smoke.spec.ts`, Playwright 1.62.1): app boots, canvas non-black (sample pixels), no console errors, a lesson starts and its first step renders, `?forceNoWebGL2=1` shows the fallback, viewport resize keeps canvas = viewport.
- [ ] Visual review against reference photos at golden hour, midday, overcast; fix.
- [ ] Performance pass with the in-app frame-time overlay on the default tier; governor tuned.
- [ ] README (screenshots, live link, controls, physics notes, credits), `THIRD_PARTY_NOTICES.md`.
- [ ] Push; Pages deploy green; open the live site in the browser pane and screenshot it as proof.

---

## Execution order and parallelism

1. Tasks 1–2 (lead) → commit + push.
2. Launch subagents for Tasks 10, 11, 12, 13, 14, 15 in parallel; lead does Tasks 3–9 meanwhile.
3. Review each subagent result (screenshots + tests), request fixes, commit per task.
4. Task 16 (lead) once 3–13 land; Task 17 + 19 subagents after 16; Task 18 lead (+ writer subagent).
5. Task 20 (lead); final whole-repo review subagent; push; deploy.
