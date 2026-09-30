// Audio demo: the procedural soundscape driven by a fake SimSnapshot built from the sliders on the page.
// Nothing here is physics — it only exercises the mappings: wind (AWS², brightness, whistle, pan by wind direction
// relative to the camera), water (speed, roll, heel), flogging sails (luffing, and the thud when they fill), winch
// clicks (sheet trim), spinnaker (collapse, refill) and the boom crash. Sound starts on the "Start sound" click (a user gesture), as it will in the app.
// Handy for scripted checks: `window.__audioDemo` = { sound, set(id, value), press(id) }.
import { Soundscape } from '../src/audio/Soundscape';
import { event, snapshotFrom } from '../src/audio/__tests__/fixtures';
import { DEG, KN } from '../src/shared/math';
import type { SimEvent } from '../src/sim/types';

declare global {
  interface Window {
    __ready?: boolean;
    __audioDemo?: { sound: Soundscape; set(id: string, value: number | boolean): void; press(id: string): void };
  }
}

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
const num = (id: string): number => Number(input(id).value);

const FORMAT: Record<string, (v: number) => string> = {
  aws: (v) => `${v.toFixed(1)} kn`,
  awa: (v) => `${Math.abs(v).toFixed(0)}° ${v >= 0 ? 'stbd' : 'port'}`,
  speed: (v) => `${v.toFixed(1)} kn`,
  heel: (v) => `${v.toFixed(0)}°`,
  roll: (v) => `${v.toFixed(2)} rad/s`,
  yaw: (v) => (v === 0 ? 'ahead' : `${Math.abs(v).toFixed(0)}° ${v > 0 ? 'stbd' : 'port'}`),
  trim: (v) => (Math.abs(v) < 0.02 ? 'steady' : v < 0 ? `hauling in ${Math.abs(v).toFixed(2)}` : `easing ${v.toFixed(2)}`),
  mainLuff: (v) => v.toFixed(2),
  jibLuff: (v) => v.toFixed(2),
  spinCollapsed: (v) => v.toFixed(2),
  crashRate: (v) => `${v.toFixed(1)} rad/s`,
  volume: (v) => `${Math.round(v * 100)} %`,
};

function refreshOutputs(): void {
  for (const out of document.querySelectorAll<HTMLOutputElement>('output[data-for]')) {
    const id = out.dataset['for']!;
    out.textContent = (FORMAT[id] ?? String)(num(id));
  }
}

const PRESETS: Record<string, Record<string, number | boolean>> = {
  'Drifting, 4 kn': { aws: 4, awa: 60, speed: 1.2, heel: 3, roll: 0.02, mainLuff: 0, jibLuff: 0, spinSet: false, spinCollapsed: 0 },
  'Close-hauled, 12 kn': { aws: 16, awa: 28, speed: 5.5, heel: 18, roll: 0.02, mainLuff: 0, jibLuff: 0, spinSet: false, spinCollapsed: 0 },
  'Beam reach, 18 kn': { aws: 20, awa: 75, speed: 7.2, heel: 20, roll: 0.05, mainLuff: 0, jibLuff: 0, spinSet: false, spinCollapsed: 0 },
  'Running, light': { aws: 5, awa: 150, speed: 3, heel: 3, roll: 0.02, mainLuff: 0, jibLuff: 0, spinSet: false, spinCollapsed: 0 },
  'Luffing: main flogs': { aws: 12, awa: 20, speed: 3, heel: 6, roll: 0.05, mainLuff: 0.9, jibLuff: 0, spinSet: false, spinCollapsed: 0 },
  'In irons: both flog': { aws: 10, awa: 2, speed: 0.4, heel: 0, roll: 0.06, mainLuff: 1, jibLuff: 1, spinSet: false, spinCollapsed: 0 },
  'Gale, 30 kn': { aws: 30, awa: 40, speed: 7.5, heel: 32, roll: 0.15, mainLuff: 0, jibLuff: 0, spinSet: false, spinCollapsed: 0 },
  'Hauling sheets': { aws: 9, awa: 40, speed: 4, heel: 10, roll: 0.02, mainLuff: 0, jibLuff: 0, spinSet: false, spinCollapsed: 0, trim: -0.3 },
  'Spinnaker collapsed': { aws: 9, awa: 135, speed: 4, heel: 4, roll: 0.02, mainLuff: 0, jibLuff: 0, spinSet: true, spinCollapsed: 1 },
};

