import { ContainerPlanner } from "../structures/ContainerPlanner";

/**
 * Harvester: Worker that harvests energy and delivers to spawn/extensions.
 * Early game: Does both harvesting AND delivering (bootstrap)
 * Late game: If container at source, becomes static miner (sits on container)
 */
export function runHarvester(creep: Creep): void {
  // Get assigned source
  const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;

  // Check if there's a container at our source - if so, become static miner
  if (source) {
    const container = ContainerPlanner.getSourceContainer(source);
    if (container) {
      runStaticMiner(creep, source, container);
      return;
    }
  }

  // Mobile harvester mode (no container)
  // State machine: working = delivering, not working = harvesting
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
    creep.say("⛏️");
  }
  if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    creep.say("🚚");
  }

  if (creep.memory.working) {
    deliver(creep);
  } else {
    harvest(creep);
  }
}

/**
 * Static miner mode: Sit on container and harvest continuously
 * Energy drops into container automatically when inventory full
 */
function runStaticMiner(creep: Creep, source: Source, container: StructureContainer): void {
  // Move to container if not on it
  if (!creep.pos.isEqualTo(container.pos)) {
    creep.moveTo(container, {
      visualizePathStyle: { stroke: "#ffaa00" },
      reusePath: 10,
    });
    creep.say("📍");
    return;
  }

  // Harvest continuously - energy drops into container when full
  const result = creep.harvest(source);
  if (result === OK) {
    // Transfer to container if we have energy and container has space
    if (creep.store[RESOURCE_ENERGY] > 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.transfer(container, RESOURCE_ENERGY);
    }
  }
}

function harvest(creep: Creep): void {
  // Get assigned source or find one
  let source: Source | null = null;

  if (creep.memory.sourceId) {
    source = Game.getObjectById(creep.memory.sourceId);
  }

  if (!source) {
    source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
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
  // Priority 1: Spawn and Extensions (critical for spawning more creeps)
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

  // Priority 2: Towers
  const tower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
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

  // Priority 3: Controller (upgrade if nothing else needs energy)
  const controller = creep.room.controller;
  if (controller && controller.my) {
    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
      creep.moveTo(controller, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 5,
      });
    }
    return;
  }
}
