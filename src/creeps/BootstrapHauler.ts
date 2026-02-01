/**
 * BOOTSTRAP_HAULER - Ferries energy from parent colony storage to target room
 *
 * Drops energy near construction site or in piles for builders.
 * Critical for getting spawn built when there's no local economy.
 */

import { moveToRoom } from "../utils/movement";

export function runBootstrapHauler(creep: Creep): void {
  const mem = creep.memory as BootstrapHaulerMemory;

  // Initialize state if needed
  if (!mem.bootstrapState) {
    mem.bootstrapState = "LOADING";
  }

  // State transitions
  if (mem.bootstrapState === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    mem.bootstrapState = "LOADING";
  }
  if (mem.bootstrapState === "LOADING" && creep.store.getFreeCapacity() === 0) {
    mem.bootstrapState = "DELIVERING";
  }

  switch (mem.bootstrapState) {
    case "LOADING":
      loadEnergy(creep, mem.parentRoom);
      break;

    case "DELIVERING":
      deliverEnergy(creep, mem.targetRoom);
      break;
  }
}

function loadEnergy(creep: Creep, parentRoom: string): void {
  if (creep.room.name !== parentRoom) {
    moveToRoom(creep, parentRoom, "#ffff00");
    return;
  }

  // Priority 1: Pick up dropped energy near us (may be from other operations)
  const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 100,
  })[0];
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      creep.moveTo(dropped);
    }
    return;
  }

  // Priority 2: Storage (primary source)
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, { reusePath: 10, visualizePathStyle: { stroke: "#ffff00" } });
    }
    return;
  }

  // Priority 3: Container with most energy
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store[RESOURCE_ENERGY] > 200,
  }) as StructureContainer[];

  if (containers.length > 0) {
    containers.sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY]);
    const container = containers[0];
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(container, { reusePath: 10 });
    }
  }
}

function deliverEnergy(creep: Creep, targetRoom: string): void {
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#00ff00");
    return;
  }

  // Priority 1: Transfer to builder with capacity
  const builder = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
    filter: (c) =>
      c.memory.role === "BOOTSTRAP_BUILDER" && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (builder) {
    if (creep.transfer(builder, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(builder, { reusePath: 3, visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // Priority 2: Drop near spawn construction site
  const spawnSite = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN,
  });
  if (spawnSite) {
    if (creep.pos.getRangeTo(spawnSite) > 2) {
      creep.moveTo(spawnSite, { visualizePathStyle: { stroke: "#00ff00" } });
    } else {
      creep.drop(RESOURCE_ENERGY);
    }
    return;
  }

  // Priority 3: Drop near any construction site
  const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
  if (site) {
    if (creep.pos.getRangeTo(site) > 2) {
      creep.moveTo(site);
    } else {
      creep.drop(RESOURCE_ENERGY);
    }
    return;
  }

  // Priority 4: Drop near controller (backup)
  if (creep.room.controller) {
    if (creep.pos.getRangeTo(creep.room.controller) > 3) {
      creep.moveTo(creep.room.controller);
    } else {
      creep.drop(RESOURCE_ENERGY);
    }
  }
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
