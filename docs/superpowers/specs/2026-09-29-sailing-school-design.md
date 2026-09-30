# Sailing School — design spec

> **Note:** this is the original design document, written before the build. Numbers and details were refined
> during implementation and review. Where this document and the code or the pages in [`docs/`](../../) differ, the
> code and those pages are authoritative.

Date: 2026-09-29 · Status: approved to build (owner chose "plan, then build straight through")

## 1. Intent

**What the owner asked for (verbatim intent):** a web-browser sailing school — wind, sail direction, main
sail, jib, tacking — whose main focus is *understanding how the wind interacts with the boat and the
sails* (main, jib, spinnaker, …). Interactive, 3D, very realistic and real-life-like. Follow-ups: the
graphics must be **stunning and look REAL** (sea water, boat, sails, everything) and **run smoothly in a
browser**; reuse the best existing open-source work (e.g. realistic water) where it helps.

**Decisions taken with the owner:** public GitHub repo `pibvbp/sailing-school`; free live site on GitHub
Pages; classic *symmetric* spinnaker flown from a pole; build straight through after planning.

**Assumptions (mine, correctable):** audience is beginners → intermediate sailors plus curious
non-sailors; desktop-first (keyboard + mouse), still usable on tablets/phones at lower quality; English
UI; knots and degrees in the UI, SI internally.

**Success criteria**
1. A learner can *see* why a boat sails: live apparent-wind triangle, streamlines bending around the
   sails, lift/drag and drive/heel arrows, telltales that behave like real ones, heel vs righting moment.
2. The physics is a real model (strip-theory sail aerodynamics, foil keel/rudder, hull resistance,
   roll/yaw/sway/surge dynamics) calibrated against published ORC VPP coefficients and plausible
   polars for a 25 ft keelboat — not scripted animation. Everything the lessons teach *emerges* from it
   (in irons, weather helm, crash gybes, spinnaker collapse, backwinding, blanketing).
3. Visuals read as photographs at a glance: FFT ocean with foam and glitter, physically based sky and
   lighting, a detailed boat, sailcloth that looks and moves like cloth.
4. 60 fps at 1440×900 on an M1-class laptop in Chrome/Safari at the default tier; adaptive quality
   keeps ≥ 50 fps elsewhere. Initial load < 3 s on broadband.
5. A complete curriculum (≈18 lessons) with tasks that check the learner's actions in the live sim,
   plus Free sail and Sail lab modes.

## 2. Scope

**v1 (this build):** sim core + tests + VPP polars; photoreal environment (ocean, sky/clouds, sun,
distant land, marks); procedural "Kestrel 25" keelboat with full rig; main, roller-furling jib,
symmetric spinnaker with pole; telltales, windex, burgee; overlays (vectors, points-of-sail wheel,
flow particles + flow slice, AoA colouring, x-ray water, part labels); cameras (chase, helm, top,
sail-view, free); HUD instruments, trim panel, lesson panel, settings; lessons engine + curriculum;
Free sail and Sail lab; procedural audio; adaptive quality; CI; GitHub Pages deploy; README.

**Not in v1:** other/AI boats, multiplayer, asymmetric spinnaker, mainsail reefing, currents/tides,
VR, localisation.

## 3. Experience

### 3.1 Modes
- **Lessons** — guided curriculum (§11). Each step sets scenario, camera, overlays and which controls
  are live; tasks are checked against the sim.
- **Free sail** — pick wind (4–25 kn), gustiness, shifts, waves, time of day; windward/leeward marks;
  every control and overlay.
- **Sail lab** — the boat is "towed": speed and heading are held while sails, forces, telltales and
  flow keep computing. The learner sets apparent wind angle and trim and watches Cl/Cd, drive/heel and
  streamlines respond (a wind tunnel on the water).

### 3.2 Screen layout (desktop)
- 3D view fills the window.
- Top bar: app name, mode switcher, wind (TWS, direction, gustiness), time of day, pause/slow-motion
  (0.25×, 0.5×, 1×, 2×), sound, quality, fullscreen, help (`?`).
- Left panel (collapsible, ~360 px): lesson panel — title, step text, live task checklist with
  progress, Hint / Show me / Next, curriculum navigator with completion ticks.
- Right panel (collapsible): trim — Helm (tiller + autopilot modes), Main (sheet, traveler; "shape":
  vang, outhaul, cunningham, backstay), Jib (sheet, lead, furl, back jib, whisker pole), Spinnaker
  (hoist/douse, pole angle, pole height, sheet), Crew (auto hike), per-sail auto-trim toggles.
- Bottom: instrument strip — boat speed, heading, TWS/TWA, AWS/AWA, heel, leeway, VMG, rudder — and a
  round wind instrument (AWA needle, true-wind arrow, no-go sectors).
- Bottom-right: overlay toggles and camera buttons. Optional picture-in-picture "telltale cam".
- Toasts for events (accidental gybe, in irons, spinnaker collapse, luffing) with a one-line why and a
  link to the relevant lesson.
- Tablet/phone: panels become bottom sheets; on-screen tiller and sheet sliders; pinch zoom.

### 3.3 Keyboard
| Key | Action |
|---|---|
| ← / → (A / D) | steer: bow to port / to starboard (tiller moves the opposite way, shown on screen) |
| W / S | mainsheet trim / ease |
| ↑ / ↓ | jib sheet trim / ease |
| Q / Z | traveler to windward / to leeward |
| I / K | spinnaker sheet trim / ease |
| J / L | spinnaker pole forward / aft |
| T / G | tack / gybe (auto-crew performs the manoeuvre; learner may keep steering) |
| H | hoist / douse spinnaker |
| F | furl / unfurl jib |
| 1–5, C | cameras (chase, helm, top, sail-view, free), cycle |
| V, O, P | toggle force vectors, flow, points-of-sail wheel |
| Space | pause · `,` `.` slow-mo down/up · `?` help · Esc menu |

