/**
 * Simple structure placement - one file, one function, no classes.
 * Places structures in priority order, one per tick to avoid CPU spikes.
 */

export function placeStructures(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;

  // Only run every 10 ticks (performance)
  if (Game.time % 10 !== 0) return;

  // Count what exists
  const count = (type: BuildableStructureConstant) => ({
    built: room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === type }).length,
    sites: room.find(FIND_CONSTRUCTION_SITES, { filter: (s) => s.structureType === type }).length,
    max: CONTROLLER_STRUCTURES[type][rcl] || 0,
  });

  // Priority order - place what's missing
  const structures: BuildableStructureConstant[] = [
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_CONTAINER,
    STRUCTURE_ROAD,
  ];

  for (const type of structures) {
    const { built, sites, max } = count(type);
    if (built + sites < max) {
      const placed = placeOne(room, spawn.pos, type);
      if (placed) return; // One per tick, avoid CPU spike
    }
  }
}

function placeOne(room: Room, near: RoomPosition, type: BuildableStructureConstant): boolean {
  const pos = findBuildPosition(room, near, type);
  if (pos) {
    const result = room.createConstructionSite(pos.x, pos.y, type);
    return result === OK;
  }
  return false;
}

function findBuildPosition(
  room: Room,
  near: RoomPosition,
  type: BuildableStructureConstant
): { x: number; y: number } | null {
  const terrain = room.getTerrain();

  // Container: near sources
  if (type === STRUCTURE_CONTAINER) {
    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      // Check if source already has container
      const hasContainer =
        source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        }).length > 0;
      const hasSite =
        source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        }).length > 0;

      if (!hasContainer && !hasSite) {
        // Find adjacent walkable tile
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (isValidBuildPos(room, x, y, terrain)) {
              return { x, y };
            }
          }
        }
      }
    }
    return null;
  }

  // Storage: near spawn but not too close
  if (type === STRUCTURE_STORAGE) {
    for (let radius = 3; radius <= 6; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

          const x = near.x + dx;
          const y = near.y + dy;

          if (!isValidBuildPos(room, x, y, terrain)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  // Roads: connect spawn to sources and controller
  if (type === STRUCTURE_ROAD) {
    return findRoadPosition(room, near, terrain);
  }

  // Everything else: spiral out from spawn
  for (let radius = 2; radius <= 10; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue; // Only edge of square

        const x = near.x + dx;
        const y = near.y + dy;

        if (!isValidBuildPos(room, x, y, terrain)) continue;

        // Extensions: checkerboard pattern for walkability
        if (type === STRUCTURE_EXTENSION) {
          if ((x + y) % 2 !== 0) continue;
        }

        // Towers: prefer positions with good coverage
        if (type === STRUCTURE_TOWER) {
          if (radius < 2 || radius > 5) continue; // Not too close, not too far
        }

        return { x, y };
      }
    }
  }

  return null;
}

function findRoadPosition(
  room: Room,
  spawnPos: RoomPosition,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  // Get path targets
  const sources = room.find(FIND_SOURCES);
  const controller = room.controller;
  const targets: RoomPosition[] = [...sources.map((s) => s.pos)];
  if (controller) targets.push(controller.pos);

  // Find first path position that needs a road
  for (const target of targets) {
    const path = room.findPath(spawnPos, target, {
      ignoreCreeps: true,
      swampCost: 2,
    });

    for (const step of path) {
      // Skip if already has road or site
      const hasRoad =
        room.lookForAt(LOOK_STRUCTURES, step.x, step.y).some((s) => s.structureType === STRUCTURE_ROAD);
      const hasSite =
        room.lookForAt(LOOK_CONSTRUCTION_SITES, step.x, step.y).some((s) => s.structureType === STRUCTURE_ROAD);

      if (!hasRoad && !hasSite && isValidBuildPos(room, step.x, step.y, terrain)) {
        return { x: step.x, y: step.y };
      }
    }
  }

  return null;
}

function isValidBuildPos(room: Room, x: number, y: number, terrain: RoomTerrain): boolean {
  if (x < 2 || x > 47 || y < 2 || y > 47) return false;
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

  const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
  if (structures.length > 0) return false;

  const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  if (sites.length > 0) return false;

  return true;
}
