// Lessons 5, 9 and 10 after the overlay-legibility pass: every step asks for the camera and the smallest overlay
// set that shows what its text talks about — and the words in the text name what is on screen. Each lesson is walked
// in the real lessons engine with a host that records what the steps ask of it.
import { describe, expect, it } from 'vitest';
import { LessonRunner } from '../engine';
import type { AppApi, CameraKey, ForcePart, Lesson, OverlayKey } from '../types';
import { CURRICULUM } from '../curriculum';
import { CLOSE_UP_M } from '../curriculum/05-sail-is-a-wing';
import { sailing } from '../curriculum/helpers';
import { Driver, Panel, SimApp } from './curriculum-harness';

interface StepView {
  title: string;
  body: string;
  camera: CameraKey;
  overlays: OverlayKey[];
  /** Pieces of the Forces overlay in force while the step is shown (null: all of them). */
  parts: ForcePart[] | null;
  /** Camera distance asked for on entering the step (null: none). */
  distance: number | null;
}

/** Walk a lesson step by step (pressing Next), recording what each step shows; then leave it. */
function walk(id: string, host: { forceParts: boolean; distance: boolean } = { forceParts: true, distance: true }): { steps: StepView[]; partsAfterExit: ForcePart[] | null | undefined } {
  const lesson: Lesson = CURRICULUM.find((l) => l.id === id)!;
  const app = new SimApp(sailing({ twsKn: 10, twa: 90 }));
  let parts: ForcePart[] | null | undefined;
  let distance: number | null = null;
  const api = app as AppApi;
  if (host.forceParts) api.setForceParts = (p) => { parts = p ? [...p] : null; };
  if (host.distance) api.setCameraDistance = (m) => { distance = m; };
  // As the App does: a new camera starts at its own distance.
  const setCamera = app.setCamera.bind(app);
  app.setCamera = (c) => { distance = null; setCamera(c); };
  const runner = new LessonRunner([lesson], app, new Panel(), { storage: null, advanceDelay: 0.25, hintAfter: 1e9 });
  const drive = new Driver(app, runner);
  runner.start(lesson.id);
  drive.frame();
  const steps: StepView[] = [];
  lesson.steps.forEach((st, i) => {
    expect(runner.activeStepIndex, `${id} step ${i + 1}`).toBe(i);
    const on = Object.entries(app.overlays()).filter(([, v]) => v).map(([k]) => k as OverlayKey).sort();
    steps.push({ title: st.title, body: st.body, camera: app.camera, overlays: on, parts: parts ?? null, distance });
    if (i < lesson.steps.length - 1) { runner.next(); drive.frame(); }
  });
  runner.exit();
  return { steps, partsAfterExit: parts };
}

const overlays = (steps: StepView[]): string[] => steps.map((s) => s.overlays.join('+'));

describe('lesson 5 (a sail is a wing): each step shows what its text talks about', () => {
  const { steps, partsAfterExit } = walk('sail-is-a-wing');

  it('looks straight down on the sail, with one subject per step', () => {
    expect(steps.map((s) => s.camera)).toEqual(['top', 'top', 'top', 'top', 'top', 'chase']);
    expect(overlays(steps)).toEqual(['flowSlice', 'aoa+forces', 'aoa+flowSlice+forces', 'aoa+flowSlice+forces', 'aoa+forces', 'aoa']);
    // The flow particles duplicate the slice's streamlines from above and bury the boat: never both.
    for (const s of steps) expect(s.overlays).not.toContain('flow');
  });

  it('reduces the Forces overlay to lift and drag, then to the drive, and restores it on leaving', () => {
    expect(steps.map((s) => s.parts)).toEqual([null, ['liftDrag'], ['liftDrag'], ['liftDrag'], ['drive'], null]);
    expect(partsAfterExit).toBeNull();
  });

  it('asks for the close top view on the top-view steps', () => {
    expect(steps.map((s) => s.distance)).toEqual([CLOSE_UP_M, CLOSE_UP_M, CLOSE_UP_M, CLOSE_UP_M, CLOSE_UP_M, null]);
  });

  it('names the arrows and colours that are on screen', () => {
    const body = (title: string): string => steps.find((s) => s.title === title)!.body;
    // The tags are "Lift", "Drag", "Apparent wind", "Angle of attack"; pink, lilac and amber arrows; a blue/green/red arc.
    for (const w of ['pink', 'lilac', 'amber', 'dashed', 'arc', 'blue', 'green', 'red']) expect(body('Lift and drag'), w).toContain(w);
    expect(body('Lift and drag')).toMatch(/\[\[lift\|Lift\]\]/);
    expect(body('Lift and drag')).toMatch(/\[\[drag\|Drag\]\]/);
    for (const w of ['streamlines', 'arc turns blue', 'lift arrow']) expect(body('Too small: luffing'), w).toContain(w);
    for (const w of ['wake', 'arc turns red', 'lift arrow', 'drag arrow']) expect(body('Too big: stall'), w).toContain(w);
    for (const w of ['green arrow', '[[drive]]']) expect(body('Maximum drive'), w).toContain(w);
    for (const w of ['bold white curve', 'streamlines', 'Suction', 'Pressure']) expect(body('The sail lab'), w).toContain(w);
  });
});

