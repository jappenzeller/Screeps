/**
 * ThresholdMonitor - measures how often a boundary condition BINDS.
 *
 * The recurring defect in this codebase is not a wrong number, it is a predicate that
 * blocks progress with no way past it. Those are invisible in code review and expensive
 * to find by hand: the sustainability factor that refused every upgrader in E43N39 had
 * been pinned at zero for days while a million energy went unspent, and it took a manual
 * investigation to notice.
 *
 * A threshold that blocks 95% of the time, for hundreds of consecutive ticks, is doing
 * damage - and you can see that without knowing anything about what it guards. One that
 * never blocks is dead weight. That turns "audit 263 constants" into "here are the two
 * boundaries currently constraining this colony", which is a question worth asking.
 *
 * Deliberately cheap: counters live in heap and only a small summary is written to
 * Memory, on an interval. Instrument the gates that decide whether work happens, not
 * every comparison in the codebase.
 */

interface ThresholdStat {
  /** Times the gate was evaluated. */
  evaluated: number;
  /** Times it blocked - the branch was not taken because of this condition. */
  bound: number;
  /** Tick the current unbroken run of blocking began, 0 when not currently blocking. */
  boundSince: number;
  /** Longest unbroken run of blocking observed. */
  longestBind: number;
}

const stats: Record<string, ThresholdStat> = {};

/** How often the heap counters are summarised into Memory for export. */
const FLUSH_INTERVAL = 100;

/** Only report thresholds that actually blocked, and only the worst few. */
const MAX_REPORTED = 6;

/** Below this bind rate a threshold is not worth reporting. */
const MIN_REPORT_RATE = 0.5;

export interface ThresholdReport {
  name: string;
  /** Fraction of evaluations that blocked, 0..1. */
  rate: number;
  evaluated: number;
  /** Longest unbroken run of blocking, in ticks. */
  longestBind: number;
  /** Ticks it has been blocking right now, 0 if currently passing. */
  bindingNow: number;
}

export class ThresholdMonitor {
  /**
   * Record the outcome of a gate and return it unchanged.
   *
   * Wrap the condition rather than replacing it, so instrumenting a threshold cannot
   * change behaviour:
   *
   *   if (ThresholdMonitor.gate("upgrader.sustainable", factor > 0)) { ... }
   */
  static gate(name: string, passed: boolean): boolean {
    let s = stats[name];
    if (!s) {
      s = stats[name] = { evaluated: 0, bound: 0, boundSince: 0, longestBind: 0 };
    }

    s.evaluated++;

    if (passed) {
      if (s.boundSince > 0) {
        const run = Game.time - s.boundSince;
        if (run > s.longestBind) s.longestBind = run;
        s.boundSince = 0;
      }
    } else {
      s.bound++;
      if (s.boundSince === 0) s.boundSince = Game.time;
    }

    return passed;
  }

  /** Thresholds that are actually constraining something, worst first. */
  static report(): ThresholdReport[] {
    const out: ThresholdReport[] = [];

    for (const name in stats) {
      const s = stats[name];
      if (s.evaluated === 0) continue;

      const rate = s.bound / s.evaluated;
      const bindingNow = s.boundSince > 0 ? Game.time - s.boundSince : 0;

      // A gate blocking most of the time, or currently stuck in a long run, is the
      // signal. Everything else is noise and should not travel to AWS.
      if (rate < MIN_REPORT_RATE && bindingNow < 100) continue;

      out.push({
        name,
        rate: Math.round(rate * 100) / 100,
        evaluated: s.evaluated,
        longestBind: Math.max(s.longestBind, bindingNow),
        bindingNow,
      });
    }

    out.sort((a, b) => b.longestBind - a.longestBind || b.rate - a.rate);
    return out.slice(0, MAX_REPORTED);
  }

  /**
   * Persist the summary so it survives a global reset and can ride to AWS.
   * Rate-limited; call every tick.
   */
  static flush(): void {
    if (Game.time % FLUSH_INTERVAL !== 0) return;
    if (!Memory.stats) return;

    const report = this.report();
    if (report.length > 0) {
      Memory.stats.thresholds = report;
    } else {
      delete Memory.stats.thresholds;
    }
  }

  /** Everything measured, including gates that never bind. For the console command. */
  static all(): Array<ThresholdReport & { bound: number }> {
    const out: Array<ThresholdReport & { bound: number }> = [];
    for (const name in stats) {
      const s = stats[name];
      if (s.evaluated === 0) continue;
      const bindingNow = s.boundSince > 0 ? Game.time - s.boundSince : 0;
      out.push({
        name,
        rate: Math.round((s.bound / s.evaluated) * 100) / 100,
        evaluated: s.evaluated,
        bound: s.bound,
        longestBind: Math.max(s.longestBind, bindingNow),
        bindingNow,
      });
    }
    out.sort((a, b) => b.rate - a.rate);
    return out;
  }
}
