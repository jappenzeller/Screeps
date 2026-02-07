/**
 * Movement utilities for cross-room travel
 * With stuck detection and alternative exit finding
 */

/**
 * Check if a room is a Source Keeper room based on coordinates.
 * SK rooms have coordinates where both x and y are between 4-6 (when mod 10).
 * Examples: W5N5, E15N25, W45N15
 */
export function isSourceKeeperRoom(roomName: string): boolean {
  const parsed = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!parsed) return false;

  const x = parseInt(parsed[1], 10) % 10;
  const y = parseInt(parsed[2], 10) % 10;

  // SK rooms have coordinates 4-6 in both x and y
  return x >= 4 && x <= 6 && y >= 4 && y <= 6;
}

/**
 * Check if a room is a highway (coordinates 0 in x or y mod 10).
 */
export function isHighwayRoom(roomName: string): boolean {
  const parsed = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!parsed) return false;

  const x = parseInt(parsed[1], 10) % 10;
  const y = parseInt(parsed[2], 10) % 10;

  return x === 0 || y === 0;
}

/**
 * Get a safe route callback that avoids dangerous rooms.
 * Use this with Game.map.findRoute() to get safe cross-room paths.
 */
export function getSafeRouteCallback(): (
  roomName: string,
  fromRoomName: string
) => number {
  return (roomName: string, _fromRoomName: string): number => {
    // Block Source Keeper rooms (too dangerous for unarmed creeps)
    if (isSourceKeeperRoom(roomName)) {
      return Infinity;
    }

    // Check intel for hostile ownership or invaders
    const intel = Memory.intel && Memory.intel[roomName];
    if (intel) {
      // Block rooms owned by hostiles
      if (intel.owner && intel.owner !== "me") {
        return Infinity;
      }

      // Penalize rooms with invader cores (but don't block)
      if (intel.invaderCore) {
        return 5; // Higher cost but still passable
      }

      // Penalize rooms with recent hostiles
      if (intel.hostiles && intel.hostiles > 0) {
        const age = Game.time - (intel.lastScanned || 0);
        if (age < 500) {
          return 3; // Penalize recent hostile activity
        }
      }
    }

    // Prefer highways (cost 1) over normal rooms (cost 2)
    if (isHighwayRoom(roomName)) {
      return 1;
    }

    return 2; // Default cost for normal rooms
  };
}

/**
 * Move creep toward a target room using safe pathfinding.
 * Avoids Source Keeper rooms and hostile-owned rooms.
 */
export function moveToRoomSafe(
  creep: Creep,
  targetRoom: string,
  visualStroke?: string
): boolean {
  if (creep.spawning) return false;
  if (creep.room.name === targetRoom) return false;

  // Use safe route callback to find path
  const route = Game.map.findRoute(creep.room.name, targetRoom, {
    routeCallback: getSafeRouteCallback(),
  });

  if (route === ERR_NO_PATH || route.length === 0) {
    // No safe path found - try regular pathfinding as fallback
    // This might happen if target is unreachable safely
    creep.say("NOPATH");
    return moveToRoom(creep, targetRoom, visualStroke);
  }

  // Get next room in route
  const nextRoom = route[0];
  const exitDir = nextRoom.exit;

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

  // Stuck detection (same as moveToRoom)
  const lastPos = creep.memory._lastPos;
  const currentPos = `${pos.x},${pos.y}`;

  if (lastPos === currentPos) {
    const stuckCount = (creep.memory._stuckCount || 0) + 1;
    creep.memory._stuckCount = stuckCount;

    if (stuckCount > 2) {
      const alternativeExit = findAlternativeExit(creep, exitDir);
      if (alternativeExit) {
        creep.moveTo(alternativeExit, {
          reusePath: 5,
          visualizePathStyle: visualStroke
            ? { stroke: "#ff0000", opacity: 0.5 }
            : undefined,
        });
        return true;
      }

      if (stuckCount > 5) {
        const directions: DirectionConstant[] = [
          TOP,
          TOP_RIGHT,
          RIGHT,
          BOTTOM_RIGHT,
          BOTTOM,
          BOTTOM_LEFT,
          LEFT,
          TOP_LEFT,
        ];
        const randomDir = directions[Math.floor(Math.random() * directions.length)];
        creep.move(randomDir);
        creep.memory._stuckCount = 0;
        return true;
      }
    }
  } else {
    creep.memory._stuckCount = 0;
  }
  creep.memory._lastPos = currentPos;

  // Find exit tile for the calculated direction
  const exit = findBestExit(creep, exitDir);

  if (!exit) {
    return false;
  }

  creep.moveTo(exit, {
    reusePath: 20,
    visualizePathStyle: visualStroke
      ? { stroke: visualStroke, opacity: 0.3 }
      : undefined,
  });
  return true;
}

/**
 * Check if creep is on a room border tile.
 */
