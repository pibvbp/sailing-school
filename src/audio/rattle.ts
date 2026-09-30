// Blocks, boom and rig rattling after a hard snap or a boom crash.
import { bandpass, gainNode, pulse, pulseMore } from './nodes';
import type { NoiseBank } from './nodes';
import type { Rng } from './noise';

/** Blocks and boom rattling: noise excited through four ringing metallic bands, hit in a decaying, uneven pattern. */
export class RigRattle {
  private readonly gate: GainNode;

  constructor(ctx: BaseAudioContext, bank: NoiseBank, dest: AudioNode, private readonly rng: Rng) {
    this.gate = gainNode(ctx, 0);
    bank.loop(bank.white).connect(this.gate);
    for (const [hz, q, g] of [[1180, 28, 1], [1960, 34, 0.8], [3120, 40, 0.6], [4750, 44, 0.4]] as const) {
      this.gate.connect(bandpass(ctx, hz, q)).connect(gainNode(ctx, g)).connect(dest);
    }
  }

  /** `ticks` hits over roughly `span` seconds, each a little softer and further apart than the last. */
  trigger(t: number, amp: number, ticks: number, span: number): void {
    const rng = this.rng;
    this.gate.gain.cancelScheduledValues(t);
    let at = t;
    let a = amp;
    let gap = (span * 0.6) / ticks;
    for (let i = 0; i < ticks; i++) {
      (i === 0 ? pulse : pulseMore)(this.gate.gain, at, a * rng.range(0.55, 1), 0.0006, 0.011, i === ticks - 1);
      at += gap * rng.range(0.4, 1.6);
      a *= 0.86;
      gap *= 1.09;
    }
  }
}
