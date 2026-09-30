// A stand-in for the subset of WebAudio the soundscape uses, so the graph-building and per-frame logic can be
// tested in Node (which has no WebAudio). It is strict the way browsers are — non-finite values, negative times and
// exponential ramps to zero throw — and it counts every AudioParam call and remembers the value range each param
// was driven through. It renders no audio: signal-level checks run in Chromium (see soundscape.test.ts).

export class FakeParam {
  private current: number;
  /** Direct `.value = x` writes — each one is a step. Only graph construction and teardown should make any. */
  valueWrites = 0;
  calls = 0;
  min = Infinity;
  max = -Infinity;
  /** Largest and smallest target passed to setTargetAtTime / setValueAtTime. */
  targets = 0;
  lastTarget = Number.NaN;
  ramps = 0;
  linearRamps = 0;
  cancels = 0;
  /** Audio nodes connected into this param (modulation). */
  fedBy: FakeNode[] = [];
  /** When true, every automation call is appended to `log` as [method, ...args] (off by default: no allocation). */
  record = false;
  readonly log: Array<[string, ...number[]]> = [];
  /** setValueAtTime calls with a value other than 0 (the exact-0 that ends a fade is the only step the code should make). */
  nonZeroSteps = 0;

  constructor(readonly name: string, initial: number) {
    this.current = initial;
  }

  get value(): number {
    return this.current;
  }

  set value(v: number) {
    if (!Number.isFinite(v)) throw new TypeError(`${this.name}: non-finite value ${v}`);
    this.valueWrites++;
    this.current = v;
  }

  private check(v: number, t: number): void {
    if (!Number.isFinite(v)) throw new TypeError(`${this.name}: non-finite value ${v}`);
    if (!(t >= 0)) throw new RangeError(`${this.name}: negative or NaN time ${t}`);
  }

  private note(v: number): void {
    this.calls++;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  setValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (this.record) this.log.push(['setValueAtTime', v, t]);
    this.note(v);
    if (v !== 0) this.nonZeroSteps++;
    this.lastTarget = v;
    return this;
  }

  setTargetAtTime(v: number, t: number, tc: number): this {
    this.check(v, t);
    if (!(tc >= 0) || !Number.isFinite(tc)) throw new RangeError(`${this.name}: bad time constant ${tc}`);
    if (this.record) this.log.push(['setTargetAtTime', v, t, tc]);
    this.note(v);
    this.targets++;
    this.lastTarget = v;
    return this;
  }

  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (this.record) this.log.push(['linearRampToValueAtTime', v, t]);
    this.note(v);
    this.linearRamps++;
    return this;
  }

  exponentialRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (Math.abs(v) < 1.4e-45) throw new RangeError(`${this.name}: exponential ramp to ${v}`);
    if (this.record) this.log.push(['exponentialRampToValueAtTime', v, t]);
    this.note(v);
    this.ramps++;
    return this;
  }

  cancelScheduledValues(t: number): this {
    if (!(t >= 0)) throw new RangeError(`${this.name}: negative cancel time ${t}`);
    if (this.record) this.log.push(['cancelScheduledValues', t]);
    this.cancels++;
    return this;
  }
}

export class FakeNode {
  readonly kind: string;
  readonly out: FakeNode[] = [];
  constructor(kind: string) {
    this.kind = kind;
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (dest instanceof FakeNode) this.out.push(dest);
    else dest.fedBy.push(this);
    return dest;
  }
  disconnect(): void {
    this.out.length = 0;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam('gain', 1);
  constructor() { super('gain'); }
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam('biquad.frequency', 350);
  Q = new FakeParam('biquad.Q', 1);
  gain = new FakeParam('biquad.gain', 0);
  detune = new FakeParam('biquad.detune', 0);
  constructor() { super('biquad'); }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  playbackRate = new FakeParam('source.playbackRate', 1);
  started = false;
  constructor() { super('source'); }
  start(when = 0, offset = 0): void {
    if (this.started) throw new Error('InvalidStateError: start() called twice');
    if (!(when >= 0) || !(offset >= 0)) throw new RangeError('bad start arguments');
    this.started = true;
  }
  stop(): void { /* nothing to stop */ }
}

export class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam('osc.frequency', 440);
  detune = new FakeParam('osc.detune', 0);
  started = false;
  constructor() { super('osc'); }
  start(): void {
    if (this.started) throw new Error('InvalidStateError: start() called twice');
    this.started = true;
  }
  stop(): void { /* nothing to stop */ }
}

export class FakePanner extends FakeNode {
  pan = new FakeParam('pan', 0);
  constructor() { super('panner'); }
}

export class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = 'none';
  constructor() { super('shaper'); }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor() { super('analyser'); }
}

