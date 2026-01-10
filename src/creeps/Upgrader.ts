/**
 * Upgrader: Takes energy and upgrades the room controller.
 */
export function runUpgrader(creep: Creep): void {
  // State machine
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.say("🔄 harvest");
  }
  if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    creep.say("⚡ upgrade");
  }

  if (creep.memory.working) {
    upgrade(creep);
  } else {
    getEnergy(creep);
  }
}

function upgrade(creep: Creep): void {
  const controller = creep.room.controller;
  if (!controller) {
    creep.say("❌ ctrl");
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
  // Priority 1: Link near controller
  const controller = creep.room.controller;
  if (controller) {
    const link = controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
      filter: (s) =>
        s.structureType === STRUCTURE_LINK && s.store[RESOURCE_ENERGY] > 0,
    })[0] as StructureLink | undefined;

    if (link) {
      if (creep.withdraw(link, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(link, {
          visualizePathStyle: { stroke: "#ffaa00" },
          reusePath: 5,
        });
      }
      return;
    }
  }

  // Priority 2: Container near controller
  if (controller) {
    const container = controller.pos.findInRange(FIND_STRUCTURES, 4, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.store[RESOURCE_ENERGY] > creep.store.getFreeCapacity(),
    })[0] as StructureContainer | undefined;

    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, {
          visualizePathStyle: { stroke: "#ffaa00" },
          reusePath: 5,
        });
      }
      return;
    }
  }

  // Priority 3: Storage
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, {
        visualizePathStyle: { stroke: "#ffaa00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 4: Dropped energy
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 50,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      creep.moveTo(droppedEnergy, {
        visualizePathStyle: { stroke: "#ffaa00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 5: Any container with enough energy
  const anyContainer = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0,
  });

  if (anyContainer) {
    if (creep.withdraw(anyContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(anyContainer, {
        visualizePathStyle: { stroke: "#ffaa00" },
        reusePath: 5,
      });
    }
    return;
  }

  // No energy available - wait near controller for haulers to deliver
  // Do NOT harvest directly - that blocks harvesters at sources
  const controller = creep.room.controller;
  if (controller) {
    if (creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, {
        visualizePathStyle: { stroke: "#888888" },
        reusePath: 10,
      });
    }
    creep.say("💤");
  }
}
