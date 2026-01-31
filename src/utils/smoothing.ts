/**
 * Smoothing Utilities
 *
 * Reusable math functions for utility calculations.
 * These provide smooth transitions instead of hard cutoffs.
 */

/**
 * Linear interpolation
 */
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
  const product = factors.reduce((a, b) => a * Math.max(0, b), 1);
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
    product *= Math.pow(Math.max(0, f.value), f.weight / totalWeight);
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
