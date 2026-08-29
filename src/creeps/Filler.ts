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
  // Never renew while the room cannot fill its own spawn. Renewal consumes the exact
  // energy the filler exists to deliver, and runRenewal() short-circuits the fill loop
  // entirely - so a filler that begins renewing in a starved room keeps it starved for
  // the whole renewal. E47N41 sat at 4/4600 spawn energy with ~3000 in its containers
  // while its last filler quietly renewed itself, deadlocking the room's only way out.
  var starved = creep.room.energyAvailable < creep.room.energyCapacityAvailable * 0.5;

  if (starved) {
    if (creep.memory.renewing) delete creep.memory.renewing;
  } else if (shouldGoRenew(creep) || creep.memory.renewing) {
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

  // Refill when empty. Storage is the normal source but must never be the ONLY one:
  // an empty storage with energy still sitting in containers strands the filler, the
  // spawn cannot be refilled, and the room cannot spawn its way out. That is a true
  // death spiral - it took E47N41 (RCL 7) down to two creeps and 4/4600 spawn energy
  // while its own containers held nearly 3000.
  if (creep.store[RESOURCE_ENERGY] === 0) {
    if (storage && storage.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, storage, { reusePath: 5 });
      }
      return;
    }

    // Fall back to the fullest container in the room.
    var containers = creep.room.find(FIND_STRUCTURES, {
      filter: function(s) {
        return s.structureType === STRUCTURE_CONTAINER &&
          (s as StructureContainer).store[RESOURCE_ENERGY] > 0;
      },
    }) as StructureContainer[];

    if (containers.length > 0) {
      var fullest = containers[0];
      for (var ci = 1; ci < containers.length; ci++) {
        if (containers[ci].store[RESOURCE_ENERGY] > fullest.store[RESOURCE_ENERGY]) {
          fullest = containers[ci];
        }
      }
      creep.say("cont");
      if (creep.withdraw(fullest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, fullest, { reusePath: 5 });
      }
      return;
    }

    // Last resort: dropped energy, then ruins/tombstones are not worth the CPU here.
    var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= 25; },
    });

    if (dropped) {
      creep.say("drop");
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, dropped, { reusePath: 5 });
      }
      return;
    }

    creep.say("no NRG");
    return;
  }

  if (!storage) {
    // No storage yet, but we are carrying energy - still worth delivering below.
    creep.say("no stor");
  }

  // Find unfilled spawn/extension.
  // findClosestByPath treats creeps as obstacles, so a cluster around the spawn makes it
  // return null even when a hungry spawn is two tiles away - and the filler then falls
  // through to the tower top-off below and walks off while the spawn sits on
  // WAIT_ENERGY. Fall back to range so a reachable target is never missed; smartMoveTo
  // does the actual pathing and has its own stuck handling.
  var fillFilter = function(s: AnyOwnedStructure) {
    return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      (s as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
  };

  var target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: fillFilter }) as
    StructureSpawn | StructureExtension | null;

  if (!target) {
    target = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, { filter: fillFilter }) as
      StructureSpawn | StructureExtension | null;
  }

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

  // Nothing to fill — park near storage (or the spawn if there is no storage yet)
  var parkTarget: RoomObject | null = storage || creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (parkTarget && !creep.pos.inRangeTo(parkTarget, 2)) {
    smartMoveTo(creep, parkTarget, { reusePath: 10 });
  }
}
