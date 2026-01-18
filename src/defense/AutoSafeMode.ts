import { logger } from "../utils/Logger";

/**
 * Auto Safe Mode Defense System
 *
 * Automatically activates safe mode when:
 * - High threat hostile present (healers are especially dangerous)
 * - Tower defense is inadequate (low energy or no towers)
 * - Critical structures (spawn, storage) are at risk
 */

interface ThreatAssessment {
  totalThreat: number;
  hasHealer: boolean;
  hostileCount: number;
  nearSpawn: boolean;
  nearStorage: boolean;
}

interface DefenseAssessment {
  towerCount: number;
  towerEnergy: number;
  canDefend: boolean;
}

/**
 * Calculate threat level from hostiles.
 * Healers are weighted heavily - they can sustain through weak tower damage.
 */
function assessThreat(room: Room): ThreatAssessment {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  const storage = room.storage;

  let totalThreat = 0;
  let hasHealer = false;

  for (const hostile of hostiles) {
    const attack = hostile.getActiveBodyparts(ATTACK);
    const ranged = hostile.getActiveBodyparts(RANGED_ATTACK);
    const heal = hostile.getActiveBodyparts(HEAL);
    const tough = hostile.getActiveBodyparts(TOUGH);

    // Weighted threat calculation
    // Healers are extremely dangerous - they can out-heal weak tower damage
    totalThreat += attack * 30;
    totalThreat += ranged * 15;
    totalThreat += heal * 50;
    totalThreat += tough * 5;

    if (heal > 0) hasHealer = true;
  }

  // Check proximity to critical structures
  const nearSpawn = spawn ? hostiles.some(h => h.pos.getRangeTo(spawn) < 10) : false;
  const nearStorage = storage ? hostiles.some(h => h.pos.getRangeTo(storage) < 10) : false;

  return {
    totalThreat,
    hasHealer,
    hostileCount: hostiles.length,
    nearSpawn,
    nearStorage,
  };
}

/**
 * Assess current defense capability.
 */
function assessDefense(room: Room): DefenseAssessment {
  const towers = room.find(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_TOWER },
  }) as StructureTower[];

  const towerEnergy = towers.reduce((sum, t) => sum + t.store[RESOURCE_ENERGY], 0);

  // Defense is adequate if:
  // - At least 1 tower
  // - Total tower energy > 500 (enough for sustained fire)
  const canDefend = towers.length > 0 && towerEnergy > 500;

  return {
    towerCount: towers.length,
    towerEnergy,
    canDefend,
  };
}

/**
 * Main function - check if safe mode should be activated.
 * Call this once per tick for each owned room.
 */
export function checkAutoSafeMode(room: Room): void {
  const controller = room.controller;

  // Must be our room with controller
  if (!controller?.my) return;

  // Can we activate safe mode?
  if (!controller.safeModeAvailable) {
    return; // No safe modes available
  }
  if (controller.safeModeCooldown) {
    return; // On cooldown
  }

  // Assess current situation
  const threat = assessThreat(room);
  const defense = assessDefense(room);

  // No hostiles = no problem
  if (threat.hostileCount === 0) return;

  // Minor threat - don't waste safe mode
  // Threshold: 200 = roughly 6-7 ATTACK parts or 4 HEAL parts
  if (threat.totalThreat < 200) return;

  // If we can defend, let towers handle it
  if (defense.canDefend && !threat.hasHealer) return;

  // Healer present with weak defense = big trouble
  // Healers can out-heal tower damage when tower energy is low
  if (threat.hasHealer && defense.towerEnergy < 1000) {
    logger.warn("AutoSafeMode", `Healer detected with low tower energy (${defense.towerEnergy})`);
  }

  // Critical structures at risk?
  const criticalRisk = threat.nearSpawn || threat.nearStorage;

  // Decision matrix:
  // 1. High threat + can't defend + critical risk = SAFE MODE
  // 2. Healer + low tower energy + any proximity = SAFE MODE
  // 3. Massive threat (>500) + can't defend = SAFE MODE

  const shouldActivate =
    (!defense.canDefend && criticalRisk) ||
    (threat.hasHealer && defense.towerEnergy < 1000 && (threat.nearSpawn || threat.nearStorage)) ||
    (threat.totalThreat > 500 && !defense.canDefend);

  if (shouldActivate) {
    logger.warn("AutoSafeMode",
      `ACTIVATING SAFE MODE! Threat: ${threat.totalThreat}, ` +
      `Healer: ${threat.hasHealer}, Tower energy: ${defense.towerEnergy}, ` +
      `Near spawn: ${threat.nearSpawn}, Near storage: ${threat.nearStorage}`
    );

    const result = controller.activateSafeMode();
    if (result === OK) {
      logger.warn("AutoSafeMode", "Safe mode activated successfully");
    } else {
      logger.warn("AutoSafeMode", `Failed to activate safe mode: ${result}`);
    }
  }
}

/**
 * Get current safe mode status for a room.
 * Useful for console debugging.
 */
export function getSafeModeStatus(room: Room): object {
  const controller = room.controller;
  if (!controller) return { error: "No controller" };

  const threat = assessThreat(room);
  const defense = assessDefense(room);

  return {
    safeModeAvailable: controller.safeModeAvailable,
    safeModeCooldown: controller.safeModeCooldown || 0,
    safeModeActive: controller.safeMode || 0,
    threat: {
      level: threat.totalThreat,
      hostiles: threat.hostileCount,
      hasHealer: threat.hasHealer,
      nearSpawn: threat.nearSpawn,
      nearStorage: threat.nearStorage,
    },
    defense: {
      towers: defense.towerCount,
      towerEnergy: defense.towerEnergy,
      canDefend: defense.canDefend,
    },
  };
}
