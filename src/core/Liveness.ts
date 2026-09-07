/**
 * Liveness - reports systems that are not running, or run without ever doing anything.
 *
 * Every expensive defect this codebase has produced was silent. Not one threw, appeared
 * in a log, or stopped the colony:
 *
 *   - MemoryManager.cleanup() was never called by anything. The stale-colony purge and
 *     the scout mortality tracking both lived there, so both silently never ran - the
 *     mortality tracking was dead from the day it shipped.
 *   - The framework's spawn arm executed every tick and failed 191 times out of 191.
 *   - The remote evaluator proposed a room it could never activate 75,429 times, then
 *     12,275 more after the first fix.
 *   - The advisor billed $351/month with no token usage recorded anywhere.
 *
 * Each was found by a person going to look, days or weeks late. The discovery rate for
 * every other class of bug is set by this one, which is why it is worth a module.
 *
 * Two questions, and an uncalled function cannot answer the first about itself:
 *
 *   1. Did this run at all?  ->  requires a DECLARED expectation (`expect`)
 *   2. Did running accomplish anything?  ->  `ran` vs `acted`
 *
 * A system that runs and never acts is not necessarily broken - a defender evaluator in a
 * quiet week correctly does nothing. The report states the fact and leaves the judgement
 * to the reader, because the alternative is a threshold that silences real findings.
 *
 * Cheap by construction: counters live in heap, `ran()` is a couple of property writes,
 * and only a small summary reaches Memory on an interval.
 */

import { logger } from "../utils/Logger";

interface LivenessStat {
  /** Times the system was observed running. */
  ran: number;
  /** Times running produced real work. */
  acted: number;
  /** Tick it last ran, 0 if never. */
  lastRan: number;
  /** Tick it last did something, 0 if never. */
  lastActed: number;
  /** How often it is expected to run, in ticks. Used to judge "stopped". */
  everyTicks: number;
  /**
   * Whether this system reports its productive work via acted().
   *
   * Without it, ALWAYS_NOOP cannot be distinguished from "nobody instrumented this", and
   * a registry that emits findings it cannot substantiate teaches you to ignore it - the
   * exact failure it exists to prevent.
   */
  tracksActs: boolean;
}

const stats: Record<string, LivenessStat> = {};

/** Tick this heap was initialised. Global resets on every code push. */
let bootTick = 0;

/**
 * Grace period after a code push before absence is treated as a finding.
 *
 * Global is wiped on deploy, so everything looks dead for a moment. Long enough to
 * outlast the slowest declared cadence below, short enough to surface a dead system
 * within one play session.
 */
const BOOT_GRACE = 1500;

/** Multiple of a system's declared cadence after which silence counts as stopped. */
const STOPPED_MULTIPLE = 3;

/** How often the heap counters are summarised into Memory for export. */
const FLUSH_INTERVAL = 100;

export type LivenessFindingType = "NEVER_RAN" | "ALWAYS_NOOP" | "STOPPED";

export interface LivenessFinding {
  system: string;
  type: LivenessFindingType;
  /** Human-readable detail - counts and ticks, not advice. */
  detail: string;
}

/**
 * Declare that a system is supposed to run.
 *
 * This is the half that catches dead code, so it has to be written where the system is
 * WIRED UP, not inside the system itself - a declaration inside an uncalled function is
 * as silent as the function.
 *
 * @param everyTicks how often it should run; 1 for every-tick systems.
 * @param tracksActs whether the system calls acted(). Only these can report ALWAYS_NOOP.
 */
export function expect(name: string, everyTicks = 1, tracksActs = false): void {
  if (!bootTick) bootTick = Game.time;
  if (!stats[name]) {
    stats[name] = { ran: 0, acted: 0, lastRan: 0, lastActed: 0, everyTicks, tracksActs };
  } else {
    stats[name].everyTicks = everyTicks;
    stats[name].tracksActs = tracksActs;
  }
}

/** Record that a system executed. */
export function ran(name: string): void {
  const s = stats[name];
  if (!s) return; // Undeclared - expect() is the registration point.
  s.ran++;
  s.lastRan = Game.time;
}

/**
 * Record that running accomplished something - a creep spawned, a site placed, a config
 * changed. Call alongside `ran`, not instead of it.
 */
export function acted(name: string): void {
  const s = stats[name];
  if (!s) return;
  s.acted++;
  s.lastActed = Game.time;
}

/**
 * Systems that are not running, or run without ever acting.
 *
 * Returns facts, not verdicts. "Ran 4,000 times, never acted" is worth a human look
 * whether or not it turns out to be correct behaviour.
 */
export function report(): LivenessFinding[] {
  const findings: LivenessFinding[] = [];
  if (!bootTick) return findings;

  const age = Game.time - bootTick;
  if (age < BOOT_GRACE) return findings; // Still settling after a deploy.

  for (const name in stats) {
    const s = stats[name];

    if (s.ran === 0) {
      findings.push({
        system: name,
        type: "NEVER_RAN",
        detail: `declared, but has not run in ${age} ticks`,
      });
      continue;
    }

    const silentFor = Game.time - s.lastRan;
    if (silentFor > s.everyTicks * STOPPED_MULTIPLE) {
      findings.push({
        system: name,
        type: "STOPPED",
        detail: `last ran ${silentFor} ticks ago, expected every ${s.everyTicks}`,
      });
      continue;
    }

    // Only claim a no-op for systems that actually report their work. Silence from an
    // uninstrumented system is absence of evidence, not evidence of absence.
    if (s.tracksActs && s.acted === 0) {
      findings.push({
        system: name,
        type: "ALWAYS_NOOP",
        detail: `ran ${s.ran} times, never did anything`,
      });
    }
  }

  return findings;
}

/** Full counters, for the console command. */
export function snapshot(): Record<string, LivenessStat & { name: string }> {
  const out: Record<string, LivenessStat & { name: string }> = {};
  for (const name in stats) out[name] = { name, ...stats[name] };
  return out;
}

/**
 * Summarise findings into Memory so they ride to the advisor in segment 90.
 *
 * Only findings are written, never the full counter set - the point is a short list a
 * person or the advisor will actually read, and Memory is already half full.
 */
export function maybeFlush(): void {
  if (Game.time % FLUSH_INTERVAL !== 0) return;

  const findings = report();
  const mem = Memory as unknown as { _liveness?: LivenessFinding[] };

  if (findings.length === 0) {
    if (mem._liveness) delete mem._liveness;
    return;
  }

  mem._liveness = findings;
  for (const f of findings) {
    logger.warn("Liveness", `${f.type} ${f.system}: ${f.detail}`);
  }
}
