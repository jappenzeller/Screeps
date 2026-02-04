/**
 * Pioneer - Self-sufficient generalist for young colonies
 *
 * Pioneers replace all specialist roles until source containers are built.
 * They harvest, deliver, build, and upgrade - zero interdependencies.
 *
 * State machine:
 * - HARVESTING: Harvesting from assigned source
 * - DELIVERING: Delivering to spawn/extensions
 * - BUILDING: Building construction sites
 * - UPGRADING: Upgrading controller
 */

import { smartMoveTo } from "../utils/movement";

type PioneerState = "HARVESTING" | "DELIVERING" | "BUILDING" | "UPGRADING";

interface PioneerMemory extends CreepMemory {
  role: "PIONEER";
  room: string;
  state: PioneerState;
  sourceId?: Id<Source>;
}

/**
 * Run the pioneer creep logic
 */
export function runPioneer(creep: Creep): void {
  var mem = creep.memory as PioneerMemory;

  // Initialize state
  if (!mem.state) {
    mem.state = "HARVESTING";
  }

  // State transitions based on energy
  if (mem.state === "HARVESTING" && creep.store.getFreeCapacity() === 0) {
    // Full energy - decide what to do
    mem.state = decideWorkState(creep);
  } else if (mem.state !== "HARVESTING" && creep.store[RESOURCE_ENERGY] === 0) {
    // Empty - go harvest
    mem.state = "HARVESTING";
  }

  // Execute current state
  switch (mem.state) {
    case "HARVESTING":
      pioneerHarvest(creep, mem);
      break;
    case "DELIVERING":
      pioneerDeliver(creep);
      break;
    case "BUILDING":
      pioneerBuild(creep);
      break;
    case "UPGRADING":
      pioneerUpgrade(creep);
      break;
  }
}

/**
 * Decide what work to do when full of energy
 * Priority: spawn/extensions > construction > controller
 */
function decideWorkState(creep: Creep): PioneerState {
  var room = creep.room;

  // Priority 1: Spawn and extensions need energy
  var spawnStructures = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      return (
        (s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION) &&
        (s as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0
      );
    },
  });

  if (spawnStructures.length > 0) {
    return "DELIVERING";
  }

  // Priority 2: Construction sites exist
  var sites = room.find(FIND_CONSTRUCTION_SITES);
  if (sites.length > 0) {
    return "BUILDING";
  }

  // Priority 3: Upgrade controller
  return "UPGRADING";
}

/**
 * Harvest energy from source
 */
function pioneerHarvest(creep: Creep, mem: PioneerMemory): void {
  // Try to pick up dropped energy first (efficiency)
  var dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
    filter: function (r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount >= 50;
    },
  })[0];

  if (dropped) {
    creep.pickup(dropped);
    return;
  }

  // Get assigned source or find one
  var source: Source | null = null;
  if (mem.sourceId) {
    source = Game.getObjectById(mem.sourceId);
  }

  if (!source) {
    // Find source with fewest pioneers assigned
    var sources = creep.room.find(FIND_SOURCES);
    var myCreeps = Object.values(Game.creeps).filter(function (c) {
      return c.memory.role === "PIONEER" && c.memory.room === creep.room.name;
    });

    var bestSource: Source | null = null;
    var bestCount = Infinity;

    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var count = 0;
      for (var j = 0; j < myCreeps.length; j++) {
        if ((myCreeps[j].memory as PioneerMemory).sourceId === s.id) {
          count++;
        }
      }
      if (count < bestCount) {
        bestCount = count;
        bestSource = s;
      }
    }

    if (bestSource) {
      source = bestSource;
      mem.sourceId = bestSource.id;
    }
  }

  if (!source) return;

  // Harvest
  var result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, source, { reusePath: 10 });
  }
}

/**
 * Deliver energy to spawn/extensions
 */
function pioneerDeliver(creep: Creep): void {
  var target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: function (s) {
      return (
        (s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION) &&
        (s as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0
      );
    },
  });

  if (!target) {
    // No spawn/extensions need energy - switch to building or upgrading
    (creep.memory as PioneerMemory).state = decideWorkState(creep);
    return;
  }

  var result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, target, { reusePath: 5 });
  }
}

/**
 * Build construction sites
 */
function pioneerBuild(creep: Creep): void {
  // Priority: containers at sources > extensions > other
  var sites = creep.room.find(FIND_CONSTRUCTION_SITES);

  if (sites.length === 0) {
    // No sites - switch to upgrading
    (creep.memory as PioneerMemory).state = "UPGRADING";
    return;
  }

  // Sort by priority
  sites.sort(function (a, b) {
    var getPriority = function (site: ConstructionSite): number {
      if (site.structureType === STRUCTURE_CONTAINER) {
        // Source containers are highest priority
        if (site.pos.findInRange(FIND_SOURCES, 1).length > 0) return 0;
        return 2;
      }
      if (site.structureType === STRUCTURE_EXTENSION) return 1;
      if (site.structureType === STRUCTURE_SPAWN) return 1;
      return 3;
    };
    return getPriority(a) - getPriority(b);
  });

  var target = sites[0];
  var result = creep.build(target);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, target, { reusePath: 10 });
  }
}

/**
 * Upgrade controller
 */
function pioneerUpgrade(creep: Creep): void {
  var controller = creep.room.controller;
  if (!controller) return;

  var result = creep.upgradeController(controller);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, controller, { reusePath: 10 });
  }
}

/**
 * Get pioneer body based on available energy
 * Pattern: [WORK, CARRY, MOVE] repeated
 */
export function getPioneerBody(energy: number): BodyPartConstant[] {
  var pattern: BodyPartConstant[] = [WORK, CARRY, MOVE];
  var patternCost = 200; // 100 + 50 + 50

  // Minimum viable pioneer
  if (energy < patternCost) {
    return [];
  }

  var body: BodyPartConstant[] = [];
  var repeats = Math.floor(energy / patternCost);

  // Cap at ~16 repeats (48 parts) to leave room and stay reasonable
  repeats = Math.min(repeats, 16);

  for (var i = 0; i < repeats; i++) {
    body.push(WORK, CARRY, MOVE);
  }

  return body;
}
