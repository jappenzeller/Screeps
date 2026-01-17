import { ColonyManager } from "../core/ColonyManager";

/**
 * Hauler: Picks up energy from containers/ground and delivers to structures.
 * Simple implementation - no task manager dependency.
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

export function runHauler(creep: Creep): void {
  const manager = ColonyManager.getInstance(creep.memory.room);

  // Task tracking
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);
    if (!myTask || myTask.assignedCreep !== creep.name) {
      delete creep.memory.taskId;
    }
  }

  // Request task based on current state
  if (!creep.memory.taskId) {
    const task = manager.getAvailableTask(creep);
    if (task) {
      // Accept SUPPLY_SPAWN, SUPPLY_TOWER, or HAUL tasks
      if (["SUPPLY_SPAWN", "SUPPLY_TOWER", "HAUL"].includes(task.type)) {
        manager.assignTask(task.id, creep.name);
      }
    }
  }

  // Initialize state if needed
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "DELIVERING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    // Task complete when we finish delivering
    if (creep.memory.taskId) {
      manager.completeTask(creep.memory.taskId);
    }
    creep.memory.state = "COLLECTING";
    creep.say("🔄");
  }

  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
    creep.say("📦");
  }

  // Also switch to deliver earlier if spawn critically needs energy
  if (creep.memory.state === "COLLECTING" && creep.store[RESOURCE_ENERGY] >= 50) {
    const spawnCritical = creep.room.energyAvailable < creep.room.energyCapacityAvailable * 0.3;
    if (spawnCritical) {
      creep.memory.state = "DELIVERING";
      creep.say("⚡");
    }
  }

  // Execute current state
  if (creep.memory.state === "DELIVERING") {
    deliver(creep);
  } else {
    collect(creep);
  }
}

function collect(creep: Creep): void {
  // Priority 1: Dropped energy (high priority)
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      creep.moveTo(droppedEnergy, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Tombstones with energy
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t) => t.store[RESOURCE_ENERGY] >= 50,
  });

  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(tombstone, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Containers near sources (not near controller)
  const sourceContainers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) => {
      if (s.structureType !== STRUCTURE_CONTAINER) return false;
      const container = s as StructureContainer;
      if (container.store[RESOURCE_ENERGY] < 100) return false;

      // Check if near a source (not controller)
      const nearSource = container.pos.findInRange(FIND_SOURCES, 2).length > 0;
      return nearSource;
    },
  }) as StructureContainer[];

  if (sourceContainers.length > 0) {
    // Pick the closest one with most energy
    sourceContainers.sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY]);
    const target = creep.pos.findClosestByPath(sourceContainers);

    if (target) {
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 4: Storage (if has excess)
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 10000) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing to collect - wait near source but off road
  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source && creep.pos.getRangeTo(source) > 3) {
    creep.moveTo(source, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
  }
}

function deliver(creep: Creep): void {
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

  // Priority 4: Controller container (for upgraders)
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

  // Nothing to deliver to - wait near spawn but off road
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
  }
}
