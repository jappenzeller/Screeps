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
 * Smart retreat decision - ONLY retreat when truly unable to fight
 *
 * For NPC invaders: Only retreat when critically wounded (< 20% HP) AND
 * taking unsustainable damage. Invaders are predictable and don't chase
 * across room borders.
 *
 * For player creeps: Use more conservative logic since they may pursue.
 */
function shouldRetreat(creep: Creep): boolean {
  // Lost all ranged attack parts - can't fight, must retreat
  if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) return true;

  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length === 0) return false;

  // Check if we're fighting NPCs only
  var allNPC = true;
  for (var i = 0; i < hostiles.length; i++) {
    var owner = hostiles[i].owner.username;
    if (owner !== "Invader" && owner !== "Source Keeper") {
      allNPC = false;
      break;
    }
  }

  // Calculate our self-heal capability
  var selfHealPerTick = creep.getActiveBodyparts(HEAL) * 12;

  // Calculate incoming DPS from nearby hostiles
  var incomingDPS = 0;
  for (var j = 0; j < hostiles.length; j++) {
    var range = creep.pos.getRangeTo(hostiles[j]);
    if (range <= 1) {
      incomingDPS += hostiles[j].getActiveBodyparts(ATTACK) * 30;
    }
    if (range <= 3) {
      incomingDPS += hostiles[j].getActiveBodyparts(RANGED_ATTACK) * 10;
    }
  }

  if (allNPC) {
    // Against NPCs: Only retreat if critically wounded AND taking massive damage
    // NPCs don't chase across room borders, so we just need to survive to the exit
    var isCritical = creep.hits < creep.hitsMax * 0.2;
    var unsustainableDamage = incomingDPS > selfHealPerTick * 2;
    return isCritical && unsustainableDamage;
  }

  // Against players: More conservative - retreat if we can't sustain the fight
  // and HP is getting low
  var netDamage = incomingDPS - selfHealPerTick;
  if (netDamage <= 0) return false;

  // Retreat if HP is below 40% and taking net damage
  return creep.hits < creep.hitsMax * 0.4 && netDamage > 10;
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
  } else {
    // Move to heal position (tower range)
    var healPos = getHealPosition(creep);
    if (creep.pos.getRangeTo(healPos) > 3) {
      smartMoveTo(creep, healPos, { visualizePathStyle: { stroke: "#ff6600" }, reusePath: 5 });
    }
  }

  // ALWAYS attack while retreating - kite and shoot
  var nearestHostile = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
  if (nearestHostile && creep.pos.getRangeTo(nearestHostile) <= 3) {
    creep.rangedAttack(nearestHostile);
  }

  // ALWAYS self-heal while retreating
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }

  creep.say("KITE");
  return true;
}

// ============================================
// Main Remote Defender Logic
// ============================================
export function runRemoteDefender(creep: Creep): void {
  var homeRoom = creep.memory.room;

  // Priority 1: If no RANGED_ATTACK parts, retreat immediately (can't fight)
  if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) {
    runRetreat(creep);
    return;
  }

  // Priority 2: Check if we need to retreat (per-tick, no sticky flag)
  // Only retreat when critically wounded - see shouldRetreat() for logic
  if (shouldRetreat(creep)) {
    runRetreat(creep);
    return;
  }

  // Clear any stale retreating flag from old logic
  if (creep.memory.retreating) {
    delete creep.memory.retreating;
  }

  var targetRoom = creep.memory.targetRoom;

  // Check if target room still has threats (read from Memory.intel)
  var targetIntel = targetRoom && Memory.intel && Memory.intel[targetRoom]
    ? Memory.intel[targetRoom]
    : null;
  var targetHasThreats = targetIntel && targetIntel.hostiles && targetIntel.hostiles > 0;

  if (!targetHasThreats) {
    // Look for another room that needs defenders
    var newTarget = findRoomNeedingDefender(homeRoom);
    if (newTarget) {
      creep.memory.targetRoom = newTarget;
      targetRoom = newTarget;
      creep.memory.renewing = false; // Cancel renewal for combat
      creep.say("NEW");
    } else {
      // No threats anywhere - move home and handle renewal/idle
      if (creep.room.name !== homeRoom) {
        moveToRoom(creep, homeRoom, "#888888");
        // Still attack anything in range while going home
        alwaysAttackAndHeal(creep);
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
      var idlePos = getIdlePosition(creep);
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
    // Attack anything in range while traveling
    alwaysAttackAndHeal(creep);
    creep.say("GO");
    return;
  }

  // In target room - kite and attack hostiles
  kiteAndAttack(creep);

  // Check if room is clear - update memory
  var remainingHostiles = creep.room.find(FIND_HOSTILE_CREEPS).length;
  var remainingCores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_INVADER_CORE; },
  }).length;

  if (remainingHostiles === 0 && remainingCores === 0) {
    // NOTE: Intel will be updated automatically by gatherRoomIntel() next tick
    // Disband the squad for this room
    var homeRoomObj = Game.rooms[creep.memory.room];
    if (homeRoomObj) {
      var squadManager = new RemoteSquadManager(homeRoomObj);
      squadManager.disbandSquad(targetRoom);
    }
    // Clear assignment so we can find new threats
    creep.memory.targetRoom = undefined;
  }
}

