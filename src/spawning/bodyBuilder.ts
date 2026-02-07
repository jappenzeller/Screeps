/**
 * Body Builder - Generic Algorithm
 *
 * Builds appropriately scaled creep bodies based on BodyConfig definitions.
 * Handles move ratio calculation, part sorting, and energy constraints.
 */

import { BodyConfig, BODY_CONFIGS, getMinEnergyCost } from "./bodyConfig";

/**
 * Build a body for a given role with available energy
 */
export function buildBody(role: string, energy: number): BodyPartConstant[] {
  const config = BODY_CONFIGS[role];
  if (!config) {
    console.log(`[BodyBuilder] No config for role: ${role}`);
    return [];
  }

  return buildBodyFromConfig(config, energy);
}

/**
 * Build a body from a BodyConfig with available energy
 */
export function buildBodyFromConfig(config: BodyConfig, energy: number): BodyPartConstant[] {
  // Check minimum energy
  if (config.minEnergy && energy < config.minEnergy) {
    return [];
  }

  // Calculate fallback cost
  const fallbackCost = config.fallback ? calculateCost(config.fallback) : 0;

  // If we can only afford the fallback, use it
  if (config.fallback && energy < fallbackCost * 1.5) {
    if (energy >= fallbackCost) {
      return sortBodyParts([...config.fallback], config.sortForCombat);
    }
    return [];
  }

  // Build the body
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  // Add prefix parts first (e.g., TOUGH buffer)
  if (config.prefix) {
    const prefixCost = calculateCost(config.prefix);
    if (remaining >= prefixCost) {
      parts.push(...config.prefix);
      remaining -= prefixCost;
    }
  }

  // Calculate how many times we can repeat the pattern
  const patternCost = calculateCost(config.pattern);
  const maxRepeats = config.maxRepeats || Math.floor(50 / config.pattern.length);
  let repeats = 0;

  // For non-pattern move modes, we need to reserve energy for MOVE parts
  const needsMoveParts = config.moveMode !== "pattern";
  const moveRatio = getMoveRatio(config.moveMode);

  if (needsMoveParts) {
    // Calculate pattern + required moves as a unit
    while (repeats < maxRepeats && parts.length < 48) {
      const nonMoveParts = config.pattern.filter((p) => p !== MOVE);
      const patternNonMoves = nonMoveParts.length;
      const movesNeeded = Math.ceil(patternNonMoves * moveRatio);
      const unitCost = patternCost + movesNeeded * BODYPART_COST[MOVE];

      if (remaining < unitCost) break;

      parts.push(...config.pattern);
      remaining -= unitCost; // FIXED: Reserve energy for MOVE parts
      repeats++;
    }
  } else {
    // Pattern already includes MOVE parts in correct ratio
    while (repeats < maxRepeats && parts.length + config.pattern.length <= 48) {
      if (remaining < patternCost) break;

      parts.push(...config.pattern);
      remaining -= patternCost;
      repeats++;
    }
  }

  // Add suffix parts (e.g., CARRY for harvesters)
  if (config.suffix) {
    const suffixCost = calculateCost(config.suffix);
    if (remaining >= suffixCost && parts.length + config.suffix.length <= 50) {
      parts.push(...config.suffix);
      remaining -= suffixCost;
    }
  }

  // Add MOVE parts for non-pattern modes
  if (needsMoveParts) {
    const existingMoves = parts.filter((p) => p === MOVE).length;
    const nonMoveParts = parts.filter((p) => p !== MOVE).length;
    const movesNeeded = Math.ceil(nonMoveParts * moveRatio);
    const movesToAdd = Math.max(0, movesNeeded - existingMoves);

    for (let i = 0; i < movesToAdd && parts.length < 50 && remaining >= 50; i++) {
      parts.push(MOVE);
      remaining -= 50;
    }
  }

  // If we couldn't build anything useful, use fallback
  if (parts.length < 3 && config.fallback && energy >= fallbackCost) {
    return sortBodyParts([...config.fallback], config.sortForCombat);
  }

  // CRITICAL: Guarantee at least 1 MOVE for any creep that needs to move
  // Even "static" miners need to reach their position after spawning
  const hasMoveMode = config.moveMode !== "pattern";
  const currentMoves = parts.filter((p) => p === MOVE).length;
  if (hasMoveMode && currentMoves === 0 && parts.length < 50) {
    // Try to add 1 MOVE by removing lowest-priority part if needed
    const moveCost = BODYPART_COST[MOVE];
    if (remaining >= moveCost) {
      parts.push(MOVE);
    } else if (parts.length > 2) {
      // Not enough energy - sacrifice a WORK or CARRY to afford MOVE
      // This is better than a completely stuck creep
      const removedPart = parts.pop()!;
      const refund = BODYPART_COST[removedPart];
      if (refund + remaining >= moveCost) {
        parts.push(MOVE);
      } else {
        // Put it back, we can't afford the swap
        parts.push(removedPart);
      }
    }
  }

  return sortBodyParts(parts, config.sortForCombat);
}

