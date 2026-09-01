/**
 * Smoothing Utilities
 *
 * Reusable math functions for utility calculations.
 * These provide smooth transitions instead of hard cutoffs.
 */

/**
 * Linear interpolation
 */
/**
 * Stand-in for a zero factor in a geometric mean.
 *
 * Small enough that it survives the n-th root as a decisive suppression: at four factors
 * it yields ~0.006, at three ~0.001. Its only job is to keep the result nonzero so a
 * suppressed option remains reachable when every alternative is worse.
 */
const UTILITY_EPSILON = 1e-9;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Smooth step (ease in/out)
 * Returns 0 at edge0, 1 at edge1, smooth transition between
 */
export function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Sigmoid curve centered at midpoint
 * Returns ~0 at low values, ~1 at high values, 0.5 at midpoint
 * Steepness controls how sharp the transition is
 */
export function sigmoid(x: number, midpoint: number, steepness: number = 1): number {
  return 1 / (1 + Math.exp(-steepness * (x - midpoint)));
}

/**
 * Diminishing returns curve
 * First items have high value, additional items provide less
 * Returns value between 0 and 1
 *
 * @param count Current count
 * @param halfPoint Count at which utility is 0.5
 */
export function diminishingReturns(count: number, halfPoint: number = 2): number {
  return halfPoint / (halfPoint + count);
}

/**
 * Inverse diminishing returns - utility increases with count but saturates
 * Returns value between 0 and 1
 *
 * @param count Current count
 * @param saturationPoint Count at which utility approaches 1
 */
export function saturatingReturns(count: number, saturationPoint: number = 5): number {
  return 1 - Math.exp(-count / saturationPoint);
}

/**
 * Clamped linear scale
 * Maps value from [inMin, inMax] to [outMin, outMax]
 */
export function scale(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number = 0,
  outMax: number = 1
): number {
  const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

/**
 * Combine multiple utility factors
 * Uses geometric mean to ensure all factors matter
 * A single 0 factor results in 0 output
 */
export function combineUtilities(...factors: number[]): number {
  if (factors.length === 0) return 0;
  // Floored, not clamped to zero. A geometric mean annihilates on any single zero, so one
  // factor reading zero deletes a role every other factor rated highly - which is exactly
  // how the upgrader's sustainability factor read E43N39 as unaffordable for days while
  // the room held most of a million energy. A factor may suppress a role to near-nothing;
  // it may not erase it. core/Decision enforces the same rule at the choosing layer.
  //
  // The epsilon is far below core/Decision's FACTOR_FLOOR on purpose: the n-th root pulls
  // it back toward 1, so a floor of 0.01 across four factors would only suppress by ~3x
  // rather than decisively. UTILITY_EPSILON is chosen so the combined result stays tiny
  // after the root for any realistic factor count.
  const product = factors.reduce((a, b) => a * Math.max(UTILITY_EPSILON, b), 1);
  return Math.pow(product, 1 / factors.length);
}

/**
 * Combine utilities with weights
 * Weighted geometric mean
 */
export function combineWeighted(
  factors: { value: number; weight: number }[]
): number {
  if (factors.length === 0) return 0;

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  if (totalWeight === 0) return 0;

  let product = 1;
  for (const f of factors) {
    product *= Math.pow(Math.max(UTILITY_EPSILON, f.value), f.weight / totalWeight);
  }

  return product;
}

/**
 * Urgency multiplier based on deficit
 * Returns higher values when deficit is larger
 */
export function urgencyMultiplier(deficit: number, maxDeficit: number = 5): number {
  if (deficit <= 0) return 0;
  return Math.min(deficit / maxDeficit, 2);
}
