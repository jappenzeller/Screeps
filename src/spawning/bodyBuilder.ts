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
  FILLER: getMinEnergyCost("FILLER"),
  UPGRADE_HAULER: getMinEnergyCost("UPGRADE_HAULER"),
  RANGED_ATTACKER: getMinEnergyCost("RANGED_ATTACKER"),
  COMBAT_HEALER: getMinEnergyCost("COMBAT_HEALER"),
  ROAD_BUILDER: getMinEnergyCost("ROAD_BUILDER"),
  CONTROLLER_ATTACKER: getMinEnergyCost("CONTROLLER_ATTACKER"),
  DECOY: getMinEnergyCost("DECOY"),
  DEMOLISHER: getMinEnergyCost("DEMOLISHER"),
  RECLAIM_BLOCKER: getMinEnergyCost("RECLAIM_BLOCKER"),
};

/**
 * Decide how much energy a body should be built from.
 *
 * Sizing to energyCapacityAvailable is right only when a room can actually reach
 * capacity. Where it cannot, it is a deadlock dressed as a quality setting - and it was
 * the sole reason the declarative framework's executeSpawn() failed 191 times out of 191
 * with "Not enough energy" while utilitySpawning, which had this logic, spawned normally.
 *
 * Shared so both spawn paths agree. Two systems sizing bodies differently is how one of
 * them silently never spawns anything.
 */
export interface SpawnBudgetInputs {
  role: string;
  energyAvailable: number;
  energyCapacity: number;
  energyStored: number;
  harvesterCount: number;
  haulerCount: number;
  /** True when the controller is close enough to downgrade to justify a small creep now. */
  downgradeRisk: boolean;
  /** Sources in the room. Fewer harvesters than sources means income is not maxed. */
  sourceCount: number;
  /** Consecutive ticks a spawn was attempted and refused for lack of energy. */
  stalledTicks: number;
}

/** Stored energy above which a room is limited by refill throughput, not by energy. */
export const BANK_RICH_THRESHOLD = 50000;

/** Minimum fill fraction to build from, so a rich room still gets a sensible body. */
export const MIN_BODY_FILL = 0.6;

/**
 * Consecutive energy-refused spawn attempts after which we stop waiting for capacity.
 *
 * Long enough that a normal refill (haulers topping up extensions) is never interrupted,
 * short enough that a genuine deadlock is broken in well under a creep's lifetime.
 */
export const SPAWN_STALL_LIMIT = 150;

export function resolveSpawnEnergyBudget(i: SpawnBudgetInputs): {
  energy: number;
  reason: string;
} {
  const noHarvesters = i.harvesterCount === 0;
  const noHaulers = i.haulerCount === 0;

  if ((noHarvesters && noHaulers) || (noHarvesters && i.energyStored < 1000)) {
    return { energy: i.energyAvailable, reason: "emergency" };
  }
  if (i.role === "HAULER" && noHaulers) {
    return { energy: i.energyAvailable, reason: "hauler bootstrap" };
  }
  if (i.role === "UPGRADER" && i.downgradeRisk) {
    return { energy: i.energyAvailable, reason: "downgrade rescue" };
  }
  if (i.energyAvailable >= i.energyCapacity * 0.9) {
    return { energy: i.energyAvailable, reason: "nearly full" };
  }
  if (i.energyStored > BANK_RICH_THRESHOLD && i.energyAvailable >= i.energyCapacity * MIN_BODY_FILL) {
    return { energy: i.energyAvailable, reason: "throughput limited" };
  }

  // Waiting for capacity is only rational if capacity is reachable, and a room whose
  // income cannot fill its extensions will never reach it. E47N41 (RCL 7, capacity 4600)
  // was left with a single 200-energy harvester while both spawns sat idle at 617
  // available and its two sources sat full at 3,000 and 1,740: it could not afford a
  // capacity-sized body, so it built nothing, so income never recovered. A textbook
  // deadlock, and one this function introduced.
  //
  // Fewer harvesters than sources means the room is not extracting what it owns. Survival
  // beats optimality: build what is affordable now.
  if (i.harvesterCount < i.sourceCount) {
    return { energy: i.energyAvailable, reason: "understaffed" };
  }

  // General backstop, independent of why the room is poor: if we have actually tried to
  // spawn and been refused for energy this many consecutive ticks, the target is not
  // being approached and waiting longer is not a strategy. Every gate that blocks
  // progress needs a release; this is the one for capacity-sized bodies.
  if (i.stalledTicks >= SPAWN_STALL_LIMIT) {
    return { energy: i.energyAvailable, reason: "stalled" };
  }

  return { energy: i.energyCapacity, reason: "wait for capacity" };
}
