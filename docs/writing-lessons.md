# Writing lessons

A lesson is a TypeScript object in [`src/lessons/curriculum/`](../src/lessons/curriculum). The lesson runner
([`src/lessons/engine.ts`](../src/lessons/engine.ts)) plays it against the live simulation: each step sets up the
scene, and its task is checked from the simulation's snapshot every frame. This page covers the contract, the helpers,
the glossary, a complete minimal lesson, and how to test it.

Before you start, it helps to read one or two real lessons. [`06-drive-and-heel.ts`](../src/lessons/curriculum/06-drive-and-heel.ts)
is short and typical. It also helps to skim [physics.md](physics.md), so you know what the simulation can show.

## The contract

The types live in [`src/lessons/types.ts`](../src/lessons/types.ts). In short:

```ts
interface Lesson {
  id: string;          // kebab-case, unique: 'beam-reach'
  module: string;      // the group in the lesson list: 'First steps', 'Manoeuvres', …
  title: string;
  summary: string;     // one line, shown in the lesson list
  setup(c: LessonCtx): void;   // runs when the lesson starts; usually c.app.scenario(...)
  steps: Step[];
  quiz?: QuizQuestion[];       // shown after the last step
}

interface Step {
  title: string;
  body: string;                        // trusted HTML; glossary terms as [[key]] or [[key|shown text]]
  task?: StepTask;                     // omit for a reading step (the learner presses Next)
  hint?(c: LessonCtx): string | null;  // advice for the situation right now, or null
  showMe?(c: LessonCtx): void;         // "Show me": let the crew or the autopilot demonstrate
  camera?: CameraKey;                  // 'chase' | 'helm' | 'top' | 'sail' | 'free'
  overlays?: Partial<Record<OverlayKey, boolean>>;
  controls?: string[];                 // controls left live in this step (omit: all of them)
  autoTrim?: { main?: boolean; jib?: boolean; spinnaker?: boolean };
  tick?(c: LessonCtx): void;           // every frame until the task succeeds (timers, demos, resets)
  onEnter?(c: LessonCtx): void;
  onExit?(c: LessonCtx): void;
}

interface StepTask {
  label: string;                        // the checklist line: 'Sail close-hauled (TWA 38–52°) for 12 s'
  check(c: LessonCtx): boolean | number; // true/false, or progress 0…1 (1 or more counts as success)
  holdSeconds?: number;                 // the check must hold this long, in simulated seconds
}

interface LessonCtx {
  app: AppApi;       // scenario(), setCamera(), setOverlay(), setMarks(), controls, …
  snap: SimSnapshot; // the latest snapshot (src/sim/types.ts)
  t: number;         // simulated seconds since this step was entered (stops while paused)
  data: Record<string, unknown>; // scratch space for the whole lesson, reset when it starts
}

interface QuizQuestion { q: string; options: string[]; correct: number; why: string }
```

## What the runner does

1. **Start.** `setup` runs, then step 1 is entered. Any race marks from before are cleared.
2. **Entering a step.** The runner applies its camera, overlays, auto-trim settings and live controls, then calls
   `onEnter`.
3. **Every frame** of the step:
   - `tick` runs, from the step's second frame until the task succeeds, and not while paused;
   - `check` runs, from the second frame, because the first snapshot can still show the previous scene;
   - if the task has `holdSeconds`, the check must stay true that long in simulated time. A pause adds nothing, and a
     single false frame starts the count again.
4. **Success.** The step is marked done, and the runner moves to the next step 1.4 s later.
5. **Hints** appear:
   - when the learner presses **Hint**;
   - by themselves, after 25 s of simulated time without progress;
   - at once, when the simulation reports a mistake: a crash gybe, being in irons, a spinnaker collapse, a round-up
     or a backwinded main.

   While a hint is showing, the runner calls `hint()` again once a second, so the advice follows the boat. If `hint()`
   returns `null`, the runner falls back to the task label, or to a built-in line about the mistake.
