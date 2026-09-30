// Mock `SimSnapshot['sails']` for the sails demo: geometrically plausible sections built from a few
// direct controls, laid out the way the simulation lays them out (src/sim/sails/*), so the renderer sees
// realistic data before the real sim is wired in. Body frame: x fwd, y stbd, z down.
import { BOAT } from '../src/shared/boatSpec';
import type { JibState, MainState, SailSection, SimSnapshot, SpinnakerState, Telltale } from '../src/sim/types';
import { mainPlanChord } from '../src/render/sails/mainMesh';

const DEG = Math.PI / 180;
const G = BOAT.boom.gooseneck;
const P = BOAT.main.P;
const E = BOAT.main.E;
const J = BOAT.jib;
const S = BOAT.spinnaker;
const FOOT_H = Math.sqrt(J.foot ** 2 - (J.clewH - J.tack.h) ** 2);

export interface MockParams {
  /** Apparent wind angle at the masthead (deg, + from starboard) and speed (m/s). */
  awa: number;
  aws: number;
  /** Boom angle (deg, + to port) and jib clew angle seen from the tack (deg, + to port). */
  boom: number;
  clew: number;
  /** Depth/chord of main and jib; twist at the head (deg). */
  camber: number;
  jibCamber: number;
  twist: number;
  /** 0…1 luffing of main (backwinding near its luff) and jib, 0…1 stall of both. */
  mainLuff: number;
  jibLuff: number;
  stall: number;
  /** Jib furl 0 (out) … 1 (rolled). */
  furl: number;
  /** Spinnaker: set, hoist 0…1, curl 0…1, collapse 0…1, pole angle (deg), sheet 0 eased … 1 trimmed. */
  spin: boolean;
  hoist: number;
  curl: number;
  collapse: number;
  pole: number;
  spinSheet: number;
  /** Overrides the belly side of main and jib (−1 port … +1 stbd); null = from the wind. */
  side: number | null;
}

