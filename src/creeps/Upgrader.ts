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

  // If controller link exists (RCL 5+), position to be in range of both
  if (controller.level >= 5) {
    const controllerLink = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    })[0] as StructureLink | undefined;

    if (controllerLink) {
      // Ideal position: range 3 to controller, range 1 to link
      const inUpgradeRange = creep.pos.getRangeTo(controller) <= 3;
      const inLinkRange = creep.pos.getRangeTo(controllerLink) <= 1;

      if (!inUpgradeRange || !inLinkRange) {
        // Move toward link (will be close enough to controller)
        smartMoveTo(creep, controllerLink, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 10 });
        return;
      }
    }
  }

  // Standard upgrade logic
  const result = creep.upgradeController(controller);

  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, controller, {
      visualizePathStyle: { stroke: "#00ffff" },
      reusePath: 10,
    });
  }
}

function getEnergy(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) return;

  // RCL 5+: Use controller link exclusively
  if (controller.level >= 5) {
    const controllerLink = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    })[0] as StructureLink | undefined;

    if (controllerLink) {
      // Try to withdraw if link has energy
      if (controllerLink.store[RESOURCE_ENERGY] >= 100) {
        if (creep.withdraw(controllerLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          smartMoveTo(creep, controllerLink, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 5 });
        }
        return;
      }

      // Link exists but empty - wait near it
      if (creep.pos.getRangeTo(controllerLink) > 1) {
        smartMoveTo(creep, controllerLink, { visualizePathStyle: { stroke: "#888888" }, reusePath: 5 });
      } else {
        // Already near link - just wait, move off road if needed
        moveOffRoad(creep);
        creep.say("⏳");
      }
      return;
    }
  }

  // No controller link - fall back to other energy sources

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
  const droppedEnergy = controller.pos.findInRange(FIND_DROPPED_RESOURCES, 5, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  })[0];

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, droppedEnergy, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // No energy available - wait near controller
  if (creep.pos.getRangeTo(controller) > 3) {
    smartMoveTo(creep, controller, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
  } else {
    moveOffRoad(creep);
    creep.say("💤");
  }
}
