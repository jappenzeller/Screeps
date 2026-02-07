/**
 * Movement utilities for cross-room travel
 * With stuck detection, safe pathfinding, and border handling
 */

/**
 * Parse room name into x/y coordinates.
 */
function parseRoomName(roomName: string): { x: number; y: number; wx: number; wy: number } | null {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;

  const wx = parseInt(match[2], 10);
  const wy = parseInt(match[4], 10);

  // Convert to world coordinates (W/S are negative)
  const x = match[1] === "W" ? -wx - 1 : wx;
  const y = match[3] === "S" ? -wy - 1 : wy;

  return { x, y, wx, wy };
}

/**
 * Check if a room is a Source Keeper room based on coordinates.
 * SK rooms have coordinates where both x and y are between 4-6 (when mod 10).
 * Examples: W5N5, E15N25, W45N15
 */
export function isSourceKeeperRoom(roomName: string): boolean {
  const parsed = parseRoomName(roomName);
  if (!parsed) return false;

  const xMod = parsed.wx % 10;
  const yMod = parsed.wy % 10;

  // SK rooms have coordinates 4-6 in both x and y
  return xMod >= 4 && xMod <= 6 && yMod >= 4 && yMod <= 6;
}

/**
 * Check if a room is a highway (coordinates 0 in x or y mod 10).
 */
export function isHighwayRoom(roomName: string): boolean {
  const parsed = parseRoomName(roomName);
  if (!parsed) return false;

  return parsed.wx % 10 === 0 || parsed.wy % 10 === 0;
}

/**
 * Get the cost for routing through a room.
 * Returns Infinity for rooms that should be avoided entirely.
 */
function getSafeRouteCost(roomName: string, allowedRooms: string[]): number {
  // Always allow explicitly permitted rooms (start/end)
  if (allowedRooms.indexOf(roomName) !== -1) return 1;

  // Block Source Keeper rooms
  if (isSourceKeeperRoom(roomName)) {
    return Infinity;
  }

  // Check intel for additional info
  const intel = Memory.intel && Memory.intel[roomName];
  if (intel) {
    // Block rooms owned by hostiles
    if (intel.owner && intel.owner !== "me") {
      return Infinity;
    }

    // Penalize rooms with invader cores
    if (intel.invaderCore) {
      return 5;
    }

    // Penalize rooms with recent hostiles
    if (intel.hostiles && intel.hostiles > 0) {
      const age = Game.time - (intel.lastScanned || 0);
      if (age < 500) {
        return 3;
      }
    }
  }

  // Prefer highways
  if (isHighwayRoom(roomName)) {
    return 1;
  }

  return 2; // Default cost
}

/**
 * Get a safe route callback for Game.map.findRoute().
 */
export function getSafeRouteCallback(allowedRooms?: string[]): (roomName: string, fromRoomName: string) => number {
  const allowed = allowedRooms || [];
  return (roomName: string, _fromRoomName: string): number => {
    return getSafeRouteCost(roomName, allowed);
  };
}

/**
 * Find a safe intermediate waypoint when direct route is blocked.
 * Looks for safe rooms adjacent to current room that get closer to target.
 */
function findSafeWaypoint(fromRoom: string, targetRoom: string): string | null {
  const exits = Game.map.describeExits(fromRoom);
  if (!exits) return null;

  const targetCoords = parseRoomName(targetRoom);
  const fromCoords = parseRoomName(fromRoom);
  if (!targetCoords || !fromCoords) return null;

  const fromDistToTarget = Math.abs(fromCoords.x - targetCoords.x) + Math.abs(fromCoords.y - targetCoords.y);

  interface Candidate {
    room: string;
    distance: number;
    cost: number;
  }

  const candidates: Candidate[] = [];

  // Check all adjacent rooms
  for (const dir in exits) {
    const neighborRoom = exits[dir as unknown as ExitKey];
    if (!neighborRoom) continue;

    const cost = getSafeRouteCost(neighborRoom, [fromRoom, targetRoom]);
    if (cost === Infinity) continue; // Skip dangerous rooms

    const neighborCoords = parseRoomName(neighborRoom);
    if (!neighborCoords) continue;

    // Calculate Manhattan distance to target
    const distToTarget = Math.abs(neighborCoords.x - targetCoords.x) + Math.abs(neighborCoords.y - targetCoords.y);

    // Prefer rooms that get us closer, but also consider lateral moves
    if (distToTarget <= fromDistToTarget) {
      candidates.push({ room: neighborRoom, distance: distToTarget, cost: cost });
    }
  }

  // If no progress possible, try any safe neighbor (for going around obstacles)
  if (candidates.length === 0) {
    for (const dir in exits) {
      const neighborRoom = exits[dir as unknown as ExitKey];
      if (!neighborRoom) continue;

      const cost = getSafeRouteCost(neighborRoom, [fromRoom, targetRoom]);
      if (cost === Infinity) continue;

      candidates.push({ room: neighborRoom, distance: 999, cost: cost });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by distance first, then by cost
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.cost - b.cost;
  });

  return candidates[0].room;
}