export function defaultMock(): MockParams {
  return {
    awa: 32, aws: 7, boom: 8, clew: 11, camber: 0.11, jibCamber: 0.12, twist: 9,
    mainLuff: 0, jibLuff: 0, stall: 0, furl: 0,
    spin: false, hoist: 1, curl: 0, collapse: 0, pole: 55, spinSheet: 0.5, side: null,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
const smooth = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function section(h: number, luff: SailSection['luff'], dir: { x: number; y: number }, chord: number, camber: number, draft: number, side: number, luffing: number, stall: number, aoa: number): SailSection {
  return {
    h, luff, chordDir: { x: dir.x, y: dir.y, z: 0 }, chord, camber, draft, leewardY: side, aoa,
    luffing: clamp(luffing, 0, 1), stall: clamp(stall, 0, 1), cl: 0, cd: 0, q: 0,
  };
}

const empty = { force: { x: 0, y: 0, z: 0 }, ce: { x: 0, y: 0, z: 0 }, lift: 0, drag: 0, drive: 0, heelForce: 0 };

/** Point on a section's surface at chord fraction u (the sim's parabolic camber line). */
function surfacePoint(s: SailSection, u: number): SailSection['luff'] {
  const c = s.chordDir, p = s.draft;
  const f = u < p ? (2 * p * u - u * u) / (p * p) : (1 - 2 * p + 2 * p * u - u * u) / ((1 - p) * (1 - p));
  const d = s.camber * s.chord * f * Math.sign(s.leewardY || 1);
  return { x: s.luff.x + c.x * u * s.chord + c.y * d, y: s.luff.y + c.y * u * s.chord - c.x * d, z: s.luff.z };
}

function sectionAt(ss: SailSection[], h: number): SailSection {
  let i = 0;
  while (i < ss.length - 2 && ss[i + 1]!.h < h) i++;
  const a = ss[i]!, b = ss[i + 1]!, t = clamp((h - a.h) / (b.h - a.h), 0, 1);
  const cx = lerp(a.chordDir.x, b.chordDir.x, t), cy = lerp(a.chordDir.y, b.chordDir.y, t), cl = Math.hypot(cx, cy) || 1;
  return {
    ...a, h,
    luff: { x: lerp(a.luff.x, b.luff.x, t), y: lerp(a.luff.y, b.luff.y, t), z: lerp(a.luff.z, b.luff.z, t) },
    chordDir: { x: cx / cl, y: cy / cl, z: 0 }, chord: lerp(a.chord, b.chord, t), camber: lerp(a.camber, b.camber, t),
    leewardY: lerp(a.leewardY, b.leewardY, t),
  };
}

export function mockMain(p: MockParams): MainState {
  const ws = p.awa >= 0 ? 1 : -1;
  const side = p.side ?? -ws;
  const beta = p.boom * DEG;
  const sections: SailSection[] = [];
  for (let i = 0; i < 8; i++) {
    const h = (i + 0.5) / 8;
    const theta = beta + Math.sign(beta || ws) * p.twist * DEG * Math.pow(h, 1.4);
    sections.push(section(h, { x: G.x, y: 0, z: -(G.h + h * P) }, { x: -Math.cos(theta), y: -Math.sin(theta) }, mainPlanChord(h),
      p.camber * (0.85 + 0.25 * Math.sin(Math.PI * h)), 0.46, side,
      p.mainLuff * (0.75 + 0.5 * h), p.stall * (1.15 - 0.4 * h), Math.abs(p.awa * DEG) - Math.abs(theta)));
  }
  const telltales: Telltale[] = [0.2, 0.4, 0.6, 0.8].map((h) => {
    const s = sectionAt(sections, h);
    const state: Telltale['state'] = s.luffing > 0.6 ? 'fluttering' : s.stall > 0.5 ? 'stalled' : 'streaming';
    return { id: `main-leech-${Math.round(h * 100)}`, pos: surfacePoint(s, 1), side: 'leech', state, intensity: Math.max(s.luffing, s.stall) };
  });
  return {
    id: 'main', set: true, area: BOAT.main.area, ...empty,
    tack: { x: G.x, y: 0, z: -G.h },
    clew: { x: G.x - Math.cos(beta) * E, y: -Math.sin(beta) * E, z: -G.h },
    head: { x: G.x, y: 0, z: -(G.h + P) },
    sections, telltales, boomAngle: beta, boomRate: 0, twistDeg: p.twist,
  };
}

export function mockJib(p: MockParams): JibState {
  const ws = p.awa >= 0 ? 1 : -1;
  const side = p.side ?? -ws;
  const gamma = p.clew * DEG;
  const f = 1 - clamp(p.furl, 0, 1);
  const tack = { x: J.tack.x, y: 0, z: -J.tack.h };
  const head = { x: J.head.x, y: 0, z: -J.head.h };
  const clew = { x: J.tack.x - FOOT_H * f * Math.cos(gamma), y: -FOOT_H * f * Math.sin(gamma), z: -(J.clewH + 2 * (1 - f)) };
  const clewH = -clew.z;
  const twist = p.twist * 0.9 * DEG;
  const tw = clamp(gamma / (5 * DEG), -1, 1);
  const zB = J.tack.h + 0.08, zT = J.head.h - 0.3, dz = (zT - zB) / 8;
  const sections: SailSection[] = [];
  for (let i = 0; i < 8; i++) {
    const z = zB + (i + 0.5) * dz;
    const s = (z - J.tack.h) / (J.head.h - J.tack.h);
    const luff = { x: lerp(tack.x, head.x, s), y: 0, z: -z };
    const k = z >= clewH ? (z - clewH) / (J.head.h - clewH) : 0;
    const lx = z >= clewH ? lerp(clew.x, head.x, k) : lerp(tack.x, clew.x, (z - J.tack.h) / Math.max(clewH - J.tack.h, 1e-3));
    const ly = z >= clewH ? lerp(clew.y, 0, k) : lerp(0, clew.y, (z - J.tack.h) / Math.max(clewH - J.tack.h, 1e-3));
    let dx = lx - luff.x, dy = ly;
    const chord = Math.max(Math.hypot(dx, dy), 0.02);
    dx /= chord; dy /= chord;
    const a = tw * twist * Math.pow(s, 1.2);
    const dir = { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
    sections.push(section(s, luff, dir, chord, p.jibCamber * (0.95 + 0.1 * Math.sin(Math.PI * s)), 0.42, side,
      p.jibLuff * (0.7 + 0.6 * s), p.stall * (1.1 - 0.3 * s), Math.abs(p.awa * DEG) - Math.abs(gamma)));
  }
  const set = p.furl < 0.97;
  const telltales: Telltale[] = [];
  if (set) {
    for (const h of [0.25, 0.5, 0.75]) {
      const s = sectionAt(sections, h);
      const pos = surfacePoint(s, 0.12);
      const lift = smooth(0.15, 0.45, s.luffing);
      const windward: Telltale['state'] = s.luffing > 0.6 ? 'fluttering' : lift > 0.35 ? 'lifting' : 'streaming';
      const leeward: Telltale['state'] = s.luffing > 0.85 ? 'fluttering' : s.stall > 0.5 ? 'stalled' : 'streaming';
      const portLee = s.leewardY < 0;
      const pct = Math.round(h * 100);
      telltales.push({ id: `jib-port-${pct}`, pos, side: 'port', state: portLee ? leeward : windward, intensity: portLee ? s.stall : Math.max(lift, s.luffing) });
      telltales.push({ id: `jib-stbd-${pct}`, pos, side: 'stbd', state: portLee ? windward : leeward, intensity: portLee ? Math.max(lift, s.luffing) : s.stall });
    }
  }
  return {
    id: 'jib', set, area: J.area * f, ...empty, tack, clew, head, sections, telltales,
    clewAngle: gamma, furl: clamp(p.furl, 0, 1), backed: false, whisker: false,
  };
}

export function mockSpinnaker(p: MockParams): SpinnakerState {
  const ws = p.awa >= 0 ? 1 : -1;
  const hoist = p.spin ? clamp(p.hoist, 0, 1) : 0;
  const a = clamp(p.pole, 0, 90) * DEG;
  const tipH = 2.4;
  const reach = Math.sqrt(Math.max(S.poleLength ** 2 - (tipH - S.poleMastH) ** 2, 0.1));
  const mastFront = BOAT.mast.x + BOAT.mast.sectionBase[0] / 2;
  const tack = { x: mastFront + reach * Math.cos(a), y: ws * reach * Math.sin(a), z: -tipH };
  const HEAD = { x: S.head.x + 0.35, y: 0, z: -(S.head.h - 0.15) };
  // Chord angle ψ from straight ahead toward leeward: across the boat on a run, aft-leeward on a reach.
  const psi = (90 + (180 - Math.abs(p.awa)) * 0.45 + (0.5 - p.spinSheet) * -24) * DEG;
  const c = { x: Math.cos(psi), y: -ws * Math.sin(psi) };
  const clew = { x: tack.x + S.foot * c.x, y: tack.y + S.foot * c.y, z: tack.z };
  // Belly toward the flow's side of the chord: s · (c.y, −c.x).
  const w = { x: -Math.cos(p.awa * DEG), y: -Math.sin(p.awa * DEG) };
  const cw = w.x * c.x + w.y * c.y;
  const nx = w.x - cw * c.x, ny = w.y - cw * c.y;
  const side = nx * c.y - ny * c.x >= 0 ? 1 : -1;
  const footH = tipH, topH = -HEAD.z;
  const sections: SailSection[] = [];
  for (let i = 0; i < 6; i++) {
    const t = (i + 0.5) / 6;
    const bow = 0.6 * Math.sin(Math.PI * t);
    sections.push(section(t, {
      x: lerp(tack.x, HEAD.x, t) + bow * Math.cos(a), y: lerp(tack.y, 0, t) + bow * ws * Math.sin(a), z: -(footH + t * (topH - footH)),
    }, c, S.foot * (1 - t) + 1.3 * Math.sin(Math.PI * t), 0.26 + 0.03 * (1 - p.spinSheet), 0.45, side, 0, 0, 0));
  }
  return {
    id: 'spinnaker', set: hoist > 0.01, area: S.area * hoist, ...empty, tack, clew,
    head: { x: HEAD.x, y: 0, z: HEAD.z + (1 - hoist) * (-HEAD.z - 1.2) },
    sections, telltales: [], hoist, poleAngle: a, poleTip: tack, poleHeight: tipH,
    collapsed: clamp(p.collapse, 0, 1), curl: clamp(p.curl, 0, 1),
  };
}

export function mockSails(p: MockParams): SimSnapshot['sails'] {
  return { main: mockMain(p), jib: mockJib(p), spinnaker: mockSpinnaker(p) };
}

/** Apparent wind at the masthead and (twisted forward, slower) at deck height. */
export function mockWind(p: MockParams): { awa: number; aws: number; awaDeck: number; awsDeck: number } {
  const awa = p.awa * DEG;
  return { awa, aws: p.aws, awaDeck: awa * 0.93, awsDeck: p.aws * 0.8 };
}