6. **Leaving.** The learner can always press **Next**, so a task can be skipped, and **Back** returns to the previous
   step. After the last step comes the quiz, if there is one. A lesson earns its tick in the lesson list only when
   every task step was completed.
   Ticks and best quiz scores are saved in the browser's `localStorage` (key `sailing-school:progress:v1`); if storage
   is blocked, they are kept in memory for the session.

Errors thrown by a lesson's code are caught and logged to the console, and the lesson carries on. The curriculum tests
fail on any such error.

## Helpers

Import everything from [`./helpers`](../src/lessons/curriculum/helpers.ts), which re-exports four focused modules.

| Module | Helpers |
|---|---|
| [`scenario.ts`](../src/lessons/curriculum/scenario.ts) | `sailing({ twsKn, twa, … })` builds a scenario: a boat sailing at a signed true wind angle, with the autopilot holding it by default. `view(...keys)` turns exactly these overlays on and every other one off. `holdTwa(c, deg)`, `holdHeading(c, deg)` and `manualHelm(c)` set the helm. `wind()` and `autoTrim()` are the building blocks. |
| [`readings.ts`](../src/lessons/curriculum/readings.ts) | What a sailor reads off the boat, in knots and degrees: `speedKn`, `forwardKn`, `absTwa`, `twaDeg`, `absAwa`, `twsKn`, `awsKn`, `heelDeg`, `helmDeg`, `vmgKn`, `headingDeg`, `tackOf`. Sails: `trimOf(sail)` (mean angle of attack, luffing, stall), `jibTelltales`, `topLeechTelltale`, `mainLuffBubble`, `kiteOf`, `poleError`. Polars: `bestBeat`, `bestRun`, `polarSpeed`. For hints: `fmt`, and `upKey` / `downKey`, the arrow key that heads up or bears away on the current tack. |
| [`steps.ts`](../src/lessons/curriculum/steps.ts) | `step({...})`, the step builder (below). Scratch state: `mem`, `peek`, `latch`, `TimeWindow` (samples over a sliding window of simulated time, which ignores paused frames), `frameDt`. |
| [`manoeuvres.ts`](../src/lessons/curriculum/manoeuvres.ts) | `TackWatch` and `GybeWatch` detect and grade manoeuvres. Demos shared by several lessons: `ramp`, `together`, `sailAway`, `backTheMain`, `steeringOnto`. |

### The `step()` builder

Every lesson in the curriculum builds its steps with `step()`, not as plain objects. It adds four things.

- **Scratch state.** Each step gets a fresh scratch space, so `mem(c, 'key', init)` state doesn't leak between
  steps.
