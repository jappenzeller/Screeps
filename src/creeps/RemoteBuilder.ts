import { smartMoveTo } from "../utils/movement";

/**
 * REMOTE_BUILDER - builds infrastructure in remote mining rooms.
 *
 * State machine:
 *   working=false: Collect energy from home storage/containers
 *   working=true: Travel to remote and build
 *
 * Lifecycle:
 *   - Spawns when remote has construction sites
 *   - Auto-recycles when no sites remain
 *   - Reassigns to different remote if current is complete
 */
export function runRemoteBuilder(creep: Creep): void {
  var mem = creep.memory as RemoteBuilderMemory;

  // State transition: empty -> collecting, full -> building
  if (mem.working && creep.store[RESOURCE_ENERGY] === 0) {
    mem.working = false;
    delete mem.targetSiteId;
  }
  if (!mem.working && creep.store.getFreeCapacity() === 0) {
    mem.working = true;
  }

  if (mem.working) {
    buildInRemote(creep, mem);
  } else {
    collectEnergy(creep, mem);
  }
}

/**
 * Collect energy from home room.
 */
function collectEnergy(creep: Creep, mem: RemoteBuilderMemory): void {
  var homeRoom = mem.room; // Use room from base memory (assigned home colony)

  // If not in home room, travel there
  if (creep.room.name !== homeRoom) {
    smartMoveTo(creep, new RoomPosition(25, 25, homeRoom), {
      visualizePathStyle: { stroke: "#ffaa00" },
      reusePath: 20,
    });
    return;
  }

  // Priority 1: Withdraw from storage
  var storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 1000) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  // Priority 2: Withdraw from container
  var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 200;
    },
  }) as StructureContainer | null;

  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  // Priority 3: Pickup dropped energy
  var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: function (r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount > 50;
    },
  });

  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  // No energy available - wait near storage
  if (storage) {
    if (creep.pos.getRangeTo(storage) > 3) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }
}

/**
 * Build in the assigned remote room.
 */
function buildInRemote(creep: Creep, mem: RemoteBuilderMemory): void {
  var remoteRoom = mem.targetRoom;
  if (!remoteRoom) {
    // No target room assigned - recycle
    handleNoSites(creep, mem);
    return;
  }

  // If not in remote room, travel there
  if (creep.room.name !== remoteRoom) {
    // Check if we need to path through intermediate room
    var colonyMem = Memory.colonies && Memory.colonies[mem.room];
    var remoteConfig = colonyMem && colonyMem.remotes && colonyMem.remotes[remoteRoom];

    if (remoteConfig && remoteConfig.via && creep.room.name === mem.room) {
      // Go to intermediate room first
      smartMoveTo(creep, new RoomPosition(25, 25, remoteConfig.via), {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 20,
      });
    } else {
      // Go directly to remote
      smartMoveTo(creep, new RoomPosition(25, 25, remoteRoom), {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 20,
      });
    }
    return;
  }

  // Find construction site to build
  var site = findBuildTarget(creep, mem);

  if (!site) {
    // No sites in this remote - check if we should reassign or despawn
    handleNoSites(creep, mem);
    return;
  }

  // Build the site
  var result = creep.build(site);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, site, {
      visualizePathStyle: { stroke: "#00ff00" },
      reusePath: 5,
    });
  } else if (result === ERR_INVALID_TARGET) {
    // Site was completed or destroyed
    delete mem.targetSiteId;
  }
}

/**
 * Find the best construction site to build.
 * Priority: container > road > other
 */
function findBuildTarget(creep: Creep, mem: RemoteBuilderMemory): ConstructionSite | null {
  // Check if current target still exists
  if (mem.targetSiteId) {
    var currentSite = Game.getObjectById(mem.targetSiteId);
    if (currentSite) return currentSite;
    delete mem.targetSiteId;
  }

  var sites = creep.room.find(FIND_CONSTRUCTION_SITES);
  if (sites.length === 0) return null;

  // Sort by priority
  sites.sort(function (a, b) {
    var priorityA = getSitePriority(a);
    var priorityB = getSitePriority(b);
    if (priorityA !== priorityB) return priorityA - priorityB;

    // Same priority: pick closest
    return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
  });

  var target = sites[0];
  mem.targetSiteId = target.id;
  return target;
}

/**
 * Get build priority for a structure type (lower = higher priority).
 */
function getSitePriority(site: ConstructionSite): number {
  switch (site.structureType) {
    case STRUCTURE_CONTAINER:
      return 1; // Highest - enables mining
    case STRUCTURE_ROAD:
      return 2; // High - improves efficiency
    case STRUCTURE_RAMPART:
      return 5;
    case STRUCTURE_WALL:
      return 5;
    default:
      return 3;
  }
}

/**
 * Handle case when no construction sites exist in remote.
 */
function handleNoSites(creep: Creep, mem: RemoteBuilderMemory): void {
  var colonyMem = Memory.colonies && Memory.colonies[mem.room];
  if (!colonyMem || !colonyMem.remotes) {
    creep.suicide();
    return;
  }

  // Check other remotes for sites
  for (var remoteName in colonyMem.remotes) {
    if (remoteName === mem.targetRoom) continue;

    var config = colonyMem.remotes[remoteName];
    if (!config.active) continue;

    var remoteRoom = Game.rooms[remoteName];
    if (!remoteRoom) continue;

    var sites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
    if (sites.length > 0) {
      // Reassign to this remote
      mem.targetRoom = remoteName;
      console.log("[" + creep.name + "] Reassigned to " + remoteName);
      return;
    }
  }

  // No remotes need building - recycle at spawn for energy return
  console.log("[" + creep.name + "] No remote sites, recycling");

  var homeRoom = Game.rooms[mem.room];
  var spawn = homeRoom && homeRoom.find(FIND_MY_SPAWNS)[0];
  if (spawn) {
    if (creep.room.name !== mem.room) {
      smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#ff0000" } });
    } else if (creep.pos.isNearTo(spawn)) {
      spawn.recycleCreep(creep);
    } else {
      smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#ff0000" } });
    }
  } else {
    creep.suicide();
  }
}

/**
 * Interface for type safety.
 */
interface RemoteBuilderMemory {
  role: "REMOTE_BUILDER";
  room: string; // Home colony
  targetRoom?: string; // Remote room to build in
  working: boolean;
  targetSiteId?: Id<ConstructionSite>;
}
