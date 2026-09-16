/**
 * Pioneer - Self-sufficient generalist for young colonies AND expansion
 *
 * LOCAL MODE (no targetRoom):
 * - Pioneers replace all specialist roles until source containers are built
 * - They harvest, deliver, build, and upgrade - zero interdependencies
 *
 * EXPANSION MODE (with targetRoom):
 * - Travels from parent to target room
 * - Self-sufficient: harvests locally, no hauler coordination needed
 * - Builds spawn, then recycles when complete
 * - Replaces BOOTSTRAP_BUILDER + BOOTSTRAP_HAULER with single role
 *
 * State machine:
 * - TRAVELING: Moving to target room (expansion only)
 * - HARVESTING: Harvesting from source or collecting dropped energy
 * - DELIVERING: Delivering to spawn/extensions
 * - BUILDING: Building construction sites
 * - UPGRADING: Upgrading controller
 */

import { moveToRoom, smartMoveTo } from "../utils/movement";
import { applyWorkerEnergy, scoreWorkerEnergy } from "./workerEnergy";
import { scoreDeliveryTargets } from "./haulerDelivery";
import { chooseHomeSite } from "./buildTargets";

type PioneerState = "TRAVELING" | "HARVESTING" | "DELIVERING" | "BUILDING" | "UPGRADING";

export interface PioneerMemory extends CreepMemory {
  role: "PIONEER";
  room: string;
  state?: PioneerState;
  sourceId?: Id<Source>;
  // Expansion fields
  targetRoom?: string;     // If set, this is an expansion pioneer
  parentRoom?: string;     // Parent colony for expansion pioneers
  working?: boolean;       // true = spending energy, false = collecting
}

/**
 * Run the pioneer creep logic
 */
export function runPioneer(creep: Creep): void {
  var mem = creep.memory as PioneerMemory;
  var isExpansionPioneer = !!mem.targetRoom;

  // === EXPANSION COMPLETION CHECK ===
  // If expansion room now has a spawn, recycle or convert
  if (isExpansionPioneer && mem.targetRoom) {
    var targetRoom = Game.rooms[mem.targetRoom];
    if (targetRoom) {
      var spawns = targetRoom.find(FIND_MY_SPAWNS);
      if (spawns.length > 0) {
        // Spawn complete! Recycle at the new spawn
        var spawn = spawns[0];
        if (creep.room.name !== mem.targetRoom) {
          // Travel to target room to recycle
          moveToRoom(creep, mem.targetRoom, "#00ff00");
          return;
        }
        // Try to recycle
        var recycleResult = spawn.recycleCreep(creep);
        if (recycleResult === ERR_NOT_IN_RANGE) {
          smartMoveTo(creep, spawn, { reusePath: 10 });
        } else if (recycleResult === OK) {
          console.log("[Pioneer] " + creep.name + " recycled at new spawn in " + mem.targetRoom);
        }
        return;
      }
    }
  }

  // === EDGE TILE HANDLING ===
  // Creeps crossing room borders land on edge tiles where pathfinding behaves oddly
  // Must move inward BEFORE any state logic to prevent flip-flopping
  if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
    // Find something to move toward
    var site = creep.room.find(FIND_MY_CONSTRUCTION_SITES)[0];
    if (site) {
      creep.moveTo(site, { reusePath: 10, visualizePathStyle: { stroke: "#00ff00" } });
    } else if (creep.room.controller) {
      creep.moveTo(creep.room.controller, { reusePath: 10 });
    } else {
      creep.moveTo(25, 25);
    }
    creep.say("EDGE!");
    return;
  }

  // Initialize state
  if (!mem.state) {
    if (isExpansionPioneer && creep.room.name !== mem.targetRoom) {
      mem.state = "TRAVELING";
    } else {
      mem.state = "HARVESTING";
    }
    mem.working = false;
  }

  // === STATE TRANSITIONS ===
  // Simple working toggle for expansion pioneers (like old BootstrapBuilder)
  if (isExpansionPioneer) {
    if (mem.working && creep.store[RESOURCE_ENERGY] === 0) {
      mem.working = false;
      mem.state = "HARVESTING";
    } else if (!mem.working && creep.store.getFreeCapacity() === 0) {
      mem.working = true;
      mem.state = decideWorkState(creep, isExpansionPioneer);
    }
    // Check if we need to travel to target room
    if (creep.room.name !== mem.targetRoom) {
      mem.state = "TRAVELING";
    }
  } else {
    // Local pioneer logic
    if (mem.state === "HARVESTING" && creep.store.getFreeCapacity() === 0) {
      mem.state = decideWorkState(creep, false);
    } else if (mem.state !== "HARVESTING" && creep.store[RESOURCE_ENERGY] === 0) {
      mem.state = "HARVESTING";
    }
  }

  // Execute current state
  switch (mem.state) {
    case "TRAVELING":
      pioneerTravel(creep, mem);
      break;
    case "HARVESTING":
      pioneerHarvest(creep, mem, isExpansionPioneer);
      break;
    case "DELIVERING":
      pioneerDeliver(creep, isExpansionPioneer);
      break;
    case "BUILDING":
      pioneerBuild(creep, isExpansionPioneer);
      break;
    case "UPGRADING":
      pioneerUpgrade(creep);
      break;
  }
}