/**
 * Debug function to analyze a route between two rooms.
 * Call from console: analyzeRoute("W1N1", "W3N3")
 */
export function analyzeRoute(fromRoom: string, toRoom: string): void {
  console.log(`[Route Analysis] ${fromRoom} -> ${toRoom}`);

  // Check direct route
  const directRoute = Game.map.findRoute(fromRoom, toRoom);
  if (directRoute === ERR_NO_PATH) {
    console.log("  Direct route: NO PATH");
  } else {
    console.log(`  Direct route: ${directRoute.length} rooms`);
    for (const step of directRoute) {
      const isSK = isSourceKeeperRoom(step.room);
      const isHW = isHighwayRoom(step.room);
      console.log(`    -> ${step.room} (SK: ${isSK}, Highway: ${isHW})`);
    }
  }

  // Check safe route
  const safeRoute = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: getSafeRouteCallback([fromRoom, toRoom]),
  });
  if (safeRoute === ERR_NO_PATH) {
    console.log("  Safe route: NO PATH (blocked by SK/hostile rooms)");

    // Try finding waypoint
    const waypoint = findSafeWaypoint(fromRoom, toRoom);
    if (waypoint) {
      console.log(`  Suggested waypoint: ${waypoint}`);
    } else {
      console.log("  No safe waypoint found");
    }
  } else {
    console.log(`  Safe route: ${safeRoute.length} rooms`);
    for (const step of safeRoute) {
      const isSK = isSourceKeeperRoom(step.room);
      const isHW = isHighwayRoom(step.room);
      console.log(`    -> ${step.room} (SK: ${isSK}, Highway: ${isHW})`);
    }
  }
}

/**
 * Alias for moveToRoom (deprecated - kept for compatibility).
 */
export function moveToRoomSafe(
  creep: Creep,
  targetRoom: string,
  visualStroke?: string
): boolean {
  return moveToRoom(creep, targetRoom, visualStroke);
}

/**
 * Check if creep is on a room border tile.
 */
export function isOnBorder(creep: Creep): boolean {
  return isPositionOnBorder(creep.pos);
}

/**
 * Check if a position is on a room border.
 */
