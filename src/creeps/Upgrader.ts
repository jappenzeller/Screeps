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
          creep.moveTo(x, y, { visualizePathStyle: { stroke: "#888888" }, reusePath: 3 });
          return;
        }
      }
    }
  }
}

export function runUpgrader(creep: Creep): void {
  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "UPGRADING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "UPGRADING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    creep.say("🔄");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "UPGRADING";
    creep.say("⚡");
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
    creep.say("❌");
    return;
  }

  const result = creep.upgradeController(controller);

  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, {
      visualizePathStyle: { stroke: "#00ffff" },
      reusePath: 10,
    });
  }
}

function getEnergy(creep: Creep): void {
  const controller = creep.room.controller;

  // Priority 1: Container near controller
  if (controller) {
    const container = controller.pos.findInRange(FIND_STRUCTURES, 4, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0,
    })[0] as StructureContainer | undefined;

    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 2: Storage
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Any container with energy
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 50,
  }) as StructureContainer | null;

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 4: Dropped energy
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      creep.moveTo(droppedEnergy, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 5: Harvest from source as last resort
  const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // No energy available - wait near controller but off road
  if (controller && creep.pos.getRangeTo(controller) > 3) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
  } else {
    moveOffRoad(creep);
    creep.say("💤");
  }
}
