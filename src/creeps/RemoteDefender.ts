import { moveToRoom, smartMoveTo } from "../utils/movement";
import { RemoteSquadManager } from "../defense/RemoteSquadManager";

/**
 * RemoteDefender - Squad-based defense for remote mining rooms
 * Stages at home until squad is ready, then attacks together
 * Persists via renewal when idle (no threats)
 */

// ============================================
// Renewal Logic for Remote Defenders
// ============================================

function getIdlePosition(creep: Creep): RoomPosition {
  // Idle near center of home room, away from spawn
  return new RoomPosition(25, 25, creep.memory.room);
}

function getIdleToSpawnDistance(creep: Creep): number {
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return 999;
  const idlePos = getIdlePosition(creep);
  return idlePos.getRangeTo(spawn);
}

function shouldGoRenew(creep: Creep): boolean {
  if (!creep.ticksToLive) return false;

  // Distance from idle position to spawn
  const idleToSpawn = getIdleToSpawnDistance(creep);
  const buffer = 30;

  // Leave idle when TTL covers travel + buffer
  return creep.ticksToLive < idleToSpawn + buffer;
}

function getRenewalTarget(creep: Creep): number {
  const idleToSpawn = getIdleToSpawnDistance(creep);
  const idlePeriod = 600; // ticks idling between renewal trips
  const buffer = 30;

  return idleToSpawn + idlePeriod + buffer;
}

function runRenewal(creep: Creep): boolean {
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return false;

  const range = creep.pos.getRangeTo(spawn);

  if (range > 1) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    creep.say("RENEW");
    return true;
  }

  // At spawn
  if (spawn.spawning) {
    if (creep.ticksToLive && creep.ticksToLive < 20) {
      return true; // critical, wait
    }
    return false; // give up, respawn later
  }

  const target = getRenewalTarget(creep);
  if (creep.ticksToLive && creep.ticksToLive >= target) {
    return false; // done renewing
  }

  spawn.renewCreep(creep);
  return true;
}

// ============================================
// Damage Detection and Retreat Logic
// ============================================

/**
 * Smart retreat decision based on DPS calculation
 * Only retreat if we can't survive the fight
 */
function shouldRetreat(creep: Creep): boolean {
  // Lost attack capability - can't fight, must retreat
  if (creep.getActiveBodyparts(ATTACK) === 0) return true;

  // Estimate damage per tick from nearby hostiles
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
  let incomingDPS = 0;
  for (const hostile of hostiles) {
    const range = creep.pos.getRangeTo(hostile);
    if (range <= 1) {
      incomingDPS += hostile.getActiveBodyparts(ATTACK) * 30;
    }
    if (range <= 3) {
      incomingDPS += hostile.getActiveBodyparts(RANGED_ATTACK) * 10;
    }
  }

  // If not taking damage, don't retreat
  if (incomingDPS === 0) return false;

  // Estimate ticks to reach tower range in home room
  const distanceHome =
    creep.room.name === creep.memory.room
      ? 25 // Already in home room, just need to reach towers
      : Game.map.getRoomLinearDistance(creep.room.name, creep.memory.room) * 50 + 25;

  // Will I survive the trip?
  const damageOnTrip = incomingDPS * distanceHome;
  const survivalMargin = creep.hits - damageOnTrip;

  // Retreat if projected HP on arrival is too low
  return survivalMargin < 100;
}

function isFullyHealed(creep: Creep): boolean {
  return creep.hits === creep.hitsMax && creep.getActiveBodyparts(ATTACK) > 0;
}

function getHealPosition(creep: Creep): RoomPosition {
  // Go to tower range in home room (near storage or center)
  const homeRoomObj = Game.rooms[creep.memory.room];
  if (homeRoomObj?.storage) {
    return homeRoomObj.storage.pos;
  }
  return new RoomPosition(25, 25, creep.memory.room);
}

function runRetreat(creep: Creep): boolean {
  // Get to home room first
  if (creep.room.name !== creep.memory.room) {
    moveToRoom(creep, creep.memory.room, "#ff6600");
    creep.say("FLEE");
    return true;
  }

  // Move to heal position (tower range)
  const healPos = getHealPosition(creep);
  if (creep.pos.getRangeTo(healPos) > 3) {
    smartMoveTo(creep, healPos, { visualizePathStyle: { stroke: "#ff6600" }, reusePath: 5 });
    creep.say("HEAL");
  }
  // Stay until fully healed by towers
  return true;
}

// ============================================
// Main Remote Defender Logic
// ============================================
export function runRemoteDefender(creep: Creep): void {
  // Priority 1: Smart retreat based on DPS calculation
  if (shouldRetreat(creep)) {
    creep.memory.retreating = true;
  }

  if (creep.memory.retreating) {
    if (isFullyHealed(creep)) {
      creep.memory.retreating = false; // fully healed and combat-capable
    } else {
      runRetreat(creep);
      return;
    }
  }

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
      creep.memory.renewing = false; // Cancel renewal for combat
      creep.say("NEW");
    } else {
      // No threats anywhere - move home and handle renewal/idle
      if (creep.room.name !== homeRoom) {
        moveToRoom(creep, homeRoom, "#888888");
        creep.say("HOME");
        return;
      }

      // At home - check for renewal
      if (shouldGoRenew(creep) || creep.memory.renewing) {
        creep.memory.renewing = true;
        if (runRenewal(creep)) return;
        creep.memory.renewing = false;
      }

      // Idle at center position (away from spawn)
      const idlePos = getIdlePosition(creep);
      if (creep.pos.getRangeTo(idlePos) > 2) {
        smartMoveTo(creep, idlePos, { visualizePathStyle: { stroke: "#888888" } });
      }
      creep.say("IDLE");
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