function isPositionOnBorder(pos: RoomPosition): boolean {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/**
 * Check if position is on the border that leads to the desired exit.
 */
function isOnCorrectBorder(pos: RoomPosition, exitDir: ExitConstant): boolean {
  switch (exitDir) {
    case FIND_EXIT_TOP: return pos.y === 0;
    case FIND_EXIT_BOTTOM: return pos.y === 49;
    case FIND_EXIT_LEFT: return pos.x === 0;
    case FIND_EXIT_RIGHT: return pos.x === 49;
    default: return false;
  }
}

/**
 * Get the direction to move to cross INTO a room from the border.
 */
function getBorderCrossDirection(pos: RoomPosition): DirectionConstant {
  if (pos.y === 0) return BOTTOM;
  if (pos.y === 49) return TOP;
  if (pos.x === 0) return RIGHT;
  if (pos.x === 49) return LEFT;
  return TOP; // fallback
}

/**
 * Move creep off the border toward room interior.
 * Uses PathFinder with maxRooms:1 to avoid routeCallback interference.
 */
function moveOffBorderInRoom(creep: Creep, color?: string): ScreepsReturnCode {
  // Find a position 5 tiles into the room
  let targetX = creep.pos.x;
  let targetY = creep.pos.y;

  if (creep.pos.x === 0) targetX = 5;
  else if (creep.pos.x === 49) targetX = 44;

  if (creep.pos.y === 0) targetY = 5;
  else if (creep.pos.y === 49) targetY = 44;

  const targetPos = new RoomPosition(targetX, targetY, creep.room.name);

  // Use PathFinder with maxRooms: 1 to guarantee same-room path
  const result = PathFinder.search(creep.pos, { pos: targetPos, range: 1 }, {
    maxRooms: 1,
  });

  if (result.path.length > 0) {
    if (color) {
      creep.room.visual.poly(result.path.map(p => [p.x, p.y]), { stroke: color });
    }
    return creep.moveByPath(result.path);
  }

  // Fallback: just move away from border
  return creep.move(getBorderCrossDirection(creep.pos));
}

/**
 * Move creep off the border toward a specific target.
 * Uses PathFinder with maxRooms:1 to avoid routeCallback interference.
 */
function moveOffBorderToTarget(creep: Creep, target: RoomPosition, color?: string): ScreepsReturnCode {
  const result = PathFinder.search(creep.pos, { pos: target, range: 1 }, {
    maxRooms: 1,
  });

  if (result.path.length > 0) {
    if (color) {
      creep.room.visual.poly(result.path.map(p => [p.x, p.y]), { stroke: color });
    }
    return creep.moveByPath(result.path);
  }

  // Fallback: just move away from border
  return creep.move(getBorderCrossDirection(creep.pos));
}

/**
 * Move creep toward center of room to get off a border tile.
 * Tries cardinal direction first, then diagonals if blocked.
 */
export function stepOffBorder(creep: Creep): boolean {
  const pos = creep.pos;
  const terrain = creep.room.getTerrain();

  // Define primary and fallback directions for each border
  let directions: DirectionConstant[] = [];

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
  for (const dir of directions) {
    let newX = pos.x;
    let newY = pos.y;

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
    const look = creep.room.lookAt(newX, newY);
    let blocked = false;
    for (const item of look) {
      if (item.type === LOOK_CREEPS) {
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
 * Move creep toward a target room safely, avoiding SK and hostile rooms.
 * Handles border edge cases and computes safe waypoints when needed.
 *
 * @param creep - The creep to move
 * @param targetRoom - Destination room name
 * @param visualStroke - Path visualization color (optional)
 * @param opts - Additional options
 * @param opts.avoidDanger - Avoid SK/hostile rooms (default: true)
 */
export function moveToRoom(
  creep: Creep,
  targetRoom: string,
  visualStroke?: string,
  opts?: { avoidDanger?: boolean }
): boolean {
  if (creep.spawning) return false;

  const avoidDanger = !opts || opts.avoidDanger !== false;

  // CASE 1: Already in target room
  if (creep.room.name === targetRoom) {
    // If on border, move off using PathFinder to avoid routeCallback issues
    if (isOnBorder(creep)) {
      moveOffBorderInRoom(creep, visualStroke);
      return true;
    }
    // Already in room and not on border - done
    return false;
  }

  // CASE 2: Check for stored waypoint from previous tick
  if (creep.memory._safeWaypoint) {
    if (creep.room.name === creep.memory._safeWaypoint) {
      // Reached waypoint, clear it and continue to target
      delete creep.memory._safeWaypoint;
      // Fall through to re-route
    } else {
      // Still heading to waypoint - route there instead
      return moveToRoomInternal(creep, creep.memory._safeWaypoint, visualStroke, avoidDanger);
    }
  }

  // CASE 3: Try to find safe route to target
  if (avoidDanger) {
    const route = Game.map.findRoute(creep.room.name, targetRoom, {
      routeCallback: getSafeRouteCallback([creep.room.name, targetRoom]),
    });

    if (route === ERR_NO_PATH || route.length === 0) {
      // No safe direct route - find intermediate waypoint
      const waypoint = findSafeWaypoint(creep.room.name, targetRoom);
      if (waypoint) {
        creep.memory._safeWaypoint = waypoint;
        creep.say("REROUTE");
        return moveToRoomInternal(creep, waypoint, visualStroke, true);
      } else {
        // No safe path at all
        creep.say("NOSAFE");
        console.log(`[Movement] ${creep.name}: No safe path from ${creep.room.name} to ${targetRoom}`);
        return false;
      }
    }
  }

  // CASE 4: Normal routing
  return moveToRoomInternal(creep, targetRoom, visualStroke, avoidDanger);
}

/**
 * Internal movement function - handles the actual pathfinding and movement.
 */
function moveToRoomInternal(
  creep: Creep,
  targetRoom: string,
  visualStroke?: string,
  avoidDanger?: boolean
): boolean {
  // Already in target room - shouldn't happen but handle it
  if (creep.room.name === targetRoom) {
    if (isOnBorder(creep)) {
      moveOffBorderInRoom(creep, visualStroke);
    }
    return false;
  }

  // Find the exit direction to use
  let exitDir: ExitConstant | ERR_NO_PATH | ERR_INVALID_ARGS;

  if (avoidDanger) {
    const route = Game.map.findRoute(creep.room.name, targetRoom, {
      routeCallback: getSafeRouteCallback([creep.room.name, targetRoom]),
    });

    if (route === ERR_NO_PATH || route.length === 0) {
      return false;
    }
    exitDir = route[0].exit;
  } else {
    exitDir = creep.room.findExitTo(targetRoom);
  }

  if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return false;

  const pos = creep.pos;

  // If on the correct border for this exit, step across
  if (isOnCorrectBorder(pos, exitDir)) {
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

  // If on wrong border, step off first using PathFinder
  if (isOnBorder(creep)) {
    // Find the exit and path to it with maxRooms:1
    const exit = findBestExit(creep, exitDir);
    if (exit) {
      moveOffBorderToTarget(creep, exit, visualStroke);
    } else {
      stepOffBorder(creep);
    }
    return true;
  }

  // Stuck detection
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
          visualizePathStyle: visualStroke ? { stroke: "#ff0000", opacity: 0.5 } : undefined,
        });
        return true;
      }

      if (stuckCount > 5) {
        const directions: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
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

  // Find exit tile and move to it
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
 * Find the best exit tile, avoiding tiles with creeps.
 */
function findBestExit(creep: Creep, exitDir: ExitConstant): RoomPosition | null {
  const exits = creep.room.find(exitDir);
  if (exits.length === 0) return null;

  // Filter out exits with creeps on them
  const freeExits = exits.filter((pos) => {
    const creeps = pos.lookFor(LOOK_CREEPS);
    return creeps.length === 0;
  });

  const candidates = freeExits.length > 0 ? freeExits : exits;

  // Find closest by range
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
 * When blocked at border, find and move to nearest unblocked exit tile.
 */
function tryAdjacentExit(creep: Creep, exitDir: ExitConstant): void {
  const exits = creep.room.find(exitDir);
  if (exits.length === 0) return;

  const freeExits = exits.filter((exitPos) => {
    const creeps = exitPos.lookFor(LOOK_CREEPS);
    return creeps.length === 0 || creeps[0].id === creep.id;
  });

  const candidates = freeExits.length > 0 ? freeExits : exits;

  let closest: RoomPosition | null = null;
  let closestDist = Infinity;

  for (const exit of candidates) {
    const dist = creep.pos.getRangeTo(exit);
    if (dist < closestDist) {
      closestDist = dist;
      closest = exit;
    }
  }

  if (closest && closestDist > 0) {
    creep.moveTo(closest, { reusePath: 3 });
  }
}

/**
 * Find an alternative exit tile when stuck.
 */
function findAlternativeExit(creep: Creep, exitDir: ExitConstant): RoomPosition | null {
  const exits = creep.room.find(exitDir);

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
 * Smart moveTo wrapper with stuck detection and border handling.
 * Uses safe pathfinding for cross-room movement by default.
 */
export function smartMoveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveToOpts & { avoidDanger?: boolean }
): ScreepsReturnCode {
  const targetPos = "pos" in target ? target.pos : target;
  const avoidDanger = !opts || opts.avoidDanger !== false;

  // Same room movement
  if (targetPos.roomName === creep.room.name) {
    // If on border, use PathFinder directly to avoid routeCallback issues
    if (isOnBorder(creep)) {
      return moveOffBorderToTarget(creep, targetPos, opts?.visualizePathStyle?.stroke);
    }

    // Stuck detection
    const currentPos = `${creep.pos.x},${creep.pos.y}`;
    if (creep.memory._lastPos === currentPos) {
      creep.memory._stuckCount = (creep.memory._stuckCount || 0) + 1;
    } else {
      creep.memory._stuckCount = 0;
    }
    creep.memory._lastPos = currentPos;

    const stuckCount = creep.memory._stuckCount || 0;

    // After 5 ticks stuck: random shove to break deadlock
    if (stuckCount > 5) {
      const directions: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
      const randomDir = directions[Math.floor(Math.random() * directions.length)];
      creep.move(randomDir);
      creep.memory._stuckCount = 0;
      return OK;
    }

    // Build move options
    const range = creep.pos.getRangeTo(targetPos);
    const moveOpts: MoveToOpts = {
      reusePath: 10,
      maxRooms: 1, // Force same-room pathing
      ...opts,
    };

    // After 3 ticks stuck: recalculate ignoring creeps
    if (stuckCount > 2) {
      moveOpts.reusePath = 0;
      moveOpts.ignoreCreeps = true;
    } else if (range <= 3) {
      moveOpts.ignoreCreeps = true;
    }

    return creep.moveTo(targetPos, moveOpts);
  }

  // Cross-room movement
  // If on border heading to target room, check if we should push through
  if (isOnBorder(creep)) {
    const exitDir = creep.room.findExitTo(targetPos.roomName);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      if (isOnCorrectBorder(creep.pos, exitDir as ExitConstant)) {
        // On correct border - just push through
        return creep.move(getBorderCrossDirection(creep.pos));
      }
    }
  }

  // Normal cross-room - use moveToRoom which handles safe routing
  moveToRoom(creep, targetPos.roomName, opts?.visualizePathStyle?.stroke, { avoidDanger });
  return OK;
}
