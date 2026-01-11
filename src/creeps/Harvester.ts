import { ColonyStateManager } from "../core/ColonyState";

/**
 * Harvester: Worker that harvests energy and delivers to spawn/extensions.
 * Early game: Does both harvesting AND delivering (bootstrap)
 * Late game: If container at source, becomes static miner (sits on container)
 * Uses ColonyState for source assignments and cached structures.
 */
export function runHarvester(creep: Creep): void {
  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "DELIVERING" : "HARVESTING";
  }

  // Get assigned source
  const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;

  // Check if there's a container at our source - if so, become static miner
  if (source) {
    const state = ColonyStateManager.getState(creep.room.name);
    if (state) {
      const assignment = state.sourceAssignments.find((a) => a.sourceId === source.id);
      if (assignment?.hasContainer && assignment.containerId) {
        const container = Game.getObjectById(assignment.containerId);
        if (container) {
          runStaticMiner(creep, source, container);
          return;
        }
      }
    }
  }

  // Mobile harvester mode (no container)
  // State transitions
  if (creep.memory.state === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "HARVESTING";
    creep.say("⛏️");
  }
  if (creep.memory.state === "HARVESTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
    creep.say("🚚");
  }

  if (creep.memory.state === "DELIVERING") {
    deliver(creep);
  } else {
    harvest(creep);
  }
}

/**
 * Static miner mode: Sit on container and harvest continuously
 * When container full, deliver directly to prevent energy decay
 */
function runStaticMiner(creep: Creep, source: Source, container: StructureContainer): void {
  const containerFull = container.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
  const creepFull = creep.store.getFreeCapacity() === 0;

  // If container is full and we're full, go deliver directly
  if (containerFull && creepFull) {
    creep.say("📦");
    deliver(creep);
    return;
  }

  // If we have energy and not on container, we were delivering - go back
  if (!creep.pos.isEqualTo(container.pos)) {
    if (creep.store[RESOURCE_ENERGY] > 0 && containerFull) {
      deliver(creep);
      return;
    }
    creep.moveTo(container, {
      visualizePathStyle: { stroke: "#ffaa00" },
      reusePath: 10,
    });
    creep.say("📍");
    return;
  }

  // On container - harvest continuously
  const result = creep.harvest(source);
  if (result === OK) {
    // Transfer to container if we have energy and container has space
    if (creep.store[RESOURCE_ENERGY] > 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.transfer(container, RESOURCE_ENERGY);
    }
  }
}

function harvest(creep: Creep): void {
  // Get assigned source
  let source: Source | null = null;

  if (creep.memory.sourceId) {
    source = Game.getObjectById(creep.memory.sourceId);
  }

  // If no source assigned, try to get one from ColonyState
  if (!source) {
    const state = ColonyStateManager.getState(creep.room.name);
    if (state) {
      source = ColonyStateManager.getUnassignedSource(state);
    }

    // Fallback to closest active source
    if (!source) {
      source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
    }

    if (source) {
      creep.memory.sourceId = source.id;
    }
  }

  if (!source) {
    creep.say("❌");
    return;
  }

  const result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(source, {
      visualizePathStyle: { stroke: "#ffaa00" },
      reusePath: 5,
    });
  }
}

function deliver(creep: Creep): void {
  // Use ColonyState for cached structures
  const state = ColonyStateManager.getState(creep.room.name);

  // Priority 1: Spawn and Extensions (critical for spawning)
  if (state?.energy.spawnNeedsEnergy) {
    // Find closest spawn or extension needing energy
    const targets = [
      ...state.structures.spawns.filter((s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0),
      ...state.structures.extensions.filter((e) => e.store.getFreeCapacity(RESOURCE_ENERGY) > 0),
    ];

    if (targets.length > 0) {
      const closest = creep.pos.findClosestByPath(targets);
      if (closest) {
        if (creep.transfer(closest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(closest, { visualizePathStyle: { stroke: "#ffffff" }, reusePath: 5 });
        }
        return;
      }
    }
  }

  // Priority 2: Towers (from cached state)
  if (state?.energy.towersNeedEnergy) {
    const tower = state.structures.towers.find(
      (t) => t.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    );
    if (tower) {
      if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(tower, { visualizePathStyle: { stroke: "#ff0000" }, reusePath: 5 });
      }
      return;
    }
  }

  // Priority 3: Storage
  if (state?.structures.storage && state.structures.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(state.structures.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(state.structures.storage, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing needs energy - go back to source and drop energy for builders/upgraders
  const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
  if (source) {
    // If not near source, go there
    if (creep.pos.getRangeTo(source) > 2) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
      return;
    }
    // Drop energy at source for others to pick up
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.drop(RESOURCE_ENERGY);
      creep.say("📦");
    }
  }
}
