/**
 * Body Configuration - Single Source of Truth
 *
 * Defines body part patterns for all roles.
 * Used by bodyBuilder.ts to generate appropriately scaled bodies.
 */

export interface BodyConfig {
  /** Core repeating pattern of body parts */
  pattern: BodyPartConstant[];
  /** Fixed parts at start (e.g., TOUGH for damage buffer) */
  prefix?: BodyPartConstant[];
  /** Fixed parts at end */
  suffix?: BodyPartConstant[];
  /** Maximum pattern repetitions (default: unlimited up to 50 parts) */
  maxRepeats?: number;
  /** Minimum energy required - returns empty if below this */
  minEnergy?: number;
  /** Emergency fallback body if energy is low but above minimum */
  fallback?: BodyPartConstant[];
  /** Movement mode determines move ratio:
   * - "road": 1 MOVE per 2 other parts (optimal for roads)
   * - "plains": 1 MOVE per 1 other part (full speed on plains)
   * - "swamp": 1 MOVE per 0.2 other parts (full speed in swamps)
   * - "static": minimal MOVE (sits in place)
   * - "pattern": uses MOVEs in pattern as-is
   */
  moveMode: "road" | "plains" | "swamp" | "static" | "pattern";
  /** If true, sort TOUGH first, HEAL last, MOVE last (combat optimization) */
  sortForCombat?: boolean;
}

/**
 * Body configurations for all roles
 */
export const BODY_CONFIGS: Record<string, BodyConfig> = {
  /**
   * HARVESTER - Static miner at sources
   * Goal: 5 WORK parts for max harvest (10 energy/tick)
   * Needs 1 CARRY to transfer to container
   */
  HARVESTER: {
    pattern: [WORK],
    suffix: [CARRY],
    maxRepeats: 5,
    minEnergy: 200,
    fallback: [WORK, CARRY, MOVE],
    moveMode: "road",
  },

  /**
   * HAULER - Moves energy around the colony
   * Balanced CARRY + MOVE for road travel
   */
  HAULER: {
    pattern: [CARRY, MOVE],
    minEnergy: 100,
    fallback: [CARRY, MOVE],
    moveMode: "pattern", // Pattern already has optimal ratio
  },

  /**
   * UPGRADER - Upgrades controller
   * WORK-heavy with some CARRY capacity
   */
  UPGRADER: {
    pattern: [WORK, WORK, WORK, CARRY],
    minEnergy: 200,
    fallback: [WORK, CARRY, MOVE],
    moveMode: "road",
  },

  /**
   * BUILDER - Builds and repairs structures
   * Balanced WORK/CARRY for flexible building
   */
  BUILDER: {
    pattern: [WORK, CARRY, MOVE],
    minEnergy: 200,
    fallback: [WORK, CARRY, MOVE],
    moveMode: "pattern", // Pattern already has optimal ratio
  },

  /**
   * DEFENDER - Local room defense
   * ATTACK-focused for melee combat
   */
  DEFENDER: {
    pattern: [ATTACK, MOVE],
    prefix: [TOUGH, TOUGH, TOUGH],
    minEnergy: 130,
    fallback: [ATTACK, MOVE, MOVE],
    moveMode: "pattern",
    sortForCombat: true,
  },

  /**
   * REMOTE_DEFENDER - Hybrid ranged/heal defender for remote rooms
   * Can fight at range 3 (no kiting), self-heal for sustain
   * Pattern: RANGED_ATTACK + MOVE gives ranged DPS
   * Suffix: HEAL + MOVE for self-sustain
   * At 2300 energy: ~8 RANGED_ATTACK, 2 HEAL, 2 TOUGH, 12 MOVE
   *   = 80 ranged DPS + 24 HPS self-heal
   *   Enough to kill standard invader pairs
   */
  REMOTE_DEFENDER: {
    pattern: [RANGED_ATTACK, MOVE],
    prefix: [TOUGH, TOUGH],
    suffix: [HEAL, HEAL, MOVE, MOVE],
    maxRepeats: 8,
    minEnergy: 520,
    fallback: [RANGED_ATTACK, RANGED_ATTACK, HEAL, MOVE, MOVE, MOVE],
    moveMode: "pattern",
    sortForCombat: true,
  },

  /**
   * SCOUT - Fast exploration unit
   * Just MOVE parts for speed
   */
  SCOUT: {
    pattern: [MOVE],
    maxRepeats: 5,
    minEnergy: 50,
    fallback: [MOVE],
    moveMode: "pattern",
  },

  /**
   * REMOTE_MINER - Harvests in remote rooms
   * 5 WORK for max efficiency, CARRY for container transfer
   */
  REMOTE_MINER: {
    pattern: [WORK],
    suffix: [CARRY],
    maxRepeats: 5,
    minEnergy: 300,
    fallback: [WORK, WORK, CARRY, MOVE],
    moveMode: "plains", // No roads in remote rooms initially
  },

  /**
   * REMOTE_HAULER - Collects energy from remote rooms
   * High CARRY capacity with full plains movement
   */
  REMOTE_HAULER: {
    pattern: [CARRY, MOVE],
    minEnergy: 200,
    fallback: [CARRY, CARRY, MOVE, MOVE],
    moveMode: "pattern",
  },

  /**
   * RESERVER - Reserves remote controllers
   * CLAIM parts are expensive
   */
  RESERVER: {
    pattern: [CLAIM, MOVE],
    maxRepeats: 2,
    minEnergy: 650,
    fallback: [CLAIM, MOVE],
    moveMode: "pattern",
  },

  /**
   * CLAIMER - Claims new rooms
   * Single CLAIM part required
   */
  CLAIMER: {
    pattern: [CLAIM, MOVE],
    maxRepeats: 1,
    minEnergy: 650,
    fallback: [CLAIM, MOVE],
    moveMode: "pattern",
  },

  /**
   * LINK_FILLER - Sits between storage and storage link
   * Stationary, needs high CARRY capacity
   */
  LINK_FILLER: {
    pattern: [CARRY, CARRY],
    maxRepeats: 3,
    minEnergy: 150,
    fallback: [CARRY, CARRY, MOVE],
    moveMode: "static",
  },

  /**
   * MINERAL_HARVESTER - Extracts minerals from extractor
   * WORK-heavy with CARRY to deliver to terminal/storage
   * 5 tick cooldown between harvests, so high WORK benefits burst extraction
   */
  MINERAL_HARVESTER: {
    pattern: [WORK, WORK, CARRY],
    maxRepeats: 10,
    minEnergy: 400,
    fallback: [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
    moveMode: "road",
  },
};

/**
 * Get minimum energy cost for a role's smallest viable body
 */
export function getMinEnergyCost(role: string): number {
  const config = BODY_CONFIGS[role];
  if (!config) return 200;
  return config.minEnergy || 200;
}
