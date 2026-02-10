import { smartMoveTo } from "../utils/movement";

/**
 * Filler - Dedicated spawn/extension filling from storage.
 *
 * At RCL 5+ with 30+ extensions, haulers can't keep up doing double duty:
 * long-haul from source containers AND distributing to extensions.
 *
 * Filler runs a tight loop: withdraw from storage, fill spawn/extensions.
 * This frees haulers to focus on long-haul delivery to storage.
 *
 * Persists via renewal (short round trip since spawn is nearby).
 */

// ============================================
// Renewal Logic for Filler
// ============================================

function getSpawnDistance(creep: Creep): number {
  var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  return spawn ? creep.pos.getRangeTo(spawn) : 999;
}

function shouldGoRenew(creep: Creep): boolean {
  if (!creep.ticksToLive) return false;

  // Don't renew undersized creeps - let them die and spawn bigger replacements
  var bodyCost = creep.body.reduce(function(sum, part) {
    return sum + BODYPART_COST[part.type];
  }, 0);
  var capacity = creep.room.energyCapacityAvailable;
  if (bodyCost < capacity * 0.5) {
    return false;
  }

  var distance = getSpawnDistance(creep);
  var roundTrip = distance * 2;
  var buffer = 20;

  return creep.ticksToLive < roundTrip + buffer;
}

function getRenewalTarget(creep: Creep): number {
  var distance = getSpawnDistance(creep);
  var roundTrip = distance * 2;
  var workPeriod = 500;
  var buffer = 20;

  return roundTrip + workPeriod + buffer;
}

function runRenewal(creep: Creep): boolean {
  var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return false;

  var range = creep.pos.getRangeTo(spawn);

  if (range > 1) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    creep.say("RENEW");
    return true;
  }

  // At spawn
  if (spawn.spawning) {
    if (creep.ticksToLive && creep.ticksToLive < 15) {
      return true; // critical, wait
    }
    return false; // give up
  }

  var target = getRenewalTarget(creep);
  if (creep.ticksToLive && creep.ticksToLive >= target) {
    return false; // done
  }

  spawn.renewCreep(creep);
  return true;
}

// ============================================
// Main Filler Logic
// ============================================

export function runFiller(creep: Creep): void {
  // Check for renewal
  if (shouldGoRenew(creep) || creep.memory.renewing) {
    creep.memory.renewing = true;
    if (runRenewal(creep)) return;
    creep.memory.renewing = false;
  }

  // === EMERGENCY: Shuttle storage → spawn when economy is dead ===
  var homeCreeps = Object.values(Game.creeps).filter(function(c) {
    return c.memory.room === creep.room.name;
  });
  var hasHarvesters = homeCreeps.some(function(c) {
    return c.memory.role === "HARVESTER";
  });
  var hasHaulers = homeCreeps.some(function(c) {
    return c.memory.role === "HAULER";
  });

  if (!hasHarvesters && !hasHaulers) {
    var emergencyStorage = creep.room.storage;
    if (emergencyStorage && emergencyStorage.store[RESOURCE_ENERGY] > 0) {
      // Emergency mode - just fill spawn/extensions like normal
      // but we stay in this block to signal emergency
      creep.say("SOS");
    }
  }
  // === END EMERGENCY ===

  var storage = creep.room.storage;
  if (!storage) {
    creep.say("no stor");
    return;
  }

  // Withdraw from storage when empty
  if (creep.store[RESOURCE_ENERGY] === 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { reusePath: 5 });
    }
    return;
  }

  // Find unfilled spawn/extension
  var target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: function(s: AnyOwnedStructure) {
      return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        (s as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    }
  }) as StructureSpawn | StructureExtension | null;

  if (target) {
    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, target, { reusePath: 3 });
    }
    return;
  }

  // All spawn/extensions full — opportunistically top off towers below 700
  var lowTower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: function(s: AnyOwnedStructure) {
      return s.structureType === STRUCTURE_TOWER &&
        (s as StructureTower).store[RESOURCE_ENERGY] < 700;
    }
  }) as StructureTower | null;

  if (lowTower) {
    if (creep.transfer(lowTower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, lowTower, { reusePath: 5 });
    }
    return;
  }

  // Nothing to fill — park near storage and wait
  if (!creep.pos.inRangeTo(storage, 2)) {
    smartMoveTo(creep, storage, { reusePath: 10 });
  }
}
