import { moveToRoom, smartMoveTo } from "../utils/movement";

/**
 * RemoteDefender - Clears hostiles from remote mining rooms
 * Spawns on-demand when threats detected, disposable after clearing
 */
export function runRemoteDefender(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  const homeRoom = creep.memory.room;

  if (!targetRoom) {
    creep.say("❓");
    return;
  }

  // Travel to target room if not there
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ff0000");
    return;
  }

  // In target room - find and attack hostiles
  const hostile = findPriorityTarget(creep);

  if (hostile) {
    // Attack!
    const result = creep.attack(hostile);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, hostile, {
        visualizePathStyle: { stroke: "#ff0000" },
        reusePath: 3, // Short reuse - targets move
      });
    }
    creep.say("⚔️");
    return;
  }

  // No hostiles - check for invader cores
  const invaderCore = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
  })[0];

  if (invaderCore) {
    const result = creep.attack(invaderCore);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, invaderCore, {
        visualizePathStyle: { stroke: "#ff0000" },
      });
    }
    creep.say("💥");
    return;
  }

  // Room is clear - move to center and wait
  const remainingHostiles = creep.room.find(FIND_HOSTILE_CREEPS).length;
  if (remainingHostiles === 0) {
    const center = new RoomPosition(25, 25, creep.room.name);
    if (creep.pos.getRangeTo(center) > 10) {
      smartMoveTo(creep, center, { visualizePathStyle: { stroke: "#00ff00" } });
    }
    creep.say("✓");
  }
}

/**
 * Find the best target to attack
 * Priority: Healers > Ranged > Melee > Other
 */
function findPriorityTarget(creep: Creep): Creep | null {
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);

  if (hostiles.length === 0) return null;

  // Sort by threat priority
  const sorted = hostiles.sort((a, b) => {
    const aPriority = getTargetPriority(a);
    const bPriority = getTargetPriority(b);

    // Higher priority first
    if (aPriority !== bPriority) {
      return bPriority - aPriority;
    }

    // Same priority - prefer closer
    return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
  });

  return sorted[0];
}

/**
 * Calculate target priority (higher = more dangerous)
 */
function getTargetPriority(hostile: Creep): number {
  let priority = 0;

  // Healers are highest priority - they sustain other hostiles
  priority += hostile.getActiveBodyparts(HEAL) * 100;

  // Ranged attackers next
  priority += hostile.getActiveBodyparts(RANGED_ATTACK) * 50;

  // Melee attackers
  priority += hostile.getActiveBodyparts(ATTACK) * 30;

  // Work parts (invader miners steal energy)
  priority += hostile.getActiveBodyparts(WORK) * 10;

  return priority;
}
