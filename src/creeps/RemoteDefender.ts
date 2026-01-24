import { moveToRoom, smartMoveTo } from "../utils/movement";
import { RemoteSquadManager } from "../defense/RemoteSquadManager";

/**
 * RemoteDefender - Squad-based defense for remote mining rooms
 * Stages at home until squad is ready, then attacks together
 */
export function runRemoteDefender(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  const homeRoom = creep.memory.room;

  if (!targetRoom) {
    creep.say("?");
    return;
  }

  const homeRoomObj = Game.rooms[homeRoom];
  if (!homeRoomObj) {
    // Can't access home room - just go attack
    if (creep.room.name !== targetRoom) {
      moveToRoom(creep, targetRoom, "#ff0000");
      return;
    }
    attackHostiles(creep);
    return;
  }

  const squadManager = new RemoteSquadManager(homeRoomObj);

  // Register with squad
  squadManager.registerDefender(creep.name, targetRoom);

  const squad = squadManager.getSquad(targetRoom);
  const isSquadReady = squadManager.isSquadReady(targetRoom);

  // STAGING: Wait at home until squad is ready
  if (!isSquadReady && creep.room.name === homeRoom) {
    // Move to rally point (near spawn but not blocking)
    const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (spawn) {
      const rallyX = Math.min(spawn.pos.x + 3, 47);
      const rallyY = Math.min(spawn.pos.y + 3, 47);
      const rallyPoint = new RoomPosition(rallyX, rallyY, homeRoom);
      if (creep.pos.getRangeTo(rallyPoint) > 2) {
        smartMoveTo(creep, rallyPoint, { visualizePathStyle: { stroke: "#ffff00" } });
      }
    }
    const memberCount = squad?.members.length || 0;
    const required = squad?.requiredSize || 0;
    creep.say(`${memberCount}/${required}`);
    return;
  }

  // Squad is ready or we're already in target room - attack!
  if (creep.room.name !== targetRoom) {
    // Mark squad as attacking once anyone moves out
    squadManager.setAttacking(targetRoom);
    moveToRoom(creep, targetRoom, "#ff0000");
    creep.say("GO");
    return;
  }

  // In target room - attack hostiles
  attackHostiles(creep);

  // Check if room is clear
  const remainingHostiles = creep.room.find(FIND_HOSTILE_CREEPS).length;
  const remainingCores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
  }).length;

  if (remainingHostiles === 0 && remainingCores === 0) {
    squadManager.disbandSquad(targetRoom);
  }
}

function attackHostiles(creep: Creep): void {
  // Find and attack hostiles
  const hostile = findPriorityTarget(creep);

  if (hostile) {
    const result = creep.attack(hostile);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, hostile, {
        visualizePathStyle: { stroke: "#ff0000" },
        reusePath: 3,
      });
    }
    creep.say("ATK");
    return;
  }

  // No hostiles - check for invader cores
  const invaderCore = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
  })[0];

  if (invaderCore) {
    const result = creep.attack(invaderCore);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, invaderCore, { visualizePathStyle: { stroke: "#ff0000" } });
    }
    creep.say("CORE");
    return;
  }

  // Room is clear
  creep.say("OK");
}

/**
 * Find the best target to attack
 * Priority: Healers > Ranged > Melee > Other
 */
function findPriorityTarget(creep: Creep): Creep | null {
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);

  if (hostiles.length === 0) return null;

  const sorted = hostiles.sort((a, b) => {
    const aPriority = getTargetPriority(a);
    const bPriority = getTargetPriority(b);

    if (aPriority !== bPriority) {
      return bPriority - aPriority;
    }

    return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
  });

  return sorted[0];
}

function getTargetPriority(hostile: Creep): number {
  let priority = 0;
  priority += hostile.getActiveBodyparts(HEAL) * 100; // Kill healers first!
  priority += hostile.getActiveBodyparts(RANGED_ATTACK) * 50;
  priority += hostile.getActiveBodyparts(ATTACK) * 30;
  priority += hostile.getActiveBodyparts(WORK) * 10;
  return priority;
}
