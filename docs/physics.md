# The sailing physics, explained

This page explains what the simulation in [`src/sim`](../src/sim) computes: why the boat moves, heels, slides and
turns the way it does. It is written for curious sailors and for developers. The maths is there for readers who want
it, but you can skip every formula and still follow the story.

The numbers come from the code ([`src/shared/boatSpec.ts`](../src/shared/boatSpec.ts) and `src/sim`), its tests,
and the polar table [`src/sim/data/polars.json`](../src/sim/data/polars.json). Where a number was measured by running
the simulation, for example the boat's speed close-hauled in 12 knots, the text says so. Those runs use steady wind,
the autopilot holding the angle and the crew trimming. If this page and the code ever disagree, the code is right, and
we'd be glad of an [issue](https://github.com/pibvbp/sailing-school/issues).

The simulation works in SI units: metres, seconds, newtons and radians. The app shows knots (1 kn = 0.514 m/s) and
degrees. Wind angles are signed: positive means the wind comes over the starboard (right-hand) side, which is called
starboard tack. The full frame and sign conventions are in [architecture.md](architecture.md#frames-and-sign-conventions).

**Contents**

1. [The boat](#1-the-boat)
2. [True wind and apparent wind](#2-true-wind-and-apparent-wind)
3. [Sails as wings](#3-sails-as-wings)
4. [How the simulation models the sails](#4-how-the-simulation-models-the-sails)
5. [Sail handling](#5-sail-handling)
6. [Hull, keel and rudder](#6-hull-keel-and-rudder)
7. [Heel and stability](#7-heel-and-stability)
8. [Helm balance and weather helm](#8-helm-balance-and-weather-helm)
9. [Equations of motion](#9-equations-of-motion)
10. [The crew and the autopilot](#10-the-crew-and-the-autopilot)
11. [Polars and VMG](#11-polars-and-vmg)
12. [Validation](#12-validation)
13. [Known limitations](#13-known-limitations)
14. [References](#14-references)

---

## 1. The boat

The **Kestrel 25** is a fictional 25 ft (7.6 m) keelboat, modelled on a typical modern day-racer. It has a fin keel, a
spade rudder, a mainsail with a traveler, a roller-furling jib with a whisker pole, and a symmetric spinnaker flown
from a pole.

| Item | Value |
|---|---|
| Length overall / on the waterline | 7.60 m / 6.40 m |
| Beam at the deck / at the waterline | 2.60 m / 2.20 m |
| Draft of the keel / of the hull alone | 1.45 m / 0.36 m |
| Mass | 1,640 kg (boat 1,400 kg + three crew, 240 kg) |
| Masthead | 10.2 m above the waterline |
| Mainsail / jib (about 105 %) / spinnaker | 14.6 m² / 13.8 m² / 32 m² |
| Keel | NACA 0012 fin, 0.90 m², chord 1.00 m at the root tapering to 0.65 m |
| Rudder | NACA 0012 spade, 0.34 m², ±35° |
| Stability | GM ≈ 0.95 m; the righting lever GZ peaks at 0.56 m at 60° of heel |
| Inertia, including the water carried along | roll 2,750 kg·m², yaw 9,000 kg·m² |

The physics and the 3-D model both read these numbers from `boatSpec.ts`, so the boat you see has the dimensions of
the boat that is simulated.

## 2. True wind and apparent wind

### True wind, and why it is weaker near the water

The **true wind** is the wind over the water: what you would feel standing on a moored buoy. The simulation describes
it by its speed at 10 m above the water (TWS, the height at which wind is normally quoted) and the direction it blows
from (TWD).

Friction with the sea slows the air near the surface, so the wind grows with height. The simulation uses the
logarithmic profile of the ORC VPP (the Offshore Racing Congress's velocity prediction program), with a roughness
length z₀ = 0.005 m for open water:

```math
V(h) = \text{TWS}\cdot\frac{\ln\left(\max(h,\ 0.3\ \text{m})/z_0\right)}{\ln\left(10\ \text{m}/z_0\right)}
```

| Height above the water | Share of the 10 m wind |
|---|---|
| 1 m | 70 % |
| 1.6 m (deck level, by the burgee at the stern) | 76 % |
| 2 m (the boom) | 79 % |
| 5 m (mid-mast) | 91 % |
| 10.2 m (masthead) | 100 % |

### Gusts, lulls and shifts

Real wind is never steady. The wind field ([`wind.ts`](../src/sim/wind.ts)) adds two kinds of change.

- **Puffs.** These are moving elliptical patches of stronger wind (gusts) or weaker wind (lulls). With a gustiness g
  between 0 and 1, the simulation keeps round(6g) of them in play around the boat, and 70 % of them are gusts.
  - A gust adds 15–45 % to the wind speed; a lull takes 10–30 % away. Both are scaled by (0.5 + 0.5g).
  - Gusts usually veer the wind a little (−6° to +14°); lulls shift it by up to ±8°.
  - Each patch has a radius of 40–120 m along the wind, scaled by (0.7 + 0.6g), and is 1.3–2 times as wide across it.
  - A patch lives for 90–240 s, fading in and out over 20 s, and drifts downwind at 0.9 times the wind speed.
  - Where patches overlap, their speed changes add up, but their direction changes are averaged.

  You can see puffs coming. The ocean draws a gust as a darker, rougher patch (a "cat's paw") and a lull as glassy
  water, and the wind streaks of the airflow overlay speed up inside a gust.
- **Shifts.** The wind direction swings back and forth. The amplitude A is up to 15° and the period T is 60–300 s in
  Free sail:

  ```math
  \text{TWD}(t) = \text{TWD}_0 + A\left(0.8\,\sin\left(\tfrac{2\pi t}{T} + \theta_1\right) + 0.2\,\sin\left(\tfrac{2\pi t}{2.9\,T} + \theta_2\right)\right)
  ```

Everything random comes from a seeded generator, so a scenario plays out the same way every time.

### Apparent wind

A moving boat makes its own wind. At 5 knots you feel a 5-knot breeze from dead ahead, even in a calm. The **apparent
wind** is the wind the sails and the crew actually feel. It is the true wind minus the boat's own velocity:

```math
\vec{A} = \vec{W}_{\text{true}} - \vec{V}_{\text{boat}}
```

The **wind triangle** overlay draws exactly this: the true wind (blue) plus the wind of the boat's motion (grey) makes
the apparent wind (amber).

Two consequences every sailor meets:

- **Speeding up moves the apparent wind forward.** Upwind, the apparent wind is also stronger than the true wind;
  downwind, it is weaker. In the simulation, close-hauled in 12 knots of true wind at 5.5 knots of boat speed, the
  masthead apparent wind is 16 knots at 26° off the bow. On a broad reach (true wind 150° off the bow) under
  spinnaker at 5.7 knots, it drops to 7.6 knots. (Measured.)
- **The apparent wind twists with height.** The boat's own wind is the same at every height, but the true wind is
  weaker near the water. So low down, the apparent wind comes from further ahead than at the masthead, and it is
  weaker. In the same 12-knot beat the difference between the masthead and deck level is about 3°; on a beam reach it
  is about 7° (measured). This is why sails are trimmed to **twist** open toward the top.

The simulation works out the apparent wind separately at every point that matters: each sail section, the windage
centre and the instruments. That includes the motion of the point itself as the boat rolls and yaws:

```math
\vec{V}_P = (u,\ v,\ 0) + \vec{\omega}\times\vec{x}_P,\qquad \vec{\omega} = (p,\ 0,\ r)
```

Here u and v are the boat's forward and sideways speeds, p and r its roll and yaw rates, and x_P the point's position
on the boat. The simulation then keeps only the part of the flow that lies in the plane of the rig. When the
boat heels, the wind across the boat is therefore reduced by cos φ (the ORC's "effective angle"), and the component
along the mast is ignored.

This also damps rolling: as the boat rolls, the mast sweeps through the air, and the sails push back against the
motion, just as on a real boat.

## 3. Sails as wings

A sail works like an aircraft wing stood on its end. Air flowing round the curved cloth speeds up on the leeward
(downwind) side and slows on the windward side. The pressure difference produces **lift**, a force at right angles to
the local flow. There is also **drag**, a force along the flow. Lift and drag add up to the sail's total force.

The **angle of attack** (α) is the angle between the sail's **chord** and the apparent wind. The chord is the straight
line from the **luff** (the front edge) to the **leech** (the back edge). The angle of attack decides almost
everything.

- **Luffing: α too small.** A soft sail cannot hold its shape when the wind meets it too head-on. The luff lifts and
  the cloth flaps. In the simulation, lift fades to zero over about 4° below a threshold of about 4–5° (for a mainsail
  with its deepest point near the middle; the threshold is lower when that point is further forward). Drag rises to
  that of flogging cloth.
- **The groove: α just right.** Between luffing and stall the flow stays attached on both sides, and lift grows
  steadily with α. For the mainsail at its base shape, the groove runs from about 4.5° to about 17°.
- **Stall: α too big.** The flow can no longer follow the leeward side and breaks away. Lift falls and drag climbs
  steeply: the sail stops being a wing and becomes a barn door.

These are the mainsail's coefficients from [`aero.ts`](../src/sim/aero.ts), for 11 % camber with its deepest point
48 % of the way back:

| α | 0° | 3° | 5° | 10° | 15° | 17° | 20° | 25° | 45° | 90° |
|---|---|---|---|---|---|---|---|---|---|---|
| Lift coefficient Cl | 0 | 0.41 | 0.73 | 1.02 | 1.32 | 1.44 | 1.46 | 1.21 | 0.95 | 0 |
| Drag coefficient Cd | 0.10 | 0.05 | 0.03 | 0.04 | 0.05 | 0.05 | 0.25 | 0.59 | 0.97 | 1.36 |

From 17° to 20° the lift barely changes but the drag grows fivefold. That is the stall.

The curves are built like this:

- **Attached flow.** Lift is Cl = CL_α (α − α₀).
  - α₀ = −1.15 × camber is the zero-lift angle: a curved sail still lifts at zero angle.
  - CL_α, the lift slope, is 3.4 per radian for the main and jib and 2.0 for the spinnaker.
  - Drag is Cd = Cd₀ + k_pp·Cl², with the ORC's profile-drag factors k_pp = 0.0138 (main), 0.016 (jib) and
    0.026 (spinnaker).
- **Stall.** It starts at α_stall = 0.21 + 0.8 × camber radians for the main (the jib's base value is 0.20), a little
  later when the draft is forward. Over 6° (for the main and jib) the flow blends into a separated-flow model: the air
  pushes on the cloth at right angles to the chord, with a normal-force coefficient Cn. Then Cl = Cn·cos α and
  Cd = Cn·sin α + Cd₀.
  - Cn is 1.34 for the main and 0.95 for the jib (0.90 by 90°).
  - The spinnaker's Cn peaks at 1.05 near 26° and falls to 0.64 at 90°, like a parachute.
- **No jumps.** Every transition is a smooth blend, so the force never jumps as α changes. A test checks that no
  coefficient moves by more than 0.04 per 0.1° anywhere from 0° to 180°. That matters for the dynamics: a jump in
  force would kick the boom and the boat.

A fuller (more cambered) sail makes more lift at the same angle and has a wider groove. Moving the draft forward
makes the entry more forgiving. Tests in `aero.test.ts` pin both.

### Flow from the leech side

Sometimes the apparent wind comes from further aft than the sail's chord, so α is more than 90°. This happens to a
main let far out on a run, or to a sail hit from behind. The air then reaches the leech first. The leech is a sharp
edge, so no attached flow can form.

The simulation works everything out from the angle to the chord line seen from behind, a′ = 180° − α. It uses the
normal force of a flat plate with separated flow (Lindenburg's fit):

```math
C_n = C_n(90^\circ)\,\frac{\sin a'}{0.56 + 0.44\,\sin a'}
```

As a′ shrinks to zero the sail is edge-on to a following wind, and it luffs again. This branch meets the forward one
smoothly at 90°. Dead downwind every sail is a drag sail: a test holds each sail's lift coefficient below 0.2 there.

## 4. How the simulation models the sails

### Strip theory

Each sail is cut into horizontal strips, called sections: 8 for the main, 8 for the jib and 6 for the spinnaker. Every
section:

- takes its chord, camber (depth as a fraction of the chord) and draft position from the current trim;
- sees its own apparent wind, at its own height and including the heel, roll and yaw;
- works out its own α and coefficients;
- produces lift at right angles to its flow, toward its belly, and drag along the flow.

The dynamic pressure is q = ½ρ|A|², with ρ = 1.225 kg/m³. The section's force acts 38 % of the way along its chord,
shifted to leeward by 0.75 of its depth. Adding up the sections gives each sail's total force, its centre of effort
(CE), and its moments, including the moment that swings the boom.

Because each strip sees its own wind, twist falls out of the model. A sail that is not twisted enough stalls near the
top, where the apparent wind comes from further aft. A sail that twists too much luffs there.

### Induced drag

A sail of finite height leaks air round its head and foot, which costs extra drag that grows with the square of the
lift. The simulation adds it once for the whole sail plan, following the ORC:

```math
D_i = \frac{L^2}{q\,\pi\,h_{\text{eff}}^2},\qquad h_{\text{eff}} = 1.1\;k_{h\text{eff}}(\text{AWA}) \times 10\ \text{m}
```

k_heff is the ORC's effective-span factor. It is 1.45 at an apparent wind angle of 20° and falls to 0.80 beyond 80°.
With the spinnaker up, h_eff is 10 m.

### Calibration against the ORC VPP

The coefficient curves were tuned so that the sails, at the best trim for each apparent wind angle, reproduce the ORC
VPP 2023 sail coefficients. These are the tables the ORC rating system uses to predict the speed of real boats.
The tests pin the result:

| Test | What must match | Tolerance |
|---|---|---|
| `orc-envelope.test.ts` | Main + jib lift at apparent wind angles of 15°, 20°, 27°, 40°, 60°, 90° and 120° | ±15 % |
| | Main + jib drag on a dead run, with the jib on the whisker pole | ±15 % |
| | Main + spinnaker lift at 60°, 75°, 90°, 110°, 130° and 150° | ±18 % |
| | Main + spinnaker drag on a dead run | ±15 % |
| `orc-per-sail.test.ts` | Each sail's own lift, wherever the ORC value is above 0.5: the main at 7°–28°, the jib at 15°–27°, the spinnaker at 41°–90° | ±15 %; the jib may be up to 30 % low at 15° and 20° (see [Known limitations](#13-known-limitations)) |
| | Dead downwind, every sail is a drag sail | abs(Cl) < 0.2 |

### Main and jib together: upwash, downwash and the slot

The two sails change each other's wind.

- **Upwash.** The main bends the air ahead of it, so the jib sees the wind from a little further aft:
  Δα_jib = +0.06 · Cl_main · A_main / A_total.
- **Downwash.** The jib bends the air behind it, so the main sees the wind from further ahead:
  Δα_main = −0.10 · Cl_jib · A_jib / A_total. The effect is 1.4 times stronger on the front 30 % of the main's chord,
  which sits right in the jib's outflow. The 1.4 comes from a potential-flow check with the project's own vortex-lattice
  solver, which puts the downwash at the main's luff at 1.3–1.4 times its average.

So the front of the main works at a smaller angle. If it drops below the luffing angle it is **backwinded**: that part
carries no lift and flogs, while the rest of the main still draws. This is the bubble you see at the main's luff when
the jib is over-trimmed, and in the simulation it costs force, not just looks. The shifts use the previous step's lift,
and they apply only when both sails are set on the same side (so not when sailing wing-on-wing).

The flow solver's tests show the pattern directly: the main induces upwash where the jib sits, and the jib induces
downwash at the main's luff, so the jib gains lift and the main loses a little. This is the real "slot effect". The
popular story that the gap between the sails acts as a venturi nozzle, speeding the air up to suck the main along, is
wrong; lesson 9 explains why.

### Blanketing

Downwind, a sail sitting in another sail's wind shadow gets less wind. The simulation reduces the dynamic pressure of a
jib or spinnaker that lies behind the main:

```math
q' = q\left(1 - 0.75\,s\,e^{-x^2}\right)
```

x is the sail's offset across the wind from the main's centre, in units of the main's projected half-width. s ramps
from 0 at an apparent wind angle of 110° to 1 at 165°. A sail right behind the main keeps only a quarter of its
dynamic pressure. That is why the jib hangs limp on a run. It is also why squaring the spinnaker pole back helps: it
moves the spinnaker out to windward, out of the shadow.

### Moving cloth meets the air

When the boom or the jib clew swings, the cloth moves through the air. The simulation subtracts each section's own
swing velocity from its airflow, which gives strong, realistic aerodynamic damping. The correction is capped at half of
the section's airflow, where the strip model would stop being valid.

### The spinnaker's shape

The symmetric spinnaker isn't trimmed to an angle. Its shape is solved from the geometry
([`spinnaker.ts`](../src/sim/sails/spinnaker.ts)).

- **The tack is the pole tip.** The pole angle runs from 0° (on the forestay) to 90° (squared back), and the tip from
  1.6 m to 3.4 m above the water. The pole is 2.9 m long.
- **The clew is held by the sheet and the leech.** It lies on a circle as wide as the foot (5.2 m) around the tack.
  The sheet runs from it to a block on the quarter: 14 m of sheet when fully eased, 2.8 m when fully trimmed. The
  length of the leech holds it too: the clew must stay within 9.2 m of the head. And the clew can't fly ahead of the
  tack's beam line.
- **The wind pushes the clew to leeward** until the sheet comes taut. So easing the sheet turns the sail toward the
  wind and lowers its angle of attack, and squaring the pole back rotates the whole sail to windward.

The usual trim rules follow from that.

- **The curl.** The spinnaker's luff begins to curl as the trim angle falls through about 16° (the model's α_curl):
  the curl grows from nothing at 19° to full at 14°. That is also where the spinnaker's force peaks, so the real-world
  rule, "ease until the luff just curls, then trim a touch", is the fast trim here too.
- **Collapse and refill.** Ease further and the luff folds in. If the trim angle stays below 9° for 0.6 s, the
  spinnaker **collapses**: its force drops to about a fifth and the cloth falls in. It refills once the angle has been
  back above 13° for 1 s.
- **Efficiency with wind angle.** Following the ORC tables, the spinnaker's lift builds from 55 % of its full value at
  an apparent wind angle of 35° to 100 % at 75°, then falls to 90 % by 110°.
- **Pole height.** A pole away from its best height costs efficiency. The best height rises with the apparent wind:
  from 2 m, by 0.08 m per m/s, to at most 3 m.
- **Gybing.** The pole goes end-for-end in 6 s, and the spinnaker gives 60 % of its lift in the meantime.
- **Hoist and douse.** Hoisting takes 6 s and dousing 5 s.

## 5. Sail handling

### The boom: a pendulum on a rope

The boom swings freely about the gooseneck. Together with the mainsail and the air it drags along, it has 90 kg·m² of
inertia. It is moved by:

- the sail's aerodynamic moment about the mast;
- gravity when the boat heels (26 kg, 1.6 m from the gooseneck), which swings it to the low side;
- air damping;
- the mainsheet.

The **mainsheet** is a rope, so it can only pull. It stops the boom going further out than the sheet allows, on either
side of the traveler car, but it never pushes the boom out. With the car at y_car across the boat, the sheet attached
3.1 m along the boom and the sheet setting s (0 eased, 1 trimmed), the boom can swing anywhere in:

```math
\beta \in [\beta_{\text{car}} - \Delta,\ \beta_{\text{car}} + \Delta],\qquad \beta_{\text{car}} = \arctan\frac{-y_{\text{car}}}{3.1\ \text{m}},\qquad \Delta = 85^\circ\,(1 - s)^{1.5}
```

The limits never go past 80° either side. Past a limit, a stiff, damped spring holds the boom, and the shrouds are a
hard stop at 82°. Let the sheet go and the boom weathervanes: the sail luffs.

The **traveler** slides the car across a 1.6 m track. It changes the boom's angle without changing how hard the
sheet pulls down on the leech.

### Ropes take time

The trim controls are targets, not positions. The crew hauls a sheet in at about 0.35 of its full range per second
and eases it at about 1 per second. The traveler car moves at 0.56 m/s to windward (hauling) and 1.6 m/s to leeward.
So nothing jumps, and the car never flips across when you tack; only its target changes side.

### Twist and sail shape

The **leech tension** comes from whichever pulls down harder: the vang, or the sheet when the boom sits against it.
With the tension T between 0 and 1, the head of the main twists off by:

```math
\tau = 2^\circ + 20^\circ\,(1 - T)^{1.3}
```

The twist grows with height as h^1.4, where h is the height fraction up the sail. It only exists while the sail is
loaded; the leech of a luffing sail just falls away.

The mainsail's base camber is 11 % and the jib's is 12 %. The other controls change the shape:

| Control | What it does in the simulation |
|---|---|
| Outhaul | Flattens the lower part of the main (up to 4 % less camber); fully eased, the foot gets up to 1.5 % deeper |
| Backstay | Bends the mast and flattens the upper main (up to 3 % less camber); tightens the forestay, flattening the jib (2 %) |
| Cunningham | Moves the main's deepest point forward, from 48 % to 40 % of the chord |
| Vang | Holds the boom down: less twist |
| Jib lead | Forward: a deeper foot and less twist. Aft: a flatter foot and a more open leech |

Deep sails give more power and a wider groove; flat sails give less heel and a narrower groove.

### Gybes, controlled and not

When the wind comes from behind, the boom can swing across the boat. The simulation calls it a **crash gybe** when the
boom crosses the centreline with the apparent wind more than 100° off the bow, and then either:

- slams into the sheet or the shrouds faster than 1.5 rad/s; or
- swings from 40° out on one side to 40° out on the other within 2 s (in 6 knots of wind or more).

A tack or gybe run by the crew never counts, and nor does a boom held out by hand.

Sailing **by the lee**, with the wind coming over the same side as the boom, makes the boom want to gybe. Once the
wind is 12–22° by the lee, the simulation adds a gybing moment. It stands in for the flow reversing over the leech,
which a strip model alone would miss.

The whole rig decides which side it is set on with some hysteresis:

- head to wind, it changes side once the wind is more than 3° across the bow;
- dead downwind, it changes only when the wind is clearly on the new side (the apparent wind less than 165° off the
  bow), when the boom actually gybes across, or when the crew gybes the rig.

So the wind wobbling across the stern doesn't flip the sails back and forth.

### The jib clew and its two sheets

The jib's clew swings about the forestay with 6 kg·m² of inertia. Each jib sheet runs from the clew to a lead on its
own side of the boat. The lead slides fore and aft, which sets the **sheeting angle**: about 10° with the lead right
aft, 11.5° with it right forward.

- A trimmed sheet pins the clew near the sheeting angle. Eased, it lets the clew swing out by at most
  29° × (1 − s)^1.3 beyond it.
- The other sheet, on the windward side, is slack.
- When the bow passes through the wind in a tack, the crew releases the old sheet and hauls in the new one over about
  2.5 s. The jib flogs in between.
- The clew can never swing more than 95° either way.

There are three ways to hold the clew out by other means.

- **Backing the jib.** The crew holds the clew 15° out on the windward side, whatever the sheets say. The wind then
  pushes the bow away from that side. It's the classic way out of irons.
- **The whisker pole.** It holds the jib's clew 80° out on the side opposite the boom (wing-on-wing), square to a
  following wind. The clew is carried onto the pole at 40°/s, which takes 2–3 s. The pole moves across only when the
  rig gybes.
- **Furling.** Rolling the jib away reduces its area and lowers its clew; a fully furled jib carries no force. A full
  roll takes about 3.3 s.

### Pushing the boom

When the boat is stuck head to wind (**in irons**), you can back the mainsail too. A crew member pushes the boom out by
hand toward 70°, with the force one person can manage: about 300 N at the boom end. They can never push it past the
mainsheet, so the sheet must be eased first.

Head to wind with the boom held out to port, the wind presses on the back of the mainsail. The boat gathers sternway
and the bow swings to port, so you sail away on starboard tack. Held to starboard, you sail away on port tack. The
tests check both sides.

## 6. Hull, keel and rudder

### Resistance

The hull's resistance ([`hydro.ts`](../src/sim/hydro.ts)) has two parts.

- **Friction** of the water on the 11.0 m² of wetted skin. It uses the ORC friction line with a 5 % form factor:

  ```math
  R_f = \tfrac12 \rho V^2 S\,C_f \cdot 1.05,\qquad C_f = \frac{0.066}{\left(\log_{10}\text{Re} - 2.03\right)^2},\qquad \text{Re} = \frac{0.85\,L_{WL}\,V}{\nu}
  ```

- **Residuary resistance**, mostly the energy that goes into making waves. It comes from a table against the Froude
  number, Fn = V/√(g·L_WL), tuned by the polar tests. It is gentle at low speed and rises into a steep wall from Fn 0.4.
  That is about 6.2 knots for this 6.4 m waterline: the "hull speed" of a displacement boat. This model never planes
  past it.

Heel adds 0.8 × sin²φ of the total, because a heeled hull is a less efficient shape, and going astern costs 1.5 times
as much. The resistance acts along the boat's centreline; sideways drift is handled by the cross-flow model below.

| Boat speed | 4 kn | 5 kn | 6 kn | 7 kn | 8 kn |
|---|---|---|---|---|---|
| Resistance, upright | 102 N | 187 N | 370 N | 710 N | 1,065 N |

Going from 6 to 7 knots nearly doubles the resistance. That is the wave wall.

### Keel and rudder: wings under water

A sailing boat can go upwind because its keel is a wing too. The sails push the boat sideways, so the boat slides a
little: that sideways slip is called **leeway**, and it is a few degrees. The water then meets the keel at an angle of
attack, and the keel makes lift that balances the sails' side force. Close-hauled in 12 knots, the simulated boat
makes about 3.3° of leeway (measured; the tests accept 2–6°).

The simulation treats the keel and the rudder as foils. Each is evaluated at its centre of pressure, with the local
water flow there, including the boat's yaw and roll rates. That gives natural damping and weathercocking.

- **Attached lift.** Cl = CL_α·α, with Helmbold's lift slope for a short wing, CL_α = 2π·AR/(AR + 2).
  - The keel's effective aspect ratio is 2.85, because the hull acts as an end plate. That gives 3.7 per radian.
  - The keel's area counts the lift of the hull under it: 0.90 m² × 1.25.
  - The rudder's aspect ratio is 4.5, giving 4.35 per radian.
- **Stall at any angle.** The keel stalls at 14° and the rudder at 22°. Over 6° they blend into a flat plate's normal
  force (Cn = 1.2 at 90°), so both foils work at any angle through 360°. Going backwards they stall earlier, at 8°,
  and the rudder's force reverses: you steer the other way in sternway.
- **Drag.** Skin friction with a thickness form factor, a small lift-dependent profile drag, and induced drag,
  Cl²/(π·AR·0.9).

### The rudder's limits

The rudder turns at up to 60°/s, to at most ±35°.

- **Keel downwash.** Moving forward, the rudder sits in the keel's downwash: the keel has already turned the water
  back toward the centreline, so the rudder sees less of the leeway. The simulation uses half the ideal downwash of a
  finite wing, at most 0.15 rad. Going astern, the rudder is upstream of the keel and sees none.
- **Heel.** The rudder loses grip as the boat heels. It tilts with the hull, and from 30° to 50° of heel it ventilates
  (draws air down from the surface), losing up to 60 % of its force. That is how an over-pressed boat **rounds up**.

### Sideways drift and windage

- **Cross-flow drag.** The hull is split into 10 stations along its waterline. Each resists sideways motion with a
  drag coefficient of 1.0, on 2.0 m² of lateral area in total. This governs slow sideways drift and pivoting.
- **Windage.** The hull, mast, rigging and crew catch the wind too: 2.6 m² of drag area head-on and 5.0 m² beam-on,
  acting 2.5 m above the water. It's why a boat stopped head to wind drifts backwards (a test checks it).

## 7. Heel and stability

The sails push sideways high up, and the keel pushes back low down. Together they make a **heeling moment** that tips
the boat over until the **righting moment** balances it.

- **The hull.** The boat's weight acts down through its centre of gravity (G). Buoyancy acts up through the centre of
  buoyancy (B), which moves to leeward as the boat heels. The horizontal distance between them is the righting lever,
  GZ. The righting moment is Δ·g·GZ(φ), from the boat's GZ table (GM ≈ 0.95 m; GZ rises to 0.56 m at 60° and falls
  to zero near 126°).
- **The crew.** Three people (240 kg) on the windward rail add m·g·y·cos φ: up to about 2.5 kN·m with them 1.05 m
  out.

| Heel | 10° | 20° | 30° | 60° |
|---|---|---|---|---|
| Righting moment of the hull | 2.6 kN·m | 5.0 kN·m | 6.8 kN·m | 9.0 kN·m |

An example (measured): close-hauled in 12 knots, the sails and appendages heel the boat with about 6.6 kN·m. It settles
at 16.6° of heel, where the hull provides 4.2 kN·m and the hiking crew 2.4 kN·m.

**The crew hike automatically** unless you place them by hand in the Trim panel. They:

- hike out to windward as the heel to leeward builds from 3° to 12°;
- sit in the middle when the boat isn't heeled to leeward;
- sit a little to leeward in light air (about 1–6 knots), to help the sails set;
- downwind, move to counter whatever heel there is.

They take about a second to move, as a first-order lag.

**Depowering.** As the wind builds, heel costs speed: heel drag, more leeway, more weather helm and eventually a
round-up. You reduce the heeling force by:

- dropping the traveler to leeward;
- easing the mainsheet or the vang, so the top of the sail twists open;
- flattening the sails with the outhaul, backstay and cunningham;
- hiking.

The crew's auto-trim starts depowering the main as the heel passes about 18–20°. Roll is damped, and the model caps
heel at 85°.

## 8. Helm balance and weather helm

A well-balanced keelboat wants to turn a little toward the wind when it heels. That is **weather helm**: the helmsman
holds a few degrees of rudder to keep the boat straight. In the simulation it comes from several effects together:

- the sails' centre of effort against the keel's centre of pressure;
- the **Munk moment**. A slender hull moving at a drift angle is turned further across the flow, so a hull sliding to
  leeward swings its bow to windward. The simulation applies 60 % of the ideal value, (m_y − m_x)·u·v, allowing for the
  flow separating at the stern;
- the **heeled hull's asymmetry**. Its immersed shape is lopsided and turns the bow toward the wind, growing with sin²φ;
- the keel's **downwash** at the rudder;
- the rudder's loss of grip at big heel angles.

The tests pin the outcome. Close-hauled in 12 knots the boat carries weather helm; on a beam reach it is nearly
balanced (less than 8° of rudder); over-pressed with the spinnaker in 25 knots, it broaches. Measured, the helm the
autopilot holds close-hauled is about 1° in 12 knots and 4° in 20 knots.

The simulation reports a **round-up** when the boat heels more than 25° and the bow swings toward the wind faster than
8°/s while the rudder is not steering it there (less than 5° of rudder toward the wind). At that point the helmsman
has lost control.

## 9. Equations of motion

The boat's state is its position (e, n), heading ψ, forward and sideways speeds u and v, yaw rate r, heel φ and roll
rate p. The boom, jib clew, spinnaker, rudder and crew have states of their own.

Every step, the simulation ([`simulation.ts`](../src/sim/simulation.ts)):

1. computes every force at its real 3-D point in the heeled boat frame: the sails section by section, the windage,
   the keel and the rudder;
2. takes their moments about the centre of gravity;
3. rotates the totals into the level heading frame;
4. integrates:

```math
\begin{aligned}
(m + m_x)\,\dot u - (m + m_y)\,v\,r &= X \\
(m + m_y)\,\dot v + (m + m_x)\,u\,r &= Y \\
I_z\,\dot r &= N \\
I_x\,\dot p &= K
\end{aligned}
```

The terms are:

- m = 1,640 kg. The added masses, m_x = 0.05·m going forward (surge) and m_y = 0.8·m going sideways (sway), are the
  water the hull and keel carry along with them: a little going forward, a lot going sideways.
- I_z = 9,000 kg·m² and I_x = 2,750 kg·m², both including the water carried along.
- X is the forward force: the sails' drive, minus the resistance of the hull and the drag of the keel, rudder and
  windage.
- Y is the sideways force: the sails, keel, rudder and windage, plus the hull's cross-flow drag.
- N is the yaw moment: sails, keel, rudder, cross-flow, hull asymmetry, the Munk moment and yaw damping.
- K is the roll moment: heeling, righting, crew and roll damping.

**Integration.** The simulation uses semi-implicit Euler at a fixed time step of 1/120 s: first the velocities, then
the positions from the new velocities. Given the same scenario and seed, the result is identical every time (a test
checks this).

**The fixed step in the app.** The app runs the physics in exact 1/120 s steps however fast the screen refreshes:
two steps per frame at 60 frames per second. At most 12 steps run in one frame, and slow motion (0.25× to 2×) only
changes how many steps run. The picture interpolates between the last two states. The budget for one step is 50 µs in
the most expensive setup (spinnaker up, crew working, gusty wind), and `pnpm test:perf` checks it.

**Heave and pitch** are not part of the physics. The renderer adds heave, pitch and some roll from the waves it draws,
for looks.

**Defence in depth.** If a step ever produced a number that isn't finite, it would be undone: the previous state is
restored, the rotation rates are zeroed, and the fault is counted. The physics is meant to keep that count at zero,
and a 10-minute test of random control abuse checks that it does.

## 10. The crew and the autopilot

The crew lives in [`autocrew.ts`](../src/sim/autocrew.ts) and the autopilot in [`autopilot.ts`](../src/sim/autopilot.ts).

### Autopilot

The helm is manual, where you steer with the tiller, or an autopilot that holds a compass heading, a true wind angle
(TWA) or an apparent wind angle (AWA). The autopilot is a PID controller on the rudder.

- Its proportional and derivative gains scale with 1/V², within bounds, because rudder force grows with speed squared.
- Its integral term trims out weather helm. It is kept as a rudder angle, so it can hold the angle at any speed, and it
  only integrates within 15° of the target.

### Auto-trim

Each sail has an **Auto** switch. With it on, the crew trims the way a good trimmer reads the telltales: from the
sail's measured angle of attack.

- **Main.** Upwind, 85 % of the way from luffing to stall: about 15° for the base shape. Off the wind, just below the
  stall. Past 18–20° of heel it eases toward the luffing edge and drops the traveler. It also sets the vang, outhaul,
  backstay and cunningham for the wind strength; upwind it flattens the main as the wind rises from 14 to 22 knots.
- **Jib.** 75 % of the way from luffing to stall. The lead goes forward upwind and aft when reaching or depowering.
- **Spinnaker.** The pole square to the apparent wind (a pole angle of about the apparent wind angle minus 90°), and
  the sheet just above the curl.

The crew smooths its readings over about a second: a trimmer doesn't chase every flicker. There are a few rules for
sharing the work with you.

- Touching one of a sail's controls takes that sail off auto-trim.
- Jib auto-trim pauses while the jib is backed or poled out, and main auto-trim pauses while someone holds the boom
  out.
- With the jib on auto, the crew rolls the jib away when the spinnaker goes up and unrolls it for the drop.

### Tacks and gybes (T and G)

**Tack.** The crew refuses if you are more than 80° off the wind or slower than 1 m/s (about 1.9 knots). Otherwise it:

1. steers through the wind with 22° of rudder;
2. centres the traveler and leaves the mainsheet alone while the bow swings;
3. releases the old jib sheet and hauls in the new one;
4. settles on the mirrored angle to the wind (at least 38°).

**Gybe.** The crew refuses if you are closer than 100° to the wind. Otherwise it:

1. bears away to 176°;
2. hauls the main in as the stern comes to 166°–174° (hauled in on a broad reach, it would lay the boat over);
3. turns through with a little rudder;
4. gybes the rig: jib across, traveler over, and the spinnaker pole end-for-end if it is flying;
5. lets the main run back out and settles on the mirrored angle.

The same routines drive the lessons' **Show me** demonstrations.

You can keep steering during either manoeuvre. Moving the tiller further over (by more than 20 % of its travel) or
changing the helm mode hands you the helm at once, and the crew carries on with the sheets. Every phase has a
timeout (15 s to turn or to cross the wind, 10 s to settle), after which the crew hands everything back.

### Events

The simulation detects situations worth a hint and reports them as events. The app turns them into toasts, and the
lessons into hints.

| Event | When it fires |
|---|---|
| Crash gybe | The boom crashes across; see [Gybes, controlled and not](#gybes-controlled-and-not) |
| In irons | Within 30° of the wind and slower than 0.5 knots for 3 s |
| Round-up | More than 25° of heel, the bow swinging toward the wind faster than 8°/s, and less than 5° of rudder toward the wind |
| Luffing | The sails luffing hard for 2 s with the wind more than 40° off the bow |
| Backwinded | A bubble at the main's luff while its leech still draws, with the jib set, more than 30° off the wind |
| Spinnaker collapse / refill | See [The spinnaker's shape](#the-spinnakers-shape) |
| Tack / gybe complete | The end of a manoeuvre run by the crew |

## 11. Polars and VMG

You can't sail straight into the wind, so the real question upwind is which angle gets you there fastest. Pointing
higher is more direct but slower through the water; bearing away is faster but less direct. **VMG** (velocity made
good) measures the useful part: boat speed × cos(TWA), your speed toward the wind or away from it. The best compromise
is the optimum VMG angle. Downwind is similar: running dead downwind is often slower than broad reaching and gybing.

A **polar diagram** plots the boat's target speed against the true wind angle, one curve per wind speed.

In this project the polar isn't a separate model: it is the steady state of the same simulation.
[`scripts/polars.ts`](../scripts/polars.ts) sails the simulated boat at every combination of:

- true wind speeds of 4, 6, 8, 10, 12, 14, 16, 20 and 25 knots;
- true wind angles from 30° to 180° in 5° steps.

Each run has the autopilot holding the angle, the crew trimming and the wind steady. It counts as settled when the
speed changes by less than 0.2 % per second for 5 s, with the boat within 1° of the angle. A run that hasn't settled
is retried for longer, then averaged and flagged in the table. From 80° off the wind, and up to 20 knots of wind, each
point is sailed with both the jib and the spinnaker and the faster one is kept. The best VMG angles are refined between
the grid angles with a parabola.

The result, [`polars.json`](../src/sim/data/polars.json), gives the app its target speeds, the polar chart, the
laylines and several lesson targets. A test checks that the table still matches the live physics within 3 %;
regenerate it with `pnpm polars` whenever you change the model.

| True wind | Best upwind: angle, speed, VMG | Beam reach (90°) | Best downwind: angle, speed, VMG |
|---|---|---|---|
| 6 kn | 43°, 3.6 kn, 2.6 kn | 4.3 kn (spinnaker) | 145°, 3.4 kn, 2.8 kn |
| 12 kn | 37.5°, 5.3 kn, 4.2 kn | 6.7 kn (spinnaker) | 155°, 5.4 kn, 5.0 kn |
| 20 kn | 37°, 5.4 kn, 4.4 kn | 8.6 kn (jib) | 160°, 7.2 kn, 6.8 kn |
| 25 kn (no spinnaker) | 38°, 5.3 kn, 4.2 kn | 9.2 kn | 174°, 7.3 kn, 7.2 kn |

The fastest point in the table is 10.0 knots, at 120° in 20 knots of wind under spinnaker. A few patterns show up:

- **Upwind, more wind soon stops helping.** Above about 14 knots the boat is heeled and depowered, and the best VMG
  hardly grows: 4.3 knots at 14 knots of wind, 4.4 at 16 and 20, and 4.2 at 25.
- **In light air it pays to gybe downwind.** In 6 knots the best downwind VMG is on a broad reach, about 145°. As the
  wind builds the best angle moves deeper, to 160° in 20 knots.

## 12. Validation

Everything below runs in `pnpm test`: Node, no browser. The tests live next to the code in `__tests__` folders.

| Behaviour | Pinned by |
|---|---|
| Wind: the log profile, puffs, shifts, overlapping puffs, determinism | [`wind.test.ts`](../src/sim/__tests__/wind.test.ts) |
| Apparent wind: geometry and signs, heel reducing the cross-flow by cos φ, roll and yaw rates | [`apparent.test.ts`](../src/sim/__tests__/apparent.test.ts) |
| Sail coefficients: continuity over 0°–180°, luffing, the lift slope in the groove, stall, reversed flow, camber and draft, k_heff, induced drag | [`aero.test.ts`](../src/sim/__tests__/aero.test.ts) |
| The ORC envelopes and each sail's own coefficients | [`orc-envelope.test.ts`](../src/sim/__tests__/orc-envelope.test.ts), [`orc-per-sail.test.ts`](../src/sim/__tests__/orc-per-sail.test.ts) |
| Sail mechanics: sheet limits, traveler, gravity, twist, crash and controlled gybes, backing, furling, the whisker pole, pushing the boom, rope speeds, hard stops, spinnaker hoist, curl, collapse and refill, blanketing | [`sails.test.ts`](../src/sim/__tests__/sails.test.ts) |
| Hull and foils: the ORC friction line, the hull-speed wall, heel drag, keel and rudder lift, stall and sternway, cross-flow, windage, the righting moment | [`hydro.test.ts`](../src/sim/__tests__/hydro.test.ts) |
| The whole boat: speed and balance on a beam reach, heel (10–25°), leeway (2–6°) and weather helm close-hauled, the tiller's sign, drifting backwards in irons, broaching in 25 knots, crew weight, determinism, the cost of a step | [`simulation.test.ts`](../src/sim/__tests__/simulation.test.ts) |
| Crew and autopilot: holding an angle, tacks and gybes (also in 18–25 knots), the learner taking the helm, getting out of irons, furling on hoist and douse, crash-gybe events | [`autocrew.test.ts`](../src/sim/__tests__/autocrew.test.ts), [`autopilot.test.ts`](../src/sim/__tests__/autopilot.test.ts), [`events.test.ts`](../src/sim/__tests__/events.test.ts) |
| No blow-ups: the whisker pole on a dead run, 10 minutes of random control abuse, the finite-state guard, the sails holding their side dead downwind | [`robustness.test.ts`](../src/sim/__tests__/robustness.test.ts) |
| Steady-state speeds in the plausibility bands, the cost of pinching, broad reaching beating a dead run in light air, the polar table in step with the physics | [`vpp.test.ts`](../src/sim/__tests__/vpp.test.ts) |
| The flow solver: thin-airfoil theory for a flat plate and a cambered one, upwash and downwash between two sails, independent reference solutions | [`src/flow/__tests__`](../src/flow/__tests__) |
| Every lesson is playable in the real simulation | [`src/lessons/__tests__`](../src/lessons/__tests__) |

### Plausibility bands

[`vpp.test.ts`](../src/sim/__tests__/vpp.test.ts) sails the boat to steady state and checks its speeds against bands
drawn from boats of the J/24 class. The light-air bands are set lower, because a boat running deep in light air has
almost no apparent wind. The test also requires the best upwind angle to lie between 34° and 48°, and the VMG at 30°
to be worse than at the optimum.

| True wind | Best upwind speed | Beam reach (90°) | Broad reach (150°) |
|---|---|---|---|
| 6 kn | 3.2–4.6 kn (polar: 3.6) | 3.8–5.2 kn (4.3) | 2.9–4.4 kn (3.2) |
| 12 kn | 4.9–6.0 kn (5.3) | 6.0–7.2 kn (6.7) | 5.2–6.8 kn (5.7) |
| 20 kn | 5.0–6.3 kn (5.4) | 7.0–8.6 kn (8.55) | 7.0–8.8 kn (7.8) |

## 13. Known limitations

The simulation is a real model, but a simple one in places. Here is where it falls short of a real boat.

- **Flat water, so a narrow no-go zone.** The physics has no waves: the boat always sails on flat water. Real boats
  lose a lot of speed when they sail too close to the wind (pinch) in a seaway, because waves stop a boat that has lost
  power. The simulated boat, whose sails follow the ORC coefficients, loses surprisingly little. Measured in 12 knots,
  the VMG at 30° off the wind is still 96 % of the best, at 25° it is 84 %, and the boat still makes 2.7 knots at 20°.
  So the no-go zone is narrower than a typical 25-footer's. The test only asks that pinching costs VMG (at 30° less
  than 97 % of the best, at 25° less than 87 %, under 3 knots at 20°); no artificial penalty was added to make it worse.
- **Waves are for looks.** Heave and pitch aren't simulated. The renderer moves the boat on the waves it draws, but
  the physics doesn't feel them: no added resistance, no surfing, and no broaches caused by waves.
- **The flow pictures are partly solved, partly modelled.**
  - Only attached flow is solved: a 2-D vortex lattice per horizontal slice, with its strength scaled to match the force
    model.
  - Separated flow is modelled, not solved: stalled sections, sails eased on a run and the spinnaker downwind get a
    bluff-body picture and a wake model.
  - The slices are 2-D, so there are no tip vortices or other 3-D flow in the picture.
  - Near the sails, the streamlines bend up to 2–3 times more than the force model implies. The particles follow the
    unscaled solution so that they never cut through the cloth.
  - The forces don't come from these pictures at all; they come from the strip model.
- **The crew is simplified.** The three crew are one mass that slides across the boat; they never move fore and aft.
  Their trimming follows simple rules based on each sail's angle of attack. The polars are sailed by this crew, so they
  reflect its habits rather than a mathematical optimum.
- **The jib is weak at very small wind angles.** At apparent wind angles of 15–20° the jib makes up to 30 % less lift
  than the ORC's generic table. The Kestrel's jib can't be sheeted closer than about 11°, so it sits at its luffing edge
  there.
- **The spinnaker is weak dead downwind.** At 170° off the wind in 12 knots, the main blankets about half of the
  spinnaker, so the spinnaker drives less than the main. The boat is still faster with it up, and by 160° the
  spinnaker drives more than the main.
- **Light air downwind is slow.** Running deep in light air the apparent wind nearly vanishes: about 3.6 knots at the
  masthead at 150° off the wind in 6 knots. The polar sits at the low end of the plausibility bands there, and some real
  boats of this size are faster.
- **No spinnaker above 20 knots in the polar.** A prudent crew takes it down, so the 25-knot row is main and jib only
  and understates what a brave crew could do downwind. You can still hoist it in Free sail.
- **Keel and rudder at one point each.** Each foil is evaluated at a single centre of pressure, not in strips, and
  rudder ventilation is a simple function of heel.
- **No capsize.** Heel is capped at 85°.
- **Not in this version:** currents and tides, reefing, an asymmetric spinnaker and other boats.

## 14. References

- Offshore Racing Congress, *ORC VPP Documentation 2023*. The source of the wind profile, the friction line, the sail
  coefficient tables and the effective-span curve.
- J. Katz and A. Plotkin, *Low-Speed Aerodynamics*. The lumped-vortex (discrete vortex) method used by `src/flow`.
- Lindenburg's fit for the normal force on a flat plate in separated flow, used for reversed flow.
- Helmbold's lift-slope formula for wings of low aspect ratio, used for the keel and rudder.
- The Munk moment on a slender body at an angle of drift.
