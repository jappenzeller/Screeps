import { TaskManager, TaskType } from "../core/TaskManager";
import { getOrFindEnergySource, acquireEnergy, clearEnergyTarget } from "../utils/EnergyUtils";

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
    clearEnergyTarget(creep);
    creep.say("🔄 energy");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "BUILDING";
    clearEnergyTarget(creep);
    creep.say("🔨 build");
  }

  if (creep.memory.state === "BUILDING") {
    buildOrRepair(creep);
  } else {
    getEnergy(creep);
  }
}

function buildOrRepair(creep: Creep): void {
  // Get current task
  const currentTask = TaskManager.getCreepTask(creep);

  // Every 10 ticks, re-evaluate to pick up higher priority tasks
  // This allows builders to switch to closer roads as priorities update
  const shouldReevaluate = Game.time % 10 === 0;

  if (currentTask && !shouldReevaluate) {
    if (currentTask.type === TaskType.BUILD) {
      const site = Game.getObjectById(currentTask.targetId as Id<ConstructionSite>);
      if (site) {
        executeBuildTask(creep, site);
        return;
      }
    } else {
      const structure = Game.getObjectById(currentTask.targetId as Id<Structure>);
      if (structure) {
        executeRepairTask(creep, structure);
        return;
      }
    }
    // Target gone, complete the task
    TaskManager.completeTask(creep);
  } else if (currentTask) {
    // Re-evaluation tick - release current task to get fresh assignment
    TaskManager.releaseTask(creep);
  }

  // Request new task - TaskManager returns highest priority unassigned task
  // Roads are now prioritized by distance from existing infrastructure
  const task = TaskManager.requestTask(creep, [TaskType.BUILD, TaskType.REPAIR]);

  if (task) {
    if (task.type === TaskType.BUILD) {
      const site = Game.getObjectById(task.targetId as Id<ConstructionSite>);
      if (!site) {
        TaskManager.completeTask(creep);
        return;
      }
      executeBuildTask(creep, site);
    } else {
      const structure = Game.getObjectById(task.targetId as Id<Structure>);
      if (!structure) {
        TaskManager.completeTask(creep);
        return;
      }
      executeRepairTask(creep, structure);
    }
    return;
  }

  // Fallback: Use legacy behavior if no tasks available
  legacyBuildOrRepair(creep);
}

/**
 * Execute a build task
 */
function executeBuildTask(creep: Creep, site: ConstructionSite): void {
  const result = creep.build(site);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(site, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
  } else if (result === ERR_INVALID_TARGET) {
    TaskManager.completeTask(creep);
  }
}

/**
 * Execute a repair task
 */
function executeRepairTask(creep: Creep, structure: Structure): void {
  const result = creep.repair(structure);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(structure, { visualizePathStyle: { stroke: "#ff8800" }, reusePath: 5 });
  } else if (result === ERR_INVALID_TARGET || structure.hits >= structure.hitsMax) {
    TaskManager.completeTask(creep);
  }
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
  // Use sticky energy source selection to prevent oscillation
  const source = getOrFindEnergySource(creep, 50);

  if (source) {
    acquireEnergy(creep, source);
    return;
  }

  // No energy available - wait near spawn
  clearEnergyTarget(creep);

  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
  }
  creep.say("💤");
}