Helm is "hold to turn, release to centre" by default (the rudder self-centres at a realistic rate);
Shift gives fine control.

## 4. Architecture

Vanilla TypeScript + three.js r186 (`WebGLRenderer`, WebGL2, GLSL). No UI framework — DOM
components with direct text updates (instrument values change every frame). Vite 8, Vitest 5,
TypeScript (strict). Runtime dependencies: `three` and `postprocessing` (pmndrs) only; adapted
open-source code is vendored with attribution (§9.7).

```
src/
  main.ts                 bootstrap: renderer, app, error overlay
  app/                    App (mode state machine), loop (fixed-step sim + interpolated render), wiring
  shared/                 boatSpec.ts (all dimensions), coords.ts (frame conversions), math (vec2/vec3)
  sim/                    PURE TS, no DOM/three: wind, aero, sails, hydro, boat dynamics,
                          crew, autopilot/auto-trim/manoeuvres, polar (VPP), snapshot, events
  render/
    core/                 renderer setup, post-processing, quality tiers, frame budget
    env/                  sky, clouds, sun/light, ocean (FFT + CPU sampler), wake/foam, land, marks
    boat/                 procedural hull/deck/rig/appendages/fittings/crew, materials, textures
    sails/                main/jib/spinnaker meshes, sail material, telltales, windex, burgee
    overlays/             vectors, points-of-sail wheel, flow particles + slice, labels, laylines, track
    cameras/              chase, helm, top, sail-view, free
  flow/                   2-D vortex-lattice solver for sail slices (pure TS, tested)
  ui/                     hud, instruments, trim panel, lesson panel, menus, toasts, polar chart, input
  lessons/                engine (runner, predicates) + curriculum/*.ts content
  audio/                  WebAudio procedural soundscape
demos/                    standalone pages per render module (ocean.html, boat.html, sails.html, …)
scripts/                  snap.mjs (headless screenshots), polars.mjs (regenerate polar table)
```

**Frame loop:** input → controls → `sim.step(1/120)` × k (accumulator, max 12/frame, × time scale) →
snapshot → render (interpolates pose between the last two sim states) → UI (instrument DOM at 15 Hz,
needles every frame) → lessons → audio.

**Boundaries:** `sim/` and `flow/` never import three or DOM (unit-testable in Node). Render modules
consume the `SimSnapshot` contract (`src/sim/types.ts`) and `boatSpec`; they never mutate sim state.
UI writes only to `Controls`. Lessons read snapshots and may call the app's scenario API.

## 5. Conventions (binding for every module)

- **Units:** SI internally (m, s, kg, N, rad). UI: knots (1 kn = 0.514444 m/s) and degrees.
- **World (three.js):** Y up, North = −Z, East = +X. Sim 2-D world `(e, n) = (X, −Z)`.
- **Compass angles:** 0 = north, clockwise positive. `TWD` = direction the wind blows **from**.
- **Body frame (sim):** x forward, y starboard, z down (SNAME). Origin: on the centreline, at the
  waterline, at the longitudinal station of the centre of gravity. Specs list heights `h` (m above
  the waterline); `z = −h`.
- **Signs:** heel φ > 0 = starboard side down; yaw rate r > 0 = turning to starboard; rudder δ > 0 =
  turns the boat to starboard; signed wind angles (TWA, AWA) ∈ (−π, π], **> 0 = wind from starboard**
  (starboard tack); boom/clew angles > 0 = out to **port**; leeway > 0 = sliding to starboard.
- **Render boat-local frame (three.js):** X = starboard, Y = up, Z = aft (bow toward −Z).
  Conversion from body: `X = y_b, Y = −z_b, Z = −x_b` (`shared/coords.ts`).
- **Boat root transform:** position `(e, heave, −n)`, Euler order `'YXZ'`: `y = −ψ`,
  `x = pitch` (bow-up positive), `z = −φ_total`.

## 6. The boat — "Kestrel 25" (fictional class; all numbers live in `shared/boatSpec.ts`)

| Item | Value |
|---|---|
| LOA / LWL | 7.60 m / 6.40 m |
| Beam max (deck) / BWL | 2.60 m / 2.20 m |
| Canoe-body draft / keel draft | 0.36 m / 1.45 m |
| Mass (boat 1400 + crew 3 × 80) | 1640 kg |
| Stem at deck / at waterline | x = +3.95 (h 0.98) / x = +3.30 |
| Transom at deck / waterline end | x = −3.65 (h 0.74) / x = −3.10 |
| Freeboard | bow 0.98, mast 0.80, min 0.72 at x = −1.5, stern 0.74 |
| Cabin trunk | x −1.30…+2.00, 0.40→0.30 m high, 1.50→1.00 m wide |
| Cockpit | x −3.45…−1.30, sole h 0.35, seats h 0.62 |
| Mast | x = 1.05, base h 1.15 (cabin top), top h 10.20; section 0.13×0.08 → 0.08×0.06 |
| Spreaders | h 5.6, 0.85 m each side, 5° sweep |
| Forestay | stem head (3.90, h 0.98) → (1.12, h 10.05); roller-furling foil |
| Backstay | (0.98, h 10.10) → transom (−3.60, h 0.74), adjuster |
| Boom | gooseneck (0.98, h 2.00), length 3.30, end-boom sheeting, traveler at x −2.15, track 1.6 m |
| Main | P 8.00, E 3.10, roach → 14.6 m², 4 battens, draft stripes |
| Jib (≈105 %) | tack (3.88, h 1.05), head (1.23, h 9.70) on the forestay, luff 9.05, LP 3.05, foot 3.33, clew h 1.45, ≈13.8 m²; leads x +0.2…−0.4, y ±0.75 |
| Spinnaker | SL 9.2, foot 5.2, half-width 3.9 → ≈32 m²; halyard at masthead |
| Spinnaker pole | 2.90 m, mast end h 1.90, tip h 1.6…3.4 |
| Keel (NACA 0012 fin) | root chord 1.00 @ h −0.36, tip 0.65 @ h −1.45, LE sweep 12°, root LE x +0.87; area ≈ 0.90 m²; CP ≈ (0.55, h −0.87) |
| Rudder (spade, NACA 0012) | stock x −2.85, root 0.40 @ h −0.15, tip 0.28 @ h −1.15; ≈0.34 m²; CP ≈ (−2.85, h −0.62) |
| Tiller | 1.05 m, varnished wood with extension |
| Righting | GZ(φ) table: 0→0, 10°→0.163, 20°→0.310, 30°→0.425, 40°→0.505, 50°→0.550, 60°→0.560, 70°→0.535, 80°→0.475, 90°→0.390, 110°→0.180, 130°→−0.05 m (GM ≈ 0.95) |
| Inertia (incl. added) | I_xx ≈ 2750, I_zz ≈ 9000 kg·m²; sway added mass 0.8 m, surge 0.05 m |

