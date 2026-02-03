/**
 * BOOTSTRAP_WORKER - Self-sufficient generalist for bootstrapping colonies
 *
 * Spawned from a parent colony, travels to target colony, and does everything
 * needed to get it running: harvest, fill spawn, upgrade controller, build.
 *
 * Unlike specialized roles, this worker can single-handedly bootstrap a colony
 * because it doesn't depend on coordination with other roles.
 */

import { moveToRoom, smartMoveTo } from "../utils/movement";

type WorkerState = "MOVING" | "HARVESTING" | "WORKING";

export function runBootstrapWorker(creep: Creep): void {
  var mem = creep.memory as any;

  // Initialize state
  if (!mem.workerState) {
    mem.workerState = creep.room.name === mem.targetRoom ? "HARVESTING" : "MOVING";
  }

  var workerState: WorkerState = mem.workerState;

  // State transitions
  if (workerState === "MOVING" && creep.room.name === mem.targetRoom) {
    workerState = "HARVESTING";
  }

  if (workerState === "WORKING" && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    workerState = "HARVESTING";
  }

  if (workerState === "HARVESTING") {
    // Transition to working when full OR when source is empty and we have some energy
    var isFull = creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
    var hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    var source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);

    if (isFull || (hasEnergy && !source)) {
      workerState = "WORKING";
    }
  }

  // Save state
  mem.workerState = workerState;

  // Execute state
  switch (workerState) {
    case "MOVING":
      travelToTarget(creep, mem.targetRoom);
      break;
    case "HARVESTING":
      harvest(creep);
      break;
    case "WORKING":
      work(creep);
      break;
  }
}

function travelToTarget(creep: Creep, targetRoom: string): void {
  if (creep.room.name === targetRoom) {
    (creep.memory as any).state = "HARVESTING";
    return;
  }

  // Use moveToRoom for cross-room travel
  var moved = moveToRoom(creep, targetRoom, "#00ffff");
  if (!moved) {
    // Fallback: moveTo room center
    creep.moveTo(new RoomPosition(25, 25, targetRoom), { reusePath: 20 });
  }
  creep.say("TRAVEL");
}

function harvest(creep: Creep): void {
  // Priority 1: Dropped energy
  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 20; }
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, { reusePath: 5 });
    }
    creep.say("PICKUP");
    return;
  }

  // Priority 2: Tombstones
  var tombstone = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
    filter: function(t) { return t.store.getUsedCapacity(RESOURCE_ENERGY) > 0; }
  });
  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, tombstone, { reusePath: 5 });
    }
    creep.say("TOMB");
    return;
  }

  // Priority 3: Containers
  var container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 50;
    }
  }) as StructureContainer | null;
  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { reusePath: 5 });
    }
    creep.say("CONT");
    return;
  }

  // Priority 4: Harvest from source
  var source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
  if (source) {
    var result = creep.harvest(source);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, source, { reusePath: 10, visualizePathStyle: { stroke: "#ffaa00" } });
    }
    creep.say("HARVEST");
    return;
  }

  // No source - wait
  creep.say("WAIT");
}

function work(creep: Creep): void {
  // Priority 1: Fill spawns (especially spawning ones first)
  var spawns = creep.room.find(FIND_MY_SPAWNS, {
    filter: function(s) { return s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; }
  });
  if (spawns.length > 0) {
    // Prefer spawning spawn (needs energy to finish)
    var target = spawns[0];
    for (var i = 0; i < spawns.length; i++) {
      if (spawns[i].spawning) {
        target = spawns[i];
        break;
      }
    }
    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, target, { reusePath: 5, visualizePathStyle: { stroke: "#ffffff" } });
    }
    creep.say("SPAWN");
    return;
  }

  // Priority 2: Fill extensions
  var extension = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_EXTENSION &&
        (s as StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    }
  }) as StructureExtension | null;
  if (extension) {
    if (creep.transfer(extension, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, extension, { reusePath: 5 });
    }
    creep.say("EXT");
    return;
  }

  // Priority 3: Upgrade controller if ticksToDowngrade < 5000
  var controller = creep.room.controller;
  if (controller && controller.my && controller.ticksToDowngrade && controller.ticksToDowngrade < 5000) {
    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, controller, { reusePath: 10 });
    }
    creep.say("SAVE!");
    return;
  }

  // Priority 4: Build construction sites
  // Spawn site first
  var spawnSite = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
    filter: function(s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (spawnSite) {
    if (creep.build(spawnSite) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, spawnSite, { reusePath: 5, visualizePathStyle: { stroke: "#00ff00" } });
    }
    creep.say("BUILD!");
    return;
  }

  // Extension sites
  var extSite = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
    filter: function(s) { return s.structureType === STRUCTURE_EXTENSION; }
  });
  if (extSite) {
    if (creep.build(extSite) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, extSite, { reusePath: 5 });
    }
    creep.say("BUILD");
    return;
  }

  // Any other site
  var site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, site, { reusePath: 5 });
    }
    creep.say("BUILD");
    return;
  }

  // Priority 5: Upgrade controller (nothing else to do)
  if (controller && controller.my) {
    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, controller, { reusePath: 10 });
    }
    creep.say("UPGRADE");
    return;
  }

  creep.say("IDLE");
}

/**
 * Body for bootstrap worker: balanced WORK/CARRY/MOVE
 * Equal MOVE to other parts for full speed on plains
 */
export function getBootstrapWorkerBody(energy: number): BodyPartConstant[] {
  // Bodies at different energy levels
  var bodies: BodyPartConstant[][] = [
    // 300 energy - minimum viable
    [WORK, CARRY, MOVE, MOVE],
    // 550 energy
    [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
    // 800 energy
    [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
    // 1300 energy
    [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  ];

  // Find largest body that fits budget
  for (var i = bodies.length - 1; i >= 0; i--) {
    var cost = 0;
    for (var j = 0; j < bodies[i].length; j++) {
      cost += BODYPART_COST[bodies[i][j]];
    }
    if (cost <= energy) return bodies[i];
  }

  return bodies[0];
}
