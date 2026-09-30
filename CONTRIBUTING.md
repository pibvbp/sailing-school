# Contributing to Sailing School

Thank you for helping! Bug reports, lesson ideas, physics corrections, graphics work, documentation and code are all
welcome, from sailors and developers alike.

- For a **small fix** (a typo, a clear bug), open a pull request directly.
- For **anything bigger**, such as a new feature, a physics change or a new lesson, please open an issue first, so we
  can agree on the approach before you spend time on it. The issue forms cover bug reports, feature requests and
  lesson ideas.
- Please follow the [code of conduct](CODE_OF_CONDUCT.md).
- Report **security problems** privately, as described in [SECURITY.md](SECURITY.md), not in an issue.

## Set-up

You need:

- **Node 22** or later;
- **pnpm 10**. The exact version is pinned in `package.json`; `corepack enable` sets it up, or you can install pnpm 10
  yourself.

```bash
git clone https://github.com/pibvbp/sailing-school.git
cd sailing-school
corepack enable
pnpm install
pnpm dev
```

Vite prints the local URL, which is <http://localhost:5180> unless that port is busy. A page per module (ocean, boat,
sails, overlays and more) is at `/demos/`.

The end-to-end tests, the real-audio tests and the screenshot script drive Playwright's Chromium. Install it once with
`pnpm exec playwright install chromium`; on Linux, add `--with-deps` to install the system libraries too.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Development server with hot reload |
| `pnpm typecheck` | TypeScript in strict mode, no output |
| `pnpm test` | All unit and lesson tests, in Node (Vitest) |
| `pnpm test:watch` | The same, re-running on every change |
| `pnpm test:perf` | The timing tests with exact budgets, one file at a time |
| `pnpm test:audio` | The soundscape rendered through real WebAudio in headless Chromium |
| `pnpm e2e` | Builds the site, serves it under `/sailing-school/`, and runs the Playwright smoke tests |
| `pnpm build` | The production site in `dist/` |
| `pnpm preview` | Serves the build at <http://localhost:4173/sailing-school/> |
| `pnpm polars` | Re-sails the boat to regenerate `src/sim/data/polars.json` |
| `pnpm snap` | Headless screenshots: `scripts/snap.mjs` |

## Running the tests

Every pull request should pass `pnpm typecheck` and `pnpm test`. CI runs both, builds the site, and runs
`pnpm test:audio` and `pnpm e2e` as well.

While you work, run just the part you are changing:

```bash
pnpm exec vitest run src/sim                    # one folder
pnpm exec vitest run src/lessons -t "tacking"   # tests whose names match
pnpm test:watch                                 # re-run on save
```

Run the other suites when your change touches their area:

- **`pnpm test:perf`** for changes to the simulation, the flow solver or the overlays. It checks the exact
  wall-clock budgets: 50 µs per simulation step, 2.5 ms of overlay CPU per frame, and 1.0–1.5 ms per flow-slice
  rebuild. The everyday suite allows three times more, so that a busy machine doesn't fail it. Run the strict suite on
  a quiet machine.
- **`pnpm test:audio`** for changes in `src/audio`. It renders the real soundscape offline in Chromium and checks
  levels, clicks, clipping and stereo placement.
- **`pnpm e2e`** for changes to start-up, the UI, the build or deployment. It builds the site and serves it on port
  4173. Locally it reuses a server that is already running there.

