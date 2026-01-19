import { ColonyManager } from "../core/ColonyManager";
import { smartMoveTo } from "../utils/movement";

/**
 * Harvester: Worker that harvests energy and delivers to spawn/extensions.
 * Early game: Does both harvesting AND delivering (bootstrap)
 * Late game: If container at source, becomes static miner (sits on container)
 */
export function runHarvester(creep: Creep): void {
  const manager = ColonyManager.getInstance(creep.memory.room);

  // Task tracking
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);
    if (!myTask || myTask.assignedCreep !== creep.name) {
      delete creep.memory.taskId;
    }
  }

  // Request HARVEST task if we don't have one
  if (!creep.memory.taskId) {
    const task = manager.getAvailableTask(creep);
    if (task && task.type === "HARVEST") {
      manager.assignTask(task.id, creep.name);
      // Store source from task
      creep.memory.sourceId = task.targetId as Id<Source>;
    }
  }

  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "DELIVERING" : "HARVESTING";
  }

  // Get assigned source
  const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;

  // Check if there's a container at our source - if so, become static miner
  if (source) {
    const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    })[0] as StructureContainer | undefined;

    if (container) {
      runStaticMiner(creep, source, container);
      return;
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
 * Never delivers - that's the hauler's job. Just harvest and transfer to link/container.
 */
function runStaticMiner(creep: Creep, source: Source, container: StructureContainer): void {
  // Check for source link (RCL 5+)
  const sourceLink = source.pos.findInRange(FIND_MY_STRUCTURES, 2, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  })[0] as StructureLink | undefined;

  // Determine deposit target: link > container
  const depositTarget =
    sourceLink && sourceLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? sourceLink : container;

  // Move to container if not there (optimal position for both harvesting and link transfer)
  if (!creep.pos.isEqualTo(container.pos)) {
    smartMoveTo(creep, container, {
      visualizePathStyle: { stroke: "#ffaa00" },
      reusePath: 10,
    });
    creep.say("📍");
    return;
  }

  // On container - harvest continuously
  const result = creep.harvest(source);

  if (result === OK && creep.store[RESOURCE_ENERGY] > 0) {
    // Deposit to link or container
    if (depositTarget.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.transfer(depositTarget, RESOURCE_ENERGY);
    } else if (creep.store.getFreeCapacity() === 0) {
      // Both full - drop for hauler
      creep.drop(RESOURCE_ENERGY);
      creep.say("💧");
    }
  }
}

function harvest(creep: Creep): void {
  // Get assigned source
  let source: Source | null = null;

  if (creep.memory.sourceId) {
    source = Game.getObjectById(creep.memory.sourceId);
  }

  // If no source assigned, find the closest one
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
    smartMoveTo(creep, source, {
      visualizePathStyle: { stroke: "#ffaa00" },
      reusePath: 5,
    });
  }
}

function deliver(creep: Creep): void {
  // Priority 1: Spawn and Extensions (critical for spawning)
  const spawnOrExtension = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });

  if (spawnOrExtension) {
    if (creep.transfer(spawnOrExtension, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, spawnOrExtension, { visualizePathStyle: { stroke: "#ffffff" }, reusePath: 5 });
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
      smartMoveTo(creep, tower, { visualizePathStyle: { stroke: "#ff0000" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Storage
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing needs energy - go back to source and drop energy
  const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
  if (source) {
    if (creep.pos.getRangeTo(source) > 2) {
      smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
      return;
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.drop(RESOURCE_ENERGY);
      creep.say("📦");
    }
  }
}