/**
 * Always attack and heal - used during travel states
 * Screeps allows move + rangedAttack + heal in the same tick
 */
function alwaysAttackAndHeal(creep: Creep): void {
  var nearestHostile = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
  if (nearestHostile) {
    var range = creep.pos.getRangeTo(nearestHostile);
    if (range <= 3) {
      creep.rangedAttack(nearestHostile);
    }
  }

  // Always self-heal if damaged
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }
}

/**
 * Kite and attack - maintain range 3 from melee hostiles
 * This is the main combat loop for remote defenders
 */
function kiteAndAttack(creep: Creep): void {
  var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);

  // Always self-heal if damaged (uses HEAL action slot)
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }

  if (hostiles.length === 0) {
    // No hostiles - check for invader cores
    var invaderCore = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_INVADER_CORE; },
    })[0] as StructureInvaderCore | undefined;

    if (invaderCore) {
      var coreRange = creep.pos.getRangeTo(invaderCore);
      if (coreRange <= 3) {
        creep.rangedAttack(invaderCore);
      }
      if (coreRange > 1) {
        smartMoveTo(creep, invaderCore, { visualizePathStyle: { stroke: "#ff0000" } });
      }
      creep.say("CORE");
    } else {
      creep.say("OK");
    }
    return;
  }

  // Find priority target (healers > ranged > melee, then closest)
  var target = findPriorityTarget(creep);
  if (!target) return;

  var targetRange = creep.pos.getRangeTo(target);

  // Check if any hostile is too close (range <= 2) - need to kite away
  var tooClose = false;
  for (var i = 0; i < hostiles.length; i++) {
    if (creep.pos.getRangeTo(hostiles[i]) <= 2) {
      tooClose = true;
      break;
    }
  }

  if (tooClose) {
    // Flee from all hostiles - maintain range 4
    var fleeGoals = [];
    for (var j = 0; j < hostiles.length; j++) {
      fleeGoals.push({ pos: hostiles[j].pos, range: 4 });
    }
    var fleePath = PathFinder.search(creep.pos, fleeGoals, { flee: true });
    if (fleePath.path.length > 0) {
      creep.move(creep.pos.getDirectionTo(fleePath.path[0]));
    }
    creep.say("KITE");
  } else if (targetRange > 3) {
    // Move closer to get in attack range
    smartMoveTo(creep, target, {
      visualizePathStyle: { stroke: "#ff0000" },
      reusePath: 3,
    });
    creep.say("GO");
  }
  // else: range is 3, perfect - don't move

  // Attack - always attack if in range
  if (targetRange <= 3) {
    // Check if multiple hostiles are close - use mass attack
    var nearbyCount = 0;
    for (var k = 0; k < hostiles.length; k++) {
      if (creep.pos.getRangeTo(hostiles[k]) <= 3) {
        nearbyCount++;
      }
    }

    if (nearbyCount > 1 && targetRange <= 1) {
      // Multiple hostiles very close - mass attack
      creep.rangedMassAttack();
    } else {
      creep.rangedAttack(target);
    }
    creep.say("ATK");
  }
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
 * Checks adjacent rooms for threats based on Memory.intel
 */
function findRoomNeedingDefender(homeRoom: string): string | null {
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return null;

  const SCAN_AGE_THRESHOLD = 200;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    // Read from Memory.intel
    const intel = Memory.intel && Memory.intel[roomName];
    if (!intel) continue;

    // Skip Source Keeper rooms
    if (intel.roomType === "sourceKeeper") continue;

    // Check scan age - don't respond to stale intel
    const scanAge = Game.time - (intel.lastScanned || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) continue;

    const hostileCount = intel.hostiles || 0;
    if (hostileCount > 0) {
      // Check for dangerous hostiles
      const hostileDetails = intel.hostileDetails;
      let hasDangerous = false;
      if (hostileDetails && hostileDetails.length > 0) {
        hasDangerous = hostileDetails.some((h) => h.hasCombat);
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
