/**
 * Hauler: Picks up energy from the ground/containers and delivers to structures.
 * Priority: Spawn/Extensions > Towers > Storage > Controller containers
 */
export function runHauler(creep: Creep): void {
  // State machine: working = delivering, not working = collecting
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.say("🔄 collect");
  }
  // Switch to deliver when at least half full OR completely full
  if (!creep.memory.working) {
    const capacity = creep.store.getCapacity();
    const used = creep.store.getUsedCapacity();
    if (used >= capacity * 0.5 || creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("📦 deliver");
    }
  }

  if (creep.memory.working) {
    deliver(creep);
  } else {
    collect(creep);
  }
}

function collect(creep: Creep): void {
  // Priority 1: Dropped energy (from harvesters) - any amount
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      creep.moveTo(droppedEnergy, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 2: Containers with energy
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
  }) as StructureContainer | null;

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(container, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 3: Tombstones with energy
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t) => t.store[RESOURCE_ENERGY] > 0,
  });

  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(tombstone, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 4: Ruins with energy
  const ruin = creep.pos.findClosestByPath(FIND_RUINS, {
    filter: (r) => r.store[RESOURCE_ENERGY] > 0,
  });

  if (ruin) {
    if (creep.withdraw(ruin, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(ruin, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Nothing to collect - move towards sources to wait for harvesters
  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source) {
    creep.moveTo(source, { visualizePathStyle: { stroke: "#888888" } });
  }
}

function deliver(creep: Creep): void {
  // Priority 1: Spawn and Extensions (critical for spawning)
  const spawnOrExtension = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });

  if (spawnOrExtension) {
    if (creep.transfer(spawnOrExtension, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(spawnOrExtension, {
        visualizePathStyle: { stroke: "#ffffff" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 2: Towers (for defense)
  const tower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 200,
  });

  if (tower) {
    if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(tower, {
        visualizePathStyle: { stroke: "#ff0000" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 3: Storage
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 4: Controller container (for upgraders)
  const controller = creep.room.controller;
  if (controller) {
    const controllerContainer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] as StructureContainer | undefined;

    if (controllerContainer) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controllerContainer, {
          visualizePathStyle: { stroke: "#00ffff" },
          reusePath: 5,
        });
      }
      return;
    }
  }

  // Nothing to deliver to - wait near spawn
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn) {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
  }
}