Look: modern classic day-racer. Near-plumb bow with slight rake, gentle sheer, open transom, white
gelcoat topsides, navy boot stripe, dark-grey antifouling, grey non-skid deck, dark tinted cabin
windows, stainless fittings, black winches, coloured running rigging (main sheet blue, jib sheets
red/green-flecked, spinnaker sheets/guys orange), varnished tiller. Sails: off-white Dacron, cross-cut
panels, corner patches, batten pockets, draft stripes, class insignia (a stylised kestrel) and the
number "25". Spinnaker: nylon, bold horizontal panels (navy / white / signal orange).

## 7. Physics model (`src/sim`)

Integration: fixed dt = 1/120 s, semi-implicit Euler; deterministic given the seed. Constants:
ρ_air 1.225, ρ_water 1025, ν 1.19e-6, g 9.81.

### 7.1 Wind
- Gradient (ORC VPP 2023 §7.1): `V(h) = TWS · ln(max(h,0.3)/z0) / ln(10/z0)`, z0 = 0.005 m. (At the
  boom, ≈ 77 % of masthead wind → the apparent wind twists with height.)
- **Puffs and lulls:** a seeded set of moving elliptical patches, `round(6·gustiness)` of them: radius along
  the wind 40–120 m × (0.7 + 0.6·gustiness), across it 1.3–2× that; gusts (70 %) +15…+45 %, lulls −10…−30 %
  of TWS, both × (0.5 + 0.5·gustiness); direction offset −6…+14° for gusts (they usually veer), ±8° for lulls;
  life 90–240 s with a 20 s fade in/out; drifting downwind at 0.9 × the wind speed; spawned 400–900 m upwind
  and within ±350 m across (the first fill spreads −250…900 m), removed 600 m downwind, 900 m to the side or
  at the end of life. At a point: speed × max(0.2, 1 + Σ strength·w), direction + Σ offset·w / max(1, Σw)
  (overlapping puffs average their shifts), w = envelope·exp(−(d_along²/r_along² + d_across²/r_across²)).
  The ocean renders each puff as darker, rougher water, and
  wind particles speed up inside it, so the learner *sees* a gust arrive before it hits.
- **Shifts:** `TWD(t) = TWD0 + A·sin(2πt/T + ϕ) + slow seeded noise`, A = 0…15°, T = 60–300 s.

### 7.2 Apparent wind at any point
For a body point **r** at heel φ: rotate to the heading frame H, point velocity
`V_P = (u, v, 0) + ω × r_H` with ω = (p, 0, r) (roll and yaw rates), relative air
`A_H = W_H(h) − V_P`, then back to body `A_B = R_x(φ)ᵀ A_H`. Sails use only the rig-plane components
`(A_B.x, A_B.y)` — the cross component is thereby reduced by cos φ (ORC "effective angle", eq. 7.2)
and the along-mast component is ignored. Roll rate therefore adds realistic aerodynamic roll damping.

### 7.3 Sail aerodynamics (strip theory)
Each sail is split into horizontal **sections** (main 8, jib 8, spinnaker 6). Per section:
- Geometry from trim (§7.4): luff point, unit chord direction **c** (luff→leech, rig plane), chord,
  camber (depth/chord), draft position; section area = chord × height step.
- Flow direction **w** = normalised `(A_B.x, A_B.y)`; α = angle(**c**, **w**) ∈ [0, π]; leeward normal
  `n_lee = normalise(w − (w·c)c)` (the side the cloth bellies to); lift ⟂ **w** toward `n_lee`; drag ∥ **w**.
- Dynamic pressure `q = ½ρ|A|² · blanket`.
- **Coefficients vs α** (per sail parameters, camber-dependent):
  - *Luffing* below `α_luff` (≈ 0° for a mid-draft sail; lower when the draft is forward): lift fades to
    0 over `luffWidth` ≈ 6°, drag → `cd_flog` (0.10). Intensity `luffing ∈ [0,1]` drives telltales,
    flapping visuals and sound.
  - *Attached:* `Cl = CLα·(α − α0(camber))`, `α0 = −1.15·camber` (rad), `CLα ≈ 3.4 /rad` (main/jib),
    `Cd = cd0 + kpp·Cl²` (ORC: kpp main 0.0138, jib 0.016, spinnaker 0.026).
  - *Stall* beyond `α_stall = 0.21 + 0.8·camber` rad, blended over ≈ 4° into a normal-force model
    `Cn(α)` acting ⟂ chord: `Cl = Cn cos α`, `Cd = Cn sin α + cd0`; `Cn_max` main 1.34, jib 0.95,
    spinnaker 1.10 at α ≈ 35° falling to 0.64 at 90° (ORC tables, cloth-area basis).
  - *Reversed flow* (α > 90°: the wind reaches the leech first): every blend is evaluated on the incidence to
    the chord line a′ = π − α. The leech is a sharp leading edge, so there is no attached lift: the normal
    force grows from 0 like a flat plate's, `Cn = Cn(90°)·sin a′/(0.56 + 0.44·sin a′)`, and the sail luffs again
    as a′ → 0 (luffing threshold of a sail with its draft at 1 − draft). Continuous with the forward branch at 90°.
  - Induced drag per sail set: `Cdi = Cl²·A/(π·h_eff²)`, `h_eff = cheff·10.0 m`, cheff = 1.1 × kheff(AWA)
    (kheff 1.45 at 20° → 0.80 at 80°, ORC Fig. 5.14); spinnaker downwind cheff ≈ 1.0.
  - Depth/shape controls change camber, draft position and twist, so *full* sails give more power and a
    wider groove, *flat* sails less heel and a narrower groove.
