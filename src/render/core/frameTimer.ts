// Frame cost for the quality governor (spec §9.2, review I-2). rAF intervals are quantised by vsync — every
// interval on a 60 Hz display is ≥ 16.7 ms — so they cannot show headroom; this measures what a frame costs.
//
//   GPU  one EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query around the frame's rendering. Results arrive
//        1–3 frames late; frames flagged GPU_DISJOINT are dropped. On ANGLE/Metal the query spans the frame's
//        GPU timeline including waits between passes (measured: it tracks pass count more than pixels), so it
//        errs high — the safe side for a step-up decision.
//   CPU  main-thread busy time from begin() to end().
// `cost.ms` = max(CPU, latest GPU) once a GPU result has landed, else CPU busy time with `cost.gpu = false`
// (Safari exposes no timer query; the governor then treats a failed step-up as final).
//
// Usage per frame:  timer.begin()  …all work and rendering…  timer.end()  governor.sample(rawMs, now, timer.cost)
import type * as THREE from 'three';
import type { FrameCost } from './quality';

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** In-flight queries kept at most; older ones are abandoned (a stalled GPU cannot grow the list). */
const MAX_PENDING = 8;

export class FrameTimer {
  /** Latest frame cost; the same object is updated in place every frame. */
  readonly cost: FrameCost = { ms: Number.NaN, gpu: false };
  /** Latest CPU busy time (ms). */
  cpuMs = Number.NaN;
  /** Latest GPU time (ms) from the timer query; NaN until the first result or when unavailable. */
  gpuMs = Number.NaN;

  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt | null;
  private active: WebGLQuery | null = null;
  private readonly pending: WebGLQuery[] = [];
  private readonly spare: WebGLQuery[] = [];
  private startedAt = 0;

  /** `gpu: false` skips the timer query (CPU busy time only). */
  constructor(renderer: THREE.WebGLRenderer, options: { gpu?: boolean } = {}) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = options.gpu === false ? null : (this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null);
  }

  /** True when GPU time is being measured on this browser. */
  get hasGpuTimer(): boolean {
    return this.ext !== null;
  }

  /** Call at the start of the frame, before any of its work. */
  begin(): void {
    this.collect();
    this.startedAt = performance.now();
    if (!this.ext || this.active) return;
    const query = this.spare.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  /** Call after the frame's last draw call. */
  end(): void {
    this.cpuMs = performance.now() - this.startedAt;
    if (this.ext && this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
      while (this.pending.length > MAX_PENDING) this.gl.deleteQuery(this.pending.shift()!);
    }
    const gpu = Number.isFinite(this.gpuMs);
    this.cost.gpu = gpu;
    this.cost.ms = gpu ? Math.max(this.cpuMs, this.gpuMs) : this.cpuMs;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.ext && this.active) gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    for (const query of [...this.pending, ...this.spare, ...(this.active ? [this.active] : [])]) gl.deleteQuery(query);
    this.pending.length = 0;
    this.spare.length = 0;
    this.active = null;
  }

  /** Read finished queries in order; a disjoint GPU event invalidates everything in flight. */
  private collect(): void {
    const ext = this.ext;
    if (!ext || this.pending.length === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const query = this.pending[0]!;
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) this.gpuMs = (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
      this.pending.shift();
      this.spare.push(query);
    }
  }
}
