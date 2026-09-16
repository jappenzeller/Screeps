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
import { firstReachable } from "./buildTargets";
import { applyWorkerEnergy, scoreWorkerEnergy } from "./workerEnergy";

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
  // Shared with Builder and RemoteBuilder. This role's own chain put storage first
  // whenever it held over 1,000, so the container and dropped-energy branches below were
  // unreachable in any developed room.
  const best = scoreWorkerEnergy(creep, { allowHarvest: false });
  if (best) {
    if (applyWorkerEnergy(creep, best) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, best.target, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing available - wait near storage or spawn
  var storage = creep.room.storage;
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
    // No roads to build - idle near storage
    creep.say("done");
    var idleStorage = creep.room.storage;
    var idleTarget = idleStorage || creep.room.find(FIND_MY_SPAWNS)[0];
    if (idleTarget && !creep.pos.inRangeTo(idleTarget, 3)) {
      smartMoveTo(creep, idleTarget, { reusePath: 10 });
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

  // Paying out from storage outward is the intent, so that order is kept - but the head of
  // the list still has to be somewhere this creep can get to. Taking roadSites[0] on faith
  // is the same range-as-proxy assumption that stranded a builder in E47N41 for 200 ticks.
  var target = firstReachable(creep, roadSites);
  if (!target) {
    creep.say("no path");
    return;
  }

  var result = creep.build(target);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, target, { visualizePathStyle: { stroke: "#cccccc" }, reusePath: 5 });
  }
  creep.say("road " + roadSites.length);
}
