import { ColonyManager } from "../core/ColonyManager";
import { smartMoveTo } from "../utils/movement";
import { shouldEmergencyRenew } from "../managers/RenewalManager";

/**
 * Hauler: Picks up energy from containers/ground and delivers to structures.
 *
 * Container Coordination:
 * - Each hauler has a primary container assignment to prevent oscillation
 * - Haulers wait at their container if a miner is present (energy coming)
 * - Container switching has a cooldown to prevent rapid oscillation
 *
 * Renewal:
 * - Opportunistic only - renew when naturally adjacent to spawn
 * - Never diverts from tasks to seek spawn
 */

/**
 * Opportunistic renewal - only renew when naturally adjacent to spawn
 * Never seeks spawn, just takes advantage of passing by during deliveries
 */
function tryRenew(creep: Creep): void {
  // Only bother if TTL is getting low
  if (!creep.ticksToLive || creep.ticksToLive > 1200) return;

  // Must already be adjacent to spawn - don't seek it out
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return;
  if (creep.pos.getRangeTo(spawn) !== 1) return;

  // Don't interrupt spawning
  if (spawn.spawning) return;

  spawn.renewCreep(creep);
}

/**
 * Select the best container to collect from based on energy, distance, and competition.
 * Called when transitioning to COLLECTING state.
 */
function selectContainer(creep: Creep): StructureContainer | null {
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.pos.findInRange(FIND_SOURCES, 1).length > 0,
  }) as StructureContainer[];

  if (containers.length === 0) return null;

  // Score each container
  const scored = containers.map((container) => {
    const energy = container.store[RESOURCE_ENERGY];
    const distance = creep.pos.getRangeTo(container);

    // Count other haulers targeting this container
    const competitors = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "HAULER" &&
        c.name !== creep.name &&
        c.memory.state === "COLLECTING" &&
        c.memory.targetContainer === container.id
    ).length;

    // Higher energy = better, more competitors = worse, closer = better
    const score = energy / (competitors + 1) / (distance + 1);

    return { container, score };
  });

  // Pick highest score
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.container || null;
}

function moveOffRoad(creep: Creep): void {
  const onRoad = creep.pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_ROAD);
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
        const hasRoad = creep.room
          .lookForAt(LOOK_STRUCTURES, x, y)
          .some((s) => s.structureType === STRUCTURE_ROAD);
        const hasCreep = creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0;
        if (!hasRoad && !hasCreep) {
          smartMoveTo(creep, new RoomPosition(x, y, creep.room.name), {
            visualizePathStyle: { stroke: "#888888" },
            reusePath: 3,
          });
          return;
        }
      }
    }
  }
}


/**
 * Collect from target container (selected at state transition)
 * Returns true if handled, false if should fallback
 */
