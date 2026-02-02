import { moveToRoom, smartMoveTo } from "../utils/movement";
import { RemoteSquadManager } from "../defense/RemoteSquadManager";

/**
 * RemoteDefender - Hybrid ranged/heal defender for remote mining rooms
 *
 * Uses RANGED_ATTACK for combat at range 3 (no kiting needed) and
 * HEAL parts for self-sustain. Can handle standard invader pairs solo.
 *
 * Persists via renewal when idle (no threats).
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

  // Don't renew undersized creeps - let them die and spawn bigger replacements
  const bodyCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
  const capacity = creep.room.energyCapacityAvailable;
  if (bodyCost < capacity * 0.5) {
    return false;
  }

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
 * Only retreat if we can't survive the fight with self-heal
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

  // Calculate our self-heal capability
  const selfHealPerTick = creep.getActiveBodyparts(HEAL) * 12;

  // If we can out-heal the damage, don't retreat
  if (selfHealPerTick >= incomingDPS) return false;

  // Net damage after self-heal
  const netDamage = incomingDPS - selfHealPerTick;
  if (netDamage <= 0) return false;

  // Estimate ticks to reach tower range in home room
  const distanceHome =
    creep.room.name === creep.memory.room
      ? 25 // Already in home room, just need to reach towers
      : Game.map.getRoomLinearDistance(creep.room.name, creep.memory.room) * 50 + 25;

  // Will I survive the trip?
  const damageOnTrip = netDamage * distanceHome;
  const survivalMargin = creep.hits - damageOnTrip;

  // Retreat if projected HP on arrival is too low
  return survivalMargin < 100;
}

function isFullyHealed(creep: Creep): boolean {
  return creep.hits === creep.hitsMax && creep.getActiveBodyparts(RANGED_ATTACK) > 0;
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

  // Check if target room still has threats
  const targetMem = targetRoom ? Memory.rooms?.[targetRoom] : null;
  const targetHasThreats = targetMem && targetMem.hostiles && targetMem.hostiles > 0;

  if (!targetHasThreats) {
    // Look for another room that needs defenders
    const newTarget = findRoomNeedingDefender(homeRoom);
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

  // Move to target room
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ff0000");
    creep.say("GO");
    return;
  }

  // In target room - attack hostiles
  attackHostiles(creep);

  // Check if room is clear - update memory
  const remainingHostiles = creep.room.find(FIND_HOSTILE_CREEPS).length;
  const remainingCores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
  }).length;

  if (remainingHostiles === 0 && remainingCores === 0) {
    // Clear threat from memory
    if (Memory.rooms?.[targetRoom]) {
      Memory.rooms[targetRoom].hostiles = 0;
    }
    // Disband the squad for this room
    const homeRoomObj = Game.rooms[creep.memory.room];
    if (homeRoomObj) {
      const squadManager = new RemoteSquadManager(homeRoomObj);
      squadManager.disbandSquad(targetRoom);
    }
    // Clear assignment so we can find new threats
    creep.memory.targetRoom = undefined;
  }
}

function attackHostiles(creep: Creep): void {
  // Self-heal if damaged (always do this first, uses HEAL action)
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }

  // Find and attack hostiles
  const hostile = findPriorityTarget(creep);

  if (hostile) {
    const range = creep.pos.getRangeTo(hostile);

    // Use rangedAttack (range 3) or rangedMassAttack if surrounded
    if (range <= 3) {
      // Check if multiple hostiles are close - use mass attack
      const nearbyHostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
      if (nearbyHostiles.length > 1) {
        creep.rangedMassAttack();
      } else {
        creep.rangedAttack(hostile);
      }
    }

    // Move to maintain range 3 (optimal for ranged attack)
    if (range > 3) {
      smartMoveTo(creep, hostile, {
        visualizePathStyle: { stroke: "#ff0000" },
        reusePath: 3,
      });
    } else if (range < 2) {
      // Too close - back up to avoid melee
      const fleePath = PathFinder.search(creep.pos, { pos: hostile.pos, range: 4 }, { flee: true });
      if (fleePath.path.length > 0) {
        creep.move(creep.pos.getDirectionTo(fleePath.path[0]));
      }
    }

    creep.say("ATK");
    return;
  }

  // No hostiles - check for invader cores
  const invaderCore = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
  })[0];

  if (invaderCore) {
    const range = creep.pos.getRangeTo(invaderCore);
    if (range <= 3) {
      creep.rangedAttack(invaderCore);
    }
    if (range > 1) {
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
 * Checks adjacent rooms for threats based on Memory.rooms intel
 */
function findRoomNeedingDefender(homeRoom: string): string | null {
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return null;

  const SCAN_AGE_THRESHOLD = 200;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    // Skip Source Keeper rooms
    const intel = Memory.rooms?.[roomName];
    if (!intel) continue;
    if (intel.hasKeepers) continue;

    // Check scan age - don't respond to stale intel
    const scanAge = Game.time - (intel.lastScan || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) continue;

    const hostileCount = intel.hostiles || 0;
    if (hostileCount > 0) {
      // Check for dangerous hostiles
      const hostileDetails = (intel as any).hostileDetails;
      let hasDangerous = false;
      if (hostileDetails && Array.isArray(hostileDetails)) {
        hasDangerous = hostileDetails.some((h: any) => h.hasCombat);
      } else {
        hasDangerous = hostileCount > 0;
      }

      if (hasDangerous) {
        return roomName;
      }
    }
  }

  return null;
}
