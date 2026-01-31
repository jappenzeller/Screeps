import { moveToRoom, smartMoveTo } from "../utils/movement";
import { updateRoomIntel, shouldFlee, fleeToSafety } from "../utils/remoteIntel";

/**
 * RemoteHauler - Collects energy from remote mining rooms and delivers home
 * State machine: COLLECTING (in remote room) or DELIVERING (bringing home)
 * Uses road-optimized pathing for efficiency on long routes.
 *
 * Renewal System:
 * Remote haulers renew opportunistically when passing spawn during delivery.
 * This eliminates spawn time for replacements (~138 ticks per hauler).
 */

// Renewal configuration
const RENEW_TTL_THRESHOLD = 1200; // Start considering renewal below this TTL
const RENEW_CRITICAL_TTL = 300; // Force renewal even if spawn busy
const RENEW_COOLDOWN = 20; // Ticks between renewal attempts
const RENEW_MAX_TICKS = 15; // Max consecutive ticks to spend renewing

// Move options optimized for road usage
const ROAD_OPTS: MoveToOpts = {
  reusePath: 50,
  plainCost: 2, // Prefer roads over plains
  swampCost: 10, // Strongly avoid swamps
  visualizePathStyle: { stroke: "#ffaa00", opacity: 0.3 },
};

const ROAD_OPTS_DELIVER: MoveToOpts = {
  ...ROAD_OPTS,
  visualizePathStyle: { stroke: "#00ff00", opacity: 0.3 },
};

/**
 * Attempt opportunistic renewal when adjacent to spawn.
 * Returns true if renewal happened (creep spent tick renewing).
 */
function tryRenew(creep: Creep): boolean {
  // Skip if TTL is healthy
  if (!creep.ticksToLive || creep.ticksToLive > RENEW_TTL_THRESHOLD) {
    return false;
  }

  // Skip if on cooldown (prevents oscillation)
  const lastRenew = creep.memory._lastRenewTick || 0;
  if (Game.time - lastRenew < RENEW_COOLDOWN) {
    return false;
  }

  // Track consecutive renew ticks to prevent blocking spawn too long
  const renewTicks = creep.memory._renewTicks || 0;
  if (renewTicks >= RENEW_MAX_TICKS) {
    // Reset and stop renewing for this pass
    creep.memory._renewTicks = 0;
    creep.memory._lastRenewTick = Game.time;
    return false;
  }

  // Must be adjacent to spawn (don't path to it specifically for renewal)
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn || creep.pos.getRangeTo(spawn) > 1) {
    // Reset renew ticks when we leave spawn
    if (renewTicks > 0) {
      creep.memory._renewTicks = 0;
    }
    return false;
  }

  // Check spawn availability - don't block spawn unless critical
  const isCritical = creep.ticksToLive < RENEW_CRITICAL_TTL;
  if (spawn.spawning && !isCritical) {
    return false;
  }

  // Check if we have enough energy to renew
  const room = spawn.room;
  if (room.energyAvailable < 50) {
    return false;
  }

  // Attempt renewal
  const result = spawn.renewCreep(creep);
  if (result === OK) {
    creep.memory._lastRenewTick = Game.time;
    creep.memory._renewTicks = renewTicks + 1;
    creep.say("♻️ " + creep.ticksToLive);
    return true;
  }

  return false;
}

export function runRemoteHauler(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  const homeRoom = creep.memory.room;

  if (!targetRoom || !homeRoom) {
    creep.say("???");
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
  // Check flee state BEFORE traveling to remote room
  if (shouldFlee(creep)) {
    fleeToSafety(creep);
    return;
  }

  // Travel to target room if not there
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ffaa00");
    return;
  }

  // Update room intel whenever we have vision (critical for defense spawning)
  updateRoomIntel(creep);

  // Priority 1: Pick up dropped energy
  const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, ROAD_OPTS);
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
      smartMoveTo(creep, container, ROAD_OPTS);
    }
    return;
  }

  // Priority 3: Pick up from tombstones
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t) => t.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });
  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, tombstone, ROAD_OPTS);
    }
    return;
  }

  // Nothing to collect - wait near a source
  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source && !creep.pos.inRangeTo(source, 3)) {
    smartMoveTo(creep, source, ROAD_OPTS);
  }
}

function deliver(creep: Creep, homeRoom: string): void {
  // Travel to home room if not there
  if (creep.room.name !== homeRoom) {
    moveToRoom(creep, homeRoom, "#00ff00");
    return;
  }

  // Opportunistic renewal - try when in home room and near spawn
  // This runs every tick we're in home room, but only acts if adjacent to spawn
  if (tryRenew(creep)) {
    return; // Spent tick renewing
  }

  // Priority 1: Storage
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, ROAD_OPTS_DELIVER);
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
        smartMoveTo(creep, controllerContainer, ROAD_OPTS_DELIVER);
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
      smartMoveTo(creep, spawn, ROAD_OPTS_DELIVER);
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
      smartMoveTo(creep, container, ROAD_OPTS_DELIVER);
    }
    return;
  }

  // Nowhere to deliver - wait near storage or spawn
  const waitTarget = storage || creep.room.find(FIND_MY_SPAWNS)[0];
  if (waitTarget && !creep.pos.inRangeTo(waitTarget, 3)) {
    smartMoveTo(creep, waitTarget, ROAD_OPTS_DELIVER);
  }
}
