// Browser-side driver for the offline-render tests: plays a Scenario through the real Soundscape on an
// OfflineAudioContext (frame by frame, exactly as the app's loop would) and hands the rendered samples back to Node
// as base64 float32, plus the measured cost of every update() call. Loaded by soundscape.test.ts in headless Chromium.
import { Soundscape, type SoundDrives } from '../Soundscape';
import { ScenarioPlayer, type Scenario } from './scenario';

export interface RenderResult {
  sampleRate: number;
  left: string;
  right: string;
  frames: number;
  update: { meanMs: number; p95Ms: number; maxMs: number };
  drives: SoundDrives;
  /** Wall-clock time the offline render took (ms) — an estimate of the audio thread's load. */
  renderMs: number;
  /** Time start() took to build the graph and generate the noise (ms): a one-off hitch on the first user gesture. */
  startMs: number;
  /** The first exception thrown by update() or the scheduler during the render, if any (null = clean). */
  error: string | null;
}

function toBase64(x: Float32Array): string {
  const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(scn: Scenario): Promise<RenderResult> {
  const sr = scn.sampleRate ?? 48000;
  const fps = scn.frameRate ?? 60;
  const ctx = new OfflineAudioContext(2, Math.round(scn.seconds * sr), sr);
  const sound = new Soundscape({ context: ctx, seed: scn.seed });
  if (scn.enabled === false) sound.setEnabled(false);
  if (scn.volume !== undefined) sound.setVolume(scn.volume);
  const startAt = performance.now();
  if (!scn.skipStart) await sound.start();
  const startMs = performance.now() - startAt;
  for (const [layer, gain] of Object.entries(scn.layers ?? {})) sound.setLayerLevel(layer as 'wind', gain);

  const player = new ScenarioPlayer(scn);
  const dt = 1 / fps;
  const frames = Math.floor(scn.seconds * fps);
  const cost = new Float64Array(frames);
  let n = 0;
  let muted = false;
  let error: string | null = null;
  const step = (k: number): void => {
    if (!muted && scn.muteAt !== undefined && k * dt >= scn.muteAt) {
      muted = true;
      sound.setEnabled(false);
    }
    const { snap, yaw } = player.next(k * dt);
    const t0 = performance.now();
    sound.update(snap, yaw, dt);
    cost[n++] = performance.now() - t0;
  };

  try {
    step(0);
  } catch (err) {
    error = `frame 0: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
  const quantum = 128 / sr;
  // `staticRender`: one update at t = 0, then straight through — measures the audio graph alone, without the
  // per-frame suspend/resume round trips.
  for (let k = 1; !scn.staticRender && k < frames; k++) {
    const at = Math.ceil((k * dt) / quantum) * quantum;
    ctx.suspend(at).then(
      () => {
        // Whatever update() does, the render must go on — a throw here would leave the context suspended forever.
        try {
          step(k);
        } catch (err) {
          error ??= `frame ${k}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
        }
        void ctx.resume();
      },
      (err: unknown) => { error ??= `suspend(${at}) rejected: ${String(err)}`; },
    );
  }

  const started = performance.now();
  const out = await ctx.startRendering();
  const renderMs = performance.now() - started;
  const sorted = cost.slice(0, n).sort();
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const result: RenderResult = {
    sampleRate: sr,
    left: toBase64(out.getChannelData(0)),
    right: scn.stereo ? toBase64(out.getChannelData(1)) : '',
    frames: n,
    update: { meanMs: mean, p95Ms: sorted[Math.floor(n * 0.95)] ?? 0, maxMs: sorted[n - 1] ?? 0 },
    drives: { ...sound.drives },
    renderMs,
    startMs,
    error,
  };
  sound.dispose();
  return result;
}

declare global {
  interface Window {
    audioHarness: { render(scn: Scenario): Promise<RenderResult> };
    __ready?: boolean;
  }
}

window.audioHarness = { render };
window.__ready = true;