/**
 * Travel to target room (expansion mode)
 */
function pioneerTravel(creep: Creep, mem: PioneerMemory): void {
  if (!mem.targetRoom) return;

  if (creep.room.name === mem.targetRoom) {
    mem.state = "HARVESTING";
    return;
  }

  moveToRoom(creep, mem.targetRoom, "#00ff00");
}

/**
 * Decide what work to do when full of energy
 * Priority for expansion: spawn site > extensions > other sites > controller
 * Priority for local: spawn/extensions > construction > controller
 */
function decideWorkState(creep: Creep, isExpansion: boolean): PioneerState {
  var room = creep.room;

  if (isExpansion) {
    // Expansion priority: spawn site first!
    var spawnSite = room.find(FIND_CONSTRUCTION_SITES, {
      filter: function(s) { return s.structureType === STRUCTURE_SPAWN; }
    })[0];
    if (spawnSite) {
      return "BUILDING";
    }
  }

  // Priority 1: Spawn and extensions need energy
  var spawnStructures = room.find(FIND_MY_STRUCTURES, {
    filter: function(s) {
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
 * Harvest energy - expansion pioneers use different priority
 */
function pioneerHarvest(creep: Creep, mem: PioneerMemory, isExpansion: boolean): void {
  if (isExpansion) {
    // An expansion pioneer takes whatever the room offers, scored by the shared worker
    // owner. This was a five-tier chain - dropped, tombstone, ruin, container, harvest -
    // each tier returning unconditionally, so a single unit of dropped energy across the
    // room outranked a full container underfoot. Harvest stays in the option set at a low
    // weight, which is what makes a pioneer self-sufficient: it can never be stranded.
    const best = scoreWorkerEnergy(creep, { allowHarvest: true });
    if (best) {
      if (applyWorkerEnergy(creep, best) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, best.target, { reusePath: 10, visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // No source active and nothing lying around - wait near the controller.
    if (creep.room.controller && creep.pos.getRangeTo(creep.room.controller) > 3) {
      smartMoveTo(creep, creep.room.controller, { reusePath: 10 });
    }
    creep.say("WAIT");
    return;
  }

  // === LOCAL PIONEER HARVESTING ===
  // Deliberately not scored: this is source *assignment*, spreading pioneers evenly across
  // a young room's sources so two do not crowd one. That is a different question from
  // "which source is best right now", and scoring it would undo the balancing.
  var nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
    filter: function(r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount >= 50;
    },
  })[0];

  if (nearbyDropped) {
    creep.pickup(nearbyDropped);
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
    var myCreeps = Object.values(Game.creeps).filter(function(c) {
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
  var harvestResult = creep.harvest(source);
  if (harvestResult === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, source, { reusePath: 10 });
  }
}

/**
 * Deliver energy to spawn/extensions
 */
function pioneerDeliver(creep: Creep, isExpansion: boolean): void {
  // Shared delivery owner. Offering only spawn and extensions meant a pioneer holding
  // energy in a room whose spawn network was full had nowhere to put it and bounced back
  // through decideWorkState every tick; towers and storage are now in the option set, and
  // a tower that cannot defend outranks everything.
  const best = scoreDeliveryTargets(creep);

  if (!best) {
    // Nothing accepts energy - switch to building or upgrading
    (creep.memory as PioneerMemory).state = decideWorkState(creep, isExpansion);
    return;
  }

  if (creep.transfer(best.target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, best.target, { reusePath: 5 });
  }
}

/**
 * A pioneer's own build order: the spawn first, then a container beside a source, because
 * in a bootstrap room static mining is what makes everything else affordable.
 */
function pioneerSitePriority(site: ConstructionSite): number {
  if (site.structureType === STRUCTURE_SPAWN) return 0;
  if (site.structureType === STRUCTURE_CONTAINER) {
    return site.pos.findInRange(FIND_SOURCES, 1).length > 0 ? 1 : 3;
  }
  if (site.structureType === STRUCTURE_EXTENSION) return 2;
  return 4;
}

/**
 * Build construction sites
 */
function pioneerBuild(creep: Creep, isExpansion: boolean): void {
  var sites = creep.room.find(FIND_CONSTRUCTION_SITES);

  if (sites.length === 0) {
    // No sites - switch to upgrading
    (creep.memory as PioneerMemory).state = "UPGRADING";
    return;
  }

  // Priority order is this role's own, but reachability is required either way: sorting and
  // taking sites[0] is what left a builder in E47N41 holding 800 energy for 200 ticks in
  // front of a site it could not path to.
  var target = chooseHomeSite(creep, sites, pioneerSitePriority);
  if (!target) {
    (creep.memory as PioneerMemory).state = "UPGRADING";
    creep.say("no path");
    return;
  }

  var result = creep.build(target);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, target, { reusePath: 10, visualizePathStyle: { stroke: "#00ff00" } });
  } else if (result === OK) {
    // Opportunistically pickup nearby energy while building
    var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: function(r) { return r.resourceType === RESOURCE_ENERGY; },
    })[0];
    if (nearby && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.pickup(nearby);
    }
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