- **Main–jib interaction** (uses the previous step's lift coefficients): jib upwash
  `Δα_jib = +0.06·Cl_main·A_main/A_tot`, main downwash `Δα_main = −0.10·Cl_jib·A_jib/A_tot`, stronger
  (×1.4) on the front 30 % of the main's chord (a potential-flow check with `src/flow` gives 1.3–1.4×). That
  front part works at the lower angle: below `α_luff` it is backwinded — no lift, flogging drag — so the luff
  bubble of an over-trimmed jib costs force, not just looks. Shifts are applied to the angle signed relative to
  the leeward side the sail is set to (a section the wind reaches from its lee side is pushed further into
  luffing, never into lifting to windward). Applies only when both sails are set on the same side (not
  wing-on-wing).
- **Blanketing:** a sail's `q` is reduced (to ≥ 20 %) when it lies in another sail's wind shadow,
  computed geometrically in the apparent-wind frame (main blankets jib and spinnaker on a run; a
  squared-back pole moves the spinnaker out of the shadow).
- Section forces act at 38 % chord + 0.75·depth to leeward; total force, centre of effort and the moment
  about the mast (boom dynamics) are sums over sections.
- A moving sail meets the air: the cloth's own swing velocity is subtracted from each section's airflow
  (aerodynamic damping of boom and clew), capped at half the section's airflow.
- **Calibration target:** with optimal trim at each AWA the model reproduces the ORC 2023 envelopes
  within ±15 % (main Cl 0.86 @ 7°, 1.16 @ 12°, 1.35 @ 28–60°, 1.27 @ 90°, 0.93 @ 120°, −0.11 @ 180°; jib
  1.0 @ 15°, 1.45 @ 27–50°, 0.40 @ 100°; spinnaker 0.66 @ 41°, 1.03 @ 67–75°, 0.64 @ 130°, 0 @ 180°).

### 7.4 Sail mechanics (trim → shape)
- **Boom** angle β_b (dynamic): `I_b β̈ = M_aero + M_gravity + M_sheet + M_damping`, I_b ≈ 90 kg·m²
  (boom + sail + entrained air). Gravity swings the boom to the low side when heeled. The mainsheet is a
  **one-sided** constraint around the traveler car angle `β_car = atan(y_car/3.1)`:
  `β_b ∈ [β_car − Δ, β_car + Δ]`, `Δ = 85°·(1 − sheet)^1.5` (within ±80°), stiff spring + damping when taut;
  the shrouds are a hard stop at ±82° where the boom stops dead (rate zeroed). Unconstrained, the boom
  weathervanes (sail luffs). A **crash gybe** event: the boom crosses the centreline with the wind from aft
  (|AWA| > 100° at the crossing) and slams into the sheet or the shrouds (|β̇| > 1.5 rad/s at impact), or swings
  from ≥ 40° out on one side to ≥ 40° out on the other within 2 s (from 6 kn TWS) — never during a crew-run
  tack or gybe, nor while the boom is held by hand.
- **Ropes are handled at a finite speed:** the sheet and traveler controls are targets. Sheets are hauled at
  ≈ 0.35 of their range per second and eased at ≈ 1 per second; the traveler car is a physical state moving at
  the same rates (to windward = hauling, 1.6 m track), so it never jumps when the tack flips — only its target
  changes side.
- **Which side the rig is set on:** head to wind the side changes once |AWA| > 3°; dead downwind only when
  |AWA| < 165° on the new side, when the boom gybes across (> 5° over, |AWA| ≥ 165°), or when the crew gybes
  the rig. The wind wobbling across the stern never moves main, jib, spinnaker or whisker pole.
- **Twist:** leech tension `T = max(vang, sheet-tension-near-car)`; head twist `τ = 2° + 20°·(1−T)^1.3`
  (+ a little more in puffs); section angle `θ(h) = β_b + side·τ·h^1.4`, side = the boom side (the tack side
  while the boom is within 4–8° of the centreline), easing across in ≈ 0.3 s when the sail flips.
- **Camber:** main base 11 %; outhaul flattens the lower third (−4 %), backstay flattens mid/upper
  (−3 %), cunningham moves draft forward (50 % → 40 %). Jib base 12 %; backstay tightens forestay (−2 %);
  lead forward = deeper foot, less twist; lead aft = flatter foot, more twist.
- **Jib clew** angle γ (dynamic, light, I ≈ 6 kg·m²): leeward sheet limit
  `γ ≤ γ_lead + 29°·(1 − sheet)^1.3` (γ_lead ≈ 10–11.5°, lead aft → forward); windward sheet slack unless
  *back jib* is on: then the crew holds the clew to windward at −side·15° whatever the sheet says (jib
  auto-trim pauses). When the bow passes head-to-wind the auto-crew releases the old sheet and hauls the new
  one in over ≈ 2.5 s (the jib flogs meanwhile). Furling reduces area and lowers the centre of effort.
  Whisker pole: latched on the side opposite the boom when it is set, it holds the clew 80° out (square to a
  following wind, wing-on-wing); the clew is carried onto it at ≈ 40°/s (2–3 s), never in a step, and the
  pole moves across only when the rig gybes. The clew stops dead at ±95°.
- **Boom held out by hand** (`boomPush`, −1…1, + = to port): the crew pushes the boom toward ±70° with what
  one person can give (≈ 300 N at the boom end), never past the sheet; 0 lets go at once. Backing the main
  this way, head to wind, drives the boat astern and turns the bow away from the side the boom is held on.
- **Spinnaker:** hoist 6 s / douse 5 s (area ∝ hoist). Tack = pole tip; pole angle 0° (on the forestay)
  → 90° (squared); clew on a circle of radius = foot around the tack, limited by the sheet length to the
  quarter block and by the leech length (clew within SL of the head: one interval of chord angles
  [ψ_lo, ψ_hi]; flown at ψ ≥ max(95°, ψ_lo) and ≤ ψ_hi) → chord angle from geometry. `α_curl` ≈ 16°: the
  luff curls just above it (optimal); below `α_curl − 7°` for 0.6 s the sail **collapses** (area 20 %,
  flogging) and it refills once α has been above `α_curl − 3°` for 1 s. Lifting efficiency builds to a peak
  on a close reach (AWA 67–75°) and falls ≈ 10 % by 100–110° (ORC table shape). Pole height off its optimum
  (tack level with clew) reduces efficiency. Over-trimmed → stall, more heel, broach risk. Gybing moves the
  pole end-for-end (≈ 6 s, reduced efficiency while the pole is off) — only when the rig changes side.

### 7.5 Hull and appendages (`hydro.ts`)
- Friction (ORC §6.1): `R_f = ½ρV²·S_c·Cf·1.05`, `Cf = 0.066/(log10 Re − 2.03)²`, `Re = V·0.85·LWL/ν`,
  S_c = 11.0 m².
- Residuary: `R_r = Δg·rr(Fn)`, monotone table rr = {0.10: 1e-4, 0.15: 4e-4, 0.20: 1.1e-3,
  0.25: 2.4e-3, 0.30: 4.7e-3, 0.35: 9.2e-3, 0.40: 0.018, 0.45: 0.033, 0.50: 0.048, 0.55: 0.058,
  0.60: 0.064, 0.70: 0.070} (tuned by the polar tests).
- Heel drag: `(R_f + R_r)·0.8·sin²φ`. Sternway: symmetric with ×1.5. Hull resistance acts along the surge
  axis (from the surge speed); sideways motion is the cross-flow model's.
- **Keel and rudder** are foils evaluated at their centres of pressure with local flow including yaw and
  roll rates (natural damping and weathercocking), valid for all 360°: attached `Cl = CLα·α`
  (Helmbold `CLα = 2π·AR/(AR+2)`, keel AR_eff 2.85 with the hull end-plate, rudder 4.5), stall at 14°
  (keel) / 22° (rudder) blending into a flat-plate normal force (Cn90 1.2); reversed flow handled.
  Profile drag `Cf(1+2t/c+60(t/c)⁴) + 0.0016|Cl| + 0.0032Cl²`; induced drag `L²/(q·π·T_eff²·0.9)`.
  Keel effective area includes the canoe body's lift (×1.25). Rudder loses effect with heel (area ×
  cos φ, ventilation above 30°) → round-ups when over-powered. With way on the rudder sits in the keel's
  downwash; going astern it is upstream of the keel and sees none (blended in over 0–0.3 m/s ahead).
