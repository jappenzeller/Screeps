/**
 * BOOTSTRAP_BUILDER - Travels to target room and builds spawn construction site
 *
 * Different from regular builder:
 * - Works in a remote room (no spawn there yet)
 * - Single-purpose: build the spawn
 * - Returns to parent for energy
 */

import { moveToRoom } from "../utils/movement";

export function runBootstrapBuilder(creep: Creep): void {
  const mem = creep.memory as BootstrapBuilderMemory;

  // Initialize state if needed
  if (!mem.bootstrapState) {
    mem.bootstrapState = "TRAVELING_TO_TARGET";
  }

  // State transitions
  if (mem.bootstrapState === "BUILDING" && creep.store[RESOURCE_ENERGY] === 0) {
    mem.bootstrapState = "RETURNING_FOR_ENERGY";
  }
  if (mem.bootstrapState === "RETURNING_FOR_ENERGY" && creep.store.getFreeCapacity() === 0) {
    mem.bootstrapState = "TRAVELING_TO_TARGET";
  }
  if (mem.bootstrapState === "TRAVELING_TO_TARGET" && creep.room.name === mem.targetRoom) {
    mem.bootstrapState = "BUILDING";
  }

  // Execute state
  switch (mem.bootstrapState) {
    case "TRAVELING_TO_TARGET":
      moveToRoom(creep, mem.targetRoom, "#00ff00");
      break;

    case "BUILDING":
      buildInTargetRoom(creep);
      break;

    case "RETURNING_FOR_ENERGY":
      returnForEnergy(creep, mem.parentRoom);
      break;
  }
}

function buildInTargetRoom(creep: Creep): void {
  // Priority 1: Spawn construction site
  const spawnSite = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN,
  });

  if (spawnSite) {
    if (creep.build(spawnSite) === ERR_NOT_IN_RANGE) {
      creep.moveTo(spawnSite, { reusePath: 5, visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // Priority 2: Any other construction site
  const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      creep.moveTo(site, { reusePath: 5, visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // No sites - maybe spawn is built, or waiting for site placement
  // Idle near controller
  if (creep.room.controller && creep.pos.getRangeTo(creep.room.controller) > 3) {
    creep.moveTo(creep.room.controller);
  }
}

function returnForEnergy(creep: Creep, parentRoom: string): void {
  if (creep.room.name !== parentRoom) {
    moveToRoom(creep, parentRoom, "#ffff00");
    return;
  }

  // Priority 1: Pick up dropped energy near us
  const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  })[0];
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      creep.moveTo(dropped);
    }
    return;
  }

  // Priority 2: Get energy from storage
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 0) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(storage, { reusePath: 10 });
    }
    return;
  }

  // Priority 3: Find any container with energy
  const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store[RESOURCE_ENERGY] > 100,
  });
  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.moveTo(container, { reusePath: 10 });
    }
    return;
  }

  // Priority 4: Harvest from source (emergency fallback)
  const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
  if (source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      creep.moveTo(source);
    }
  }
}

/**
 * Body for bootstrap builder: balanced WORK/CARRY/MOVE
 */
export function getBootstrapBuilderBody(energy: number): BodyPartConstant[] {
  // Target: 5W 5C 10M = 800 energy (good for RCL 4+ parent)
  // Minimum: 2W 2C 4M = 400 energy

  const bodies: BodyPartConstant[][] = [
    // 400 energy
    [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
    // 550 energy
    [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
    // 700 energy
    [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    // 800 energy
    [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    // 1000 energy
    [
      WORK,
      WORK,
      WORK,
      WORK,
      WORK,
      CARRY,
      CARRY,
      CARRY,
      CARRY,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
      MOVE,
    ],
  ];

  // Find largest body that fits budget
  for (let i = bodies.length - 1; i >= 0; i--) {
    const cost = bodies[i].reduce((sum, part) => sum + BODYPART_COST[part], 0);
    if (cost <= energy) return bodies[i];
  }

  return bodies[0];
}
