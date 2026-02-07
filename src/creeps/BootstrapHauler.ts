/**
 * BOOTSTRAP_HAULER - Ferries energy from parent colony storage to target room
 *
 * 4-state machine:
 * - LOADING: In parent room, withdraw from storage/containers
 * - TRAVELING_TO_TARGET: Moving to target room with energy
 * - DELIVERING: In target room, drop energy for builders
 * - RETURNING: Moving back to parent room (empty)
 */

import { moveToRoomSafe, smartMoveTo } from "../utils/movement";

export function runBootstrapHauler(creep: Creep): void {
  const mem = creep.memory as BootstrapHaulerMemory;

  // === REASSIGNMENT CHECK ===
  // If the expansion room now has a functional spawn, convert to local hauler
  const targetRoom = mem.targetRoom;
  if (targetRoom) {
    const room = Game.rooms[targetRoom];
    if (room) {
      const spawns = room.find(FIND_MY_SPAWNS);
      if (spawns.length > 0) {
        // Spawn exists — new room is self-sufficient
        // Reassign as HAULER in the new room
        creep.memory.role = "HAULER";
        creep.memory.room = targetRoom;
        delete creep.memory.targetRoom;
        delete (creep.memory as any).bootstrapState;
        delete (creep.memory as any).parentRoom;
        creep.say("HAUL");
        console.log(
          `[Bootstrap] ${creep.name} reassigned to HAULER in ${targetRoom} (TTL: ${creep.ticksToLive})`
        );
        return; // Next tick will run as HAULER
      }
    }
  }

  // CRITICAL: If on room edge, move inward FIRST before any state logic
  // Creeps crossing room borders land on edge tiles where pathfinding behaves oddly
  if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
    // Move toward room center or a useful target
    if (creep.room.name === mem.targetRoom) {
      const site = creep.room.find(FIND_MY_CONSTRUCTION_SITES)[0];
      if (site) {
        creep.moveTo(site, { reusePath: 10 });
      } else {
        creep.moveTo(25, 25);
      }
    } else if (creep.room.name === mem.parentRoom) {
      const storage = creep.room.storage;
      if (storage) {
        creep.moveTo(storage, { reusePath: 10 });
      } else {
        creep.moveTo(25, 25);
      }
    } else {
      // Transit room - just move to center
      creep.moveTo(25, 25);
    }
    creep.say("EDGE!");
    return;
  }

  // Initialize state if needed
  if (!mem.bootstrapState) {
    mem.bootstrapState = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ? "DELIVERING" : "LOADING";
  }

  // Handle legacy 2-state haulers - convert to 4-state
  if (mem.bootstrapState === "LOADING" && creep.room.name !== mem.parentRoom) {
    // In wrong room with LOADING state - figure out correct state
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      mem.bootstrapState = "TRAVELING_TO_TARGET";
    } else {
      mem.bootstrapState = "RETURNING";
    }
  }
  if (mem.bootstrapState === "DELIVERING" && creep.room.name !== mem.targetRoom) {
    // In wrong room with DELIVERING state - figure out correct state
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      mem.bootstrapState = "TRAVELING_TO_TARGET";
    } else {
      mem.bootstrapState = "RETURNING";
    }
  }

  switch (mem.bootstrapState) {
    case "LOADING":
      loadFromParent(creep, mem);
      break;

    case "TRAVELING_TO_TARGET":
      travelToTarget(creep, mem);
      break;

    case "DELIVERING":
      deliverAtTarget(creep, mem);
      break;

    case "RETURNING":
      returnToParent(creep, mem);
      break;
  }
}

