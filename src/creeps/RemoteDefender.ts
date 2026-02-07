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
// Border Crossing Logic
// ============================================

/**
 * Check if creep is on a room border tile.
 */
function isOnBorder(creep: Creep): boolean {
  var x = creep.pos.x;
  var y = creep.pos.y;
  return x === 0 || x === 49 || y === 0 || y === 49;
}

/**
 * Handle border crossing - push through if we have a target room.
 * Returns true if we handled this tick.
 */
function handleBorderCrossing(creep: Creep, mem: RemoteDefenderMemory): boolean {
  // If we have a target room and we're on the border, push through
  if (mem.targetRoom) {
    // Move toward target room center
    var targetPos = new RoomPosition(25, 25, mem.targetRoom);
    creep.moveTo(targetPos, { reusePath: 5 });
    creep.say("CROSS");
    return true;
  }

  // No target room - step off border toward room interior
  var x = creep.pos.x;
  var y = creep.pos.y;
  var direction: DirectionConstant;

  if (y === 0) direction = BOTTOM;
  else if (y === 49) direction = TOP;
  else if (x === 0) direction = RIGHT;
  else direction = LEFT;

  creep.move(direction);
  return true;
}

/**
 * Update target tracking based on visibility.
 * Persists targetRoom even when target isn't directly visible.
 */
function updateTargetTracking(creep: Creep, mem: RemoteDefenderMemory): void {
  // If we have a targetId, check if it's still valid
  if (mem.targetId) {
    var target = Game.getObjectById(mem.targetId);
    if (target) {
      // Target still visible - update tracking
      mem.lastTargetSeen = Game.time;
      mem.targetRoom = target.pos.roomName;
      return;
    }

    // Target not visible - could have moved or died
    // Keep targetRoom but clear targetId, will re-acquire in room
    delete mem.targetId;

    // If we haven't seen target in 100 ticks, clear everything
    if (mem.lastTargetSeen && Game.time - mem.lastTargetSeen > 100) {
      // Only clear if we're IN the target room and confirmed clear
      if (creep.room.name === mem.targetRoom) {
        var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) {
          delete mem.targetRoom;
          delete mem.lastTargetSeen;
        }
      }
    }
  }
}

// ============================================
// Main Remote Defender Logic
// ============================================
export function runRemoteDefender(creep: Creep): void {
  var mem = creep.memory as RemoteDefenderMemory;
  var homeRoom = mem.room;

  // Priority 0: Handle border stuck (always check first)
  if (isOnBorder(creep) && mem.targetRoom) {
    handleBorderCrossing(creep, mem);
    alwaysAttackAndHeal(creep);
    return;
  }

  // Priority 1: If no RANGED_ATTACK parts, retreat immediately (can't fight)
  if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) {
    runRetreat(creep);
    return;
  }

  // Priority 2: Check if we need to retreat (per-tick, no sticky flag)
  if (shouldRetreat(creep)) {
    runRetreat(creep);
    return;
  }

  // Clear any stale retreating flag from old logic
  if (mem.retreating) {
    delete mem.retreating;
  }

  // Update target tracking (handles cross-room persistence)
  updateTargetTracking(creep, mem);

  // Step 1: If we have a target room and aren't there, travel to it
  if (mem.targetRoom && creep.room.name !== mem.targetRoom) {
    travelToTargetRoom(creep, mem);
    alwaysAttackAndHeal(creep);
    return;
  }

  // Step 2: If in target room, try to acquire/engage target
  if (mem.targetRoom && creep.room.name === mem.targetRoom) {
    // Try to find a target if we don't have one
    if (!mem.targetId) {
      var hostile = findHostileInRoom(creep);
      if (hostile) {
        mem.targetId = hostile.id;
        mem.lastTargetSeen = Game.time;
      }
    }

    // Engage if we have a visible target
    var target = mem.targetId ? Game.getObjectById(mem.targetId) : null;
    if (target) {
      kiteAndAttack(creep);
      return;
    }

    // In target room but no hostiles visible - check if room is clear
    var remainingHostiles = creep.room.find(FIND_HOSTILE_CREEPS).length;
    var remainingCores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_INVADER_CORE; },
    }).length;

    if (remainingHostiles === 0 && remainingCores === 0) {
      // Room is clear - disband squad and clear assignment
      console.log("[" + creep.name + "] " + mem.targetRoom + " clear, returning home");
      var homeRoomObj = Game.rooms[homeRoom];
      if (homeRoomObj) {
        var squadManager = new RemoteSquadManager(homeRoomObj);
        squadManager.disbandSquad(mem.targetRoom);
      }
      delete mem.targetRoom;
      delete mem.targetId;
      delete mem.lastTargetSeen;
    } else if (remainingCores > 0) {
      // Attack invader core
      kiteAndAttack(creep);
      return;
    }
  }

  // Step 3: No active target room - check intel for hostile activity
  if (!mem.targetRoom) {
    var newTarget = findRoomNeedingDefender(homeRoom);
    if (newTarget) {
      mem.targetRoom = newTarget;
      mem.renewing = false; // Cancel renewal for combat
      console.log("[" + creep.name + "] Intel reports hostiles in " + newTarget);
      creep.say("NEW");
      return;
    }
  }

  // Step 4: No threats - return home and handle renewal/idle
  if (creep.room.name !== homeRoom) {
    moveToRoom(creep, homeRoom, "#888888");
    alwaysAttackAndHeal(creep);
    creep.say("HOME");
    return;
  }

  // At home - check for renewal
  if (shouldGoRenew(creep) || mem.renewing) {
    mem.renewing = true;
    if (runRenewal(creep)) return;
    mem.renewing = false;
  }

  // Idle at center position (away from spawn)
  var idlePos = getIdlePosition(creep);
  if (creep.pos.getRangeTo(idlePos) > 2) {
    smartMoveTo(creep, idlePos, { visualizePathStyle: { stroke: "#888888" } });
  }
  creep.say("IDLE");
}

