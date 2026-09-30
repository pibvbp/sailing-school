// Lesson 1 — Meet the boat (spec §11.2): the parts, port and starboard, and a tiller that steers backwards.
import type { LessonCtx, Lesson, Step } from '../types';
import { angleDiff, fmt, headingDeg, holdHeading, manualHelm, sailing, step, view } from './helpers';

const TWD = 200;
/** Starting heading: the wind (from 200°) is on the starboard beam. */
const START = 110;

function steerTo(target: number, turn: 'starboard' | 'port', body: string): Step {
  const key = turn === 'starboard' ? '→' : '←';
  return step({
    title: `Turn to ${turn}`,
    body,
    camera: 'chase',
    overlays: view(),
    controls: ['helm'],
    autoTrim: { main: true, jib: true },
    onEnter: manualHelm,
    task: {
      label: `Steer to a heading of ${target}° (±10°) and hold it for 3 s`,
      holdSeconds: 3,
      check: (c) => Math.abs(angleDiff(headingDeg(c.snap), target)) <= 10,
    },
    hint: (c: LessonCtx) => {
      const off = angleDiff(target, headingDeg(c.snap)); // + = still need to turn to starboard
      if (Math.abs(off) <= 10) return Math.abs(c.snap.boat.yawRate) > 0.05 ? 'Nearly there — centre the tiller so the bow stops swinging.' : null;
      if (c.app.controls.helmMode !== 'manual') return 'The autopilot is steering. Set the helm to Manual in the trim panel, then steer with ← and →.';
      const now = `Your heading is ${fmt(headingDeg(c.snap), 0)}°.`;
      const wanted = off > 0 ? 'starboard' : 'port';
      const k = off > 0 ? '→' : '←';
      return wanted === turn
        ? `${now} Keep turning to ${turn}: hold ${key} — the [[tiller]] swings the other way.`
        : `${now} You have turned past ${target}°. Steer back to ${wanted} with ${k}, and centre the tiller a little early.`;
    },
    showMe: (c) => holdHeading(c, target),
  });
}

export const meetTheBoat: Lesson = {
  id: 'meet-the-boat',
  module: 'First steps',
  title: 'Meet the boat',
  summary: 'The parts of a keelboat, port and starboard, and why the tiller steers backwards.',
  setup: (c) => c.app.scenario(sailing({ twsKn: 8, twdDeg: TWD, twa: TWD - START })),
  steps: [
    step({
      title: 'Welcome aboard',
      body: `<p>This is the <strong>Kestrel 25</strong>, a 7.6-metre (25 ft) keelboat. The labels name her parts. The [[hull]] floats; the [[mast]] carries two sails — the big [[mainsail]] behind it, stretched along the [[boom]], and the [[jib]] in front, on the [[forestay]].</p>
<p>Under the water hang the [[keel]], a heavy fin that stops her sliding sideways and keeps her upright, and the [[rudder]], which you turn with the [[tiller]] in the [[cockpit]].</p>
<p>The crew is sailing for now. Try the camera keys <kbd>1</kbd>–<kbd>5</kbd> to look around; <kbd>1</kbd> brings you back behind the boat.</p>`,
      camera: 'chase',
      overlays: view('labels'),
      controls: ['helm'],
      autoTrim: { main: true, jib: true },
    }),
    step({
      title: 'Port and starboard',
      body: `<p>Facing the [[bow]] (the front), the left side is <span class="port">port</span> and the right side is <span class="stbd">starboard</span> — they never change, whichever way you face. Boats show a red light to [[port]] and a green one to [[starboard]]; the wind dial uses the same colours.</p>
<p>The wind is coming over the starboard side, so we are on <strong>starboard [[tack]]</strong>. That side is [[windward]]; the other side, where the boom and sails swing out, is [[leeward]]. The back of the boat is the [[stern]].</p>`,
      camera: 'helm',
      overlays: view('labels'),
      controls: ['helm'],
    }),
    step({
      title: 'The tiller steers backwards',
      body: `<p>The [[rudder]] under the stern steers the boat, and you move it with the [[tiller]]. A tiller works backwards: push it to port and the bow turns to starboard.</p>
<p>Here you steer the <em>bow</em>: hold <kbd>→</kbd> (or <kbd>D</kbd>) to turn the bow to starboard and <kbd>←</kbd> (or <kbd>A</kbd>) to turn it to port — and watch the tiller on screen swing the opposite way. Let go and the tiller centres itself; hold <kbd>Shift</kbd> for small corrections.</p>
<p>The autopilot is off now: you have the helm.</p>`,
      camera: 'chase',
      overlays: view(),
      controls: ['helm'],
      onEnter: manualHelm,
    }),
    steerTo(140, 'starboard', `<p>Your heading — the compass direction the bow points — is on the instrument strip. Turn the bow to starboard with <kbd>→</kbd> until it reads about 140°, then straighten up.</p>
<p>A boat keeps turning for a moment after you centre the tiller, so ease off a little early. The crew pulls the sails in as you turn toward the wind.</p>`),
    steerTo(80, 'port', `<p>Now the other way: turn the bow to port with <kbd>←</kbd> onto a heading of about 80°.</p>
<p>This time you turn away from the wind, and the crew lets the sails out. Why sails go in and out as you turn is what the next lessons are about.</p>`),
  ],
  quiz: [
    {
      q: 'You push the tiller to port. Which way does the bow turn?',
      options: ['To port', 'To starboard'],
      correct: 1,
      why: 'The rudder blade swings the opposite way to the tiller: the stern is pushed toward the tiller side and the bow turns away from it.',
    },
    {
      q: 'Facing the bow, which side is starboard?',
      options: ['The left', 'The right'],
      correct: 1,
      why: 'Facing the bow, port is on the left (red light) and starboard on the right (green light) — they are sides of the boat, not of you.',
    },
    {
      q: 'Which part stops the boat sliding sideways and keeps it upright?',
      options: ['The rudder', 'The keel', 'The boom'],
      correct: 1,
      why: 'The [[keel]] is a heavy underwater fin: its weight keeps the boat upright and its shape resists sliding sideways.',
    },
  ],
};