- Hull cross-flow drag along 10 stations (Cd 1.0) for slow sideways drift and pivoting.
- Windage of hull, mast, rigging and crew (ORC Table 5.10 style) — why a boat in irons drifts backwards.
- Righting moment `−Δg·GZ(φ)`; crew moment `m_c g y_c cos φ`. Auto-hike: to windward in proportion to
  smoothstep(3°, 12°) of the heel to leeward (φ_L = −sign(TWA)·φ), centred when not heeled to leeward, a little
  to leeward in light air (1–6 kn, not in a calm); downwind they counter whatever heel there is. The crew moves
  with a first-order lag of ≈ 1 s.

### 7.6 Rigid-body dynamics
State: e, n, ψ, u, v, r, φ, p (+ boom, jib clew, spinnaker, rudder, crew states). Equations in the
heading frame: `(m+m_x)(u̇ − v r) = X`, `(m+m_y)(v̇ + u r) = Y`, `I_z ṙ = N`, `I_x ṗ = K`. Rudder follows
the helm at ≤ 60°/s, max ±35° (a crew override too), self-centring. Heave and pitch are **not** simulated; the
renderer adds wave-driven heave/pitch/roll on top (§9.3). Defence in depth: a step that ends in a non-finite
state is undone (previous state, angular rates zeroed), counted in `faults` and warned about once — the physics
itself must keep that count at 0.

### 7.7 Crew, autopilot, auto-trim, manoeuvres
- Helm modes: manual, hold heading, hold TWA, hold AWA (PID on rudder: P and D gains ∝ 1/V², bounded; the
  integral is kept as a rudder angle up to the stops, so the autopilot holds its angle at any speed).
- Auto-trim per sail ("the crew"): main to α ≈ 85 % of the way from luff to stall upwind, near max
  lift off the wind, and depowers via traveler/sheet above 22° heel; jib to 75 % of the groove;
  spinnaker pole ⟂ apparent wind (from a 1 s-smoothed reading), sheet to just-curling. Jib trim pauses while
  the jib is backed or poled out, main trim while someone holds the boom out by hand. With the jib on auto the
  crew furls it on a spinnaker hoist and unfurls it on the douse — only on those edges, so a learner's furl
  otherwise stands.
- Tack: needs ≥ 2 kn; steers through the wind at a realistic rate with the traveler centred and the mainsheet
  left alone while the bow swings through, releases/hauls the jib, settles on the mirrored close-hauled TWA.
  Gybe: bear away to ~176°, haul the main in as the stern comes to 166–174° (hauled on a broad reach it would
  lay the boat over), turn through, gybe the rig (jib across, traveler over, pole end-for-end if flying), let the
  main run back out. Both double as "Show me" demos. The learner may keep steering: moving the tiller more than
  20 % of its travel from where it was, or changing the helm mode, hands them the helm at once — the crew keeps
  working the sheets and never takes it back in that manoeuvre. Every phase has a timeout (turn, cross ≤ 15 s;
  settle ≤ 10 s) after which the crew ends the manoeuvre cleanly and releases every override. A scenario reset
  resets the crew too.