/**
 * Sort body parts for combat efficiency:
 * - TOUGH first (damage soak)
 * - Combat parts in middle
 * - HEAL and MOVE last (protected)
 */
function sortBodyParts(parts: BodyPartConstant[], sortForCombat?: boolean): BodyPartConstant[] {
  if (!sortForCombat) return parts;

  const priority: Record<BodyPartConstant, number> = {
    [TOUGH]: 0,
    [WORK]: 1,
    [CARRY]: 2,
    [ATTACK]: 3,
    [RANGED_ATTACK]: 4,
    [CLAIM]: 5,
    [HEAL]: 6,
    [MOVE]: 7,
  };

  return parts.sort((a, b) => priority[a] - priority[b]);
}

/**
 * Get the MOVE ratio for a movement mode
 */
function getMoveRatio(mode: BodyConfig["moveMode"]): number {
  switch (mode) {
    case "road":
      return 0.5; // 1 MOVE per 2 other parts
    case "plains":
      return 1; // 1 MOVE per 1 other part
    case "swamp":
      return 5; // 5 MOVE per 1 other part
    case "static":
      return 0.2; // Minimal movement (1 MOVE per 5 parts, min 1)
    case "pattern":
      return 0; // Pattern handles its own MOVE parts
    default:
      return 0.5;
  }
}

/**
 * Calculate energy cost of body parts
 */
export function calculateCost(parts: BodyPartConstant[]): number {
  return parts.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

/**
 * Get the minimum cost for a role
 */
export function getMinCost(role: string): number {
  return getMinEnergyCost(role);
}

/**
 * Minimum energy cost lookup for each role (for backwards compatibility)
 */
export const ROLE_MIN_COST: Record<string, number> = {
  HARVESTER: getMinEnergyCost("HARVESTER"),
  HAULER: getMinEnergyCost("HAULER"),
  UPGRADER: getMinEnergyCost("UPGRADER"),
  BUILDER: getMinEnergyCost("BUILDER"),
  DEFENDER: getMinEnergyCost("DEFENDER"),
  REMOTE_MINER: getMinEnergyCost("REMOTE_MINER"),
  REMOTE_HAULER: getMinEnergyCost("REMOTE_HAULER"),
  REMOTE_DEFENDER: getMinEnergyCost("REMOTE_DEFENDER"),
  RESERVER: getMinEnergyCost("RESERVER"),
  CLAIMER: getMinEnergyCost("CLAIMER"),
  SCOUT: getMinEnergyCost("SCOUT"),
  LINK_FILLER: getMinEnergyCost("LINK_FILLER"),
  UPGRADE_HAULER: getMinEnergyCost("UPGRADE_HAULER"),
  RANGED_ATTACKER: getMinEnergyCost("RANGED_ATTACKER"),
  COMBAT_HEALER: getMinEnergyCost("COMBAT_HEALER"),
};