- **Bodies from data.** `body` may be a function of `ctx.data`, for text that shows numbers from earlier steps.
- **Multi-phase demos.** `showMe` may set the controls and return nothing, or it may return a **demo**: a function
  that runs every frame (from the step's `tick`) until the task succeeds or the learner leaves the step.
- **Hands off when the learner acts.** A demo stops as soon as the learner changes a control that neither the demo,
  the crew nor the simulation changed. The crew trims sails that are on auto-trim and steers during its own tacks and
  gybes, and the tiller springs back to centre by itself; none of that counts.

### Controls, cameras and overlays

`controls` lists the controls the learner may use in the step; everything else is locked for the keyboard, the trim
panel and the touch controls alike. A locked tiller self-centres. The names are the `ControlKey`s in `types.ts`, and a
few groups:

| Group | Expands to |
|---|---|
| `helm` | `tiller`, `helmMode`, `helmTarget` |
| `main` | `mainSheet`, `traveler`, `vang`, `outhaul`, `cunningham`, `backstay`, `boomPush`, `autoTrim.main` |
| `mainShape` | `vang`, `outhaul`, `cunningham`, `backstay` |
| `jib` | `jibSheet`, `jibLead`, `jibFurl`, `jibBacked`, `jibWhisker`, `autoTrim.jib` |
| `spinnaker` | `spinHoist`, `spinPole`, `spinPoleHeight`, `spinSheet`, `autoTrim.spinnaker` |
| `crew` | `crewHike` |
| `autoTrim` | the three `autoTrim.*` switches |
| `manoeuvres` | `tack`, `gybe` |
| `all` | everything |

An empty list (`controls: []`) locks everything, for a step where the learner only watches.

The cameras are `chase`, `helm`, `top` (looking straight down, wind at the top of the screen), `sail` (looking up
the mainsail from under the boom) and `free`. The overlay keys are `windTriangle`, `forces`, `wheel`, `flow`,
`flowSlice`, `aoa`, `xray`, `labels`, `laylines`, `track` and `telltaleCam`. Use `view(...)` so that each step shows
exactly what it talks about.

## Glossary terms

Sailing words in lesson text link to the glossary ([`src/lessons/glossary.ts`](../src/lessons/glossary.ts), 98 terms),
and the app shows the definition when the word is hovered or tapped.

- Write `[[key]]` or `[[key|shown text]]`, for example `[[beam-reach|beam reach]]` or `[[telltale]]s`.
- A lookup also accepts the displayed term, an alias ("kicker" finds the vang) or a simple plural.
- The markup works in bodies, task labels, quizzes and hints.
- If a term is missing, add an entry: a lower-case, hyphenated `key`, the `term` as it should appear, and a
  one-sentence plain-English `def`.

The tests fail on any reference that doesn't resolve.

## Writing a good task

- **Make it measurable from the snapshot.** Angles, speeds, heel, helm, telltale states, events: anything in
  `SimSnapshot`. Keep the numbers in the units the learner sees, knots and degrees, via the readings helpers.
- **Make it need the learner.** A learner who does nothing must never complete it. The tests idle for at least 60 s
  (or the hold time plus 60 s) and fail if the task passes. Start the scenario somewhere the task isn't already true;
  the autopilot keeps the boat there until the learner acts.
- **Make it achievable.** "Show me" must complete the task, in the real physics, within 90 s of simulated time. Use
  the crew and the autopilot (`holdTwa`, `c.app.controls.command = 'tack'`, trim targets) rather than faking the
  result.
- **Use `holdSeconds`** for anything that should be sustained, so a lucky frame doesn't count.
- **Give every task a `hint` and a `showMe`.** The tests require both. Make the hint react to what the boat is doing:
  "Too close to the wind: bear away with ←" beats repeating the label.
- **Say which key to press on this tack.** On starboard tack, → heads up; on port tack it bears away. Use `upKey(s)` and
  `downKey(s)`.

## A minimal lesson

This lesson asks the learner to bear away from close-hauled to a beam reach. It passes the same playthrough harness
as the real curriculum.

```ts
// src/lessons/curriculum/19-beam-reach.ts
import type { Lesson } from '../types';
import { absTwa, downKey, fmt, holdTwa, sailing, speedKn, step, upKey, view } from './helpers';

export const beamReach: Lesson = {
  id: 'beam-reach',
  module: 'First steps',
  title: 'The beam reach',
  summary: 'Sail with the wind straight across the boat, usually the fastest point of sail.',
  // Start close-hauled on autopilot: an idle learner never reaches the beam.
  setup: (c) => c.app.scenario(sailing({ twsKn: 10, twa: 50 })),
  steps: [
    step({
      title: 'Wind on the beam',
      body: `<p>On a [[beam-reach|beam reach]] the [[true-wind|true wind]] blows straight across the boat,
at about 90° to the bow. The ring on the water is the points-of-sail wheel; its pointer shows where you are.</p>`,
      camera: 'top',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'Bear away to the beam',
      body: `<p>Turn away from the wind until the pointer sits in the beam-reach sector, then hold it there.
The crew trims the sails for you, so watch the boat speed climb.</p>`,
      camera: 'top',
      overlays: view('wheel'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
      task: {
        label: 'Sail a beam reach (true wind angle 80–100°) at 5 kn or more for 10 s',
        holdSeconds: 10,
        check: (c) => absTwa(c.snap) >= 80 && absTwa(c.snap) <= 100 && speedKn(c.snap) >= 5,
      },
      hint: (c) => {
        const s = c.snap;
        const a = absTwa(s);
        if (a < 80) return `True wind angle ${fmt(a, 0)}°: bear away with ${downKey(s)}.`;
        if (a > 100) return `True wind angle ${fmt(a, 0)}°: head up with ${upKey(s)}.`;
        return `Right angle. Speed ${fmt(speedKn(s))} kn: give the boat a moment to pick up speed.`;
      },
      showMe: (c) => holdTwa(c, 90),
    }),
  ],
  quiz: [
    {
      q: 'On a beam reach the true wind comes from…',
      options: ['ahead', 'the side', 'behind'],
      correct: 1,
      why: 'A beam reach has the true wind at about 90° to the bow: straight across the boat.',
    },
  ],
};
```

A few points about it:

- `sailing({ twsKn: 10, twa: 50 })` starts on starboard tack, 50° off a 10-knot wind, with the autopilot holding that
  angle. With the autopilot on, ← and → move its target, so the learner steers by changing the angle and the
  autopilot keeps it.
- The task needs both the angle and the speed. Turning onto the beam isn't enough; the boat must also get going.
- **Show me** only tells the autopilot to hold 90°. The crew's auto-trim and the physics do the rest.

## Adding it to the curriculum

1. Put the file in `src/lessons/curriculum/` and add the lesson to `CURRICULUM` in
   [`index.ts`](../src/lessons/curriculum/index.ts), in teaching order.
2. Add its id to `SPEC_ORDER` in [`curriculum-harness.ts`](../src/lessons/__tests__/curriculum-harness.ts). The tests
   compare the curriculum's order with this list.
3. If a task naturally takes longer than the defaults allow, give its step an entry in `LONG_IDLE_S` or
   `LONG_SHOW_ME_S` in the harness, keyed `'lesson-id › Step title'`.
4. If your lesson is the best place to learn about a simulation event, the event's toast can link to it: see
   `EVENT_TOASTS` in [`src/ui/toasts.ts`](../src/ui/toasts.ts) and `setEventLessons` in
   [`src/app/App.ts`](../src/app/App.ts).

## Testing a lesson

The curriculum tests ([`src/lessons/__tests__`](../src/lessons/__tests__)) play every lesson in `CURRICULUM` like a
learner would, through the real lesson runner, the real simulation and the real crew, with no rendering. They check
that:

- setup, bodies, checks, hints and ticks run without errors or engine warnings (an unknown control name is a warning);
- idling never completes a task;
- **Show me** completes every task within its budget;
- the same two hold for a learner who pressed Next past the steps before the task;
- ids, text lengths, glossary references, camera, overlay and control names, and quizzes are well formed.

Run only your lesson's tests while you work:

```bash
pnpm exec vitest run src/lessons -t "beam-reach"
```

Then run the whole suite with `pnpm test` before opening a pull request. To try the lesson for real, start
`pnpm dev`, open **Lessons** and pick it from the list.

When a playthrough fails, the message names the lesson, the step and what went wrong: for example, a task that
completed after some seconds of idling, or a "Show me" that didn't finish within its budget. For deeper digging,
the harness's `startLesson`, `Driver` and `gotoStep` let you script a learner step by step in a test of your own; the
focused tests for lessons 5, 11, 12, 16 and 18 in `curriculum.test.ts` are good examples.

## Style

- British English, as in the rest of the app: colour, centre, manoeuvre.
- Short paragraphs in `<p>` tags. Use `<strong>` for the key idea and `<kbd>` for keys.
- Talk to the learner ("turn away from the wind"), and explain why, not only what.
- Gloss every sailing term with `[[…]]` the first time a lesson uses it.
- Keep task labels short and concrete: what to do, the numbers, and for how long.
- Body HTML is inserted as-is, so keep it to simple markup and never build it from outside input.
