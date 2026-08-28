import { smartMoveTo } from "../utils/movement";

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

    if (controllerLink && creep.pos.getRangeTo(controllerLink) > 1) {
      smartMoveTo(creep, controllerLink, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 10 });
    }
  }
}

function getEnergy(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  // RCL 5+: prefer the controller link - it is by far the cheapest source when supplied.
  let controllerLink: StructureLink | undefined;
  if (controller.level >= 5) {
    controllerLink = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    })[0] as StructureLink | undefined;

    if (controllerLink && controllerLink.store[RESOURCE_ENERGY] >= 100) {
      if (creep.withdraw(controllerLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, controllerLink, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 5 });
      }
      return;
    }
  }

  // Link empty or absent: fall through to the other sources rather than idling next
  // to it. Treating the link as exclusive deadlocks the room the moment the link
  // stops being filled - upgraders park beside an empty link indefinitely while a
  // full container sits two tiles away, the controller earns nothing, and the
  // downgrade timer runs down. Waiting is only correct when nothing else has energy.

  // Priority 1: Container near controller
  const container = controller.pos.findInRange(FIND_STRUCTURES, 4, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0,
  })[0] as StructureContainer | undefined;

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Storage (only if no link and no container)
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Dropped energy near controller
  var droppedEnergy = controller.pos.findInRange(FIND_DROPPED_RESOURCES, 5, {
    filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= 50; },
  })[0];

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, droppedEnergy, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // === FALLBACK for integrating colonies with no controller infrastructure ===

  // Priority 4: Any container in room (source containers)
  var anyContainer = creep.room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0;
    },
  })[0] as StructureContainer | undefined;

  if (anyContainer) {
    if (creep.withdraw(anyContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, anyContainer, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 5: Dropped energy anywhere in room
  var anyDropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= 30; },
  });

  if (anyDropped) {
    if (creep.pickup(anyDropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, anyDropped, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 6: Direct harvest from source (last resort for integrating colonies)
  var source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
  if (source) {
    var harvestResult = creep.harvest(source);
    if (harvestResult === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 10 });
    }
    return;
  }

  // Nothing in the room has energy. Now waiting is genuinely correct - hold beside the
  // controller link if there is one, so the next link transfer is picked up instantly.
  const holdTarget = controllerLink || controller;
  const holdRange = controllerLink ? 1 : 3;

  if (creep.pos.getRangeTo(holdTarget) > holdRange) {
    smartMoveTo(creep, holdTarget, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
  } else {
    moveOffRoad(creep);
    creep.say("ZZZ");
  }
}
