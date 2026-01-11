import { logger } from "../utils/Logger";

/**
 * Claimer - Claims controllers in target rooms for expansion
 * One-time use: claims then dies (or converts to another role)
 */
export function runClaimer(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;

  if (!targetRoom) {
    logger.warn("Claimer", `${creep.name} has no target room assigned`);
    return;
  }

  // Move to target room if not there
  if (creep.room.name !== targetRoom) {
    const exitDir = creep.room.findExitTo(targetRoom);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      const exit = creep.pos.findClosestByPath(exitDir);
      if (exit) {
        creep.moveTo(exit, { visualizePathStyle: { stroke: "#ff00ff" } });
      }
    }
    return;
  }

  // Check for hostiles - flee if dangerous
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
  const dangerous = hostiles.filter(
    (h) =>
      h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0
  );
  if (dangerous.length > 0) {
    const homeRoom = creep.memory.room;
    const exitDir = creep.room.findExitTo(homeRoom);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      const exit = creep.pos.findClosestByPath(exitDir);
      if (exit) {
        creep.moveTo(exit, { visualizePathStyle: { stroke: "#ff0000" } });
      }
    }
    return;
  }

  const controller = creep.room.controller;
  if (!controller) {
    logger.warn("Claimer", `No controller in ${targetRoom}`);
    return;
  }

  // Can't claim owned controllers
  if (controller.owner) {
    logger.warn("Claimer", `${targetRoom} is owned by ${controller.owner.username}`);
    return;
  }

  // Attack hostile reservation if present (not ours)
  if (controller.reservation && controller.reservation.username !== creep.owner.username) {
    const result = creep.attackController(controller);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ff00ff" } });
    }
    return;
  }

  // Claim the controller
  const result = creep.claimController(controller);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#ff00ff" } });
  } else if (result === OK) {
    creep.say("🏴");
    logger.info("Claimer", `Claimed room ${targetRoom}!`);
  } else if (result === ERR_GCL_NOT_ENOUGH) {
    logger.warn("Claimer", "Not enough GCL to claim another room");
    // Fall back to reserving
    creep.reserveController(controller);
  }
}