function loadFromParent(creep: Creep, mem: BootstrapHaulerMemory): void {
  // CRITICAL: If not in parent room, go there first
  if (creep.room.name !== mem.parentRoom) {
    moveToRoomSafe(creep, mem.parentRoom, "#ffff00");
    return;
  }

  // If full, switch to traveling
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    mem.bootstrapState = "TRAVELING_TO_TARGET";
    return;
  }

  // Priority 1: Storage (primary source)
  const storage = creep.room.storage;
  if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > 1000) {
    const result = creep.withdraw(storage, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { reusePath: 10, visualizePathStyle: { stroke: "#ffff00" } });
    } else if (result === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      mem.bootstrapState = "TRAVELING_TO_TARGET";
    }
    return;
  }

  // Priority 2: Container with most energy
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 200,
  }) as StructureContainer[];

  if (containers.length > 0) {
    containers.sort((a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY));
    const container = containers[0];
    const result = creep.withdraw(container, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { reusePath: 10 });
    } else if (result === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      mem.bootstrapState = "TRAVELING_TO_TARGET";
    }
    return;
  }

  // Priority 3: Dropped energy nearby
  const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 100,
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, { reusePath: 5 });
    }
    return;
  }

  // Nothing to pick up - wait near storage
  if (storage) {
    if (creep.pos.getRangeTo(storage) > 3) {
      smartMoveTo(creep, storage, { reusePath: 10 });
    }
    creep.say("WAIT");
  }
}

function travelToTarget(creep: Creep, mem: BootstrapHaulerMemory): void {
  // If we somehow lost all energy, go back to loading
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    mem.bootstrapState = "RETURNING";
    return;
  }

  // Arrived at target room
  if (creep.room.name === mem.targetRoom) {
    mem.bootstrapState = "DELIVERING";
    return;
  }

  // Move toward target room using safe pathfinding
  moveToRoomSafe(creep, mem.targetRoom, "#00ff00");
}

function deliverAtTarget(creep: Creep, mem: BootstrapHaulerMemory): void {
  // If not in target room, travel there
  if (creep.room.name !== mem.targetRoom) {
    mem.bootstrapState = "TRAVELING_TO_TARGET";
    return;
  }

  // If empty, return to parent
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    mem.bootstrapState = "RETURNING";
    return;
  }

  // Priority 1: Transfer to nearby builder with capacity
  const builder = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
    filter: (c) =>
      c.memory.role === "BOOTSTRAP_BUILDER" && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (builder && creep.pos.isNearTo(builder)) {
    creep.transfer(builder, RESOURCE_ENERGY);
    return;
  }

  // Priority 2: Drop near spawn construction site
  const spawnSite = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN,
  });
  if (spawnSite) {
    if (creep.pos.getRangeTo(spawnSite) <= 2) {
      creep.drop(RESOURCE_ENERGY);
      creep.say("DROP");
    } else {
      smartMoveTo(creep, spawnSite, { reusePath: 10, visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // Priority 3: Drop near any construction site
  const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
  if (site) {
    if (creep.pos.getRangeTo(site) <= 2) {
      creep.drop(RESOURCE_ENERGY);
    } else {
      smartMoveTo(creep, site, { reusePath: 10 });
    }
    return;
  }

  // Priority 4: Drop near controller (backup)
  if (creep.room.controller) {
    if (creep.pos.getRangeTo(creep.room.controller) <= 3) {
      creep.drop(RESOURCE_ENERGY);
    } else {
      smartMoveTo(creep, creep.room.controller, { reusePath: 10 });
    }
  }
}

function returnToParent(creep: Creep, mem: BootstrapHaulerMemory): void {
  // Arrived at parent room
  if (creep.room.name === mem.parentRoom) {
    mem.bootstrapState = "LOADING";
    return;
  }

  // Move toward parent room using safe pathfinding
  moveToRoomSafe(creep, mem.parentRoom, "#ffff00");
}

/**
 * Body for bootstrap hauler: maximize CARRY with MOVE
 * 1:1 ratio for road-less travel in new room
 */
export function getBootstrapHaulerBody(energy: number): BodyPartConstant[] {
  // All CARRY + MOVE (1:1 ratio for road-less travel)
  // 300 energy = 3C 3M (150 carry)
  // 600 energy = 6C 6M (300 carry)
  // 900 energy = 9C 9M (450 carry)
  // 1200 energy = 12C 12M (600 carry)

  const pairs = Math.min(Math.floor(energy / 100), 16); // Max 16 pairs (3200 energy)
  const body: BodyPartConstant[] = [];

  for (let i = 0; i < pairs; i++) {
    body.push(CARRY);
  }
  for (let i = 0; i < pairs; i++) {
    body.push(MOVE);
  }

  return body;
}
