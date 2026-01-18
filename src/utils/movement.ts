/**
 * Movement utilities for cross-room travel
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
 * Used when pathfinding fails due to being on an edge.
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
 *
 * Handles two scenarios:
 * 1. Creep is on border and needs to cross INTO next room (move across)
 * 2. Creep is on border and pathfinding fails (step off border first)
 *
 * @returns true if movement was issued, false if already in target room or no path
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
    // Already on the correct exit edge - step across
    const dirMap: Record<number, DirectionConstant> = {
      [FIND_EXIT_LEFT]: LEFT,
      [FIND_EXIT_RIGHT]: RIGHT,
      [FIND_EXIT_TOP]: TOP,
      [FIND_EXIT_BOTTOM]: BOTTOM,
    };
    creep.move(dirMap[exitDir]);
    return true;
  }

  // Try normal pathfinding
  const exit = creep.pos.findClosestByPath(exitDir);

  // If pathfinding fails and we're on ANY border, step off first
  if (!exit || creep.pos.isEqualTo(exit)) {
    if (isOnBorder(creep)) {
      stepOffBorder(creep);
      return true;
    }
    return false;
  }

  creep.moveTo(exit, {
    visualizePathStyle: visualStroke ? { stroke: visualStroke } : undefined,
  });
  return true;
}
