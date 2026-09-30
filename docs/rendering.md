# How the visuals are made

Everything on screen is drawn with three.js r186 on WebGL 2, and nothing is loaded from image files: every texture
is generated in code when the app starts. This page describes each part briefly and points at the code. The
conventions for frames and signs are in [architecture.md](architecture.md#frames-and-sign-conventions).

- [The pipeline](#the-pipeline)
- [The ocean](#the-ocean)
- [Sky, sun and light](#sky-sun-and-light)
- [The boat](#the-boat)
- [Sails, telltales, windex and burgee](#sails-telltales-windex-and-burgee)
- [Post-processing](#post-processing)
- [The overlays](#the-overlays)
- [Performance budgets](#performance-budgets)
- [Module demos](#module-demos)

## The pipeline

- **Renderer** ([`src/render/core/renderer.ts`](../src/render/core/renderer.ts)). A WebGL 2 context with the
  browser's anti-aliasing off (the post chain does it), sRGB output and PCF sun shadows. If WebGL 2 isn't available,
  the app shows a message instead ([`src/main.ts`](../src/main.ts)).
- **High dynamic range.** The scene renders into a half-float buffer, and the post chain tone-maps it. If the GPU
  can't render to half-float targets, the post chain falls back to drawing straight to the screen with the renderer's
  own tone mapping.
- **One sun.** A single directional light casts the shadows
  ([`lighting.ts`](../src/render/env/lighting.ts)). Its shadow box is fitted tightly around the boat and moved in
  whole shadow-map texels, so shadow edges don't crawl as the boat sails. The softness is matched to the sun's 0.53°
  disc: the sails and boom, a few metres above the deck, cast shadows with edges about 3 cm soft.
- **Ambient light** is an environment map baked from the sky with three's `PMREMGenerator`, re-baked when the sun
  moves.

## The ocean

The ocean ([`src/render/env/ocean/`](../src/render/env/ocean)) builds on two MIT-licensed projects:

- **ABYSSAL** by Davi ([Token-Gremlin/natural-disasters](https://github.com/Token-Gremlin/natural-disasters)): the
  FFT cascades, the spectrum and butterfly passes, the projected grid, cascade sampling, foam accumulation, water
  shading and the procedural foam and ripple textures.
- **wave-riders** ([developmentation/wave-riders](https://github.com/developmentation/wave-riders)), a fork of ABYSSAL:
  the height sampler, the Kelvin wake ribbon and the bow spray.

Each adapted file keeps its copyright header, and the full licences are in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

**Sea state.** The waves come from a fetch-limited JONSWAP spectrum, driven by the mean wind speed and direction over
15 km of open water. That spectrum ([`spectrum.ts`](../src/render/env/ocean/spectrum.ts)) is the standard description
of a wind sea that is still growing. A long swell is added: 0.3 m high with a 9 s period, arriving 30° clockwise of the
wind. The sea follows the wind settings, so there is no separate wave control.

**FFT on the GPU** ([`fft.ts`](../src/render/env/ocean/fft.ts), [`cascades.ts`](../src/render/env/ocean/cascades.ts)).
The surface is the sum of three tiles of about 250 m, 37 m and 7 m, computed with Tessendorf's inverse-FFT method.
The tile sizes don't divide into one another, so the tiles never line up. Some details:

- Each tile is 256 × 256 on the Ultra and High tiers. Medium and Low use two tiles at 128 × 128.
- All the tiles are packed side by side, so each FFT stage is one GPU pass for all of them.
- Horizontal "choppy" displacement sharpens the crests.
- The wave frequencies are rounded so that the sea repeats exactly every 20 minutes, which keeps every wave's phase
  precise in 32-bit floats however long you sail.
- A smooth, static warp of the lookup coordinates hides any repeat of the 250 m tile.

**The surface** ([`oceanMesh.ts`](../src/render/env/ocean/oceanMesh.ts),
[`shaders/surface.glsl.ts`](../src/render/env/ocean/shaders/surface.glsl.ts)) is a projected grid: every vertex is a
ray from the camera, intersected with the curved sea. So the triangles are evenly spread in screen space and the mesh
ends exactly on the horizon. The shading combines:

- sky reflection with a Fresnel term, from a baked map of the sky;
- the sun's glitter, as a GGX highlight;
- Cox–Munk roughness for the ripples too small for the mesh;
- light scattering through the wave crests;
- haze toward the horizon;
- on High and Ultra, a planar reflection of the boat and marks, distorted by the waves. The teaching overlays are kept
  out of it.

**Wind on the water.**

- **Whitecaps** are keyed to the wind: none below about 10.5 knots, the first scattered caps at 12–14 knots, plenty by
  20 knots. Foam comes from the steepest crests of each tile and lingers as it decays.
- **Gusts and lulls.** The simulation's gust patches make the water darker and matte, like a cat's paw; lulls turn it
  glassy and silvery. So you can see a gust coming.

**The boat's own water.**

- **Hull waves.** The bow wave heaped at the stem, the trough amidships and the stern wave are computed around the hull
  and grow with speed.
- **The wake.** A world-space texture that scrolls with the boat holds the churned water, bubbles and the long glassy
  slick behind it ([`wake.ts`](../src/render/env/ocean/wake.ts)).
- **The Kelvin wake.** A ribbon of past stern positions draws its 19.47° wedge of transverse and diverging waves, with
  foam on the cusps as the boat nears hull speed.
- **Bow spray** ([`spray.ts`](../src/render/env/ocean/spray.ts)) flies when the drawn waves bury the bow.

**Heights on the CPU** ([`sampler.ts`](../src/render/env/ocean/sampler.ts)). The boat's heave, pitch and roll on the
waves, the bobbing marks and the camera's clearance all need the sea's height. A probe pass renders height and slope
with the surface's own displacement code into:

- a fine 40 m grid around the boat;
- a coarse 1.6 km grid;
- 5 × 5 patches around each mark and the camera.

The result is read back asynchronously (`readRenderTargetPixelsAsync`), so it is one frame late but never stalls the
GPU. The boat and the marks ride the waves that are drawn; the boat ignores the waves it makes itself.

**X-ray** turns the water around the boat see-through, to show the keel, rudder, leeway and underwater forces.

## Sky, sun and light

- **Sky** ([`sky.ts`](../src/render/env/sky.ts), [`clouds.ts`](../src/render/env/clouds.ts)). The sky is three's
  `Sky.js`, a Preetham daylight model with a cloud layer, patched in a few ways:
  - the clouds drift with the wind aloft, which is veered and stronger than the surface wind;
  - they are lit by sunlight that has crossed the atmosphere;
  - they have bright sun-facing edges and grey bases;
  - the sunlight dims when a cloud crosses the sun.
- **Sun position** comes from the local solar time at a mid-latitude site (45°) in late summer: 17:00 puts the sun
  24° up (the default), 13:00 62°, and 18:30 9°. The time slider runs from 05:00 to 21:00.
- **One set of numbers.** A CPU copy of the same Preetham terms gives the sun's colour, the horizon and fog colours,
  and the exposure. So the boat, sails, sea and haze are lit with numbers that match the sky pixels behind them.
- **Exposure** is metered from the sky model, part incident light and part a reading of the view, and adapts
  smoothly.
- **Distant land** ([`land.ts`](../src/render/env/land.ts)). Low islands and a headland 2–6 km away give you a heading
  reference. Their colour fades toward the sky just above the horizon in the same direction, so a hazy island melts
  into the sky behind it. A lighthouse flashes two white flashes every 10 s once the sun is low.
- **Race marks** ([`marks.ts`](../src/render/env/marks.ts)) are inflatable buoys about 1.5 m tall: an orange windward
  cylinder, a yellow leeward cylinder and orange start pyramids. They rock on the sampled waves.

## The boat

The Kestrel 25 ([`src/render/boat/`](../src/render/boat)) is built in code from the same `boatSpec.ts` numbers the
physics uses.

- **The hull** ([`hull.ts`](../src/render/boat/hull.ts)) is lofted from design curves: profile, sheer and deck line,
  with sections that run from a fine bow to firm bilges and a flat run aft. The firmness of the bilge is solved so that
  the waterline beam comes out at exactly 2.20 m, and a unit test measures the waterplane.
- **Everything else**: the cambered deck with non-skid panels; the cabin trunk with smoked windows and hatches; the
  cockpit with its open transom; a NACA 0012 fin keel and spade rudder; a tapered mast with spreaders, 1×19 standing
  rigging, a roller-furling drum and a split backstay; the boom with its rigid vang; the spinnaker pole; and the deck
  hardware (stanchions, lifelines, pulpits, winches, cleats, blocks, clutches, jib-lead tracks and the traveler).
- **Ropes** are tubes swept along their paths through the blocks, rewritten in place every frame.
- **Materials** are physically based: gelcoat with a clear coat, aluminium, polished and brushed metal, rope, wood and
  antifouling. Their textures are generated in code, including the paint zones, non-skid, wood grain, rope braid and
  the name on the transom. Static parts are merged per material to keep draw calls down.
- **Moving parts** follow the snapshot: the boom, tiller and rudder, jib clew and sheets, spinnaker pole, the jib-lead
  and traveler cars, and three crew figures, a helmsman and two trimmers. The crew stand on an 11-joint skeleton; they
  hike, and on a tack they cross the cockpit under the boom instead of jumping.

## Sails, telltales, windex and burgee

**Cloth** ([`sailMesh.ts`](../src/render/sails/sailMesh.ts)). Each sail is a grid of vertices. Every frame:

1. the sail builds a target surface from the simulation's sections: 6–8 per sail, interpolated smoothly in height and
   pinned to the corners;
2. each free vertex chases its target through a damped spring, solved implicitly so that a long frame can't make it
   explode;
3. motion is added along the cloth: waves running back from the luff when it luffs, flogging, leech flutter, and the
   spinnaker's curl, collapse and hoist;
4. the normals are rebuilt.

**Material** ([`clothMaterial.ts`](../src/render/sails/clothMaterial.ts)). The sailcloth is three's physical material,
extended for thin cloth.

- It is two-sided and translucent: sunlight glows through it, and seams, patches, tapes and battens show dark when the
  sail is backlit, as on real Dacron.
- Each face carries its own decals, so the sail number reads correctly from either side (starboard numbers sit higher,
  as the racing rules require).
- It has fine relief: ply edges, load wrinkles from the corners, scallops between the luff slides, and stitching drawn
  when the camera is close.
- The spinnaker's nylon tints the light that comes through it.

The textures ([`sailTextures.ts`](../src/render/sails/sailTextures.ts)) are drawn on canvases: cross-cut panels,
corner patches, batten pockets, draft stripes at 25, 50 and 75 % of the height, a stylised kestrel insignia and the
number 25. The **AoA** overlay recolours the cloth: blue where it luffs, green in the groove, red where it stalls.

**Telltales** ([`telltales.ts`](../src/render/sails/telltales.ts)) are short ribbons: red to port and green to
starboard on the jib's luff at 25, 50 and 75 % of its height, and one at each batten end on the main's leech. Each is a
small chain of points whose root rides the rendered cloth. It moves according to the state the simulation reports:

- **streaming:** along the sail, with a fine flutter;
- **lifting:** rising and spinning;
- **stalled:** drooping, or hidden behind the leech;
- **fluttering:** thrashing, when the sail luffs.

**Windex and burgee.** The windex at the masthead ([`windex.ts`](../src/render/sails/windex.ts)) points into the
apparent wind at 10 m and hunts a little in gusts. The burgee on the backstay ([`burgee.ts`](../src/render/sails/burgee.ts))
streams in the apparent wind at deck level, so the difference between the two shows the wind twisting with height.

## Post-processing

The post chain ([`post.ts`](../src/render/core/post.ts)) uses pmndrs `postprocessing` and reads the half-float scene
buffer:

- **Below Ultra**, one fused pass: FXAA anti-aliasing, a guard that clamps any overflowing or invalid value, bloom,
  **AgX** tone mapping, a gentle vibrance lift for pale sky and sea blues, then a subtle vignette with dithering
  against banding in the sky.
- **On Ultra**, the same steps in two passes, with SMAA instead of FXAA. SMAA is sharper on fine texture but needs the
  tone-mapped image and two extra full-resolution passes.

Bloom has a high threshold, set after exposure, so only sun glints, the sun's disc, specular hot spots and the
lighthouse at dusk glow. Its maximum is capped so single-pixel glints don't bloom into blobs. It runs at half and
quarter resolution. The code comments record the measured cost on an Apple M2: the fused pass takes 1.2–1.6 ms at 2.9
megapixels (High on a Retina screen) and 0.85 ms at 1.44 megapixels; the Ultra layout with SMAA takes 7.4 ms at
5.2 megapixels. On such tile-based GPUs each extra pass costs a lot, which is why everything below Ultra is fused into
one. The chain can also tone-map with ACES, which the environment demo uses for comparison; the app uses AgX.

## The overlays

The teaching overlays ([`src/render/overlays/`](../src/render/overlays)) are built for legibility rather than realism.

- **Arrows** for forces and winds are drawn in one instanced call ([`arrows.ts`](../src/render/overlays/arrows.ts)).
  Each is a screen-aligned quad shaded as a signed-distance shape, so it keeps its width in pixels at any distance.
  The parts hidden under water or behind a sail are drawn faintly rather than not at all. An arrow pointing straight
  at the camera becomes ⊙ or ⊗, the physics symbols for a vector toward or away from you.
- **Lines**, such as laylines, the track and the flow slice's streamlines, are screen-space ribbons
  ([`lines.ts`](../src/render/overlays/lines.ts)). Streamline dashes crawl at the local air speed. Lines lying on the
  water are pulled toward the eye so wave crests don't cut them, while the hull still hides them.
- **Flow particles** leave comet trails ([`trails.ts`](../src/render/overlays/trails.ts)). Each particle's last
  positions sit in a texture used as a ring buffer, and one instanced draw turns them into tapering ribbons.
- **Labels** are DOM elements pinned to 3-D points ([`labels.ts`](../src/render/overlays/labels.ts)), so the text
  stays crisp. They are placed by priority, and a label that would overlap a more important one fades out.
- **True colours.** Overlay colours are pre-compensated for the AgX tone mapping and the current exposure, so a green
  arrow is the palette's green at dawn and at noon.
- **Only in the main view.** Overlays draw only for the main camera: never in the sea's reflection or the telltale
  cam.
- **Built on first use.** Each overlay's objects are created the first time you turn it on.

**How the flow pictures are made** ([`flowField.ts`](../src/render/overlays/flowField.ts),
[`src/flow`](../src/flow)). Horizontal slices are cut through the sails from the snapshot's sections: five for the
particles, between 2.5 and 8.6 m up, and one for the flow slice, 4.5 m up unless you move it with its height slider.
Each sail's cut is handled according to the state the simulation reports for it:

- **Attached flow is solved.** A 2-D vortex lattice gives the velocity field. It uses 20 panels per sail, and all
  the sails in the slice are solved together, so the slot effect appears. The particles move through this solution
  because it is tangent to the cloth, so they never cut through a sail. The colours and pressures use the circulation
  scaled to the force model's lift, which includes stall, luffing and 3-D effects.
- **Stalled sections** add a slowed, turbulent layer that separates along the lee side and is shed from the leech as a
  wake.
- **Sails on a run** and the spinnaker downwind are drawn as a bluff body: air parting round the sail and a wide wake
  of dead air behind it.

These separated-flow pictures are modelled, not solved; see
[Known limitations](physics.md#13-known-limitations). The regimes blend with the angle of attack, so a sail eased from
a reach to a run morphs from one picture to the other. Slices are rebuilt in the background, the particle slices about
6 times a second and the view slice about 10 times, within 0.3 ms of CPU per frame. A slice whose inputs haven't
changed is skipped.

## Performance budgets

**Design targets.** At the default tier, the target is 60 frames per second at 1440 × 900 on an M1-class laptop.
The frame is split up like this:

| Part | Target per frame |
|---|---|
| Simulation | 0.5 ms CPU |
| Sails and particles | 1.5 ms CPU |
| Ocean | 4 ms GPU |
| Boat, sails and shadows | 3 ms GPU |
| Sky and clouds | 1 ms GPU |
| Post-processing | 2 ms GPU |

These are goals for the design, not guarantees. The quality governor exists for machines that miss them: it steps
down a tier when the median frame takes longer than 20 ms, and back up after 10 s under 12 ms (see
[architecture.md](architecture.md#quality-tiers-and-the-governor)).

**What the tests enforce** (exactly under `pnpm test:perf`, three times looser in `pnpm test`):

- one simulation step costs 50 µs or less, in the most expensive setup;
- the overlays cost 2.5 ms or less of CPU per frame, with the flow and slice on (two physics steps included);
- one flow-slice rebuild costs 1.0 ms upwind and 1.5 ms downwind with the spinnaker.

**Spreading the work.** Flow-field rebuilds get 0.3 ms per frame and streamline tracing 0.15 ms. The telltale cam
re-renders at 20 Hz. Physics steps are capped at 12 per frame.

**Measuring.** `node scripts/snap.mjs index.html snaps/app.png --perf 3000` prints the median and 95th-percentile frame
time over 3 seconds in headless Chromium. In a running app, `window.__stats` holds the frame time, frame rate, draw
calls and triangles. By default the snap script asks Chromium for the GPU (the Metal backend on macOS), so frame times
are real; `--swiftshader` switches to software rendering, which is deterministic but slow.

## Module demos

`pnpm dev` also serves a page per module at `/demos/`:

| Demo | What it shows |
|---|---|
| `kit` | The shared demo kit: sky, sun, image-based light and shadows |
| `env` | The production sky, clouds, sun, distant land, marks and post chain, over a flat stand-in sea |
| `ocean` | The FFT ocean: foam, glitter, gust patches and the wake |
| `boat` | The procedural Kestrel 25 |
| `sails` | Main, jib and spinnaker, telltales and windex |
| `ui` | The HUD, instruments, trim panel and lesson panel |
| `overlays` | Forces, the wind triangle, flow and the points-of-sail wheel |
| `audio` | The procedural soundscape |

Most demos take query parameters, such as `?hour=18.5` or `?tier=low`; they are listed at the top of each demo's `.ts`
file. The demos are for development only and are not part of the published site.
