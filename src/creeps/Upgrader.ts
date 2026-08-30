import { smartMoveTo } from "../utils/movement";

/**
 * Range at which the proximity factor halves when scoring energy sources. Large enough
 * that supply dominates distance across a room, small enough to break ties toward the
 * nearer of two comparable sources.
 */
const DISTANCE_HALF_LIFE = 25;

/**
 * Upgrader: Takes energy and upgrades the room controller.
 * Simple implementation - no external dependencies.
 */

function moveOffRoad(creep: Creep): void {
  const onRoad = creep.pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_ROAD);
  if (!onRoad) return;

  const terrain = creep.room.getTerrain();

  // Search in expanding radius for non-road tile
  for (let radius = 1; radius <= 5; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = creep.pos.x + dx;
        const y = creep.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const hasRoad = creep.room.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType === STRUCTURE_ROAD);
        const hasCreep = creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0;
        if (!hasRoad && !hasCreep) {
          smartMoveTo(creep, new RoomPosition(x, y, creep.room.name), { visualizePathStyle: { stroke: "#888888" }, reusePath: 3 });
          return;
        }
      }
    }
  }
}

export function runUpgrader(creep: Creep): void {
  // EMERGENCY SHUTDOWN: Don't consume energy when economy is dead
  var homeRoom = Game.rooms[creep.memory.room];
  if (homeRoom) {
    var homeCreeps = Object.values(Game.creeps).filter(function(c) {
      return c.memory.room === creep.memory.room;
    });
    var hasHarvesters = homeCreeps.some(function(c) {
      return c.memory.role === 'HARVESTER' || c.memory.role === 'PIONEER';
    });
    var totalEnergy = (homeRoom.energyAvailable || 0) +
      (homeRoom.storage ? homeRoom.storage.store[RESOURCE_ENERGY] : 0);

    if (!hasHarvesters && totalEnergy < 500) {
      creep.say('NO ECO');
      var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn && creep.pos.getRangeTo(spawn) > 5) {
        smartMoveTo(creep, spawn, { reusePath: 20 });
      }
      return;
    }
  }

  // If not in assigned room, travel there (handles reassigned bootstrap creeps)
  if (creep.room.name !== creep.memory.room) {
    smartMoveTo(creep, new RoomPosition(25, 25, creep.memory.room), {
      reusePath: 20,
      visualizePathStyle: { stroke: "#ffffff" },
    });
    creep.say("GO");
    return;
  }

  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "UPGRADING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "UPGRADING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    creep.say("GET");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "UPGRADING";
    creep.say("UPG");
  }

  if (creep.memory.state === "UPGRADING") {
    upgrade(creep);
  } else {
    getEnergy(creep);
  }
}

function upgrade(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) {
    creep.say("ERR");
    return;
  }

  // Upgrading and moving are independent actions within a tick, so always spend the
  // upgrade first and treat link positioning as a background drift. Gating the upgrade
  // on link adjacency stalls the controller outright: a creep already in upgrade range
  // but not adjacent to the link repositions forever and never spends a single tick
  // upgrading, even while carrying a full load.
  const result = creep.upgradeController(controller);

  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, controller, {
      visualizePathStyle: { stroke: "#00ffff" },
      reusePath: 10,
    });
    return;
  }

  // In range and upgrading. Drift toward the controller link so refills become free
  // once the link network is actually supplied - but never at the cost of an upgrade.
  if (controller.level >= 5) {
    const controllerLink = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    })[0] as StructureLink | undefined;

    // Only drift if standing beside the link would still be inside upgrade range. The
    // link is matched anywhere within range 4 of the controller, but upgrading needs
    // range 3 - chasing a range-4 link walks the creep out of upgrade range, which pulls
    // it back next tick, and it oscillates away roughly half its upgrade ticks.
    if (
      controllerLink &&
      creep.pos.getRangeTo(controllerLink) > 1 &&
      controllerLink.pos.getRangeTo(controller) <= 3
    ) {
      smartMoveTo(creep, controllerLink, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 10 });
    }
  }
}

/**
 * Score every energy source and take the best.
 *
 * Replaces a six-branch priority chain. That chain had already produced two separate
 * deadlocks: the controller link was treated as an exclusive source, so an empty link
 * stranded upgraders beside a full container; and each branch returned unconditionally,
 * so anything matching early starved everything after it.
 *
 * Scoring cannot strand a creep, because every source is weighed on the same scale and
 * an empty one simply scores zero rather than short-circuiting the rest. Weights preserve
 * the intent of the old order - the link is cheapest to draw from, a controller container
 * next, storage is worth a walk, dropped energy decays so it is worth collecting - while
 * amount and distance decide between them.
 */
function scoreEnergySources(creep: Creep): { target: RoomObject; kind: "withdraw" | "pickup" | "harvest"; score: number } | null {
  const controller = creep.room.controller;
  if (!controller) return null;

  let best: { target: RoomObject; kind: "withdraw" | "pickup" | "harvest"; score: number } | null = null;
  const need = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 1;

  const consider = (
    target: RoomObject,
    kind: "withdraw" | "pickup" | "harvest",
    base: number,
    available: number
  ): void => {
    if (available <= 0) return;
    // Enough to be worth the trip, capped so a huge store does not beat a closer one
    // purely on size.
    const supply = Math.min(available / need, 1);
    const proximity = 1 / (1 + creep.pos.getRangeTo(target) / DISTANCE_HALF_LIFE);
    const score = base * (0.4 + 0.6 * supply) * proximity;
    if (!best || score > best.score) best = { target, kind, score };
  };

  // Controller link - cheapest energy in the room when supplied.
  const link = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  })[0] as StructureLink | undefined;
  if (link) consider(link, "withdraw", 100, link.store[RESOURCE_ENERGY]);

  // Containers - controller-adjacent ones are staged for exactly this.
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
  }) as StructureContainer[];
  for (const c of containers) {
    const nearController = c.pos.getRangeTo(controller) <= 4;
    consider(c, "withdraw", nearController ? 85 : 40, c.store[RESOURCE_ENERGY]);
  }

  // Storage - always worth the walk when nothing closer has energy.
  const storage = creep.room.storage;
  if (storage) consider(storage, "withdraw", 50, storage.store[RESOURCE_ENERGY]);

  // Dropped energy decays, so collecting it is strictly better than leaving it.
  const dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: (rsc) => rsc.resourceType === RESOURCE_ENERGY && rsc.amount >= 25,
  });
  for (const d of dropped) consider(d, "pickup", 60, d.amount);

  // Direct harvest - last resort, but never zero, so a creep is never left with nothing.
  const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
  if (source) consider(source, "harvest", 15, source.energy);

  return best;
}

function getEnergy(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  const best = scoreEnergySources(creep);

  if (best) {
    let result: ScreepsReturnCode;
    if (best.kind === "withdraw") {
      result = creep.withdraw(best.target as AnyStoreStructure, RESOURCE_ENERGY);
    } else if (best.kind === "pickup") {
      result = creep.pickup(best.target as Resource);
    } else {
      result = creep.harvest(best.target as Source);
    }

    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, best.target, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing in the room holds energy. Hold beside the controller link if there is one, so
  // the next transfer is picked up immediately.
  const link = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  })[0] as StructureLink | undefined;

  const holdTarget: RoomObject = link || controller;
  const holdRange = link ? 1 : 3;

  if (creep.pos.getRangeTo(holdTarget) > holdRange) {
    smartMoveTo(creep, holdTarget, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
  } else {
    moveOffRoad(creep);
    creep.say("ZZZ");
  }
}
