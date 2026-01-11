import { TaskManager, TaskType, Task } from "../core/TaskManager";
import { logger } from "../utils/Logger";

/**
 * Hauler: Picks up energy from the ground/containers and delivers to structures.
 * Uses TaskManager for coordination to prevent multiple haulers targeting same resource.
 * Falls back to legacy behavior during emergency bootstrap.
 */
export function runHauler(creep: Creep): void {
  // Initialize state if needed
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "DELIVERING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    TaskManager.completeTask(creep);
    creep.say("🔄 collect");
  }

  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
    TaskManager.completeTask(creep);
    creep.say("📦 deliver");
  }

  // Also switch to deliver earlier if spawn critically needs energy
  if (creep.memory.state === "COLLECTING" && creep.store[RESOURCE_ENERGY] >= 50) {
    const spawnCritical = creep.room.energyAvailable < creep.room.energyCapacityAvailable * 0.5;
    if (spawnCritical) {
      creep.memory.state = "DELIVERING";
      TaskManager.completeTask(creep);
      creep.say("📦 urgent");
    }
  }

  // Execute current state
  if (creep.memory.state === "DELIVERING") {
    executeDelivery(creep);
  } else {
    executeCollection(creep);
  }
}

/**
 * Execute collection task
 */
function executeCollection(creep: Creep): void {
  // Try to get a task from TaskManager
  let task = TaskManager.getCreepTask(creep);

  if (!task || task.type !== TaskType.HAUL_COLLECT) {
    // Request a new collection task
    TaskManager.releaseTask(creep);
    task = TaskManager.requestTask(creep, [TaskType.HAUL_COLLECT]);
  }

  if (task) {
    const target = Game.getObjectById(task.targetId);
    if (!target) {
      TaskManager.completeTask(creep);
      return;
    }

    // Handle different target types
    if (target instanceof Resource) {
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
      }
    } else if ("store" in target) {
      const storeTarget = target as StructureContainer | StructureStorage | Tombstone | Ruin;
      if (creep.withdraw(storeTarget, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(storeTarget, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
      }
    }
    return;
  }

  // Fallback: Legacy collection behavior (for emergency/bootstrap)
  legacyCollect(creep);
}

/**
 * Execute delivery task
 */
function executeDelivery(creep: Creep): void {
  // Try to get a task from TaskManager
  let task = TaskManager.getCreepTask(creep);

  if (!task || task.type !== TaskType.HAUL_DELIVER) {
    // Request a new delivery task
    TaskManager.releaseTask(creep);
    task = TaskManager.requestTask(creep, [TaskType.HAUL_DELIVER]);
  }

  if (task) {
    const target = Game.getObjectById(task.targetId);
    if (!target) {
      TaskManager.completeTask(creep);
      return;
    }

    if ("store" in target) {
      const storeTarget = target as StructureSpawn | StructureExtension | StructureTower | StructureStorage | StructureContainer;
      const result = creep.transfer(storeTarget, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(storeTarget, { visualizePathStyle: { stroke: "#ffffff" }, reusePath: 5 });
      } else if (result === OK || result === ERR_FULL) {
        TaskManager.completeTask(creep);
      }
    }
    return;
  }

  // Fallback: Legacy delivery behavior
  legacyDeliver(creep);
}

/**
 * Legacy collection - used during bootstrap/emergency when TaskManager has no tasks
 */
function legacyCollect(creep: Creep): void {
  // Priority 1: Dropped energy
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      creep.moveTo(droppedEnergy, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
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
      creep.moveTo(container, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Tombstones
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t) => t.store[RESOURCE_ENERGY] > 0,
  });

  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(tombstone, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 4: Ruins
  const ruin = creep.pos.findClosestByPath(FIND_RUINS, {
    filter: (r) => r.store[RESOURCE_ENERGY] > 0,
  });

  if (ruin) {
    if (creep.withdraw(ruin, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(ruin, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing to collect - move towards sources
  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source) {
    creep.moveTo(source, { visualizePathStyle: { stroke: "#888888" } });
  }
}

/**
 * Legacy delivery - used during bootstrap/emergency
 */
function legacyDeliver(creep: Creep): void {
  // Priority 1: Spawn and Extensions
  const spawnOrExtension = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });

  if (spawnOrExtension) {
    if (creep.transfer(spawnOrExtension, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(spawnOrExtension, { visualizePathStyle: { stroke: "#ffffff" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Towers
  const tower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 200,
  });

  if (tower) {
    if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(tower, { visualizePathStyle: { stroke: "#ff0000" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Storage
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 4: Controller container
  const controller = creep.room.controller;
  if (controller) {
    const controllerContainer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] as StructureContainer | undefined;

    if (controllerContainer) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controllerContainer, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 5 });
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