export class FakeBuffer {
  readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    if (numberOfChannels < 1 || length < 1 || sampleRate < 3000) throw new RangeError('bad buffer arguments');
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(c: number): Float32Array { return this.data[c]!; }
}

export class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'running';
  onstatechange: (() => void) | null = null;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  resumes = 0;
  suspends = 0;
  closed = false;
  /** Name of a create…() method that should throw (an old browser missing a node type). */
  failOn: string | null = null;
  /** resume() is accepted but the context stays locked (a touch that is not a gesture, an autoplay rule). */
  resumeBlocked = false;

  private make<T extends FakeNode>(name: string, n: T): T {
    if (this.failOn === name) throw new Error(`NotSupportedError: ${name}`);
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeGain { return this.make('createGain', new FakeGain()); }
  createBiquadFilter(): FakeBiquad { return this.make('createBiquadFilter', new FakeBiquad()); }
  createBufferSource(): FakeSource { return this.make('createBufferSource', new FakeSource()); }
  createOscillator(): FakeOscillator { return this.make('createOscillator', new FakeOscillator()); }
  createStereoPanner(): FakePanner { return this.make('createStereoPanner', new FakePanner()); }
  createWaveShaper(): FakeShaper { return this.make('createWaveShaper', new FakeShaper()); }
  createAnalyser(): FakeAnalyser { return this.make('createAnalyser', new FakeAnalyser()); }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer { return new FakeBuffer(channels, length, sampleRate); }

  private setState(state: FakeContext['state']): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
  }
  resume(): Promise<void> { this.resumes++; if (!this.resumeBlocked) this.setState('running'); return Promise.resolve(); }
  suspend(): Promise<void> { this.suspends++; this.setState('suspended'); return Promise.resolve(); }
  close(): Promise<void> { this.closed = true; this.setState('closed'); return Promise.resolve(); }
  /** The browser stops the context by itself (a phone call, a locked screen): not one of our suspend() calls. */
  interrupt(): void { this.setState('suspended'); }

  /** Every AudioParam on every node, for range checks. */
  params(): FakeParam[] {
    const out: FakeParam[] = [];
    for (const n of this.nodes) for (const v of Object.values(n)) if (v instanceof FakeParam) out.push(v);
    return out;
  }

  asContext(): BaseAudioContext {
    return this as unknown as BaseAudioContext;
  }
}

/** The end of the signal chain in a built graph, found by structure: duck → pre-gain → soft limiter → master → speakers. */
export function outputChain(ctx: FakeContext): { master: FakeGain; shaper: FakeShaper; pre: FakeGain; duck: FakeGain } {
  const into = (n: FakeNode): FakeNode[] => ctx.nodes.filter((m) => m.out.includes(n));
  const one = <T extends FakeNode>(nodes: FakeNode[], kind: string, what: string): T => {
    if (nodes.length !== 1 || nodes[0]!.kind !== kind) throw new Error(`expected exactly one ${kind} ${what}, found ${nodes.map((n) => n.kind).join(',') || 'none'}`);
    return nodes[0] as T;
  };
  const master = one<FakeGain>(into(ctx.destination), 'gain', 'feeding the destination');
  const shaper = one<FakeShaper>(into(master), 'shaper', 'feeding the master gain');
  const pre = one<FakeGain>(into(shaper), 'gain', 'feeding the limiter');
  const duck = one<FakeGain>(into(pre), 'gain', 'feeding the pre-gain');
  return { master, shaper, pre, duck };
}

export interface TimelineEvent { kind: 'value' | 'target' | 'linear' | 'exp'; v: number; t: number; tc: number }

/**
 * The automation timeline a recorded param ends up with, replaying its log the way WebAudio does: cancelScheduledValues(c)
 * drops every event at or after c, events sort by time (insertion order breaks ties).
 */
export function timeline(p: FakeParam): TimelineEvent[] {
  let events: TimelineEvent[] = [];
  for (const [method, a, b, c] of p.log) {
    switch (method) {
      case 'cancelScheduledValues': events = events.filter((e) => e.t < a!); break;
      case 'setValueAtTime': events.push({ kind: 'value', v: a!, t: b!, tc: 0 }); break;
      case 'setTargetAtTime': events.push({ kind: 'target', v: a!, t: b!, tc: c! }); break;
      case 'linearRampToValueAtTime': events.push({ kind: 'linear', v: a!, t: b!, tc: 0 }); break;
      case 'exponentialRampToValueAtTime': events.push({ kind: 'exp', v: a!, t: b!, tc: 0 }); break;
    }
  }
  return events.map((e, i) => ({ e, i })).sort((x, y) => x.e.t - y.e.t || x.i - y.i).map((x) => x.e);
}

