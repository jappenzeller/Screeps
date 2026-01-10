import { logger } from "../utils/Logger";

/**
 * Defender - Attacks hostile creeps in the room
 * Priority targets: healers > ranged > melee > other
 */
export function runDefender(creep: Creep): void {
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);

  if (hostiles.length === 0) {
    // No hostiles - patrol near spawn
    const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (spawn && !creep.pos.inRangeTo(spawn, 5)) {
      creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ff0000" } });
    }
    return;
  }

  // Prioritize targets
  const target = findPriorityTarget(hostiles);

  if (target) {
    const result = creep.attack(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ff0000" } });
    } else if (result === OK) {
      logger.debug("Defender", `${creep.name} attacking ${target.owner.username}`);
    }
  }
}

function findPriorityTarget(hostiles: Creep[]): Creep | null {
  // Priority: healers > ranged attackers > melee > others
  const healers = hostiles.filter((c) => c.getActiveBodyparts(HEAL) > 0);
  if (healers.length > 0) {
    return healers.reduce((a, b) => (a.hits < b.hits ? a : b));
  }

  const ranged = hostiles.filter((c) => c.getActiveBodyparts(RANGED_ATTACK) > 0);
  if (ranged.length > 0) {
    return ranged.reduce((a, b) => (a.hits < b.hits ? a : b));
  }

  const melee = hostiles.filter((c) => c.getActiveBodyparts(ATTACK) > 0);
  if (melee.length > 0) {
    return melee.reduce((a, b) => (a.hits < b.hits ? a : b));
  }

  // Any hostile
  return hostiles.reduce((a, b) => (a.hits < b.hits ? a : b));
}
