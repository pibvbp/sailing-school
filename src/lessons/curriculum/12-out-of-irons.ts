// Lesson 12 — Getting out of irons (spec §11.2): starts stuck head to wind; back the jib, steer in reverse
// while drifting astern, then sail away; then back the main as well, pushing the boom out to choose the tack.
// Tasks: sailing again at ≥ 2 kn going forward; out of irons again by backing the main, on the chosen tack.
import type { Lesson, LessonCtx } from '../types';
import { absTwa, autoTrim, backTheMain, fmt, forwardKn, mem, peek, sailAway, sailing, step, tackOf, toDeg, view } from './helpers';

const RELEASE_TWA = 50;
/** Stopped head to wind, drifting astern. */
const IRONS = sailing({ twsKn: 10, twa: 2, speedKn: -0.3, helm: 'manual', controls: { autoTrim: autoTrim(true, true, false) } });
/**
 * A stopped boat does fall off by herself in the end — slowly, drifting astern, on whichever side the wind
 * pushes her. The drill: if she falls off before the jib was backed, or nothing happens within ATTEMPT_S, she is
 * put back in irons for another try.
 */
const ATTEMPT_S = 40;
const FELL_OFF_TWA = 35;

interface Drill { t0: number; backed: boolean; resets: number; why: 'fell' | 'slow' | null }
const drill = (c: LessonCtx): Drill => mem(c, 'drill', () => ({ t0: c.t, backed: false, resets: 0, why: null }));

/** Backing the main: the boom counts as held out once it is this far (deg) off the centreline on the pushed side. */
const BOOM_OUT = 40;
/** More to do than backing the jib alone: push, turn, let go, and pick up speed. */
const MAIN_ATTEMPT_S = 60;
/**
 * The backing-the-main drill. `pushed`: the learner has pushed the boom (so a fall-off is theirs, not the wind's);
 * `chosen`: the tack the boom chose once it was out (+1 starboard tack = boom out to port).
 */
interface MainDrill { t0: number; pushed: boolean; chosen: 1 | -1 | 0; resets: number; why: 'fell' | 'slow' | null }
const mainDrill = (c: LessonCtx): MainDrill => mem(c, 'mainDrill', () => ({ t0: c.t, pushed: false, chosen: 0, resets: 0, why: null }));
const tackName = (side: number): string => (side > 0 ? 'starboard' : 'port');

