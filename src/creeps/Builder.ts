import { ColonyManager } from "../core/ColonyManager";

/**
 * Builder: Builds construction sites and repairs structures.
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

export function runBuilder(creep: Creep): void {
  const manager = ColonyManager.getInstance(creep.memory.room);

  // Task tracking
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);
    if (!myTask || myTask.assignedCreep !== creep.name) {
      delete creep.memory.taskId;
    }
  }

  // Request BUILD task if idle
  if (!creep.memory.taskId) {
    const task = manager.getAvailableTask(creep);
    if (task && task.type === "BUILD") {
      manager.assignTask(task.id, creep.name);
      // Store target site
      creep.memory.targetSiteId = task.targetId as Id<ConstructionSite>;
    }
  }

  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "BUILDING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "BUILDING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    creep.say("🔄");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "BUILDING";
    creep.say("🔨");
  }

  if (creep.memory.state === "BUILDING") {
    buildOrRepair(creep);
  } else {
    getEnergy(creep);
  }
}

function buildOrRepair(creep: Creep): void {
  // Priority 1: Construction sites
  // Prefer assigned target from task
  let site: ConstructionSite | null = null;

  if (creep.memory.targetSiteId) {
    site = Game.getObjectById(creep.memory.targetSiteId);
    if (!site) {
      // Site complete or removed
      delete creep.memory.targetSiteId;
      if (creep.memory.taskId) {
        const manager = ColonyManager.getInstance(creep.memory.room);
        manager.completeTask(creep.memory.taskId);
      }
    }
  }

  // Fallback to closest site
  if (!site) {
    site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);
  }

  if (site) {
    const result = creep.build(site);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(site, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Repair damaged structures
  const damaged = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) => {
      if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
        return s.hits < 10000;
      }
      return s.hits < s.hitsMax * 0.75;
    },
  });

  if (damaged) {
    const result = creep.repair(damaged);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(damaged, { visualizePathStyle: { stroke: "#ff8800" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Maintain walls/ramparts
  const wall = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
      s.hits < 100000,
  });

  if (wall) {
    const result = creep.repair(wall);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(wall, { visualizePathStyle: { stroke: "#888888" }, reusePath: 5 });
    }
    return;
  }

  // Nothing to do - behave like upgrader
  const controller = creep.room.controller;
  if (controller) {
    const result = creep.upgradeController(controller);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 10 });
    }
  }
}

function getEnergy(creep: Creep): void {
  // Priority 1: Storage
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Any container with energy
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 50,
  }) as StructureContainer | null;

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Dropped energy
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      creep.moveTo(droppedEnergy, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 4: Harvest from source as last resort
  const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // No energy available - wait near spawn but off road
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
    creep.say("💤");
  }
}
