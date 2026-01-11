import { TaskManager, TaskType } from "../core/TaskManager";
import { ColonyStateManager } from "../core/ColonyState";

/**
 * Builder: Builds construction sites and repairs structures.
 * Uses TaskManager for task assignment and ColonyState for cached structures.
 */
export function runBuilder(creep: Creep): void {
  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "BUILDING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "BUILDING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    TaskManager.completeTask(creep);
    creep.say("🔄 energy");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "BUILDING";
    creep.say("🔨 build");
  }

  if (creep.memory.state === "BUILDING") {
    buildOrRepair(creep);
  } else {
    getEnergy(creep);
  }
}

function buildOrRepair(creep: Creep): void {
  // Always get a fresh task - this ensures builders pick the highest priority target
  TaskManager.releaseTask(creep);

  // Check what other builders in this room are already doing
  const otherBuilders = Object.values(Game.creeps).filter(
    (c) => c.memory.role === "BUILDER" && c.memory.room === creep.memory.room && c.name !== creep.name
  );

  // Check if another builder is already on containers
  const anotherOnContainers = otherBuilders.some((b) => {
    const taskId = b.memory.taskId;
    if (!taskId) return false;
    const tasks = TaskManager.getTasks(creep.memory.room);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const site = Game.getObjectById(task.targetId) as ConstructionSite | null;
    return site?.structureType === STRUCTURE_CONTAINER;
  });

  // Check if another builder is already on roads
  const anotherOnRoads = otherBuilders.some((b) => {
    const taskId = b.memory.taskId;
    if (!taskId) return false;
    const tasks = TaskManager.getTasks(creep.memory.room);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const site = Game.getObjectById(task.targetId) as ConstructionSite | null;
    return site?.structureType === STRUCTURE_ROAD;
  });

  let task: ReturnType<typeof TaskManager.requestTask> = null;

  // If no one is on containers yet, this builder takes containers
  if (!anotherOnContainers) {
    task = TaskManager.requestTask(creep, [TaskType.BUILD], (t) => {
      const site = Game.getObjectById(t.targetId) as ConstructionSite | null;
      return site?.structureType === STRUCTURE_CONTAINER;
    });
  }

  // If no container task or someone else is on containers, try roads
  if (!task && !anotherOnRoads) {
    task = TaskManager.requestTask(creep, [TaskType.BUILD], (t) => {
      const site = Game.getObjectById(t.targetId) as ConstructionSite | null;
      return site?.structureType === STRUCTURE_ROAD;
    });
  }

  // Fall back to any non-road structure
  if (!task) {
    task = TaskManager.requestTask(creep, [TaskType.BUILD], (t) => {
      const site = Game.getObjectById(t.targetId) as ConstructionSite | null;
      return site?.structureType !== STRUCTURE_ROAD;
    });
  }

  // Finally, take any available task
  if (!task) {
    task = TaskManager.requestTask(creep, [TaskType.BUILD, TaskType.REPAIR]);
  }

  if (task) {
    const target = Game.getObjectById(task.targetId);
    if (!target) {
      TaskManager.completeTask(creep);
      return;
    }

    if (task.type === TaskType.BUILD) {
      const site = target as ConstructionSite;
      const result = creep.build(site);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(site, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
      } else if (result === ERR_INVALID_TARGET) {
        TaskManager.completeTask(creep);
      }
    } else {
      const structure = target as Structure;
      const result = creep.repair(structure);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(structure, { visualizePathStyle: { stroke: "#ff8800" }, reusePath: 5 });
      } else if (result === ERR_INVALID_TARGET || structure.hits >= structure.hitsMax) {
        TaskManager.completeTask(creep);
      }
    }
    return;
  }

  // Fallback: Use legacy behavior if no tasks available
  legacyBuildOrRepair(creep);
}

/**
 * Legacy build/repair - used when TaskManager has no tasks
 */
function legacyBuildOrRepair(creep: Creep): void {
  // Priority 1: Construction sites (non-roads first, then roads from spawn outward)
  const sites = creep.room.find(FIND_CONSTRUCTION_SITES);

  if (sites.length > 0) {
    const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);

    // Sort: non-roads first, then roads by distance from spawn (closer first)
    sites.sort((a, b) => {
      const aIsRoad = a.structureType === STRUCTURE_ROAD;
      const bIsRoad = b.structureType === STRUCTURE_ROAD;

      // Non-roads before roads
      if (!aIsRoad && bIsRoad) return -1;
      if (aIsRoad && !bIsRoad) return 1;

      // For roads, sort by distance from spawn (closer = higher priority)
      if (aIsRoad && bIsRoad && spawn) {
        return a.pos.getRangeTo(spawn) - b.pos.getRangeTo(spawn);
      }

      return 0;
    });

    // Find closest reachable site from the prioritized list
    for (const site of sites) {
      const path = creep.pos.findPathTo(site, { ignoreCreeps: true });
      if (path.length > 0) {
        const result = creep.build(site);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(site, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
        }
        return;
      }
    }
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
  // Use ColonyState for cached energy sources
  const state = ColonyStateManager.getState(creep.room.name);

  // Priority 1: Storage (if sufficient energy)
  if (state?.structures.storage && state.structures.storage.store[RESOURCE_ENERGY] > 1000) {
    if (creep.withdraw(state.structures.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(state.structures.storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Containers with energy (from cached state)
  if (state && state.energy.containersWithEnergy.length > 0) {
    // Find closest container with any energy
    let closestContainer: StructureContainer | null = null;
    let closestDist = Infinity;

    for (const { id } of state.energy.containersWithEnergy) {
      const container = Game.getObjectById(id);
      if (!container) continue;
      const dist = creep.pos.getRangeTo(container);
      if (dist < closestDist) {
        closestDist = dist;
        closestContainer = container;
      }
    }

    if (closestContainer) {
      if (creep.withdraw(closestContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(closestContainer, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 3: Dropped energy (from cached state)
  if (state && state.energy.droppedResources.length > 0) {
    const closest = creep.pos.findClosestByPath(state.energy.droppedResources);
    if (closest) {
      if (creep.pickup(closest) === ERR_NOT_IN_RANGE) {
        creep.moveTo(closest, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 4: Early game - go to sources where harvesters drop energy
  // This is better than withdrawing from spawn (which starves economy)
  const sources = state?.sources ?? creep.room.find(FIND_SOURCES);
  if (sources.length > 0) {
    const closestSource = creep.pos.findClosestByPath(sources);
    if (closestSource) {
      // Check for dropped energy near the source first
      const droppedNearSource = creep.room.find(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.pos.inRangeTo(closestSource, 3),
      });
      if (droppedNearSource.length > 0) {
        const closest = creep.pos.findClosestByPath(droppedNearSource);
        if (closest) {
          if (creep.pickup(closest) === ERR_NOT_IN_RANGE) {
            creep.moveTo(closest, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
          }
          return;
        }
      }
      // No dropped energy yet - move toward source and wait
      if (creep.pos.getRangeTo(closestSource) > 3) {
        creep.moveTo(closestSource, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
      }
      creep.say("⏳");
      return;
    }
  }

  // Fallback - wait in place
  creep.say("💤");
}
