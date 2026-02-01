import { moveToRoom, smartMoveTo } from "../utils/movement";

/**
 * RemoteDefenderRanged - Ranged support for melee remote defenders
 * Follows melee defender, attacks from range 3, heals self and defender
 * Persists via renewal when idle (no threats)
 */

// ============================================
// Renewal Logic for Ranged Defenders
// ============================================

function getIdlePosition(creep: Creep): RoomPosition {
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

  const idleToSpawn = getIdleToSpawnDistance(creep);
  const buffer = 30;

  return creep.ticksToLive < idleToSpawn + buffer;
}

function getRenewalTarget(creep: Creep): number {
  const idleToSpawn = getIdleToSpawnDistance(creep);
  const idlePeriod = 600;
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

  if (spawn.spawning) {
    if (creep.ticksToLive && creep.ticksToLive < 20) {
      return true;
    }
    return false;
  }

  const target = getRenewalTarget(creep);
  if (creep.ticksToLive && creep.ticksToLive >= target) {
    return false;
  }

  spawn.renewCreep(creep);
  return true;
}

// ============================================
// Damage Detection and Retreat Logic
// ============================================

/**
 * Smart retreat decision based on DPS calculation
 * Ranged defenders can self-heal, so factor that in
 */
function shouldRetreat(creep: Creep): boolean {
  // Lost ranged attack capability - can't fight, must retreat
  if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) return true;

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

  // Factor in self-healing (12 hp/tick per HEAL part)
  const selfHeal = creep.getActiveBodyparts(HEAL) * 12;
  const netDPS = Math.max(0, incomingDPS - selfHeal);

  // If we can out-heal the damage, don't retreat
  if (netDPS === 0) return false;

  // Estimate ticks to reach tower range in home room
  const distanceHome =
    creep.room.name === creep.memory.room
      ? 25
      : Game.map.getRoomLinearDistance(creep.room.name, creep.memory.room) * 50 + 25;

  // Will I survive the trip?
  const damageOnTrip = netDPS * distanceHome;
  const survivalMargin = creep.hits - damageOnTrip;

  // Retreat if projected HP on arrival is too low
  return survivalMargin < 100;
}

function isFullyHealed(creep: Creep): boolean {
  return creep.hits === creep.hitsMax && creep.getActiveBodyparts(RANGED_ATTACK) > 0;
}

function getHealPosition(creep: Creep): RoomPosition {
  const homeRoomObj = Game.rooms[creep.memory.room];
  if (homeRoomObj?.storage) {
    return homeRoomObj.storage.pos;
  }
  return new RoomPosition(25, 25, creep.memory.room);
}

function runRetreat(creep: Creep): boolean {
  // Self-heal while retreating
  creep.heal(creep);

  if (creep.room.name !== creep.memory.room) {
    moveToRoom(creep, creep.memory.room, "#ff6600");
    creep.say("FLEE");
    return true;
  }

  const healPos = getHealPosition(creep);
  if (creep.pos.getRangeTo(healPos) > 3) {
    smartMoveTo(creep, healPos, { visualizePathStyle: { stroke: "#ff6600" }, reusePath: 5 });
    creep.say("HEAL");
  }
  return true;
}

// ============================================
// Main Ranged Defender Logic
// ============================================

export function runRemoteDefenderRanged(creep: Creep): void {
  // Priority 1: Smart retreat based on DPS calculation
  if (shouldRetreat(creep)) {
    creep.memory.retreating = true;
  }

  if (creep.memory.retreating) {
    if (isFullyHealed(creep)) {
      creep.memory.retreating = false;
    } else {
      runRetreat(creep);
      return;
    }
  }

  // Self-heal if damaged (can attack + heal same tick)
  if (creep.hits < creep.hitsMax) {
    creep.heal(creep);
  }

  const homeRoom = creep.memory.room;

  // Find melee defender to follow
  const meleeDefender = Object.values(Game.creeps).find(
    (c) =>
      c.memory.role === "REMOTE_DEFENDER" &&
      c.memory.room === homeRoom &&
      c.ticksToLive &&
      c.ticksToLive > 50
  );

  if (!meleeDefender) {
    // No defender - go home and handle renewal/idle
    if (creep.room.name !== homeRoom) {
      moveToRoom(creep, homeRoom, "#888888");
      creep.say("HOME");
      return;
    }

    // Check for renewal
    if (shouldGoRenew(creep) || creep.memory.renewing) {
      creep.memory.renewing = true;
      if (runRenewal(creep)) return;
      creep.memory.renewing = false;
    }

    // Idle at center
    const idlePos = getIdlePosition(creep);
    if (creep.pos.getRangeTo(idlePos) > 2) {
      smartMoveTo(creep, idlePos, { visualizePathStyle: { stroke: "#888888" } });
    }
    creep.say("IDLE");
    return;
  }

  // Cancel renewal when following defender into combat
  creep.memory.renewing = false;

  // Follow defender to their room
  if (creep.room.name !== meleeDefender.room.name) {
    moveToRoom(creep, meleeDefender.room.name, "#ff0000");
    creep.say("FOLLOW");
    return;
  }

  // In same room as defender - find and engage hostiles
  const hostile = findPriorityTarget(creep);

  if (hostile) {
    const rangeToHostile = creep.pos.getRangeTo(hostile);

    // Attack if in range
    if (rangeToHostile <= 3) {
      creep.rangedAttack(hostile);
      creep.say("ATK");
    }

    // Positioning: stay at range 3 from hostile
    if (rangeToHostile < 3) {
      // Too close - kite back
      const fleePath = PathFinder.search(
        creep.pos,
        { pos: hostile.pos, range: 4 },
        { flee: true, maxRooms: 1 }
      );
      if (fleePath.path.length > 0) {
        creep.moveByPath(fleePath.path);
      }
    } else if (rangeToHostile > 3) {
      // Move closer to range 3
      smartMoveTo(creep, hostile, { range: 3, reusePath: 3 });
    }
  } else {
    // No hostile - follow defender
    const rangeToDefender = creep.pos.getRangeTo(meleeDefender);
    if (rangeToDefender > 3) {
      smartMoveTo(creep, meleeDefender, { reusePath: 5 });
    }
    creep.say("OK");
  }

  // Heal defender if hurt (after attack actions)
  const rangeToDefender = creep.pos.getRangeTo(meleeDefender);
  if (meleeDefender.hits < meleeDefender.hitsMax) {
    if (rangeToDefender === 1) {
      creep.heal(meleeDefender);
    } else if (rangeToDefender <= 3) {
      creep.rangedHeal(meleeDefender);
    }
  }
}

/**
 * Find best target - prioritize healers, then ranged, then melee
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
  priority += hostile.getActiveBodyparts(HEAL) * 100;
  priority += hostile.getActiveBodyparts(RANGED_ATTACK) * 50;
  priority += hostile.getActiveBodyparts(ATTACK) * 30;
  priority += hostile.getActiveBodyparts(WORK) * 10;
  return priority;
}
