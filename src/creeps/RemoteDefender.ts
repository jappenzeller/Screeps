import { moveToRoom, smartMoveTo } from "../utils/movement";
import { RemoteSquadManager } from "../defense/RemoteSquadManager";

/**
 * RemoteDefender - Squad-based defense for remote mining rooms
 * Stages at home until squad is ready, then attacks together
 */
export function runRemoteDefender(creep: Creep): void {
  const homeRoom = creep.memory.room;
  let targetRoom = creep.memory.targetRoom;

  // Check if we need reassignment (orphaned from disbanded squad)
  const currentSquad = targetRoom ? Memory.remoteSquads?.[targetRoom] : null;
  const isOrphaned = !currentSquad || currentSquad.status === "DISBANDED";

  if (isOrphaned) {
    // Look for another room that needs defenders
    const newTarget = findRoomNeedingDefender(homeRoom, creep.name);
    if (newTarget) {
      creep.memory.targetRoom = newTarget;
      targetRoom = newTarget;
      creep.say("NEW");
    } else {
      // No threats anywhere - move home and wait
      if (creep.room.name !== homeRoom) {
        moveToRoom(creep, homeRoom, "#888888");
        creep.say("HOME");
      } else {
        // Idle near spawn
        const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
        if (spawn && creep.pos.getRangeTo(spawn) > 3) {
          smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#888888" } });
        }
        creep.say("IDLE");
      }
      return;
    }
  }

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

/**
 * Find a remote room that needs defenders
 * Checks existing squads first, then looks for new threats
 */
function findRoomNeedingDefender(homeRoom: string, creepName: string): string | null {
  if (!Memory.remoteSquads) Memory.remoteSquads = {};

  // First check existing squads that need more members
  for (const roomName in Memory.remoteSquads) {
    const squad = Memory.remoteSquads[roomName];

    // Skip disbanded squads
    if (squad.status === "DISBANDED") continue;

    // Check if squad needs more members
    const currentMembers = squad.members.filter((name) => Game.creeps[name]).length;
    if (currentMembers < squad.requiredSize) {
      // Join this squad
      if (!squad.members.includes(creepName)) {
        squad.members.push(creepName);
      }
      return roomName;
    }
  }

  // No squads need help - check for new threats without squads
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return null;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    // Skip Source Keeper rooms
    const intel = Memory.rooms?.[roomName];
    if (intel?.hasKeepers) continue;

    const hostileCount = intel?.hostiles || 0;
    if (hostileCount > 0 && !Memory.remoteSquads[roomName]) {
      // Threat without squad - go solo
      return roomName;
    }
  }

  return null;
}
