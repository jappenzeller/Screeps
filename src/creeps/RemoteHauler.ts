import { moveToRoom, smartMoveTo } from "../utils/movement";

/**
 * RemoteHauler - Collects energy from remote mining rooms and delivers home
 * State machine: COLLECTING (in remote room) or DELIVERING (bringing home)
 */
export function runRemoteHauler(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  const homeRoom = creep.memory.room;

  if (!targetRoom || !homeRoom) {
    creep.say("❓");
    return;
  }

  // Initialize state
  if (!creep.memory.state) {
    creep.memory.state = "COLLECTING";
  }

  // State transitions
  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
  }
  if (creep.memory.state === "DELIVERING" && creep.store.getUsedCapacity() === 0) {
    creep.memory.state = "COLLECTING";
  }

  if (creep.memory.state === "COLLECTING") {
    collect(creep, targetRoom);
  } else {
    deliver(creep, homeRoom);
  }
}

function collect(creep: Creep, targetRoom: string): void {
  // Travel to target room if not there
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ffaa00");
    return;
  }

  // Check for hostiles - flee if dangerous
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
  const dangerous = hostiles.filter(
    (h) => h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0
  );
  if (dangerous.length > 0) {
    // Flee to home
    moveToRoom(creep, creep.memory.room, "#ff0000");
    return;
  }

  // Priority 1: Pick up dropped energy
  const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  // Priority 2: Withdraw from containers
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.store.getUsedCapacity(RESOURCE_ENERGY) >= 100,
  }) as StructureContainer | null;
  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  // Priority 3: Pick up from tombstones
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t) => t.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });
  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, tombstone, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return;
  }

  // Nothing to collect - wait near a source
  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source && !creep.pos.inRangeTo(source, 3)) {
    smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
  }
}

function deliver(creep: Creep, homeRoom: string): void {
  // Travel to home room if not there
  if (creep.room.name !== homeRoom) {
    moveToRoom(creep, homeRoom, "#00ff00");
    return;
  }

  // Priority 1: Storage
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // Priority 2: Containers near controller
  const controller = creep.room.controller;
  if (controller) {
    const controllerContainer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] as StructureContainer | undefined;

    if (controllerContainer) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, controllerContainer, { visualizePathStyle: { stroke: "#00ff00" } });
      }
      return;
    }
  }

  // Priority 3: Spawn/extensions that need energy
  const spawn = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (spawn) {
    if (creep.transfer(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // Priority 4: Any container with space
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 100,
  });
  if (container) {
    if (creep.transfer(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // Nowhere to deliver - wait near storage or spawn
  const waitTarget = storage || creep.room.find(FIND_MY_SPAWNS)[0];
  if (waitTarget && !creep.pos.inRangeTo(waitTarget, 3)) {
    smartMoveTo(creep, waitTarget, { visualizePathStyle: { stroke: "#00ff00" } });
  }
}