/**
 * Travel to the target room with cross-room pathing.
 */
function travelToTargetRoom(creep: Creep, mem: RemoteDefenderMemory): void {
  if (!mem.targetRoom) return;

  var targetPos = new RoomPosition(25, 25, mem.targetRoom);

  var result = creep.moveTo(targetPos, {
    visualizePathStyle: { stroke: "#ff0000" },
    reusePath: 10,
    maxRooms: 3,
  });

  // If pathing fails, try direct move toward exit
  if (result === ERR_NO_PATH) {
    var exitDir = creep.room.findExitTo(mem.targetRoom);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      var exit = creep.pos.findClosestByPath(exitDir as ExitConstant);
      if (exit) {
        creep.moveTo(exit);
      }
    }
  }

  creep.say("GO");
}

/**
 * Find a hostile creep in the current room.
 * Prioritizes dangerous hostiles (ATTACK, RANGED, HEAL parts).
 */
function findHostileInRoom(creep: Creep): Creep | null {
  var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);

  if (hostiles.length === 0) return null;

  // Sort by threat level (highest first)
  hostiles.sort(function(a, b) {
    return getTargetPriority(b) - getTargetPriority(a);
  });

  return hostiles[0];
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
 * Checks all remote rooms (including distance-2) from Memory.colonies
 * Falls back to adjacent rooms via exits
 */
function findRoomNeedingDefender(homeRoom: string): string | null {
  const SCAN_AGE_THRESHOLD = 200;

  // Priority 1: Check all registered remote rooms (includes distance-2)
  var colonyMem = Memory.colonies && Memory.colonies[homeRoom];
  if (colonyMem && colonyMem.remotes) {
    for (var remoteName in colonyMem.remotes) {
      var config = colonyMem.remotes[remoteName];
      if (!config.active) continue;

      // Check intel for this remote
      var intel = Memory.intel && Memory.intel[remoteName];
      if (!intel) continue;

      // Skip source keeper rooms
      if (intel.roomType === "sourceKeeper") continue;

      // Check scan age
      var scanAge = Game.time - (intel.lastScanned || 0);
      if (scanAge > SCAN_AGE_THRESHOLD) continue;

      var hostileCount = intel.hostiles || 0;
      if (hostileCount > 0 || intel.invaderCore) {
        return remoteName;
      }

      // Also check direct visibility
      var room = Game.rooms[remoteName];
      if (room) {
        var hostiles = room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length > 0) {
          return remoteName;
        }
      }
    }
  }

  // Priority 2: Fallback - check adjacent rooms via exits
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return null;

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

  // Priority 3: Check home room itself
  var homeRoomObj = Game.rooms[homeRoom];
  if (homeRoomObj) {
    var homeHostiles = homeRoomObj.find(FIND_HOSTILE_CREEPS);
    if (homeHostiles.length > 0) {
      return homeRoom;
    }
  }

  return null;
}
