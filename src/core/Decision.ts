/**
 * Decision - the single scoring primitive.
 *
 * Every decision this bot makes has the same shape: enumerate the options, score each as
 * a base weight times some factors, take the highest. That shape was implemented five
 * separate times - utilitySpawning, the framework's SpawnEvaluator, and the Hauler,
 * Upgrader and Builder roles - and each copy independently reintroduced the same failure
 * mode, because the failure mode lives in the arithmetic rather than in any one caller.
 *
 * Upgrader.ts and Builder.ts had reached byte-identical scoring lines by copy-paste.
 *
 * The defects this module makes structurally impossible:
 *
 *   1. ANNIHILATING ZERO. A factor of 0 wipes out the whole product, so one input reading
 *      zero silently deletes an option that other factors rated highly. Observed: haulers
 *      scored spawn delivery `hasFiller ? 0 : 90` and abandoned a room holding 586,590
 *      energy with 11 in the spawn; upgrader utility read a starved room as unaffordable
 *      for days because its sustainability factor hit zero. Factors are floored here, so
 *      a factor can suppress an option almost completely but never erase it. To exclude
 *      an option, do not offer it - `consider()` simply is not called. Exclusion is a
 *      statement about the option set, not a score of zero.
 *
 *   2. SATURATING CEILING. A hard `Math.min(100, score)` maps every strong option onto
 *      the same number, so the ranking vanishes exactly where the decisions matter and
 *      arbitration silently falls through to array order - a static priority list wearing
 *      a score's clothes. Observed: E43N39 scored LINK_FILLER 116 and UPGRADER 107, both
 *      became 100, and array order handed the win to the weaker option. Bounding here is
 *      order-preserving.
 *
 *   3. EMPTY-SET AMBIGUITY. "No option scored well" and "there were no options" are
 *      different situations that a single `null` conflates, and callers routinely treat
 *      the second as the first and idle. `best()` reports which one happened.
 *
 * The general rule behind all three: a predicate that gates progress must have a release
 * condition. Scoring is how that rule is enforced by construction rather than by review.
 */

/**
 * Smallest multiplier a factor may contribute.
 *
 * Not zero, deliberately. A factor at the floor suppresses an option by two orders of
 * magnitude - it will lose to any live alternative - but the option remains reachable if
 * everything else is worse, which is precisely the case the annihilating zero got wrong.
 */
export const FACTOR_FLOOR = 0.01;

/** Scores below the knee pass through untouched; above it they compress toward the cap. */
const CEILING_KNEE = 90;
const CEILING_CAP = 100;
const CEILING_SCALE = 60;

/**
 * Distance at which proximity has halved. Large enough that need dominates distance:
 * proximity should break ties, never override a real deficit.
 */
export const DISTANCE_HALF_LIFE = 25;

/** How much of a score is fixed vs. driven by supply/urgency. */
const FLOOR_SHARE = 0.4;

export interface ScoredChoice<T> {
  target: T;
  label: string;
  /** Bounded score, comparable across candidates. */
  score: number;
  /** Pre-ceiling score. Above the cap means the option was in the saturated band. */
  raw: number;
}

/** Why `best()` returned nothing. Callers need to tell these apart. */
export type EmptyReason = "no-candidates" | "none";

/**
 * Map [0, inf) onto [0, CEILING_CAP) monotonically, leaving low scores untouched.
 *
 * Strictly increasing, so a genuinely stronger option always outranks a weaker one no
 * matter how large either grows - unlike a hard clamp, which discards that information.
 */
export function softCeiling(score: number): number {
  if (score <= CEILING_KNEE) return score;
  const headroom = CEILING_CAP - CEILING_KNEE;
  return CEILING_KNEE + headroom * (1 - Math.exp(-(score - CEILING_KNEE) / CEILING_SCALE));
}

/**
 * How much a supply covers a need, as a multiplier.
 *
 * Capped at full coverage so a huge store does not beat a closer adequate one on size
 * alone, and floored so a partially-stocked option stays in contention.
 */
export function supplyFactor(available: number, needed: number): number {
  if (needed <= 0) return 1;
  const covered = Math.min(available / needed, 1);
  return FLOOR_SHARE + (1 - FLOOR_SHARE) * covered;
}

/**
 * How badly a store wants filling, as a multiplier. The mirror of supplyFactor: an empty
 * sink scores 1, a nearly-full one scores FLOOR_SHARE.
 */
export function urgencyFactor(free: number, capacity: number): number {
  if (capacity <= 0) return FLOOR_SHARE;
  return FLOOR_SHARE + (1 - FLOOR_SHARE) * Math.min(free / capacity, 1);
}

/** Nearer is better, but never decisively. Never reaches zero. */
export function proximityFactor(range: number): number {
  return 1 / (1 + Math.max(range, 0) / DISTANCE_HALF_LIFE);
}

/**
 * Accumulates candidates and returns the best.
 *
 * Streaming rather than array-building: roles call this per creep per tick, so it holds
 * one object and no per-candidate allocation.
 */
export class Chooser<T> {
  private bestTarget: T | null = null;
  private bestLabel = "";
  private bestRaw = -1;
  private seen = 0;

  /**
   * Offer one option.
   *
   * `base` is the option's standing weight; `factors` scale it. Any factor at or below
   * zero is lifted to FACTOR_FLOOR rather than annihilating the product - see the header.
   * A base of zero means "never choose this", which is a contradiction: do not offer it.
   */
  consider(target: T, label: string, base: number, ...factors: number[]): void {
    if (base <= 0) return; // Not a candidate at all; scoring it zero would be a lie.

    this.seen++;
    let score = base;
    for (let i = 0; i < factors.length; i++) {
      const f = factors[i];
      score *= f > FACTOR_FLOOR ? f : FACTOR_FLOOR;
    }

    if (score > this.bestRaw) {
      this.bestRaw = score;
      this.bestTarget = target;
      this.bestLabel = label;
    }
  }

  /** How many options were offered. Zero means the world had none, not that all lost. */
  get candidateCount(): number {
    return this.seen;
  }

  /** The winner, or null when nothing was offered. */
  best(): ScoredChoice<T> | null {
    if (this.bestTarget === null) return null;
    return {
      target: this.bestTarget,
      label: this.bestLabel,
      score: Math.round(softCeiling(this.bestRaw) * 10) / 10,
      raw: Math.round(this.bestRaw * 10) / 10,
    };
  }

  /**
   * Why there is no winner. `no-candidates` means nothing was offered - a fact about the
   * room, which usually calls for a different action rather than idling.
   */
  emptyReason(): EmptyReason {
    return this.seen === 0 ? "no-candidates" : "none";
  }
}
