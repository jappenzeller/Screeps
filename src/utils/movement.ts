/**
 * Movement utilities for cross-room travel
 * Simplified: Just use Screeps' built-in pathfinder with high reusePath
 */

/**
 * Check if creep is on a room border tile.
 */
export function isOnBorder(creep: Creep): boolean {
  const pos = creep.pos;
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/**
 * Move creep toward center of room to get off a border tile.
 */
export function stepOffBorder(creep: Creep): boolean {
  const pos = creep.pos;

  if (pos.x === 0) { creep.move(RIGHT); return true; }
  if (pos.x === 49) { creep.move(LEFT); return true; }
  if (pos.y === 0) { creep.move(BOTTOM); return true; }
  if (pos.y === 49) { creep.move(TOP); return true; }

  return false;
}

/**
 * Move creep toward a target room, handling border edge cases.
 */
export function moveToRoom(creep: Creep, targetRoom: string, visualStroke?: string): boolean {
  if (creep.room.name === targetRoom) return false;

  const exitDir = creep.room.findExitTo(targetRoom);
  if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return false;

  const pos = creep.pos;

  // If on the border we need to cross, just step across
  if (
    (exitDir === FIND_EXIT_LEFT && pos.x === 0) ||
    (exitDir === FIND_EXIT_RIGHT && pos.x === 49) ||
    (exitDir === FIND_EXIT_TOP && pos.y === 0) ||
    (exitDir === FIND_EXIT_BOTTOM && pos.y === 49)
  ) {
    const dirMap: Record<number, DirectionConstant> = {
      [FIND_EXIT_LEFT]: LEFT,
      [FIND_EXIT_RIGHT]: RIGHT,
      [FIND_EXIT_TOP]: TOP,
      [FIND_EXIT_BOTTOM]: BOTTOM,
    };
    creep.move(dirMap[exitDir]);
    return true;
  }

  // Try normal pathfinding to exit
  const exit = creep.pos.findClosestByPath(exitDir);

  if (!exit || creep.pos.isEqualTo(exit)) {
    if (isOnBorder(creep)) {
      stepOffBorder(creep);
      return true;
    }
    return false;
  }

  creep.moveTo(exit, {
    reusePath: 50,
    visualizePathStyle: visualStroke ? { stroke: visualStroke, opacity: 0.3 } : undefined,
  });
  return true;
}

/**
 * Simple moveTo wrapper with high reusePath.
 * Just uses Screeps' built-in pathfinder - no custom stuck detection.
 */
export function smartMoveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveToOpts
): ScreepsReturnCode {
  const targetPos = "pos" in target ? target.pos : target;

  // Handle cross-room movement
  if (targetPos.roomName !== creep.room.name) {
    if (isOnBorder(creep)) {
      moveToRoom(creep, targetPos.roomName, opts?.visualizePathStyle?.stroke);
      return OK;
    }
  }

  // Simple moveTo with high reusePath to minimize recalculation
  return creep.moveTo(targetPos, {
    reusePath: 50,
    ...opts,
  });
}
