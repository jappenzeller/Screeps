/**
 * BaseEvaluator - Abstract base class for utility-based decision evaluators
 *
 * Each evaluator owns one decision domain. It reads WorldState + WeightTable
 * and produces scored options. It never executes anything.
 */

import {
  Evaluator,
  ScoredOption,
  FactorBreakdown,
  WorldState,
  ColonySnapshot,
  FrameworkAction,
} from "./types";

// ============================================================================
// BASE EVALUATOR CLASS
// ============================================================================

/**
 * Abstract base class for evaluators.
 * Provides common utilities for scoring and factor tracking.
 */
export abstract class BaseEvaluator<T extends FrameworkAction> implements Evaluator<T> {
  abstract readonly domain: string;

  /**
   * Evaluate options for a colony.
   * Override this in subclasses.
   */
  abstract evaluate(state: WorldState, colony: ColonySnapshot): ScoredOption<T>[];

  /**
   * Create a scored option with factor breakdown
   */
  protected createOption(
    action: T,
    label: string,
    baseScore: number,
    factors: FactorBreakdown
  ): ScoredOption<T> {
    // Calculate final score from factors
    let score = baseScore;

    for (const factorName in factors) {
      const factor = factors[factorName];
      score *= 1 + factor.contribution;
    }

    // Bound to 0-100 WITHOUT losing ordering.
    //
    // This was Math.min(100, score), which is a threshold wearing a score's clothes: in
    // E43N39 both UPGRADER and LINK_FILLER computed above the ceiling and arrived as an
    // exact 100/100 tie, so the evaluator had no opinion between them and arbitration
    // fell through to array order - a static priority list, which is precisely what the
    // framework was built to replace. A scoring system that saturates degrades into a
    // branching one exactly where the decisions matter most.
    //
    // Below the knee nothing changes; above it, scores are compressed asymptotically
    // toward 100. The mapping is strictly monotonic, so a genuinely stronger option
    // always outranks a weaker one no matter how large either grows.
    const raw = Math.max(0, score);
    score = softCeiling(raw);

    return {
      action,
      score: Math.round(score * 10) / 10,
      raw: Math.round(raw * 10) / 10,
      factors,
      label,
    };
  }

  /**
   * Add a multiplicative factor to the breakdown
   */
  protected addFactor(
    factors: FactorBreakdown,
    name: string,
    raw: number,
    weight: number,
    contribution: number
  ): void {
    factors[name] = { raw, weight, contribution };
  }

  /**
   * Compute a deficit factor (more deficit = higher contribution)
   */
  protected deficitFactor(current: number, target: number, weight: number): number {
    const deficit = target - current;
    if (deficit <= 0) return -0.5 * weight; // Surplus = negative contribution
    return Math.min(deficit, 3) / 3 * weight; // Cap at 3 deficit
  }

  /**
   * Compute a saturation factor (diminishing returns)
   */
  protected saturationFactor(current: number, target: number, weight: number): number {
    if (current === 0 || target === 0) return 0;
    const ratio = current / target;
    if (ratio >= 1.0) return -0.9; // Already saturated
    return -(ratio * weight); // More saturated = more negative
  }

  /**
   * Compute an RCL penalty factor
   */
  protected rclFactor(currentRcl: number, minRcl: number, penalty: number): number {
    if (currentRcl >= minRcl) return 0; // No penalty
    return penalty - 1; // Convert 0.1 penalty to -0.9 contribution
  }

  /**
   * Log evaluation results for debugging
   * Enable with: Memory.debug = { showEvaluations: true }
   */
  protected logEvaluation(colony: string, options: ScoredOption<T>[]): void {
    // Only log when explicitly enabled via Memory.debug.showEvaluations
    if (!Memory.debug?.showEvaluations) return;
    if (options.length === 0) return;

    const top3 = options.slice(0, 3);
    const summary = top3.map((o) => `${o.label}: ${o.score}`).join(", ");
    console.log(`[${this.domain}] ${colony}: ${summary}`);
  }
}

// ============================================================================
// FACTOR UTILITIES
// ============================================================================

/**
 * Utility functions for common factor calculations
 */
export const FactorUtils = {
  /**
   * Linear interpolation between min and max
   */
  lerp(value: number, min: number, max: number): number {
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  },

  /**
   * Inverse linear interpolation (high value = low result)
   */
  inverseLerp(value: number, min: number, max: number): number {
    return 1 - this.lerp(value, min, max);
  },

  /**
   * Exponential decay (value 0 = 1.0, value infinity = 0)
   */
  decay(value: number, rate: number = 0.1): number {
    return Math.exp(-rate * value);
  },

  /**
   * Sigmoid function (smooth 0-1 transition)
   */
  sigmoid(value: number, midpoint: number = 0, steepness: number = 1): number {
    return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
  },

  /**
   * Clamp a value between min and max
   */
  clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  },

  /**
   * Calculate distance penalty (closer = better)
   */
  distancePenalty(distance: number, maxDistance: number = 50): number {
    return 1 - Math.min(distance / maxDistance, 1);
  },

  /**
   * Calculate economy health (0-1)
   */
  economyHealth(netFlow: number, harvestIncome: number): number {
    if (harvestIncome === 0) return 0.5; // No income = neutral
    if (netFlow >= 0) return 1.0; // Positive flow = healthy
    return Math.max(0.1, 1 + netFlow / harvestIncome);
  },
};

// ============================================================================
// SCORE BOUNDING
// ============================================================================

/** Scores below this are passed through untouched. */
const SOFT_CEILING_KNEE = 90;

/** Larger values compress more gently above the knee. */
const SOFT_CEILING_SCALE = 60;

/**
 * Map [0, inf) onto [0, 100) monotonically, leaving everything below the knee unchanged.
 *
 * Replaces a hard Math.min(100, x), which mapped every strong option onto the same value
 * and silently destroyed the ranking among them.
 */
export function softCeiling(score: number): number {
  if (score <= SOFT_CEILING_KNEE) return score;
  const headroom = 100 - SOFT_CEILING_KNEE;
  return SOFT_CEILING_KNEE + headroom * (1 - Math.exp(-(score - SOFT_CEILING_KNEE) / SOFT_CEILING_SCALE));
}
