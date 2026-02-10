/**
 * Decoy — Cheap tower drain bait
 *
 * Body: [TOUGH×N, MOVE×N] — cheapest possible
 * Purpose: Walk toward enemy base to make towers fire, draining their energy
 * Each tower shot = 10 energy drained from the tower
 * A 120-energy decoy can drain ~400 energy from 2 towers before dying
 *
 * Behavior: Enter target room → walk toward towers → die
 */

import { moveToRoom } from "../../utils/movement";

export interface DecoyMemory extends CreepMemory {
  role: "DECOY";
  room: string;
  targetRoom: string;
  campaignId: string;
  enteredTargetRoom: boolean;
}

export function runDecoy(creep: Creep): void {
  var mem = creep.memory as DecoyMemory;

  // Not in target room — travel
  if (creep.room.name !== mem.targetRoom) {
    moveToRoom(creep, mem.targetRoom);
    creep.say("->BAIT");
    return;
  }

  mem.enteredTargetRoom = true;

  // In target room — find closest tower and walk toward it
  var tower = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
    filter: function(s: Structure) {
      return s.structureType === STRUCTURE_TOWER;
    }
  }) as StructureTower | null;

  if (tower) {
    creep.moveTo(tower, { maxRooms: 1 });
    creep.say("BAIT");
  } else {
    // No towers found — walk toward spawn instead
    var spawn = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
      filter: function(s: Structure) {
        return s.structureType === STRUCTURE_SPAWN;
      }
    });
    if (spawn) {
      creep.moveTo(spawn, { maxRooms: 1 });
      creep.say("BAIT");
    } else {
      // Nothing to bait — suicide
      creep.suicide();
    }
  }
}
