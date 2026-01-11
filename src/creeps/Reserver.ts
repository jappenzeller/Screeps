import { logger } from "../utils/Logger";

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

  // Move to target room if not there
  if (creep.room.name !== targetRoom) {
    const exitDir = creep.room.findExitTo(targetRoom);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      const exit = creep.pos.findClosestByPath(exitDir);
      if (exit) {
        creep.moveTo(exit, { visualizePathStyle: { stroke: "#00ffff" } });
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
    creep.moveTo(controller, { visualizePathStyle: { stroke: "#00ffff" } });
  } else if (result === OK) {
    creep.say("📋");
  }
}

// Extend CreepMemory for reserver
declare global {
  interface CreepMemory {
    targetRoom?: string;
  }
}