export function isOnBorder(creep: Creep): boolean {
  const pos = creep.pos;
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/**
 * Move creep toward center of room to get off a border tile.
 * Tries cardinal direction first, then diagonals if blocked.
 */
export function stepOffBorder(creep: Creep): boolean {
  const pos = creep.pos;
  const terrain = creep.room.getTerrain();

  // Define primary and fallback directions for each border
  var directions: DirectionConstant[] = [];

  if (pos.x === 0) {
    directions = [RIGHT, TOP_RIGHT, BOTTOM_RIGHT];
  } else if (pos.x === 49) {
    directions = [LEFT, TOP_LEFT, BOTTOM_LEFT];
  } else if (pos.y === 0) {
    directions = [BOTTOM, BOTTOM_LEFT, BOTTOM_RIGHT];
  } else if (pos.y === 49) {
    directions = [TOP, TOP_LEFT, TOP_RIGHT];
  } else {
    return false; // Not on border
  }

  // Try each direction until one works
  for (var i = 0; i < directions.length; i++) {
    var dir = directions[i];
    var newX = pos.x;
    var newY = pos.y;

    // Calculate target position based on direction
    if (dir === TOP || dir === TOP_LEFT || dir === TOP_RIGHT) newY--;
    if (dir === BOTTOM || dir === BOTTOM_LEFT || dir === BOTTOM_RIGHT) newY++;
    if (dir === LEFT || dir === TOP_LEFT || dir === BOTTOM_LEFT) newX--;
    if (dir === RIGHT || dir === TOP_RIGHT || dir === BOTTOM_RIGHT) newX++;

    // Check bounds
    if (newX < 0 || newX > 49 || newY < 0 || newY > 49) continue;

    // Check terrain
    if (terrain.get(newX, newY) === TERRAIN_MASK_WALL) continue;

    // Check for blocking creeps
    var look = creep.room.lookAt(newX, newY);
    var blocked = false;
    for (var j = 0; j < look.length; j++) {
      if (look[j].type === LOOK_CREEPS) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    // Found a valid direction - move there
    creep.move(dir);
    return true;
  }

  return false; // All directions blocked
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
 * When blocked at border, find and move to nearest unblocked exit tile
 */
function tryAdjacentExit(creep: Creep, exitDir: ExitConstant): void {
  const pos = creep.pos;
  const exits = creep.room.find(exitDir);

  if (exits.length === 0) return;

  // Find exit tiles that aren't blocked by creeps
  const freeExits = exits.filter(function (exitPos) {
    const creeps = exitPos.lookFor(LOOK_CREEPS);
    return creeps.length === 0 || creeps[0].id === creep.id;
  });

  const candidates = freeExits.length > 0 ? freeExits : exits;

  // Find closest unblocked exit tile
  var closest: RoomPosition | null = null;
  var closestDist = Infinity;

  for (var i = 0; i < candidates.length; i++) {
    var exit = candidates[i];
    var dist = pos.getRangeTo(exit);
    if (dist < closestDist) {
      closestDist = dist;
      closest = exit;
    }
  }

  if (closest && closestDist > 0) {
    // Move toward the closest unblocked exit tile
    creep.moveTo(closest, { reusePath: 3 });
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
 * Smart moveTo wrapper with stuck detection and dynamic ignoreCreeps.
 * Uses Screeps' built-in pathfinder with sensible defaults.
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

  // Stuck detection: track position
  const currentPos = creep.pos.x + "," + creep.pos.y;
  if (creep.memory._lastPos === currentPos) {
    creep.memory._stuckCount = (creep.memory._stuckCount || 0) + 1;
  } else {
    creep.memory._stuckCount = 0;
  }
  creep.memory._lastPos = currentPos;

  const stuckCount = creep.memory._stuckCount || 0;

  // Handle border tiles in same room: step off border when stuck
  // This prevents pathfinding issues at room edges
  if (isOnBorder(creep) && stuckCount > 2) {
    if (stepOffBorder(creep)) {
      return OK; // Successfully moved off border
    }
    // If stepOffBorder failed (all directions blocked), fall through to random shove
  }

  // After 5 ticks stuck (or stepOffBorder failed on border): random shove to break deadlock
  if (stuckCount > 5 || (isOnBorder(creep) && stuckCount > 3)) {
    const directions: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
    const randomDir = directions[Math.floor(Math.random() * directions.length)];
    creep.move(randomDir);
    creep.memory._stuckCount = 0;
    return OK;
  }

  // Build move options
  const range = creep.pos.getRangeTo(targetPos);
  const moveOpts: MoveToOpts = {
    reusePath: 10, // Lower default for more responsive pathing
    ...opts,
  };

  // After 3 ticks stuck: recalculate ignoring creeps
  if (stuckCount > 2) {
    moveOpts.reusePath = 0; // Force recalculation
    moveOpts.ignoreCreeps = true;
  }
  // Short-range ignoreCreeps: when target is 3 tiles or less, path through creeps
  else if (range <= 3) {
    moveOpts.ignoreCreeps = true;
  }

  return creep.moveTo(targetPos, moveOpts);
}
