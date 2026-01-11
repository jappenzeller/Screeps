import { logger } from "../utils/Logger";
import { CachedColonyState, ThreatLevel } from "./ColonyState";

/**
 * Emergency bootstrap body - minimum viable harvester
 * Cost: 250 energy (WORK=100, CARRY=50, MOVE=50x2)
 */
const BOOTSTRAP_BODY: BodyPartConstant[] = [WORK, CARRY, MOVE, MOVE];
const BOOTSTRAP_COST = 250;

/**
 * FailureRecovery - Handles colony death spiral prevention
 *
 * Detects:
 * - No harvesters (economy collapse)
 * - Spawn under attack (defense emergency)
 * - Low energy with no income (starvation)
 *
 * Responses:
 * - Emergency bootstrap creep spawn
 * - Safe mode activation
 */
export class FailureRecovery {
  /**
   * Check colony state and take emergency action if needed
   * @returns true if emergency action was taken
   */
  static check(state: CachedColonyState): boolean {
    // Check for critical spawn damage under attack
    if (this.checkSpawnEmergency(state)) {
      return true;
    }

    // Check for economic collapse
    if (this.checkEconomicEmergency(state)) {
      return true;
    }

    return false;
  }

  /**
   * Check if spawn is critically damaged under attack
   */
  private static checkSpawnEmergency(state: CachedColonyState): boolean {
    if (state.threat.level < ThreatLevel.HIGH) return false;

    const spawn = state.structures.spawns[0];
    if (!spawn) return false;

    // Spawn critically damaged (< 30% health) while under attack
    if (spawn.hits < spawn.hitsMax * 0.3 && state.threat.spawnUnderAttack) {
      const controller = state.room.controller;
      if (controller && controller.safeModeAvailable > 0 && !controller.safeModeCooldown) {
        logger.warn(
          "FailureRecovery",
          `ACTIVATING SAFE MODE in ${state.room.name} - spawn critical!`
        );
        const result = controller.activateSafeMode();
        if (result === OK) {
          Game.notify(`Safe mode activated in ${state.room.name} - spawn was critically damaged!`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check for economic collapse and spawn bootstrap creep
   */
  private static checkEconomicEmergency(state: CachedColonyState): boolean {
    // Need harvesters to have economy
    const harvesters = state.creeps.byRole["HARVESTER"] ?? [];
    if (harvesters.length > 0) return false;

    // Check if we have any creep that can harvest
    const canHarvest = state.creeps.all.some((c) => c.getActiveBodyparts(WORK) > 0);
    if (canHarvest) return false;

    // Economic emergency - no harvesters! (only log every 10 ticks to reduce spam)
    if (Game.time % 10 === 0) {
      logger.warn("FailureRecovery", `Economic emergency in ${state.room.name} - no harvesters!`);
    }

    // Try to spawn emergency bootstrap creep
    return this.spawnBootstrapCreep(state);
  }

  /**
   * Spawn an emergency bootstrap creep
   */
  private static spawnBootstrapCreep(state: CachedColonyState): boolean {
    const spawn = state.structures.spawns.find((s) => !s.spawning);
    if (!spawn) {
      logger.debug("FailureRecovery", "No available spawn for bootstrap");
      return false;
    }

    // Check if we have enough energy
    if (state.energy.available < BOOTSTRAP_COST) {
      logger.debug(
        "FailureRecovery",
        `Not enough energy for bootstrap: ${state.energy.available}/${BOOTSTRAP_COST}`
      );
      return false;
    }

    // Find an unassigned source
    const unassignedSource = state.sourceAssignments.find((a) => !a.creepName);
    const sourceId = unassignedSource?.sourceId ?? state.sources[0]?.id;

    if (!sourceId) {
      logger.error("FailureRecovery", "No sources available for bootstrap");
      return false;
    }

    const name = `Bootstrap_${Game.time}`;
    const result = spawn.spawnCreep(BOOTSTRAP_BODY, name, {
      memory: {
        role: "HARVESTER",
        room: state.room.name,
        sourceId,
        emergency: true,
        state: "IDLE",
      },
    });

    if (result === OK) {
      logger.warn("FailureRecovery", `Spawning emergency bootstrap creep: ${name}`);
      return true;
    } else {
      logger.debug("FailureRecovery", `Bootstrap spawn failed: ${result}`);
      return false;
    }
  }

  /**
   * Check if a room is in recovery mode
   */
  static isRecovering(state: CachedColonyState): boolean {
    return state.emergency.isEmergency;
  }

  /**
   * Get recovery status for display
   */
  static getStatus(state: CachedColonyState): string {
    if (!state.emergency.isEmergency) return "OK";

    const issues: string[] = [];
    if (state.emergency.noHarvesters) issues.push("NO_HARVESTERS");
    if (state.emergency.spawnDying) issues.push("SPAWN_DYING");
    if (state.emergency.lowEnergy) issues.push("LOW_ENERGY");

    return `EMERGENCY: ${issues.join(", ")}`;
  }
}