function setControl(id: string, value: number | boolean): void {
  const e = input(id);
  if (typeof value === 'boolean') e.checked = value;
  else e.value = String(value);
  e.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---- sound + state ----------------------------------------------------------------------------------------

const sound = new Soundscape();
const status = el('status');
const startBtn = el<HTMLButtonElement>('start');
const muteBtn = el<HTMLButtonElement>('mute');
let enabled = true;
let simT = 0;
let prevCollapsed = 0;
let jibClew = 0.5;
const pending: SimEvent[] = [];

startBtn.addEventListener('click', () => {
  void sound.start().then(() => {
    startBtn.hidden = true;
    muteBtn.hidden = false;
    refreshStatus();
  });
});

muteBtn.addEventListener('click', () => {
  enabled = !enabled;
  sound.setEnabled(enabled);
  muteBtn.textContent = enabled ? 'Mute' : 'Unmute';
  muteBtn.classList.toggle('on', !enabled);
  refreshStatus();
});

function refreshStatus(): void {
  const live = sound.running && enabled;
  status.textContent = !sound.context ? 'silent — press Start sound' : !enabled ? 'muted' : sound.running ? `sound on · ${sound.context.state}` : 'starting…';
  status.classList.toggle('live', live);
}

input('volume').addEventListener('input', () => sound.setVolume(num('volume')));

el('crash').addEventListener('click', () => pending.push(event('crashGybe', simT, { rate: num('crashRate') })));
el('refill').addEventListener('click', () => pending.push(event('spinRefill', simT)));
el('collapse').addEventListener('click', () => pending.push(event('spinCollapse', simT)));

for (const id of Object.keys(FORMAT)) input(id).addEventListener('input', refreshOutputs);
for (const [name, values] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.addEventListener('click', () => {
    setControl('trim', 0);
    for (const [id, v] of Object.entries(values)) setControl(id, v);
  });
  el('presets').append(b);
}
refreshOutputs();

// ---- output display ---------------------------------------------------------------------------------------

const scope = el<HTMLCanvasElement>('scope');
const spectrum = el<HTMLCanvasElement>('spectrum');
const meters = el('meters');
const rows = ['Wind roar level', 'Water rush level', 'Flogging level', 'Flutter rate', 'Spinnaker rustle', 'Wind pan', 'Output RMS', 'Output peak'];
rows.forEach((label, i) => {
  const row = document.createElement('div');
  row.textContent = label;
  const value = document.createElement('b');
  value.id = `m${i}`;
  value.textContent = '–';
  row.append(value);
  meters.append(row);
});
const meter = (i: number, text: string): void => { el(`m${i}`).textContent = text; };
const time = new Float32Array(2048);
const freq = new Float32Array(1024);

function drawScope(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.strokeStyle = '#7cc4ff';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const v = time[Math.floor((x / w) * time.length)]!;
    const y = h / 2 - Math.max(-1, Math.min(1, v)) * (h / 2 - 3);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number, sampleRate: number): void {
  ctx.clearRect(0, 0, w, h);
  const fmin = 40, fmax = 16000;
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.font = '11px system-ui';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  for (const f of [100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 3);
  }
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#ffb547'); grad.addColorStop(1, '#2b6fb3');
  ctx.fillStyle = grad;
  const bin = sampleRate / 2 / freq.length;
  for (let x = 0; x < w; x += 2) {
    const f0 = fmin * (fmax / fmin) ** (x / w), f1 = fmin * (fmax / fmin) ** ((x + 2) / w);
    const a = Math.max(1, Math.floor(f0 / bin)), b = Math.max(a + 1, Math.ceil(f1 / bin));
    let m = -140;
    for (let k = a; k < b && k < freq.length; k++) m = Math.max(m, freq[k]!);
    const t = Math.max(0, Math.min(1, (m + 110) / 90)); // −110 … −20 dBFS
    ctx.fillRect(x, h - 16 - t * (h - 22), 2, t * (h - 22));
  }
}

const scopeCtx = scope.getContext('2d')!;
const specCtx = spectrum.getContext('2d')!;
// Before the sound starts, show the empty axes rather than two black boxes.
drawScope(scopeCtx, scope.width, scope.height);
freq.fill(-140);
drawSpectrum(specCtx, spectrum.width, spectrum.height, 48000);
specCtx.fillStyle = 'rgba(255,255,255,.55)';
specCtx.font = '15px system-ui';
specCtx.fillText('Press "Start sound" to see the live spectrum', 24, 34);
const db = (x: number): string => `${(20 * Math.log10(Math.max(x, 1e-6))).toFixed(1)} dBFS`;

// ---- the frame loop ---------------------------------------------------------------------------------------

let last = performance.now();
let costSum = 0;
let costN = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  simT += dt;

  const collapsed = num('spinCollapsed');
  if (input('spinSet').checked) {
    if (prevCollapsed < 0.5 && collapsed >= 0.5) pending.push(event('spinCollapse', simT));
    if (prevCollapsed >= 0.5 && collapsed < 0.5) pending.push(event('spinRefill', simT));
  }
  prevCollapsed = collapsed;

  // The trim slider fakes a crew hauling (−) or easing (+): the boom moves at that rate and the jib clew follows.
  const trim = num('trim');
  jibClew = Math.min(0.8, Math.max(0.1, jibClew + trim * dt));

  const gust = input('gusts').checked ? 1 + 0.18 * Math.sin(simT * 0.7) + 0.12 * Math.sin(simT * 1.9 + 1) : 1;
  const snap = snapshotFrom({
    t: simT,
    aws: num('aws') * KN * gust,
    awa: num('awa') * DEG,
    heading: 0,
    speed: num('speed') * KN,
    heel: num('heel') * DEG,
    rollRate: num('roll'),
    mainLuff: num('mainLuff'),
    jibLuff: num('jibLuff'),
    boomAngle: 0.35,
    boomRate: trim,
    clewAngle: jibClew,
    spinSet: input('spinSet').checked,
    spinCollapsed: collapsed,
    spinCurl: collapsed > 0.5 ? 1 : collapsed,
    events: pending.splice(0),
  });
  const t0 = performance.now();
  sound.update(snap, num('yaw') * DEG, dt);
  costSum += performance.now() - t0;
  costN++;

  const analyser = sound.analyser();
  if (analyser) {
    analyser.getFloatTimeDomainData(time);
    analyser.getFloatFrequencyData(freq);
    drawScope(scopeCtx, scope.width, scope.height);
    drawSpectrum(specCtx, spectrum.width, spectrum.height, sound.context!.sampleRate);
    let sum = 0, pk = 0;
    for (const v of time) { sum += v * v; pk = Math.max(pk, Math.abs(v)); }
    meter(6, db(Math.sqrt(sum / time.length)));
    meter(7, db(pk));
  }
  const d = sound.drives;
  meter(0, d.windRoar.toFixed(3));
  meter(1, d.water.toFixed(3));
  meter(2, d.flog.toFixed(2));
  meter(3, `${d.flutterHz.toFixed(1)} Hz`);
  meter(4, d.spinRustle.toFixed(2));
  meter(5, d.windPan.toFixed(2));
  el('pan').style.left = `${50 + 46 * d.windPan}%`;
  if ((now | 0) % 8 === 0) refreshStatus();
  requestAnimationFrame(frame);
}

window.__audioDemo = {
  sound,
  set: setControl,
  press: (id) => el(id).click(),
};
Object.defineProperty(window.__audioDemo, 'updateMs', { get: () => (costN ? costSum / costN : 0) });
requestAnimationFrame(frame);
window.__ready = true;
