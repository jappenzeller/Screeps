/**
 * RoadBuilder - Specialized road construction
 *
 * Only builds road construction sites. Prioritizes roads closest to storage
 * (or spawn if no storage) and works outward. This ensures critical paths
 * are paved first (storage → spawn, storage → sources, storage → controller).
 *
 * State machine:
 * - COLLECTING: Get energy from storage, containers, or dropped resources
 * - BUILDING: Build the nearest-to-storage road construction site
 */

import { smartMoveTo } from "../utils/movement";

type RoadBuilderState = "COLLECTING" | "BUILDING";

export function runRoadBuilder(creep: Creep): void {
  var mem = creep.memory;

  // State transitions
  if (mem.state === "BUILDING" && creep.store[RESOURCE_ENERGY] === 0) {
    mem.state = "COLLECTING";
    creep.say("collect");
  } else if (mem.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    mem.state = "BUILDING";
    creep.say("road");
  }

  // Default state
  if (!mem.state) {
    mem.state = creep.store[RESOURCE_ENERGY] > 0 ? "BUILDING" : "COLLECTING";
  }

  if (mem.state === "COLLECTING") {
    collectEnergy(creep);
  } else {
    buildRoad(creep);
  }
}

function collectEnergy(creep: Creep): void {
  // Priority 1: Storage
  var storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 1000) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Container with energy
  var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 100;
    },
  });
  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Dropped energy
  var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: function(r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount > 30;
    },
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing available — wait near storage or spawn
  var waitTarget = storage || creep.room.find(FIND_MY_SPAWNS)[0];
  if (waitTarget && !creep.pos.inRangeTo(waitTarget, 3)) {
    smartMoveTo(creep, waitTarget, { reusePath: 10 });
  }
  creep.say("wait");
}

function buildRoad(creep: Creep): void {
  // Find all road construction sites in home room
  var roadSites = creep.room.find(FIND_CONSTRUCTION_SITES, {
    filter: function(s) { return s.structureType === STRUCTURE_ROAD; },
  });

  if (roadSites.length === 0) {
    // No roads to build — idle near storage
    creep.say("done");
    var storage = creep.room.storage;
    var waitTarget = storage || creep.room.find(FIND_MY_SPAWNS)[0];
    if (waitTarget && !creep.pos.inRangeTo(waitTarget, 3)) {
      smartMoveTo(creep, waitTarget, { reusePath: 10 });
    }
    return;
  }

  // Sort by distance to storage (closest first), fallback to spawn
  var anchor = creep.room.storage || creep.room.find(FIND_MY_SPAWNS)[0];
  if (anchor) {
    roadSites.sort(function(a, b) {
      return anchor.pos.getRangeTo(a) - anchor.pos.getRangeTo(b);
    });
  }

  // Build the closest-to-storage road
  var target = roadSites[0];
  var result = creep.build(target);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, target, { visualizePathStyle: { stroke: "#cccccc" }, reusePath: 5 });
  }
  creep.say("road " + roadSites.length);
}
