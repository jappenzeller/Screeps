import { ColonyStateManager } from "../core/ColonyState";

/**
 * Upgrader: Takes energy and upgrades the room controller.
 * Uses ColonyState for cached structures to reduce CPU.
 */
export function runUpgrader(creep: Creep): void {
  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "UPGRADING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "UPGRADING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    creep.say("🔄 energy");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "UPGRADING";
    creep.say("⚡ upgrade");
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
  // Use ColonyState for cached structures
  const state = ColonyStateManager.getState(creep.room.name);
  const controller = creep.room.controller;

  // Priority 1: Link near controller (from cached state)
  if (state && controller) {
    const controllerLinks = state.structures.links.filter(
      (link) => link.pos.inRangeTo(controller.pos, 4) && link.store[RESOURCE_ENERGY] > 0
    );
    if (controllerLinks.length > 0) {
      const link = controllerLinks[0];
      if (creep.withdraw(link, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(link, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 2: Container near controller (from cached state)
  if (state && controller) {
    const controllerContainers = state.structures.containers.filter(
      (c) => c.pos.inRangeTo(controller.pos, 4) && c.store[RESOURCE_ENERGY] > 0
    );
    if (controllerContainers.length > 0) {
      const container = controllerContainers[0];
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 3: Storage
  if (state?.structures.storage && state.structures.storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(state.structures.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(state.structures.storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 4: Dropped energy (from cached state)
  if (state && state.energy.droppedResources.length > 0) {
    const closest = creep.pos.findClosestByPath(state.energy.droppedResources);
    if (closest) {
      if (creep.pickup(closest) === ERR_NOT_IN_RANGE) {
        creep.moveTo(closest, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 5: Any container with energy
  if (state && state.energy.containersWithEnergy.length > 0) {
    const { id } = state.energy.containersWithEnergy[0];
    const container = Game.getObjectById(id);
    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 6: Early game - go to sources where harvesters drop energy
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

  // Fallback - wait near controller
  if (controller) {
    if (creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
    }
    creep.say("💤");
  }
}
