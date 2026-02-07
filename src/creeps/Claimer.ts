import { moveToRoomSafe } from "../utils/movement";

/**
 * Claimer - Claims controllers in target rooms for expansion
 * Uses safe pathfinding to avoid Source Keeper and hostile rooms.
 */
export function runClaimer(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;

  if (!targetRoom) {
    console.log(`${creep.name}: No target room assigned`);
    return;
  }

  // Not in target room yet - use safe pathfinding
  if (creep.room.name !== targetRoom) {
    moveToRoomSafe(creep, targetRoom, "#ff00ff");
    return;
  }

  // In target room - find controller
  const controller = creep.room.controller;
  if (!controller) {
    console.log(`${creep.name}: No controller in ${targetRoom}!`);
    return;
  }

  // If reserved by enemy, attack to clear reservation
  if (controller.reservation && controller.reservation.username !== creep.owner.username) {
    if (creep.attackController(controller) === ERR_NOT_IN_RANGE) {
      creep.moveTo(controller, { reusePath: 10 });
    }
    return;
  }

  // If owned by enemy (shouldn't happen for our targets)
  if (controller.owner && !controller.my) {
    console.log(`${creep.name}: ${targetRoom} is owned by ${controller.owner.username}!`);
    return;
  }

  // Claim it
  const result = creep.claimController(controller);

  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { reusePath: 10 });
  } else if (result === ERR_GCL_NOT_ENOUGH) {
    console.log(`${creep.name}: GCL too low to claim ${targetRoom}`);
  } else if (result === OK) {
    console.log(`CLAIMED ${targetRoom}!`);

    // Update expansion state in Memory.empire.expansion
    if (Memory.empire && Memory.empire.expansion && Memory.empire.expansion.active) {
      var expansionState = Memory.empire.expansion.active[targetRoom];
      if (expansionState) {
        expansionState.state = "BOOTSTRAPPING";
        expansionState.stateChangedAt = Game.time;
        expansionState.claimer = null; // Claimer done
        console.log("[Claimer] Transitioned " + targetRoom + " to BOOTSTRAPPING state");
      }
    }
  }
}