describe('lesson 9 (main and jib together): the slice alone, then with the groove colours', () => {
  const { steps } = walk('main-and-jib');

  it('keeps one picture through the lesson and adds only the angle-of-attack colours for the trim steps', () => {
    expect(steps.map((s) => s.camera)).toEqual(['top', 'top', 'top', 'top']);
    expect(overlays(steps)).toEqual(['flowSlice', 'flowSlice', 'aoa+flowSlice', 'aoa+flowSlice']);
    for (const s of steps) expect(s.distance).toBe(CLOSE_UP_M);
  });

  it('tells the learner what the curves, lines and colours are', () => {
    for (const w of ['bold white curves', 'streamlines', 'jib', 'mainsail']) expect(steps[0]!.body, w).toContain(w);
    for (const w of ['green', 'blue', 'red', "mainsail's section turn blue"]) expect(steps[2]!.body, w).toContain(w);
    expect(steps[3]!.body).toContain('both sections green');
  });
});

describe('lesson 10 (keel, leeway and balance): only the forces each step is about', () => {
  const { steps, partsAfterExit } = walk('keel-and-balance');

  it('shows the pair that balances sideways, then the righting couple, then the rudder', () => {
    expect(steps.map((s) => s.camera)).toEqual(['chase', 'chase', 'chase', 'chase', 'chase']);
    expect(overlays(steps)).toEqual(['forces+xray', 'forces+xray', 'forces+xray', 'forces', 'forces+xray']);
    expect(steps.map((s) => s.parts)).toEqual([
      ['heel', 'keel'], ['heel', 'keel', 'righting'], ['rudder', 'helm'], ['heel', 'helm'], ['heel', 'keel', 'rudder', 'helm'],
    ]);
    expect(partsAfterExit).toBeNull();
  });

  it('explains the leeway picture in the words and colours on screen', () => {
    const body = steps[0]!.body;
    for (const w of ['purple arrow', 'white arrow', 'yellow arrow', 'yellow marks', 'heading', 'track', 'cyan arrow', '[[leeway]]']) expect(body, w).toContain(w);
    for (const w of ['gold arrow', 'light-blue arrow']) expect(steps[1]!.body, w).toContain(w);
    for (const w of ['rudder blade', 'tag at the tiller']) expect(steps[2]!.body, w).toContain(w);
  });
});

describe('the three lessons on a host without the optional calls', () => {
  it('still run: the steps fall back to the whole Forces overlay and the camera’s own distance', () => {
    for (const id of ['sail-is-a-wing', 'main-and-jib', 'keel-and-balance']) {
      const { steps, partsAfterExit } = walk(id, { forceParts: false, distance: false });
      expect(steps.length, id).toBeGreaterThan(3);
      for (const s of steps) { expect(s.parts, id).toBeNull(); expect(s.distance, id).toBeNull(); }
      expect(partsAfterExit, id).toBeUndefined();
    }
  });

  it('never show more than three teaching overlays at once', () => {
    for (const id of ['sail-is-a-wing', 'main-and-jib', 'keel-and-balance']) {
      for (const s of walk(id).steps) expect(s.overlays.length, `${id} › ${s.title}`).toBeLessThanOrEqual(3);
    }
  });
});