[docs/architecture.md](docs/architecture.md#testing-strategy) describes what each suite covers.

## Code style

There is no linter or formatter, so please **match the surrounding code**:

- two-space indentation, single quotes, semicolons, and trailing commas in multi-line lists;
- lines up to about 120 characters;
- small, focused files with clear names;
- comments that explain *why*, meaning the physics or graphics reasoning, rather than restating the code.

A few rules matter more than formatting.

- **TypeScript strict.** The project uses `strict`, `noImplicitOverride` and `noFallthroughCasesInSwitch`.
  `pnpm typecheck` must be clean. Avoid `any`.
- **Units and frames.** The simulation works in SI units (metres, seconds, newtons, radians); knots and degrees
  appear only in the UI. Follow the frame and sign conventions in
  [docs/architecture.md](docs/architecture.md#frames-and-sign-conventions), and use `src/shared/coords.ts` for
  conversions. Most integration bugs come from a flipped sign.
- **One source for the boat.** Every boat dimension lives in `src/shared/boatSpec.ts`. Never hard-code one elsewhere.
- **Keep the physics portable.** `src/sim` and `src/flow` must not import three.js or touch the DOM; they run in
  plain Node.
- **Frame-loop code shouldn't allocate.** Code that runs every frame or every physics step avoids creating objects;
  follow the patterns around it.
- **No new runtime dependencies** without discussing them in an issue first. Today there are two, `three` and
  `postprocessing`.
- **No assets, no network.** Textures, geometry and sounds are generated in code, and the app makes no network requests
  at run time. Please keep it that way.
- **Third-party code.** Only code under a permissive licence (MIT, BSD, Zlib, Apache-2.0) may be adapted. Keep its
  copyright header, note that it was adapted for sailing-school, and add an entry with the full licence to
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Text.** The app and the docs use British English: colour, centre, manoeuvre. Gloss sailing terms for newcomers.

## Proposing a change

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one topic. Small pull requests are reviewed faster.
3. Add or update tests with any change of behaviour. For a bug, a test that fails before the fix is the best
   evidence.
4. Run `pnpm typecheck` and `pnpm test`, plus the suites that cover your change.
5. Update the docs when behaviour, controls or numbers change: the README, `docs/physics.md` and the others.
6. Open the pull request and fill in the template. CI must be green before it's merged.

### Physics changes

The physics is calibrated and heavily tested, so changes to `src/sim` need a little extra care.

- **Keep the ORC calibration green.** `src/sim/__tests__/orc-envelope.test.ts` and `orc-per-sail.test.ts` hold the sail
  coefficients to the ORC VPP 2023 tables.
- **Keep the plausibility tests green.** `src/sim/__tests__/vpp.test.ts` holds the steady-state speeds to realistic
  bands, and requires a sensible best upwind angle and a cost for pinching.
- **Regenerate the polars** with `pnpm polars`, and commit `src/sim/data/polars.json`. A test fails if the table
  drifts more than 3 % from the live physics.
- **Keep every lesson playable.** The curriculum tests must still pass: each task still needs the learner, and "Show
  me" still completes it.
- **Explain the physics** in the pull request: what was wrong, the reasoning, and references if you have them. Include
  before-and-after numbers, such as steady speeds from `solveSteady` in `src/sim/vpp.ts`.
- **Prefer physical mechanisms to tuning knobs.** A penalty added only to hit a number will be questioned.
- **Update [docs/physics.md](docs/physics.md)** if any number or behaviour it describes changes.

### Screenshots for visual changes

For any change you can see, please add before-and-after screenshots to the pull request. Use the same camera, time of
day and quality tier for both. The screenshot script starts Vite, opens the page in headless Chromium and waits for
it to be ready:

```bash
node scripts/snap.mjs index.html snaps/app-after.png --wait 3000 --size 1600x900
node scripts/snap.mjs demos/sails.html snaps/sails-after.png --wait 3000 --size 1600x900 \
  --query "preset=beat&cam=quarter&hour=17"
node scripts/snap.mjs demos/boat.html snaps/boat.png --perf 3000   # also prints the median and p95 frame time
```

`snaps/` is ignored by git. The demo pages take query parameters for the camera, time of day, quality tier and so on;
they are listed at the top of each `demos/*.ts` file.

By default the script asks Chromium for the GPU (the Metal backend on macOS); `--swiftshader` renders in software,
which is deterministic but slow. If your change could affect performance, include the `--perf` numbers and say which
GPU you measured on. Judge the result against photographs of real water, boats and sails, not against other computer
graphics.

### New lessons

Start with a **Lesson idea** issue, then read [docs/writing-lessons.md](docs/writing-lessons.md). It covers the lesson
engine, the glossary, a complete example lesson and how to test it.

## Licence

Sailing School is released under the [MIT licence](LICENSE). By contributing, you agree that your contributions are
released under the same licence.

## Questions

If something here is unclear or out of date, open an issue: a question is a fine reason for one.
