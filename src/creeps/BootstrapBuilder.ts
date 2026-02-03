/**
 * BOOTSTRAP_BUILDER - Travels to target room and builds spawn construction site
 *
 * Different from regular builder:
 * - Works in a remote room (no spawn there yet)
 * - Single-purpose: build the spawn
 * - STAYS in target room - haulers bring energy to it
 * - Picks up dropped energy from haulers, never returns to parent
 */

import { moveToRoom, smartMoveTo } from "../utils/movement";

type BuilderState = "TRAVELING" | "COLLECTING" | "BUILDING";

export function runBootstrapBuilder(creep: Creep): void {
  const mem = creep.memory as BootstrapBuilderMemory;

  // === SELF-HARVEST CHECK ===
  // Ensure there's always one self-harvester for this expansion
  // This handles: (1) existing builders spawned before the fix, (2) selfHarvester died
  if (!mem.selfHarvest && mem.targetRoom) {
    const otherBuilders = Object.values(Game.creeps).filter(
      (c) =>
        c.name !== creep.name &&
        c.memory.role === "BOOTSTRAP_BUILDER" &&
        (c.memory as BootstrapBuilderMemory).targetRoom === mem.targetRoom
    );
    const hasSelfHarvester = otherBuilders.some(
      (c) => (c.memory as BootstrapBuilderMemory).selfHarvest === true
    );
    if (!hasSelfHarvester) {
      mem.selfHarvest = true;
      console.log(`[Bootstrap] ${creep.name} becoming self-harvester for ${mem.targetRoom}`);
    }
  }

  // === REASSIGNMENT CHECK ===
  // If the expansion room now has a functional spawn, convert to local upgrader
  const targetRoom = mem.targetRoom;
  if (targetRoom) {
    const room = Game.rooms[targetRoom];
    if (room) {
      const spawns = room.find(FIND_MY_SPAWNS);
      if (spawns.length > 0) {
        // Spawn exists — new room is self-sufficient
        // Reassign as UPGRADER in the new room
        creep.memory.role = "UPGRADER";
        creep.memory.room = targetRoom;
        delete creep.memory.targetRoom;
        delete (creep.memory as any).bootstrapState;
        delete (creep.memory as any).selfHarvest;
        creep.say("UPG");
        console.log(
          `[Bootstrap] ${creep.name} reassigned to UPGRADER in ${targetRoom} (TTL: ${creep.ticksToLive})`
        );
        return; // Next tick will run as UPGRADER
      }
    }
  }

  // CRITICAL: If on room edge, move inward FIRST before any state logic
  // Creeps crossing room borders land on edge tiles where pathfinding behaves oddly
  // This must happen BEFORE state transitions to prevent flip-flopping
  if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
    // Find something to move toward
    const site = creep.room.find(FIND_MY_CONSTRUCTION_SITES)[0];
    if (site) {
      creep.moveTo(site, { reusePath: 10, visualizePathStyle: { stroke: "#ff00ff" } });
    } else if (creep.room.controller) {
      creep.moveTo(creep.room.controller, { reusePath: 10 });
    } else {
      // Fallback: move toward room center
      creep.moveTo(25, 25);
    }
    creep.say("EDGE!");
    return; // Don't run any other logic until off the edge
  }

  // Initialize or normalize state
  // Old states: TRAVELING_TO_TARGET, RETURNING_FOR_ENERGY, BUILDING
  // New states: TRAVELING, COLLECTING, BUILDING
  let state: BuilderState = mem.bootstrapState as BuilderState;

  if (!state || state === ("TRAVELING_TO_TARGET" as any)) {
    state = creep.room.name === mem.targetRoom ? "COLLECTING" : "TRAVELING";
  }
  if (state === ("RETURNING_FOR_ENERGY" as any)) {
    // Old state that went back to parent - now stay in target and collect
    state = "COLLECTING";
  }

  // State transitions based on energy
  if (state === "BUILDING" && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    state = "COLLECTING";
  }
  if (state === "COLLECTING" && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    state = "BUILDING";
  }

  // Also transition to BUILDING if we have some energy and there's a site
  // But self-harvesters should fill up completely before building
  if (state === "COLLECTING" && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    const isSelfHarvester = mem.selfHarvest === true;
    const isFull = creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;

    // Self-harvesters only build when full, others build with any energy
    if (!isSelfHarvester || isFull) {
      const site = creep.room.find(FIND_MY_CONSTRUCTION_SITES)[0];
      if (site) {
        state = "BUILDING";
      }
    }
  }

  // Save state back to memory
  mem.bootstrapState = state as BootstrapBuilderMemory["bootstrapState"];

  // Execute state
  switch (state) {
    case "TRAVELING":
      travelToTarget(creep, mem.targetRoom);
      break;

    case "COLLECTING":
      collectEnergyInTargetRoom(creep, mem.targetRoom);
      break;

    case "BUILDING":
      buildInTargetRoom(creep, mem.targetRoom);
      break;
  }
}

