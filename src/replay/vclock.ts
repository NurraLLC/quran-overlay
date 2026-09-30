// Virtual clock for replays: timers fire in order as time is advanced, never in real time.
import type { Clock } from '../server/tracker/scheduler';

export class VClock implements Clock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advanceTo(t: number) {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.timers[0];
      if (!n || n.at > t) break;
      this.timers.shift();
      this.t = n.at;
      n.fn();
    }
    this.t = Math.max(this.t, t);
  }
}
