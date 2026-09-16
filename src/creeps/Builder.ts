import { ColonyManager } from "../core/ColonyManager";
import { smartMoveTo, moveToRoom } from "../utils/movement";
import { chooseHomeSite, firstReachable } from "./buildTargets";
import { applyWorkerEnergy, scoreWorkerEnergy } from "./workerEnergy";

/** Ticks a builder holds a chosen site before re-picking by priority. */
const BUILD_LEASE_TICKS = 60;

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

  // Priority 1: Non-road home sites, best reachable structure-type tier first.
  //
  // This used to sort by getRangeTo and return the nearest. Straight-line distance is a
  // proxy for "can I get there", and in E47N41 the two came apart: a builder in a dead-end
  // pocket kept reselecting the nearest-by-air extension site it could not path to, holding
  // 800 energy for 200 ticks. chooseHomeSite honours priority strictly, but a tier nothing
  // can reach no longer blocks the tiers below it.
  if (homeRoom) {
    const nonRoad = homeRoom.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType !== STRUCTURE_ROAD,
    });
    const chosen = chooseHomeSite(creep, nonRoad);
    if (chosen) return chosen;
  }

  // Priority 2 and 3: container sites in remotes we are mining, then roads there.
  const exits = Game.map.describeExits(creep.memory.room);
  if (exits) {
    const remoteOrder: StructureConstant[] = [STRUCTURE_CONTAINER, STRUCTURE_ROAD];
    for (const wanted of remoteOrder) {
      for (const dir in exits) {
        const roomName = exits[dir as ExitKey];
        if (!roomName || !Game.rooms[roomName]) continue;

        // Only build in rooms we are actively mining.
        const hasMiner = Object.values(Game.creeps).some(
          (c) =>
            c.memory.role === "REMOTE_MINER" &&
            c.memory.targetRoom === roomName &&
            c.memory.room === creep.memory.room
        );
        if (!hasMiner) continue;

        const remoteSites = Game.rooms[roomName].find(FIND_CONSTRUCTION_SITES, {
          filter: (s) => s.structureType === wanted,
        });
        if (remoteSites.length > 0) return remoteSites[0];
      }
    }
  }

  // Priority 4: Road sites in home room (lowest priority).
  // Skip if storage exists - RoadBuilder handles home room roads.
  if (homeRoom && !homeRoom.storage) {
    const roads = homeRoom.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    });
    // No `|| roads[0]` fallback: handing back an unreachable road is precisely what
    // stranded the builder. If none is reachable, fall through to repair work.
    const road = firstReachable(creep, roads);
    if (road) return road;
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
  // EMERGENCY SHUTDOWN: Don't consume energy when economy is dead
  // If no harvesters exist and stored energy is critically low, idle to preserve energy for spawner
  var homeRoom = Game.rooms[creep.memory.room];
  if (homeRoom) {
    var homeCreeps = Object.values(Game.creeps).filter(function(c) {
      return c.memory.room === creep.memory.room;
    });
    var hasHarvesters = homeCreeps.some(function(c) {
      return c.memory.role === 'HARVESTER' || c.memory.role === 'PIONEER';
    });
    var totalEnergy = (homeRoom.energyAvailable || 0) +
      (homeRoom.storage ? homeRoom.storage.store[RESOURCE_ENERGY] : 0);

    if (!hasHarvesters && totalEnergy < 500) {
      creep.say('NO ECO');
      // Move toward spawn to be out of the way, but do nothing
      var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn && creep.pos.getRangeTo(spawn) > 5) {
        smartMoveTo(creep, spawn, { reusePath: 20 });
      }
      return;
    }
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
    creep.say("GET");
  }
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "BUILDING";
    creep.say("BLD");
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
    // Expire the choice periodically. The cached site was only ever dropped when it
    // vanished, so a builder that locked onto a road went on building roads while a
    // higher-priority site sat untouched - observed live, with a storage link stalled at
    // 315/5000 while the builder worked roads 25 tiles away. Long enough to make real
    // progress on one site, short enough to notice a link appearing.
    const leaseAge = Game.time - (creep.memory._buildLeaseAt || 0);
    if (leaseAge > BUILD_LEASE_TICKS) {
      delete creep.memory.targetSiteId;
      delete creep.memory._buildLeaseAt;
    }
  }

  if (creep.memory.targetSiteId) {
    site = Game.getObjectById(creep.memory.targetSiteId);
    if (!site) {
      // Site complete or removed
      delete creep.memory.targetSiteId;
      delete creep.memory._buildLeaseAt;
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
      creep.memory._buildLeaseAt = Game.time;
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
  // One owner for worker collection, shared with RemoteBuilder and RoadBuilder. Harvesting
  // is allowed only at home: a builder in a remote should head back, not start mining there.
  const best = scoreWorkerEnergy(creep, { allowHarvest: creep.room.name === creep.memory.room });

  if (best) {
    if (applyWorkerEnergy(creep, best) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, best.target, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing here holds energy. In a remote that means going home; at home it means wait.
  if (creep.room.name !== creep.memory.room) {
    moveToRoom(creep, creep.memory.room, "#ffaa00");
    return;
  }

  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
    creep.say("ZZZ");
  }
}