- Events: `crashGybe` (§7.4), `inIrons` (|TWA| < 30° and speed < 0.5 kn for 3 s), `tackComplete`,
  `gybeComplete`, `spinCollapse`, `spinRefill`, `roundUp` (heel > 25°, the bow swinging toward the wind faster
  than 8°/s with less than 5° of rudder toward the wind — tiller centred or fighting it), `luffing`,
  `backwinded`.

### 7.8 Steady-state solver (VPP) and polars
`solveSteady(TWS, TWA, trim)` finds (V, leeway, heel, rudder) with zero net X, Y, K, N using the
*same* force functions (Newton with numerical Jacobian); `bestSpeed` optimises trim (sheet angles,
flatten, spinnaker vs jib). A steady result means the speed has settled with the boat on the requested TWA
(within 1°); an unsettled run is retried for twice as long, then reported as its 20 s average with
`converged: false`, and a sail set that cannot hold the angle does not compete with one that can.
`scripts/polars.ts` writes `src/sim/data/polars.json` (TWS 4–25 kn, TWA 30–180° step 5°; the optimal VMG
angles are refined between grid angles with a parabola; points that never settled are listed in
`unconverged`). UI uses it for target speed and optimal VMG angles.
**Plausibility bands** (J/24-class references; the polar is produced by sailing the simulated boat to
steady state with the auto-crew, `src/sim/vpp.ts`): 6 kn — beat 3.2–4.6 kn, 90° 3.8–5.2, 150° 2.9–4.4;
12 kn — beat 4.9–6.0, 90° 6.0–7.2, 150° 5.2–6.8; 20 kn — beat 5.0–6.3, 90° 7.0–8.6, 150° 7.0–8.8.
Optimal upwind TWA 34–48°; VMG at 30° below the optimum; in light air the best downwind VMG is on a
broad reach (so gybing downwind pays). Light-air broad reaching sits at the low end: running deep, the
apparent wind collapses (≈ 2 m/s at 150° in 6 kn) and no rig of this size can drive the hull faster.

### 7.9 Snapshot contract (`src/sim/types.ts`)
`SimSnapshot` is produced once per sim step (render interpolates the last two):
- `boat`: pos (e,n), heading, heel, yaw/roll rates, u, v, speed, cog, leeway, rudder, vmg, crew hike.
- `wind`: local TWS/TWD (with gust), TWA, AWS/AWA at 10 m and at deck height, puffs (for rendering).
- `sails.main | jib | spinnaker`: set flag, area, corner points (tack/clew/head, body frame), boom angle
  or pole data, hoist/furl, collapse/curl, and `sections[]` = {h, luff, chordDir, chord, camber, draft,
  leewardY, aoa, luffing, stall, cl, cd, q}; total force + centre of effort; lift/drag/drive/heel;
  `telltales[]` = {id, pos, side, state: streaming | lifting | stalled | fluttering, intensity}.
- `forces`: aero total (force + point), drive, side force, keel & rudder forces (force + point), hull
  resistance, heeling / righting / crew moments, CG and CB (for the righting-couple overlay).
- `events[]` since the previous snapshot.

## 8. Seeing the physics (overlays and teaching visuals)

- **Wind triangle:** true wind (blue), boat-motion wind (grey), apparent wind (amber) arrows at the
  masthead and at deck level (shows gradient twist).
- **Forces:** total sail force (red) at the CE, split into drive (green) and heeling force (purple);
  per-sail lift/drag; keel lift (cyan) and hull resistance under water; righting couple (weight at CG
  down, buoyancy at CB up) when heeled; rudder force and helm-balance meter.
- **Points-of-sail wheel:** a ring on the water fixed to the true wind, sectors no-go / close-hauled /
  close reach / beam reach / broad reach / run, "you are here" marker.
- **Flow:** (a) true-wind particles drifting over the water (world frame; faster in gusts);
  (b) apparent-wind streaks advected in the boat frame through a flow field around the sails from the
  2-D vortex-lattice solver (`src/flow`, §8.1), coloured by speed ratio (faster = lower pressure);
  separated turbulent wake behind stalled sections; (c) **flow slice** — a translucent horizontal plane
  at a chosen height with streamlines and a pressure map, like a textbook diagram but live.
- **AoA colouring** of the sails (blue luffing / green in the groove / red stalled); **draft stripes**
  and a sail-view camera to judge camber and twist; **telltale cam** picture-in-picture.
- **X-ray water:** water near the boat turns translucent to show keel, rudder, leeway and underwater
  forces.
- **Part labels** (lesson 1), laylines, course line, track trail, marks.

### 8.1 Flow solver (`src/flow`)
Per slice (4–6 heights): discretise the main and jib camber lines into N ≈ 20 panels each, lumped
vortices at ¼ panel, collocation at ¾ panel, flow tangency → solve the coupled 2N system (captures
upwash/downwash — the slot effect — without the discredited "venturi" story). Circulations are then
scaled per sail so the slice lift matches the force model (which includes stall, luffing and 3-D
effects). Velocity field sampled onto a grid per slice at ~10 Hz; particles sample the grids. Spinnaker
downwind: separated-flow model (bluff-body wake) with a small attached-flow luff region when reaching.

## 9. Rendering (photoreal + smooth)

### 9.1 Pipeline
`WebGLRenderer` (antialias off; SMAA in post), HalfFloat HDR render target, AgX tone mapping by
default (ACES selectable), physically correct lights, exposure tuned to the sky. Post chain
(pmndrs `postprocessing`, one fused effect pass): bloom (sun glints only, high threshold) → tone map
→ SMAA; vignette subtle. Shadows: sun directional light, tightly fitted around the boat (sails shade
the deck and hull).

