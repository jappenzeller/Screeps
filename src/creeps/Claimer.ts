import { moveToRoom } from "../utils/movement";

/**
 * Claimer - Claims controllers in target rooms for expansion
 * Simple implementation: move to room, claim controller, done.
 */
export function runClaimer(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;

  if (!targetRoom) {
    console.log(`${creep.name}: No target room assigned`);
    return;
  }

  // Not in target room yet
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ff00ff");
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
    console.log(`🎉 CLAIMED ${targetRoom}!`);

    // Record in memory
    Memory.expansion = Memory.expansion || {};
    Memory.expansion.claimed = Memory.expansion.claimed || {};
    Memory.expansion.claimed[targetRoom] = {
      claimedAt: Game.time,
      claimedBy: creep.name,
    };

    // Clear target so we don't spawn another claimer
    delete Memory.expansion.targetRoom;

    // Set next phase
    Memory.expansion.bootstrapping = targetRoom;
  }
}
