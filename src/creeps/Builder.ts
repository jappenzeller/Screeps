import { ColonyManager } from "../core/ColonyManager";
import { smartMoveTo, moveToRoom } from "../utils/movement";

/**
 * Builder: Builds construction sites and repairs structures.
 * Supports building in remote rooms (containers for remote mining).
 */

/**
 * Find the highest priority construction site.
 * Priority: home non-road > remote containers > remote roads > home roads
 */
function findConstructionSite(creep: Creep): ConstructionSite | null {
  const homeRoom = Game.rooms[creep.memory.room];

  // Priority 1: Non-road sites in home room
  if (homeRoom) {
    const homeSites = homeRoom.find(FIND_CONSTRUCTION_SITES);
    const nonRoad = homeSites.filter((s) => s.structureType !== STRUCTURE_ROAD);
    if (nonRoad.length > 0) {
      return creep.pos.findClosestByPath(nonRoad) || nonRoad[0];
    }
  }

  // Priority 2: Container sites in adjacent remote rooms we're mining
  // Priority 3: Road sites in remote rooms (for hauler efficiency)
  const exits = Game.map.describeExits(creep.memory.room);
  if (exits) {
    // First pass: containers (higher priority)
    for (const dir in exits) {
      const roomName = exits[dir as ExitKey];
      if (!roomName || !Game.rooms[roomName]) continue;

      // Only build in rooms we're actively mining
      const hasMiner = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "REMOTE_MINER" &&
          c.memory.targetRoom === roomName &&
          c.memory.room === creep.memory.room
      );
      if (!hasMiner) continue;

      const remoteSites = Game.rooms[roomName].find(FIND_CONSTRUCTION_SITES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });

      if (remoteSites.length > 0) {
        // Return first remote container site found
        return remoteSites[0];
      }
    }

    // Second pass: roads in remote rooms
    for (const dir in exits) {
      const roomName = exits[dir as ExitKey];
      if (!roomName || !Game.rooms[roomName]) continue;

      // Only build roads in rooms we're actively mining
      const hasMiner = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "REMOTE_MINER" &&
          c.memory.targetRoom === roomName &&
          c.memory.room === creep.memory.room
      );
      if (!hasMiner) continue;

      const remoteRoads = Game.rooms[roomName].find(FIND_CONSTRUCTION_SITES, {
        filter: (s) => s.structureType === STRUCTURE_ROAD,
      });

      if (remoteRoads.length > 0) {
        return remoteRoads[0];
      }
    }
  }

  // Priority 4: Road sites in home room (lowest priority)
  if (homeRoom) {
    const roads = homeRoom.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    });
    if (roads.length > 0) {
      return creep.pos.findClosestByPath(roads) || roads[0];
    }
  }

  return null;
}

/**
 * Move to a construction site, handling inter-room travel
 */
function moveToSite(creep: Creep, site: ConstructionSite): void {
  // If site is in a different room, travel there first
  if (site.pos.roomName !== creep.room.name) {
    moveToRoom(creep, site.pos.roomName, "#ffaa00");
    return;
  }

  // Same room - move directly to site
  smartMoveTo(creep, site, {
    visualizePathStyle: { stroke: "#00ff00" },
    reusePath: 5,
  });
}

function moveOffRoad(creep: Creep): void {
  const onRoad = creep.pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_ROAD);
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
        const hasRoad = creep.room.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType === STRUCTURE_ROAD);
        const hasCreep = creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0;
        if (!hasRoad && !hasCreep) {
          smartMoveTo(creep, new RoomPosition(x, y, creep.room.name), { visualizePathStyle: { stroke: "#888888" }, reusePath: 3 });
          return;
        }
      }
    }
  }
}

export function runBuilder(creep: Creep): void {
  const manager = ColonyManager.getInstance(creep.memory.room);

  // Task tracking
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);
    if (!myTask || myTask.assignedCreep !== creep.name) {
      delete creep.memory.taskId;
    }
  }

  // Request BUILD task if idle
  if (!creep.memory.taskId) {
    const task = manager.getAvailableTask(creep);
    if (task && task.type === "BUILD") {
      manager.assignTask(task.id, creep.name);
      // Store target site
      creep.memory.targetSiteId = task.targetId as Id<ConstructionSite>;
    }
  }

  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "BUILDING" : "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "BUILDING" && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.state = "COLLECTING";
    creep.say("🔄");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "BUILDING";
    creep.say("🔨");
  }

  if (creep.memory.state === "BUILDING") {
    buildOrRepair(creep);
  } else {
    getEnergy(creep);
  }
}

function buildOrRepair(creep: Creep): void {
  // Priority 1: Construction sites (home and remote rooms)
  // Prefer assigned target from task
  let site: ConstructionSite | null = null;

  if (creep.memory.targetSiteId) {
    site = Game.getObjectById(creep.memory.targetSiteId);
    if (!site) {
      // Site complete or removed
      delete creep.memory.targetSiteId;
      if (creep.memory.taskId) {
        const manager = ColonyManager.getInstance(creep.memory.room);
        manager.completeTask(creep.memory.taskId);
      }
    }
  }

  // Find site across home and remote rooms
  if (!site) {
    site = findConstructionSite(creep);
    if (site) {
      creep.memory.targetSiteId = site.id;
    }
  }

  if (site) {
    const result = creep.build(site);
    if (result === ERR_NOT_IN_RANGE) {
      moveToSite(creep, site);
    } else if (result === ERR_INVALID_TARGET) {
      // Site completed or removed
      delete creep.memory.targetSiteId;
    }
    return;
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
      smartMoveTo(creep, damaged, { visualizePathStyle: { stroke: "#ff8800" }, reusePath: 5 });
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
      smartMoveTo(creep, wall, { visualizePathStyle: { stroke: "#888888" }, reusePath: 5 });
    }
    return;
  }

  // Nothing to do - behave like upgrader
  const controller = creep.room.controller;
  if (controller) {
    const result = creep.upgradeController(controller);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, controller, { visualizePathStyle: { stroke: "#00ffff" }, reusePath: 10 });
    }
  }
}

function getEnergy(creep: Creep): void {
  // Check current room for energy sources first (works in home or remote)

  // Priority 1: Storage (home room only)
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 2: Any container with energy (works in remote rooms too)
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 50,
  }) as StructureContainer | null;

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 3: Dropped energy
  const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });

  if (droppedEnergy) {
    if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, droppedEnergy, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Priority 4: If in remote room with no local energy, return home
  if (creep.room.name !== creep.memory.room) {
    moveToRoom(creep, creep.memory.room, "#ffaa00");
    return;
  }

  // Priority 5: Harvest from source as last resort (home room only)
  const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // No energy available - wait near spawn but off road
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
    creep.say("💤");
  }
}
