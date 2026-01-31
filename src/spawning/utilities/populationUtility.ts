/**
 * Population Utility Module
 *
 * Utility calculations based on creep populations.
 * Handles diminishing returns, TTL awareness, and role ratios.
 */

import { diminishingReturns } from "../../utils/smoothing";

/**
 * Diminishing returns for adding more of the same role
 * First creep has high utility, each additional has less
 *
 * @param currentCount Current number of creeps with this role
 * @param optimalCount Target number for this role
 */
export function roleCountUtility(currentCount: number, optimalCount: number): number {
  if (optimalCount <= 0) return 0;

  if (currentCount >= optimalCount) {
    // Over optimal: steep dropoff
    return Math.max(0, 1 - (currentCount - optimalCount) * 0.5);
  }

  // Under optimal: diminishing returns curve
  // Utility is higher when we have fewer creeps
  const deficit = optimalCount - currentCount;
  return diminishingReturns(currentCount, optimalCount / 2);
}

/**
 * TTL-aware count - don't count creeps about to die
 *
 * @param creeps List of creeps to filter
 * @param role Role to count
 * @param ttlThreshold Ignore creeps with TTL below this
 */
export function getEffectiveCount(
  creeps: Creep[],
  role: string,
  ttlThreshold: number = 100
): number {
  return creeps.filter(
    (c) => c.memory.role === role && (!c.ticksToLive || c.ticksToLive > ttlThreshold)
  ).length;
}

/**
 * Get count of creeps dying soon (below TTL threshold)
 */
export function getDyingCount(
  creeps: Creep[],
  role: string,
  ttlThreshold: number = 100
): number {
  return creeps.filter(
    (c) =>
      c.memory.role === role && c.ticksToLive !== undefined && c.ticksToLive <= ttlThreshold
  ).length;
}

/**
 * Role ratio utility
 * Ensures balanced populations (e.g., haulers per harvester)
 *
 * @param roleCount Number of this role
 * @param referenceCount Number of the reference role
 * @param targetRatio Desired ratio of role to reference
 */
export function ratioUtility(
  roleCount: number,
  referenceCount: number,
  targetRatio: number
): number {
  if (referenceCount === 0) {
    // No reference creeps - this role shouldn't spawn
    return roleCount === 0 ? 0 : 0.1;
  }

  const currentRatio = roleCount / referenceCount;
  const deviation = Math.abs(currentRatio - targetRatio) / targetRatio;

  // High utility when under ratio, low when over
  if (currentRatio < targetRatio) {
    return 1 - deviation * 0.5;
  } else {
    return Math.max(0, 1 - deviation);
  }
}

/**
 * Deficit-based utility
 * Returns higher utility when more creeps are needed
 *
 * @param currentCount Current number of creeps
 * @param targetCount Desired number of creeps
 */
export function deficitUtility(currentCount: number, targetCount: number): number {
  const deficit = targetCount - currentCount;
  if (deficit <= 0) return 0;

  // Scale from 0 (no deficit) to 1 (large deficit)
  return Math.min(deficit / Math.max(targetCount, 1), 1);
}

/**
 * Critical shortage utility
 * Returns very high utility when a role has zero creeps
 *
 * @param currentCount Current number of creeps
 * @param isEssential Whether this role is critical for survival
 */
export function shortageUtility(currentCount: number, isEssential: boolean): number {
  if (!isEssential) return 0;

  if (currentCount === 0) return 10; // Emergency priority
  if (currentCount === 1) return 2; // High priority for redundancy

  return 0;
}

/**
 * Get optimal count for a role based on RCL and colony state
 *
 * @param role The role to get optimal count for
 * @param rcl Current RCL
 * @param sources Number of sources in room
 * @param hasStorage Whether room has storage
 */
export function getOptimalCount(
  role: string,
  rcl: number,
  sources: number,
  hasStorage: boolean
): number {
  switch (role) {
    case "HARVESTER":
      return sources; // 1 per source

    case "HAULER":
      // More haulers with storage, fewer early game
      if (!hasStorage) return sources;
      return Math.max(2, sources);

    case "UPGRADER":
      // Scale with RCL, max at 8
      if (rcl === 8) return 1; // 15/tick cap at RCL8
      return Math.min(rcl, 3);

    case "BUILDER":
      // Based on construction needs, handled separately
      return 0;

    default:
      return 0;
  }
}

/**
 * Combined population utility for a role
 * Considers count, TTL, and deficit
 */
export function populationUtility(
  creeps: Creep[],
  role: string,
  optimalCount: number,
  ttlThreshold: number = 100
): number {
  const effectiveCount = getEffectiveCount(creeps, role, ttlThreshold);
  const dyingCount = getDyingCount(creeps, role, ttlThreshold);

  // Effective deficit includes dying creeps
  const effectiveDeficit = optimalCount - effectiveCount;

  if (effectiveDeficit <= 0 && dyingCount === 0) return 0;

  // Base utility from role count
  const countUtil = roleCountUtility(effectiveCount, optimalCount);

  // Boost for replacement spawning
  const replacementBoost = dyingCount > 0 ? 0.3 : 0;

  return countUtil + replacementBoost;
}