export const outOfIrons: Lesson = {
  id: 'out-of-irons',
  module: 'Manoeuvres',
  title: 'Getting out of irons',
  summary: 'Stuck head to wind and drifting backwards? Back the jib, back the main, steer in reverse, and sail away.',
  setup: (c) => c.app.scenario(IRONS),
  steps: [
    step({
      title: 'In irons',
      body: `<p>The boat has stopped with her bow pointing into the wind: she is [[in-irons]]. The sails flap, nothing drives her, and the wind on the hull and rig is pushing her backwards — she has [[sternway]].</p>
<p>The rudder only steers when water flows past it, and going backwards it works in reverse. Waiting helps little: sooner or later the bow falls off to one side, but you can make it happen at once.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: [],
    }),
    step({
      title: 'Back the jib',
      body: `<p>Switch on <strong>Back jib</strong> in the trim panel: the crew holds the jib out on the side it is on. The wind now presses on its back and pushes the bow away from that side.</p>
<p>Help with the rudder. You are drifting backwards, so steering is reversed: the key that normally turns the bow one way now turns it the other. With the jib held out to port the bow swings to starboard, so hold <kbd>←</kbd>; with it held out to starboard, hold <kbd>→</kbd>. Keep going until the wind is well round on the side, about ${RELEASE_TWA}° off the bow.</p>
<p>Left alone she would fall off by herself in the end, on whichever side the wind pushes her. If that happens before you act — or you are still stuck after ${ATTEMPT_S} s — she is put back in irons for another try.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'jibBacked'],
      tick: (c) => {
        const d = drill(c);
        if (c.app.controls.jibBacked) d.backed = true;
        const fell = !d.backed && absTwa(c.snap) >= FELL_OFF_TWA;
        if (fell || c.t - d.t0 > ATTEMPT_S) {
          c.app.scenario(IRONS);
          Object.assign(d, { t0: c.t, backed: false, resets: d.resets + 1, why: fell ? 'fell' : 'slow' });
        }
      },
      task: {
        label: `Back the jib until the bow is ${RELEASE_TWA}° off the wind, within ${ATTEMPT_S} s`,
        holdSeconds: 0.5,
        check: (c) => c.app.controls.jibBacked && absTwa(c.snap) >= RELEASE_TWA,
      },
      hint: (c) => {
        const s = c.snap;
        if (!c.app.controls.jibBacked) {
          const d = peek<Drill>(c, 'drill');
          if (d?.why === 'fell') return 'She fell off by herself that time, so she is back in irons. Switch on Back jib in the trim panel (Jib section) before she drifts off again.';
          if (d?.why === 'slow') return 'That took too long — back in irons for another try. Switch on Back jib in the trim panel (Jib section).';
          return 'Switch on Back jib in the trim panel (Jib section).';
        }
        if (absTwa(s) >= RELEASE_TWA) return null;
        const clew = s.sails.jib.clewAngle > 0 ? 'port' : 'starboard';
        const bow = clew === 'port' ? 'starboard' : 'port';
        const key = bow === 'starboard' ? '←' : '→';
        if (s.boat.u < -0.05) return `The jib is held out to ${clew}, so the bow swings to ${bow}. You are drifting backwards: hold ${key} to help it round (${fmt(absTwa(s), 0)}° off the wind so far).`;
        return `The jib is pushing the bow to ${bow} — ${fmt(absTwa(s), 0)}° off the wind so far.`;
      },
      showMe: () => sailAway(60, { releaseAt: RELEASE_TWA + 8 }),
    }),
    step({
      title: 'Sail away',
      body: `<p>The jib is still held aback, pushing the bow round. Now let it go: switch <strong>Back jib</strong> off, and the crew sheets it in on the proper side. Steer onto a close reach, about 60° off the wind, and let the boat pick up speed. Once water flows past the rudder it steers the normal way again.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'jibBacked', 'main', 'jib'],
      // Start with the jib aback, whether or not the step before was done.
      onEnter: (c) => {
        c.app.controls.jibBacked = true;
        c.app.controls.tiller = 0;
      },
      task: {
        label: 'Sailing again at 2 kn or more going forward, with the jib drawing normally',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          const a = absTwa(s);
          return !c.app.controls.jibBacked && !s.sails.jib.backed && a >= 40 && a <= 150 && forwardKn(s) >= 2;
        },
      },
      hint: (c) => {
        const s = c.snap;
        if (c.app.controls.jibBacked) return 'Switch Back jib off now, or the jib keeps pushing the bow round.';
        if (absTwa(s) < 40) return 'You have turned back toward the wind. Steer away from it until the sails fill.';
        if (forwardKn(s) < 2) return `${fmt(Math.max(0, forwardKn(s)))} kn forward — hold a close reach and let her accelerate.`;
        return null;
      },
      showMe: () => sailAway(60, { releaseAt: 0 }),
    }),
    step({
      title: 'Back the main',
      body: `<p>Backing the jib swings the bow off, but you cannot choose the side: the crew holds the jib out on whichever side the wind is. Back the main as well and you choose — and she comes round faster. She is back in irons for a try.</p>
<p>[[ease|Ease]] the mainsheet, then push the [[boom]] out by hand — <strong>Push boom</strong> (<kbd>B</kbd>) — to the side it will be on when you sail away: out to port for [[starboard]] tack, out to starboard for [[port]] tack. The wind presses on the back of the mainsail: you are [[backing]] it. She goes backwards, and the bow swings toward the boom. Back the jib too: the crew holds it out on the other side, and it pushes the bow the same way.</p>
<p>Going backwards the steering is reversed: hold <kbd>→</kbd> with the boom out to port, <kbd>←</kbd> with it out to starboard. When the bow is about ${RELEASE_TWA}° off the wind, let go of the boom and the jib and steer onto a close reach. Once she moves forward, the rudder works the normal way again.</p>`,
      camera: 'chase',
      overlays: view('wheel'),
      controls: ['helm', 'jibBacked', 'boomPush', 'main', 'jib'],
      onEnter: (c) => c.app.scenario(IRONS),
      tick: (c) => {
        const d = mainDrill(c);
        const k = c.app.controls;
        const s = c.snap;
        if (k.boomPush !== 0) {
          d.pushed = true;
          const side = k.boomPush > 0 ? 1 : -1;
          const boom = toDeg(s.sails.main.boomAngle);
          if (Math.sign(boom) === side && Math.abs(boom) >= BOOM_OUT) d.chosen = side;
        }
        const fell = !d.pushed && absTwa(s) >= FELL_OFF_TWA;
        if (fell || c.t - d.t0 > MAIN_ATTEMPT_S) {
          c.app.scenario(IRONS);
          Object.assign(d, { t0: c.t, pushed: false, chosen: 0, resets: d.resets + 1, why: fell ? 'fell' : 'slow' });
        }
      },
      task: {
        label: 'Back the main and sail away on the tack you chose, at 2 kn or more going forward',
        holdSeconds: 3,
        check: (c) => {
          const s = c.snap;
          const k = c.app.controls;
          const d = peek<MainDrill>(c, 'mainDrill');
          const a = absTwa(s);
          return !!d && d.chosen !== 0 && k.boomPush === 0 && !k.jibBacked && !s.sails.jib.backed
            && tackOf(s) === d.chosen && a >= 40 && a <= 150 && forwardKn(s) >= 2;
        },
      },
      hint: (c) => {
        const s = c.snap;
        const k = c.app.controls;
        const d = peek<MainDrill>(c, 'mainDrill');
        const a = absTwa(s);
        if (k.boomPush === 0 && !d?.chosen) {
          if (d?.why === 'fell') return 'She came round by herself before you pushed the boom out, so she is back in irons. Ease the mainsheet and push the boom out (Push boom, B) straight away.';
          if (d?.why === 'slow') return 'That took too long — back in irons for another try. Ease the mainsheet and push the boom out (Push boom, B).';
          return 'Ease the mainsheet, then push the boom out (Push boom, B): out to port to sail away on starboard tack, out to starboard for port tack.';
        }
        if (k.boomPush !== 0) {
          const side = k.boomPush > 0 ? 1 : -1;
          const boom = toDeg(s.sails.main.boomAngle);
          if (Math.sign(boom) !== side || Math.abs(boom) < BOOM_OUT) return `Ease the mainsheet further: the crew cannot push the boom out against a tight sheet (it is ${fmt(Math.abs(boom), 0)}° out).`;
          if (!k.jibBacked) return 'Back the jib as well (Back jib): it pushes the bow round the same way.';
          if (tackOf(s) !== side || a < RELEASE_TWA) {
            if (s.boat.u < -0.05) return `Going backwards the steering is reversed: hold ${side > 0 ? '→' : '←'} to help the bow round (${fmt(a, 0)}° off the wind so far).`;
            return `The main is backed: she is starting to go backwards (${fmt(a, 0)}° off the wind so far).`;
          }
          return `${fmt(a, 0)}° off the wind on ${tackName(side)} tack: let go of the boom (Push boom off) and the jib (Back jib off), and steer onto a close reach.`;
        }
        if (k.jibBacked) return 'Switch Back jib off now, or the jib keeps pushing the bow round.';
        if (d?.chosen && tackOf(s) !== d.chosen) return `She is on ${tackName(tackOf(s))} tack, but you pushed the boom out for ${tackName(d.chosen)} tack. Steer her back round — or wait, and she is put back in irons for another try.`;
        if (a < 40) return 'You have turned back toward the wind. Steer away from it until the sails fill.';
        if (forwardKn(s) < 2) return `${fmt(Math.max(0, forwardKn(s)))} kn forward — hold a close reach and let her accelerate.`;
        return null;
      },
      showMe: (c) => {
        // Follow the learner's choice if they made one; otherwise go the way she is already falling off.
        const pushed = c.app.controls.boomPush;
        const side = peek<MainDrill>(c, 'mainDrill')?.chosen || (pushed > 0 ? 1 : pushed < 0 ? -1 : tackOf(c.snap));
        return backTheMain(side);
      },
    }),
  ],
  quiz: [
    {
      q: 'In irons and drifting backwards, the rudder…',
      options: ['works as usual', 'works in reverse', 'does nothing at all'],
      correct: 1,
      why: 'With the water flowing past it from behind, the rudder turns the boat the opposite way.',
    },
    {
      q: 'The jib is held out (backed) on the port side. Which way does the bow turn?',
      options: ['To port', 'To starboard'],
      correct: 1,
      why: 'The wind presses on the back of the jib and pushes the bow away from the side it is held on.',
    },
    {
      q: 'In irons, you ease the mainsheet and push the boom out to port. Which tack do you sail away on?',
      options: ['Port tack', 'Starboard tack'],
      correct: 1,
      why: 'The backed main drives her backwards and swings the bow toward the boom, so the wind comes over the starboard side — and on starboard tack the boom sits out to port, where you pushed it.',
    },
  ],
};
