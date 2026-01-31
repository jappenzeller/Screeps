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
 */

// Anti-oscillation cooldown (ticks)
const CONTAINER_SWITCH_COOLDOWN = 50;

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
 * Assign a primary container to this hauler
 * Picks the least-covered source container
 */
function assignPrimaryContainer(creep: Creep): Id<StructureContainer> | null {
  const room = creep.room;

  // Find source containers
  const sourceContainers = room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.pos.findInRange(FIND_SOURCES, 2).length > 0,
  }) as StructureContainer[];

  if (sourceContainers.length === 0) return null;

  // Count haulers assigned to each container
  const assignments: Record<string, number> = {};
  for (const container of sourceContainers) {
    assignments[container.id] = 0;
  }

  for (const hauler of Object.values(Game.creeps)) {
    if (hauler.memory.role !== "HAULER") continue;
    if (hauler.memory.room !== room.name) continue;
    if (hauler.name === creep.name) continue;

    const primary = hauler.memory.primaryContainer as string | undefined;
    if (primary && assignments[primary] !== undefined) {
      assignments[primary]++;
    }
  }

  // Assign to least-covered container
  let bestContainer: StructureContainer | null = null;
  let minAssignments = Infinity;

  for (const container of sourceContainers) {
    const count = assignments[container.id] || 0;
    if (count < minAssignments) {
      minAssignments = count;
      bestContainer = container;
    }
  }

  return bestContainer?.id || null;
}

/**
 * Find a container that has energy or an active miner
 * Excludes specified container ID
 * Respects existing hauler assignments to prevent convergence
 */
function findActiveContainer(
  creep: Creep,
  excludeId: Id<StructureContainer> | null
): StructureContainer | null {
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.id !== excludeId &&
      s.pos.findInRange(FIND_SOURCES, 2).length > 0,
  }) as StructureContainer[];

  // Count existing assignments (excluding self)
  const assignmentCounts = new Map<string, number>();
  for (const container of containers) {
    assignmentCounts.set(container.id, 0);
  }

  for (const hauler of Object.values(Game.creeps)) {
    if (hauler.memory.role !== "HAULER") continue;
    if (hauler.memory.room !== creep.room.name) continue;
    if (hauler.name === creep.name) continue;

    const assigned = hauler.memory.primaryContainer as string | undefined;
    if (assigned && assignmentCounts.has(assigned)) {
      assignmentCounts.set(assigned, (assignmentCounts.get(assigned) || 0) + 1);
    }
  }

  // Prioritize: unassigned > has energy > has miner > closest
  return (
    containers
      .map((c) => ({
        container: c,
        energy: c.store[RESOURCE_ENERGY],
        hasMiner:
          c.pos.findInRange(FIND_MY_CREEPS, 1, {
            filter: (cr) => cr.memory.role === "HARVESTER",
          }).length > 0,
        distance: creep.pos.getRangeTo(c),
        assignedHaulers: assignmentCounts.get(c.id) || 0,
      }))
      .sort((a, b) => {
        // Prefer containers without assigned haulers first
        if (a.assignedHaulers === 0 && b.assignedHaulers > 0) return -1;
        if (b.assignedHaulers === 0 && a.assignedHaulers > 0) return 1;

        // Has significant energy wins
        if (a.energy > 100 && b.energy <= 100) return -1;
        if (b.energy > 100 && a.energy <= 100) return 1;

        // Has miner is next priority
        if (a.hasMiner && !b.hasMiner) return -1;
        if (b.hasMiner && !a.hasMiner) return 1;

        // Otherwise closest
        return a.distance - b.distance;
      })[0]?.container || null
  );
}

/**
 * Smart collection from containers with affinity and patience
 * Returns true if handled (collecting or waiting), false if should fallback
 */