### 9.2 Quality tiers and frame budget
Tiers `ultra | high | medium | low` set: render scale (0.6–1.0 × DPR≤2), ocean FFT size (256/128) and
cascades (3/2), ocean mesh density, planar reflection (on/half-res/off), shadow map (4096/2048/1024),
bloom, particle counts, sail mesh resolution. Start at `high`; a governor measures median frame time
over 2 s and steps down above 20 ms / up after 10 s below 12 ms (hysteresis); user override in
settings. Budget @ 60 fps, M1 Air: sim ≤ 0.5 ms, sails + particles ≤ 1.5 ms CPU; GPU ocean ≤ 4 ms,
boat/sails/shadows ≤ 3 ms, sky/clouds ≤ 1 ms, post ≤ 2 ms.

### 9.3 Ocean
FFT (Tessendorf) ocean with JONSWAP spectrum and directional spreading driven by TWS and fetch, plus a
long swell; 3 cascades (≈ 250 m / 37 m / 7 m patches) so there is no visible tiling; choppy horizontal
displacement; normals and Jacobian foam (whitecaps from ≈ 12 kn); camera-centred LOD grid to the
horizon; Fresnel sky reflection, GGX sun glitter, subsurface scattering in crests, planar reflection of
the boat (distorted by normals) on higher tiers; gust patches (from the sim's puffs) as darker, rougher
water; boat wake (Kelvin arms + turbulent centreline foam) and bow wave foam via a world-space foam
render target around the boat; aerial perspective toward the horizon. Boat heave/pitch/roll and
bobbing marks come from a small height grid around the boat rendered from the *same* ocean shader and
read back asynchronously one frame late (exact match with what is drawn, no GPU stall; wave-riders
approach). Base implementation adapted from ABYSSAL (§9.7).

### 9.4 Sky and light
three r186 `Sky.js` (Preetham) with its built-in cloud layer, sun disc, time-of-day control (default
late afternoon, sun ≈ 25°), clouds drifting with the upper wind, IBL environment map regenerated from
the sky when the sun moves, fog/aerial perspective matching the horizon colour.

### 9.5 Boat
Procedural lofted hull from station sections (fine bow → firm bilges → flat run aft), smooth normals,
deck with camber, non-skid texture, cockpit, cabin trunk with tinted windows and hatches, stanchions,
lifelines, pulpit/pushpit, winches, cleats, tracks, traveler, mast with spreaders, standing rigging,
halyards, sheets as sagging tubes following their blocks, spinnaker pole, tiller. PBR materials
(clearcoat gelcoat, anodised aluminium, stainless, rope, varnish, antifouling); baked ambient occlusion
where cheap. Animated parts driven by the snapshot: boom, tiller/rudder, jib clew, sheets, pole, crew
(simple figures that hike and switch sides on tacks).

### 9.6 Sails
Each sail is a dynamic grid built from the snapshot sections (roach curve, batten stiffness, foot and
luff attachments). Vertices follow the target shape through a per-vertex spring–damper, with
procedural excitation for luffing (travelling waves starting at the luff), flogging, the spinnaker's
luff curl and collapse, and tacks (the belly passes through flat with a flutter). Material: double-sided
cloth with translucency (sun glowing through), panel seams, corner patches, batten pockets, draft
stripes, insignia and numbers (procedural canvas textures), subtle wrinkle normals, sheen on nylon.
Telltales (red port / green starboard; leech telltales on the main) are ribbons animated from their
state. Windex at the masthead, burgee at the stern.

### 9.7 Reuse of existing open-source components
Decided 2026-09-29 after a survey of open-source water/sky/sailing projects (licences verified via
the GitHub licence API). Only permissive licences are vendored; attribution lives in
`THIRD_PARTY_NOTICES.md` and in each adapted file's header.

| Area | Decision | Source (licence) |
|---|---|---|
| FFT ocean (cascades, JONSWAP + spreading, Jacobian foam accumulation, projected grid, GGX/Fresnel/SSS shading, quality presets) | **Adapt** `src/ocean/OceanFFT.js`, `OceanMesh.js`, `OceanSampleGLSL.js` to TypeScript/r186; strip the disaster fields; feed our sky/sun uniforms | Token-Gremlin/natural-disasters "ABYSSAL" (MIT, © 2026 Davi) |
| Wave heights for boat motion; Kelvin wake | **Adapt** the idea/code of `WaveField.js` (height grid around the boat rendered from the ocean shader, read back asynchronously one frame late with `readRenderTargetPixelsAsync`) and `Wake.js` (19.47° Kelvin foam ribbon, bow spray) | developmentation/wave-riders (MIT, fork of the above) |
| Sky + clouds | **Use** three r186 `Sky.js` (Preetham + built-in 2-D cloud layer); environment map via `PMREMGenerator.fromScene` only when the sun moves. Upgrade path (not v1): ABYSSAL `sky/Atmosphere.js` LUTs for better sunsets | three.js (MIT) |
| Post-processing | **Depend on** pmndrs `postprocessing` 6.39.x (fused Bloom + SMAA + AgX/ACES tone mapping in one pass; peer `three <0.187`) | pmndrs/postprocessing (Zlib) |
| Quality governor | **Learn from** ABYSSAL `core/Quality.js` + `GpuProfiler.js` (timer queries where available) | MIT |
| Physics cross-check | **Learn from** marinlauber/Python-VPP (ORC-based 3-DOF VPP) when tuning polars | MIT |
| Sails, boat, telltales | **Build** — no photoreal open-source sail renderer exists; procedural hull keeps geometry consistent with the physics | — |

Avoided: no-licence ocean repos, GPL/LGPL sailing sims, Shadertoy code (default CC BY-NC-SA), Unity
Companion-licensed assets.

## 10. Audio
WebAudio, fully procedural (no assets): wind (filtered noise, level ∝ AWS², pitch with AWS, panned by
apparent-wind direction), water (lowpassed noise ∝ speed, splash modulation from pitch), sail flogging
(noise bursts at the flutter rate ∝ luffing), boom crash (thump), winch clicks when trimming. Starts on
first interaction; mute toggle; master volume.

## 11. Lessons

### 11.1 Engine
A lesson = `{id, module, title, summary, setup(ctx), steps[], quiz?}`; a step =
`{title, body (HTML with glossary terms), task?: {check(snapshot, ctx) → boolean | progress 0..1,
holdSeconds?}, hint?(snapshot) → string | null, camera?, overlays?, controls? (which are live),
autoTrim?, onEnter?, onExit?}`. The runner evaluates tasks every frame, shows progress, advances on
success, offers hints after inactivity or on detected mistakes (events), and saves progress in
`localStorage` (wrapped in try/catch). "Show me" runs the auto-crew/autopilot for that step.
Glossary terms are hoverable everywhere.

### 11.2 Curriculum
1. **Meet the boat** — parts (labels), port/starboard, the tiller steers the opposite way. *Task:*
   steer to a target heading ±10°.
2. **Finding the wind** — reading the water, clouds, flags and the windex; head to wind; the no-go
   zone. *Task:* point head-to-wind (|TWA| < 10° for 3 s), then bear away until the sails fill.
3. **Points of sail** — wheel overlay; *tasks:* close-hauled, beam reach, broad reach, run (crew
   auto-trims) — compare speeds.
4. **Apparent wind** — the wind triangle; why the apparent wind moves forward as you speed up and is
   stronger upwind. *Tasks + quiz.*
5. **A sail is a wing** (Sail lab) — lift, drag, angle of attack, luffing vs stall with streamlines and
   the flow slice. *Task:* find the trim that maximises drive at a beam reach.
6. **Drive and heel** — the same force splits differently by point of sail. *Task:* compare drive/heel
   close-hauled vs broad reach.
7. **Jib and telltales** — the groove; ease till the windward telltale lifts, trim till it streams;
   then steer to the telltales upwind. *Task:* both streaming for 15 s.
8. **Mainsail trim and twist** — boom angle, traveler, leech telltales, the wind gradient and twist
   (sail-view camera, draft stripes). *Task:* top leech telltale streaming about half the time.
9. **Main and jib together** — upwash/downwash, backwinding (and why the "venturi" story is wrong).
   *Task:* cause and fix a backwinded main.
10. **Keel, leeway and balance** — keel lift and leeway (x-ray), heeling vs righting moment, weather
    helm; depower with traveler, twist, flattening, hiking. *Task:* upwind in 16 kn with heel < 20°
    and helm < 6°.
11. **Tacking** — the sequence and calls, keeping momentum, in irons. *Task:* three tacks keeping ≥ 60 %
    of entry speed.
12. **Getting out of irons** — starts stuck; back the jib, push the boom, reverse steering. *Task:*
    sailing again at ≥ 2 kn.
13. **Gybing** — controlled vs accidental gybe (demonstrated safely). *Task:* two gybes without a crash
    gybe event.
14. **Running and wing-on-wing** — blanketing, by-the-lee danger, whisker pole. *Task:* 30 s dead
    downwind with the jib full.
15. **Spinnaker: hoist and trim** — pole ⟂ apparent wind, ease to the curl. *Task:* 30 s full and
    curling at TWA 120–150°.
16. **Spinnaker: reaching to running** — pole and sheet through course changes; collapse and broach
    risk. *Task:* broad reach → run → broad reach without a collapse.
17. **Spinnaker gybe and douse**. *Task:* gybe with the spinnaker up, then douse before heading up.
18. **Sailing smart** — VMG and polars, laylines, gusts/lulls, lifts/headers. *Task:* reach the
    windward mark in shifty, gusty wind within the target time.

## 12. Verification
- **Unit (Vitest, Node):** math and frame conversions; wind gradient and puffs; apparent wind;
  coefficient curves (continuity, ORC envelope reproduction); section forces; foils (all quadrants,
  sign of lift); resistance values; dynamics sanity (turn direction, heel to leeward, leeway to
  leeward, weather helm when heeled); boom crash vs controlled gybe; tack/gybe automation; in-irons
  drift; spinnaker curl/collapse; VPP polar plausibility; dynamic sim converges to the VPP speed;
  determinism; step cost (< 50 µs mean).
- **Flow solver:** thin-airfoil check (flat plate Cl ≈ 2πα, parabolic camber α0 ≈ −2f/c); two-element
  upwash/downwash sign.
- **Lessons engine:** progression with scripted snapshots.
- **Visual:** `scripts/snap.mjs` headless screenshots of every demo page and the app (compared against
  reference photos by eye at each milestone); browser-pane proof of the deployed site.
- **E2E smoke (CI):** the app boots headless (SwiftShader), draws non-black frames, no console errors,
  a lesson can be started.
- **Performance:** in-app frame-time overlay; manual check on the owner's-class hardware.

## 13. Delivery
Public repo `pibvbp/sailing-school` (MIT). README with screenshots, live link, controls, how the physics
works, credits. GitHub Actions: typecheck, unit tests, build, e2e smoke on every push/PR; Pages deploy
from `main` (Vite `base: '/sailing-school/'`). Small verified commits pushed at each milestone.

## 14. Risks and mitigations
- *Photoreal water within budget:* FFT on the GPU is cheap; the risk is the mesh + shading. Mitigation:
  LOD grid, tiers, governor; reuse proven code (§9.7).
- *Physics tuning drift:* calibration tests pin the ORC envelopes and polar targets; tuning happens in
  one place (`boatSpec` + coefficient tables).
- *Cloth that looks fake:* parametric shape + spring–damper follower + procedural excitation instead of
  a full cloth solver (controllable, stable, cheap); judge against reference photos.
- *Float render-target support (iOS):* fall back to half-float with scaled data; low tier drops to
  2 cascades.
- *Scope:* v1 list is fixed above; anything else goes to the backlog in the README.
