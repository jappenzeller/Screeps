/**
 * Demolisher — Dismantle remaining enemy structures after controller falls
 *
 * Body: WORK×N, CARRY×1, MOVE×(N+1)/2 (roads expected in our territory)
 *   RCL 6: [WORK×5, CARRY×1, MOVE×3] = 800 energy → 250 DPS dismantle
 *   RCL 7: [WORK×10, CARRY×2, MOVE×6] = 1500 energy → 500 DPS dismantle
 *
 * Behavior:
 *   1. Travel to target room
 *   2. Find highest-priority structure to dismantle
 *   3. Dismantle it (returns energy to carry)
 *   4. Drop energy on ground (or transfer to nearby container if exists)
 *   5. Repeat until room is clear
 *
 * Target priority:
 *   1. Hostile spawns (prevent respawning)
 *   2. Hostile towers (remove threat)
 *   3. Terminal (may contain resources enemy could reclaim)
 *   4. Storage (same)
 *   5. Extensions, labs, factory, other structures
 *   6. Walls and ramparts blocking our pathing
 *
 * Safety: If hostile combat creeps appear, flee to exit.
 */

export interface DemolisherMemory extends CreepMemory {
  role: "DEMOLISHER";
  room: string;           // Spawning room
  targetRoom: string;
  campaignId: string;
  state: "TRAVELING" | "DISMANTLING" | "FLEEING";
  targetId: string | null;
}

function getDemolishPriority(structureType: string): number {
  // Higher = demolish first
  switch (structureType) {
    case STRUCTURE_SPAWN: return 100;
    case STRUCTURE_TOWER: return 90;
    case STRUCTURE_TERMINAL: return 80;
    case STRUCTURE_STORAGE: return 70;
    case STRUCTURE_FACTORY: return 60;
    case STRUCTURE_LAB: return 55;
    case STRUCTURE_LINK: return 50;
    case STRUCTURE_EXTENSION: return 40;
    case STRUCTURE_OBSERVER: return 35;
    case STRUCTURE_POWER_SPAWN: return 35;
    case STRUCTURE_NUKER: return 30;
    case STRUCTURE_EXTRACTOR: return 20;
    case STRUCTURE_RAMPART: return 15;
    case STRUCTURE_WALL: return 10;
    case STRUCTURE_ROAD: return 5;
    case STRUCTURE_CONTAINER: return 3;
    default: return 1;
  }
}

export function run(creep: Creep): void {
  var mem = creep.memory as DemolisherMemory;

  // --- Safety check: flee from combat creeps ---
  if (creep.room.name === mem.targetRoom) {
    var hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
      filter: function(c: Creep) {
        return c.getActiveBodyparts(ATTACK) > 0 ||
               c.getActiveBodyparts(RANGED_ATTACK) > 0;
      }
    });

    if (hostiles.length > 0) {
      var closest = creep.pos.findClosestByRange(hostiles);
      if (closest && creep.pos.getRangeTo(closest) < 6) {
        mem.state = "FLEEING";
      }
    }
  }

  switch (mem.state) {
    case "TRAVELING":
      runTraveling(creep, mem);
      break;
    case "DISMANTLING":
      runDismantling(creep, mem);
      break;
    case "FLEEING":
      runFleeing(creep, mem);
      break;
  }
}

function runTraveling(creep: Creep, mem: DemolisherMemory): void {
  if (creep.room.name === mem.targetRoom) {
    mem.state = "DISMANTLING";
    return;
  }

  creep.moveTo(new RoomPosition(25, 25, mem.targetRoom), {
    reusePath: 20,
    range: 20,
  });
  creep.say("->DEMO");
}

function runDismantling(creep: Creep, mem: DemolisherMemory): void {
  // Find or validate target
  var target: Structure | null = null;

  if (mem.targetId) {
    target = Game.getObjectById(mem.targetId as Id<Structure>);
    if (!target) {
      mem.targetId = null; // Destroyed or gone
    }
  }

  if (!target) {
    target = findBestDemolishTarget(creep);
    if (target) {
      mem.targetId = target.id;
    }
  }

  if (!target) {
    // Room is clear — report to campaign and suicide
    console.log("[Demolisher] " + creep.name + ": Room " + mem.targetRoom + " is clear of structures");
    creep.suicide();
    return;
  }

  // Drop energy if nearly full (keep dismantling)
  if (creep.store.getFreeCapacity() < 10) {
    creep.drop(RESOURCE_ENERGY);
  }

  // Dismantle
  var result = creep.dismantle(target);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(target, { reusePath: 5, range: 1 });
    creep.say("->TARGET");
  } else if (result === OK) {
    creep.say("DISMANTLE");
    // Log high-value demolitions
    var sType = target.structureType;
    if (sType === STRUCTURE_SPAWN || sType === STRUCTURE_TOWER ||
        sType === STRUCTURE_TERMINAL || sType === STRUCTURE_STORAGE) {
      // These will trigger "destroyed" on next tick if HP reaches 0
      var hits = (target as any).hits;
      if (hits && hits <= creep.getActiveBodyparts(WORK) * 50) {
        console.log("[Demolisher] " + creep.name + ": About to destroy " +
          sType + " in " + mem.targetRoom);
      }
    }
  }
}

function runFleeing(creep: Creep, mem: DemolisherMemory): void {
  creep.say("FLEE!");

  // Flee toward the nearest exit to home room
  var exitDir = creep.room.findExitTo(mem.room);
  if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
    var exit = creep.pos.findClosestByRange(exitDir as ExitConstant);
    if (exit) {
      creep.moveTo(exit);
    }
  }

  // Check if hostiles are gone
  var hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: function(c: Creep) {
      return c.getActiveBodyparts(ATTACK) > 0 ||
             c.getActiveBodyparts(RANGED_ATTACK) > 0;
    }
  });

  if (hostiles.length === 0) {
    mem.state = "DISMANTLING";
  }

  // If we've fled to a different room, go back
  if (creep.room.name !== mem.targetRoom && hostiles.length === 0) {
    mem.state = "TRAVELING";
  }
}

function findBestDemolishTarget(creep: Creep): Structure | null {
  // Find all hostile and neutral structures (after controller falls, structures become neutral)
  var structures = creep.room.find(FIND_STRUCTURES, {
    filter: function(s: Structure) {
      // Skip our own structures
      if ((s as OwnedStructure).my) return false;
      // Skip the controller
      if (s.structureType === STRUCTURE_CONTROLLER) return false;
      // Skip indestructible structures
      if (s.structureType === STRUCTURE_KEEPER_LAIR) return false;
      // Include hostile and neutral structures
      return true;
    }
  });

  if (structures.length === 0) return null;

  // Sort by priority descending, then by distance ascending
  structures.sort(function(a: Structure, b: Structure) {
    var priA = getDemolishPriority(a.structureType);
    var priB = getDemolishPriority(b.structureType);
    if (priA !== priB) return priB - priA; // Higher priority first

    // Same priority — pick closer one
    var distA = creep.pos.getRangeTo(a);
    var distB = creep.pos.getRangeTo(b);
    return distA - distB;
  });

  return structures[0];
}
