import { logger } from "../utils/Logger";
import { moveToRoom, smartMoveTo } from "../utils/movement";
import { shouldFlee, fleeToSafety, updateRoomIntel } from "../utils/remoteIntel";

/**
 * Reserver - Reserves controllers in remote rooms
 * Prevents invader cores from spawning (reservation lasts 5000 ticks per CLAIM part)
 */
export function runReserver(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;

  if (!targetRoom) {
    logger.warn("Reserver", `${creep.name} has no target room assigned`);
    return;
  }

  // Check flee state before traveling
  if (shouldFlee(creep)) {
    fleeToSafety(creep);
    return;
  }

  // Move to target room if not there
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#00ffff");
    return;
  }

  // Update room intel whenever we have vision
  updateRoomIntel(creep);

  // Reserve the controller
  const controller = creep.room.controller;
  if (!controller) {
    logger.warn("Reserver", `No controller in ${targetRoom}`);
    return;
  }

  // Don't try to reserve owned controllers
  if (controller.owner) {
    logger.warn("Reserver", `${targetRoom} is owned by ${controller.owner.username}`);
    return;
  }

  const result = creep.reserveController(controller);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, controller, { visualizePathStyle: { stroke: "#00ffff" } });
  } else if (result === OK) {
    creep.say("RSV");
  }
}

// Extend CreepMemory for reserver
declare global {
  interface CreepMemory {
    targetRoom?: string;
  }
}
