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
 * Returns true if renewal happened or waiting (creep should stay).
 *
 * Cooldown only applies when NOT adjacent to spawn - this prevents
 * oscillation during travel, but allows consecutive renews at spawn.
 */
function tryRenew(creep: Creep): boolean {
  // Skip if TTL is healthy
  if (!creep.ticksToLive || creep.ticksToLive > RENEW_TTL_THRESHOLD) {
    return false;
  }

  // Don't renew undersized creeps - let them die and spawn bigger replacements
  const bodyCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
  const capacity = creep.room.energyCapacityAvailable;
  if (bodyCost < capacity * 0.5) {
    return false;
  }

  // Find spawn first - need to know range before cooldown check
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return false;

  const range = creep.pos.getRangeTo(spawn);

  // Cooldown only applies when NOT adjacent
  // This prevents oscillation during travel, but allows consecutive renews at spawn
  if (range > 1) {
    const lastRenew = creep.memory._lastRenewTick || 0;
    if (Game.time - lastRenew < RENEW_COOLDOWN) {
      return false;
    }
    // Reset renew ticks when we leave spawn
    if (creep.memory._renewTicks && creep.memory._renewTicks > 0) {
      creep.memory._renewTicks = 0;
    }
    // Not adjacent and not on cooldown - don't divert, just skip
    return false;
  }

  // --- Adjacent to spawn (range <= 1) ---

  // Stop renewing once TTL reaches target (even if we haven't used all allowed ticks)
  if (creep.ticksToLive >= RENEW_TTL_THRESHOLD) {
    creep.memory._renewTicks = 0;
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

  // Spawn busy - continue delivering, renew on next pass
  if (spawn.spawning) {
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
    creep.memory._renewTicks = renewTicks + 1;
    creep.say("RNW " + creep.ticksToLive);
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

  // === EMERGENCY: Fill spawn/extensions when home economy is dead ===
  // If no harvesters AND no haulers exist, remote haulers are the only
  // way to get energy into spawn. Override normal delivery priority.
  const homeCreeps = Object.values(Game.creeps).filter(
    (c) => c.memory.room === homeRoom
  );
  const hasHarvesters = homeCreeps.some((c) => c.memory.role === "HARVESTER");
  const hasHaulers = homeCreeps.some((c) => c.memory.role === "HAULER");

  if (!hasHarvesters || !hasHaulers) {
    const spawnOrExt = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (spawnOrExt) {
      if (creep.transfer(spawnOrExt, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, spawnOrExt, ROAD_OPTS_DELIVER);
      }
      creep.say("SOS");
      return;
    }
  }
  // === END EMERGENCY ===

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
