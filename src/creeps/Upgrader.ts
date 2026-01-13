import { ColonyStateManager } from "../core/ColonyState";
import { getOrFindEnergySource, acquireEnergy, clearEnergyTarget } from "../utils/EnergyUtils";

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
    clearEnergyTarget(creep);
    creep.say("🔄 energy");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "UPGRADING";
    clearEnergyTarget(creep);
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

  // Priority 1: Link near controller (dedicated upgrader energy source)
  if (state && controller) {
    const controllerLinks = state.structures.links.filter(
      (link) => link.pos.inRangeTo(controller.pos, 4) && link.store[RESOURCE_ENERGY] > 0
    );
    if (controllerLinks.length > 0) {
      const link = controllerLinks[0];
      creep.memory.energyTarget = link.id;
      if (creep.withdraw(link, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(link, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 2: Container near controller (dedicated upgrader energy source)
  if (state && controller) {
    const controllerContainers = state.structures.containers.filter(
      (c) => c.pos.inRangeTo(controller.pos, 4) && c.store[RESOURCE_ENERGY] > 0
    );
    if (controllerContainers.length > 0) {
      const container = controllerContainers[0];
      creep.memory.energyTarget = container.id;
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 3: Use sticky energy source selection to prevent oscillation
  const source = getOrFindEnergySource(creep, 50);
  if (source) {
    acquireEnergy(creep, source);
    return;
  }

  // No energy available - wait near controller
  clearEnergyTarget(creep);

  if (controller) {
    if (creep.pos.getRangeTo(controller) > 3) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
    } else {
      creep.say("💤");
    }
  }
}
