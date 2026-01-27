/**
 * Movement utilities for cross-room travel
 * With stuck detection and alternative exit finding
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
 * Move creep toward a target room, handling border edge cases and stuck detection.
 */
export function moveToRoom(creep: Creep, targetRoom: string, visualStroke?: string): boolean {
  if (creep.spawning) return false;
  if (creep.room.name === targetRoom) return false;

  const exitDir = creep.room.findExitTo(targetRoom);
  if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return false;

  const pos = creep.pos;

  // If on the correct border, step across
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
    const result = creep.move(dirMap[exitDir]);

    // If move failed (blocked), try adjacent exit tiles
    if (result !== OK) {
      tryAdjacentExit(creep, exitDir);
    }
    return true;
  }

  // If on wrong border, step off first
  if (isOnBorder(creep)) {
    stepOffBorder(creep);
    return true;
  }

  // Stuck detection: track last position
  const lastPos = creep.memory._lastPos;
  const currentPos = `${pos.x},${pos.y}`;

  if (lastPos === currentPos) {
    // Stuck in same position - increment counter
    const stuckCount = (creep.memory._stuckCount || 0) + 1;
    creep.memory._stuckCount = stuckCount;

    if (stuckCount > 2) {
      // Stuck for 3+ ticks - find alternative exit
      const alternativeExit = findAlternativeExit(creep, exitDir);
      if (alternativeExit) {
        creep.moveTo(alternativeExit, {
          reusePath: 5,
          visualizePathStyle: visualStroke ? { stroke: "#ff0000", opacity: 0.5 } : undefined,
        });
        return true;
      }

      // No alternative - try random movement to break deadlock
      if (stuckCount > 5) {
        const directions: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
        const randomDir = directions[Math.floor(Math.random() * directions.length)];
        creep.move(randomDir);
        creep.memory._stuckCount = 0;
        return true;
      }
    }
  } else {
    // Moving - reset stuck counter
    creep.memory._stuckCount = 0;
  }
  creep.memory._lastPos = currentPos;

  // Find exit tile
  const exit = findBestExit(creep, exitDir);

  if (!exit) {
    return false;
  }

  creep.moveTo(exit, {
    reusePath: 20,
    visualizePathStyle: visualStroke ? { stroke: visualStroke, opacity: 0.3 } : undefined,
  });
  return true;
}

/**
 * Find the best exit tile, avoiding tiles with creeps
 */
function findBestExit(creep: Creep, exitDir: ExitConstant): RoomPosition | null {
  const exits = creep.room.find(exitDir);

  if (exits.length === 0) return null;

  // Filter out exits with creeps on them
  const freeExits = exits.filter((pos) => {
    const creeps = pos.lookFor(LOOK_CREEPS);
    return creeps.length === 0;
  });

  // If all exits blocked, just use any exit
  const candidates = freeExits.length > 0 ? freeExits : exits;

  // Find closest by range (not path - faster)
  let closest: RoomPosition | null = null;
  let closestDist = Infinity;

  for (const exit of candidates) {
    const dist = creep.pos.getRangeTo(exit);
    if (dist < closestDist) {
      closestDist = dist;
      closest = exit;
    }
  }

  return closest;
}

/**
 * When blocked at border, try moving to adjacent exit tile
 */
function tryAdjacentExit(creep: Creep, exitDir: ExitConstant): void {
  const pos = creep.pos;
  let dx = 0, dy = 0;

  // Determine which axis is the border
  if (exitDir === FIND_EXIT_LEFT || exitDir === FIND_EXIT_RIGHT) {
    // On left/right border - try moving up or down
    dy = Math.random() > 0.5 ? 1 : -1;
  } else {
    // On top/bottom border - try moving left or right
    dx = Math.random() > 0.5 ? 1 : -1;
  }

  const newX = pos.x + dx;
  const newY = pos.y + dy;

  // Check bounds and terrain
  if (newX >= 0 && newX <= 49 && newY >= 0 && newY <= 49) {
    const terrain = creep.room.getTerrain();
    if (terrain.get(newX, newY) !== TERRAIN_MASK_WALL) {
      const direction = getDirection(dx, dy);
      creep.move(direction);
    }
  }
}

/**
 * Find an alternative exit tile when stuck
 */
function findAlternativeExit(creep: Creep, exitDir: ExitConstant): RoomPosition | null {
  const exits = creep.room.find(exitDir);

  // Sort by distance, skip the closest one (that's where we're stuck)
  const sorted = exits
    .filter((e) => {
      const creeps = e.lookFor(LOOK_CREEPS);
      return creeps.length === 0 || creeps[0].id === creep.id;
    })
    .sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));

  // Return second closest (or first if only one)
  return sorted[1] || sorted[0] || null;
}

/**
 * Get direction constant from dx/dy
 */
function getDirection(dx: number, dy: number): DirectionConstant {
  if (dx === 0 && dy === -1) return TOP;
  if (dx === 1 && dy === -1) return TOP_RIGHT;
  if (dx === 1 && dy === 0) return RIGHT;
  if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
  if (dx === 0 && dy === 1) return BOTTOM;
  if (dx === -1 && dy === 1) return BOTTOM_LEFT;
  if (dx === -1 && dy === 0) return LEFT;
  if (dx === -1 && dy === -1) return TOP_LEFT;
  return TOP; // fallback
}

/**
 * Simple moveTo wrapper with high reusePath.
 * Uses Screeps' built-in pathfinder with stuck detection.
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