function travelToTarget(creep: Creep, targetRoom: string): void {
  if (creep.room.name === targetRoom) {
    const mem = creep.memory as BootstrapBuilderMemory;
    mem.bootstrapState = "COLLECTING";
    return;
  }

  moveToRoom(creep, targetRoom, "#00ff00");
}

function collectEnergyInTargetRoom(creep: Creep, targetRoom: string): void {
  const mem = creep.memory as BootstrapBuilderMemory;

  // If not in target room yet, travel there
  if (creep.room.name !== targetRoom) {
    mem.bootstrapState = "TRAVELING";
    return;
  }

  // Self-harvesting builder: go directly to source and harvest
  if (mem.selfHarvest) {
    const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (source) {
      const result = creep.harvest(source);
      if (result === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, source, { reusePath: 10, visualizePathStyle: { stroke: "#ffaa00" } });
      } else if (result === OK) {
        creep.say("HARVEST");
      }
      // Transition to building when full
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        mem.bootstrapState = "BUILDING";
      }
      return;
    }
    // No active source - fall through to other collection methods
  }

  // Priority 1: Dropped energy (from haulers)
  const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 20,
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, dropped, { reusePath: 5, visualizePathStyle: { stroke: "#ffff00" } });
    }
    return;
  }

  // Priority 2: Tombstones with energy
  const tombstone = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
    filter: (t) => t.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });
  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, tombstone, { reusePath: 5 });
    }
    return;
  }

  // Priority 3: Ruins with energy
  const ruin = creep.pos.findClosestByRange(FIND_RUINS, {
    filter: (r) => r.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });
  if (ruin) {
    if (creep.withdraw(ruin, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, ruin, { reusePath: 5 });
    }
    return;
  }

  // Priority 4: Container in target room (if one exists)
  const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 50,
  }) as StructureContainer | null;
  if (container) {
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, container, { reusePath: 5 });
    }
    return;
  }

  // Priority 5: Wait near spawn construction site for hauler delivery
  // DO NOT go back to parent room - hauler will bring energy
  const site = creep.room.find(FIND_MY_CONSTRUCTION_SITES)[0];
  if (site) {
    if (creep.pos.getRangeTo(site) > 3) {
      smartMoveTo(creep, site, { reusePath: 10, visualizePathStyle: { stroke: "#888888" } });
    }
    creep.say("WAIT");
  } else {
    // No site yet - wait near controller
    if (creep.room.controller && creep.pos.getRangeTo(creep.room.controller) > 3) {
      smartMoveTo(creep, creep.room.controller, { reusePath: 10 });
    }
  }
}

function buildInTargetRoom(creep: Creep, targetRoom: string): void {
  // If not in target room, go there
  if (creep.room.name !== targetRoom) {
    const mem = creep.memory as BootstrapBuilderMemory;
    mem.bootstrapState = "TRAVELING";
    return;
  }

  // Priority 1: Spawn construction site
  const spawnSite = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN,
  });

  if (spawnSite) {
    const result = creep.build(spawnSite);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, spawnSite, { reusePath: 5, visualizePathStyle: { stroke: "#00ff00" } });
    } else if (result === OK) {
      // Opportunistically pickup nearby energy while building
      const nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      })[0];
      if (nearby && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        creep.pickup(nearby);
      }
    }
    return;
  }

  // Priority 2: Any other construction site
  const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, site, { reusePath: 5, visualizePathStyle: { stroke: "#00ff00" } });
    }
    return;
  }

  // No sites - check if spawn exists (complete!)
  const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
  if (spawn) {
    console.log(`[BootstrapBuilder] ${creep.name}: Spawn complete in ${targetRoom}!`);
    // Transition to helping with other construction or suicide
    creep.suicide();
    return;
  }

  // No site and no spawn - waiting for site placement
  if (creep.room.controller && creep.pos.getRangeTo(creep.room.controller) > 3) {
    smartMoveTo(creep, creep.room.controller, { reusePath: 10 });
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