function collectFromContainers(creep: Creep): boolean {
  const targetId = creep.memory.targetContainer as Id<StructureContainer> | undefined;
  if (!targetId) return false;

  const container = Game.getObjectById(targetId);
  if (!container) {
    delete creep.memory.targetContainer;
    return false;
  }

  const hasEnergy = container.store[RESOURCE_ENERGY] > 0;
  const isNearby = creep.pos.isNearTo(container);

  // Check for nearby miner (energy coming soon)
  const minerNearby = container.pos.findInRange(FIND_MY_CREEPS, 1, {
    filter: (c) => c.memory.role === "HARVESTER",
  }).length > 0;

  // If at container with miner but no energy, wait
  if (isNearby && minerNearby && !hasEnergy) {
    creep.say("WAIT");
    return true;
  }

  // If has energy, collect
  if (hasEnergy) {
    if (isNearby) {
      creep.withdraw(container, RESOURCE_ENERGY);
    } else {
      smartMoveTo(creep, container, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return true;
  }

  // No energy but miner present - go there and wait
  if (minerNearby) {
    if (!isNearby) {
      smartMoveTo(creep, container, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return true;
  }

  // No energy and no miner - clear target and fallback
  delete creep.memory.targetContainer;
  return false;
}

export function runHauler(creep: Creep): void {
  // Opportunistic renewal - fire and forget, doesn't block normal behavior
  tryRenew(creep);

  // Emergency renewal check - only for critical, dying haulers that are the last one
  if (shouldEmergencyRenew(creep)) {
    const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (spawn && !creep.pos.isNearTo(spawn)) {
      creep.say("RENEW");
      smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 3 });
      return;
    }
    // If near spawn, continue normal work - RenewalManager will handle it
  }

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
    // Select container if starting in COLLECTING
    if (creep.memory.state === "COLLECTING") {
      const target = selectContainer(creep);
      creep.memory.targetContainer = target?.id || null;
    }
  }

  // State transitions
  if (creep.memory.state === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    // Task complete when we finish delivering
    if (creep.memory.taskId) {
      manager.completeTask(creep.memory.taskId);
    }
    creep.memory.state = "COLLECTING";
    // Select best container for this collection trip
    const target = selectContainer(creep);
    creep.memory.targetContainer = target?.id || null;
    creep.say("GET");
  }

  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
    delete creep.memory.targetContainer;
    creep.say("DLV");
  }

  // Also switch to deliver earlier if spawn critically needs energy
  if (creep.memory.state === "COLLECTING" && creep.store[RESOURCE_ENERGY] >= 50) {
    const spawnCritical = creep.room.energyAvailable < creep.room.energyCapacityAvailable * 0.3;
    if (spawnCritical) {
      creep.memory.state = "DELIVERING";
      delete creep.memory.targetContainer;
      creep.say("URG");
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
  // Priority 1: Dropped energy (high priority - prevents waste)
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, droppedEnergy, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Tombstones with energy
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t) => t.store[RESOURCE_ENERGY] >= 50,
  });

  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, tombstone, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Smart container collection with affinity
  if (collectFromContainers(creep)) {
    return;
  }

  // Priority 4: Storage (if has excess)
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 10000) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing to collect - wait near target container or source
  const targetContainer = creep.memory.targetContainer
    ? Game.getObjectById(creep.memory.targetContainer as Id<StructureContainer>)
    : null;

  if (targetContainer) {
    if (creep.pos.getRangeTo(targetContainer) > 1) {
      smartMoveTo(creep, targetContainer, { visualizePathStyle: { stroke: "#888888" } });
    } else {
      moveOffRoad(creep);
    }
    return;
  }

  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source && creep.pos.getRangeTo(source) > 3) {
    smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
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
      smartMoveTo(creep, spawnOrExtension, {
        visualizePathStyle: { stroke: "#ffffff" },
        reusePath: 5,
      });
    }
    return;
  }

  // Priority 2: Towers below 50% (defensive readiness - CRITICAL)
  const criticalTower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_TOWER &&
      s.store[RESOURCE_ENERGY] < 500, // 50% of 1000 capacity
  }) as StructureTower | null;

  if (criticalTower) {
    if (creep.transfer(criticalTower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, criticalTower, { visualizePathStyle: { stroke: "#ff0000" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Storage
  // NOTE: Haulers never deliver to links - LINK_FILLER handles link logistics
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 5: Top off towers to 80% (when nothing else needs energy)
  const towerTopOff = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_TOWER &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 200, // Below 80%
  }) as StructureTower | null;

  if (towerTopOff) {
    if (creep.transfer(towerTopOff, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, towerTopOff, { visualizePathStyle: { stroke: "#ff6600" }, reusePath: 5 });
    }
    return;
  }

  // Priority 6: Controller container (for upgraders)
  const controller = creep.room.controller;
  if (controller) {
    const controllerContainer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] as StructureContainer | undefined;

    if (controllerContainer) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, controllerContainer, {
          visualizePathStyle: { stroke: "#00ffff" },
          reusePath: 5,
        });
      }
      return;
    }
  }

  // Nothing to deliver to - wait near spawn but off road
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
  }
}
