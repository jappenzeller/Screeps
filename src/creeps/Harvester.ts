/**
 * Harvester: Worker that harvests energy and delivers to spawn/extensions.
 * Early game: Does both harvesting AND delivering (bootstrap)
 * Late game: If container at source, becomes static miner (sits on container)
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
 * Never delivers - that's the hauler's job. Just harvest and drop.
 */
function runStaticMiner(creep: Creep, source: Source, container: StructureContainer): void {
  // Move to container if not there
  if (!creep.pos.isEqualTo(container.pos)) {
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
    // Transfer to container if it has space
    if (creep.store[RESOURCE_ENERGY] > 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.transfer(container, RESOURCE_ENERGY);
    }
    // If container full and we're full, just drop on ground - haulers will get it
    else if (creep.store.getFreeCapacity() === 0) {
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
    creep.moveTo(source, {
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
      creep.moveTo(spawnOrExtension, { visualizePathStyle: { stroke: "#ffffff" }, reusePath: 5 });
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

  // Nothing needs energy - go back to source and drop energy
  const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
  if (source) {
    if (creep.pos.getRangeTo(source) > 2) {
      creep.moveTo(source, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
      return;
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.drop(RESOURCE_ENERGY);
      creep.say("📦");
    }
  }
}
