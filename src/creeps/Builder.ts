/**
 * Builder: Builds construction sites and repairs structures.
 */
export function runBuilder(creep: Creep): void {
  // State machine
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.say("🔄 harvest");
  }
  if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    creep.say("🔨 build");
  }

  if (creep.memory.working) {
    buildOrRepair(creep);
  } else {
    getEnergy(creep);
  }
}

function buildOrRepair(creep: Creep): void {
  // Priority 1: Construction sites
  const site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);

  if (site) {
    const result = creep.build(site);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(site, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 2: Repair damaged structures (not walls/ramparts unless critical)
  const damaged = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) => {
      // Skip walls and ramparts unless very damaged
      if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
        return s.hits < 10000; // Only repair if critically low
      }
      // Repair if below 75% health
      return s.hits < s.hitsMax * 0.75;
    },
  });

  if (damaged) {
    const result = creep.repair(damaged);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(damaged, {
        visualizePathStyle: { stroke: "#ff8800" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 3: Maintain walls/ramparts to minimum level
  const wall = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
      s.hits < 100000, // Maintain to 100k hits
  });

  if (wall) {
    const result = creep.repair(wall);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(wall, {
        visualizePathStyle: { stroke: "#888888" },
        reusePath: 5,
      });
    }
    return;
  }

  // Nothing to do - behave like upgrader
  const controller = creep.room.controller;
  if (controller) {
    const result = creep.upgradeController(controller);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(controller, {
        visualizePathStyle: { stroke: "#00ffff" },
        reusePath: 10,
      });
    }
  }
}

function getEnergy(creep: Creep): void {
  // Priority 1: Storage
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 1000) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, {
        visualizePathStyle: { stroke: "#ffaa00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 2: Containers
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.store[RESOURCE_ENERGY] > creep.store.getFreeCapacity(),
  });

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(container, {
        visualizePathStyle: { stroke: "#ffaa00" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 3: Dropped energy
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

  // No energy available - wait near spawn for haulers to deliver
  // Do NOT harvest directly - that blocks harvesters at sources
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn) {
    if (creep.pos.getRangeTo(spawn) > 3) {
      creep.moveTo(spawn, {
        visualizePathStyle: { stroke: "#888888" },
        reusePath: 10,
      });
    }
    creep.say("💤");
  }
}