function collectFromContainers(creep: Creep): boolean {
  // Ensure we have a primary container assigned
  if (!creep.memory.primaryContainer) {
    const assigned = assignPrimaryContainer(creep);
    if (assigned) {
      creep.memory.primaryContainer = assigned;
    }
  }

  // Periodic rebalancing check - if another container is full and unassigned, switch to it
  if (creep.memory.primaryContainer && Game.time % 20 === 0) {
    const containers = creep.room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.pos.findInRange(FIND_SOURCES, 2).length > 0,
    }) as StructureContainer[];

    // Count assignments
    const assignmentCounts = new Map<string, number>();
    for (const c of containers) {
      assignmentCounts.set(c.id, 0);
    }
    for (const hauler of Object.values(Game.creeps)) {
      if (hauler.memory.role !== "HAULER") continue;
      if (hauler.memory.room !== creep.room.name) continue;
      const assigned = hauler.memory.primaryContainer as string | undefined;
      if (assigned && assignmentCounts.has(assigned)) {
        assignmentCounts.set(assigned, (assignmentCounts.get(assigned) || 0) + 1);
      }
    }

    // Find if any container is full and has no hauler assigned
    for (const container of containers) {
      if (container.id === creep.memory.primaryContainer) continue;
      const count = assignmentCounts.get(container.id) || 0;
      if (count === 0 && container.store[RESOURCE_ENERGY] > 1500) {
        // Unassigned container with lots of energy - switch to it
        creep.memory.primaryContainer = container.id;
        creep.memory._lastContainerSwitch = Game.time;
        creep.say("BAL");
        break;
      }
    }
  }

  const primaryContainer = creep.memory.primaryContainer
    ? Game.getObjectById(creep.memory.primaryContainer as Id<StructureContainer>)
    : null;

  // Check if primary container is valid
  if (primaryContainer) {
    const minerNearby =
      primaryContainer.pos.findInRange(FIND_MY_CREEPS, 1, {
        filter: (c) => c.memory.role === "HARVESTER",
      }).length > 0;

    const hasEnergy = primaryContainer.store[RESOURCE_ENERGY] > 0;
    const isNearby = creep.pos.getRangeTo(primaryContainer) <= 1;

    // If at primary container with miner present, WAIT even if empty
    if (isNearby && minerNearby && !hasEnergy) {
      // Stay put - energy coming soon
      creep.say("WAIT");
      return true; // "Handled" - don't switch
    }

    // If primary has energy, collect from it
    if (hasEnergy) {
      if (isNearby) {
        creep.withdraw(primaryContainer, RESOURCE_ENERGY);
      } else {
        smartMoveTo(creep, primaryContainer, {
          visualizePathStyle: { stroke: "#ffff00" },
          reusePath: 5,
        });
      }
      return true;
    }

    // Primary empty - check if we should switch or go there and wait
    if (minerNearby) {
      // Miner present but container empty - go there and wait
      if (!isNearby) {
        smartMoveTo(creep, primaryContainer, {
          visualizePathStyle: { stroke: "#ffff00" },
          reusePath: 5,
        });
      }
      return true;
    }

    // No miner at primary - consider switching
    const lastSwitch = (creep.memory._lastContainerSwitch as number) || 0;
    if (Game.time - lastSwitch < CONTAINER_SWITCH_COOLDOWN) {
      // Recently switched, stay patient - go to primary anyway
      if (!isNearby) {
        smartMoveTo(creep, primaryContainer, {
          visualizePathStyle: { stroke: "#888888" },
          reusePath: 5,
        });
      }
      return true;
    }

    // Look for better option (container with miner or energy AND fewer assigned haulers)
    const betterContainer = findActiveContainer(
      creep,
      creep.memory.primaryContainer as Id<StructureContainer>
    );
    // Only switch if the better container actually has energy or a miner
    // findActiveContainer now respects assignments, so it won't suggest over-serviced containers
    if (betterContainer && (betterContainer.store[RESOURCE_ENERGY] > 100 ||
        betterContainer.pos.findInRange(FIND_MY_CREEPS, 1, {
          filter: (c) => c.memory.role === "HARVESTER",
        }).length > 0)) {
      creep.memory.primaryContainer = betterContainer.id;
      creep.memory._lastContainerSwitch = Game.time;
      creep.say("SWAP");

      if (creep.pos.isNearTo(betterContainer)) {
        creep.withdraw(betterContainer, RESOURCE_ENERGY);
      } else {
        smartMoveTo(creep, betterContainer, {
          visualizePathStyle: { stroke: "#ffff00" },
          reusePath: 5,
        });
      }
      return true;
    }
  }

  // No primary or primary invalid - find any active container
  const anyContainer = findActiveContainer(creep, null);
  if (anyContainer) {
    if (!creep.memory.primaryContainer) {
      creep.memory.primaryContainer = anyContainer.id;
    }

    if (creep.pos.isNearTo(anyContainer)) {
      creep.withdraw(anyContainer, RESOURCE_ENERGY);
    } else {
      smartMoveTo(creep, anyContainer, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return true;
  }

  return false; // No containers to collect from
}

export function runHauler(creep: Creep): void {
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
  }

  // State transitions
  if (creep.memory.state === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    // Task complete when we finish delivering
    if (creep.memory.taskId) {
      manager.completeTask(creep.memory.taskId);
    }
    creep.memory.state = "COLLECTING";
    creep.say("GET");
  }

  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
    creep.say("DLV");
  }

  // Also switch to deliver earlier if spawn critically needs energy
  if (creep.memory.state === "COLLECTING" && creep.store[RESOURCE_ENERGY] >= 50) {
    const spawnCritical = creep.room.energyAvailable < creep.room.energyCapacityAvailable * 0.3;
    if (spawnCritical) {
      creep.memory.state = "DELIVERING";
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

  // Nothing to collect - wait near primary container or source
  const primaryContainer = creep.memory.primaryContainer
    ? Game.getObjectById(creep.memory.primaryContainer as Id<StructureContainer>)
    : null;

  if (primaryContainer) {
    if (creep.pos.getRangeTo(primaryContainer) > 1) {
      smartMoveTo(creep, primaryContainer, { visualizePathStyle: { stroke: "#888888" } });
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
