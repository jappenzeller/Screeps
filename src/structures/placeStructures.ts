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
  // Note: STRUCTURE_EXTENSION and STRUCTURE_CONTAINER are handled by
  // ExtensionPlanner and ContainerPlanner respectively (wired in main.ts)
  const structures: BuildableStructureConstant[] = [
    STRUCTURE_SPAWN,
    // STRUCTURE_EXTENSION - handled by ExtensionPlanner
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_LINK,
    STRUCTURE_EXTRACTOR,
    // STRUCTURE_CONTAINER - handled by ContainerPlanner
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

  // Extractor: on mineral
  if (type === STRUCTURE_EXTRACTOR) {
    const mineral = room.find(FIND_MINERALS)[0];
    if (mineral) {
      // Check if mineral already has extractor or site
      const hasExtractor =
        mineral.pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_EXTRACTOR);
      const hasSite =
        mineral.pos.lookFor(LOOK_CONSTRUCTION_SITES).some((s) => s.structureType === STRUCTURE_EXTRACTOR);

      if (!hasExtractor && !hasSite) {
        return { x: mineral.pos.x, y: mineral.pos.y };
      }
    }
    return null;
  }

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

  // Link: strategic placement based on priority
  if (type === STRUCTURE_LINK) {
    return findLinkPosition(room, near, terrain);
  }

  // Roads: connect spawn to sources and controller
  if (type === STRUCTURE_ROAD) {
    return findRoadPosition(room, near, terrain);
  }

  // Extensions: path-aware placement
  if (type === STRUCTURE_EXTENSION) {
    return findExtensionPosition(room, near, terrain);
  }

  // Towers and everything else: spiral out from spawn
  for (let radius = 2; radius <= 10; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue; // Only edge of square

        const x = near.x + dx;
        const y = near.y + dy;

        if (!isValidBuildPos(room, x, y, terrain)) continue;

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

/**
 * Find extension position that doesn't block critical paths
 */
function findExtensionPosition(
  room: Room,
  spawnPos: RoomPosition,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  // Calculate protected tiles (critical paths)
  const protectedTiles = getProtectedTiles(room, spawnPos);

  // Score all candidate positions
  const candidates: Array<{ x: number; y: number; score: number }> = [];

  // Search in rings from spawn (range 2-8)
  for (let radius = 2; radius <= 8; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        // Only check edge of current radius ring
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

        const x = spawnPos.x + dx;
        const y = spawnPos.y + dy;

        // Basic validity checks
        if (!isValidBuildPos(room, x, y, terrain)) continue;

        // Skip protected path tiles
        if (protectedTiles.has(`${x},${y}`)) continue;

        // Skip tiles adjacent to spawn (keep spawn accessible)
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;

        // Skip tiles adjacent to sources
        if (isAdjacentToSource(room, x, y)) continue;

        // Skip tiles adjacent to controller
        if (isAdjacentToController(room, x, y)) continue;

        // Checkerboard pattern (allows walking between extensions)
        const isCheckerboard = (x + y) % 2 === (spawnPos.x + spawnPos.y) % 2;

        // Calculate score (lower is better)
        let score = radius * 10; // Base: prefer closer to spawn

        // Penalty for non-checkerboard (still allowed, but less preferred)
        if (!isCheckerboard) score += 50;

        // Penalty for swamp
        if (terrain.get(x, y) === TERRAIN_MASK_SWAMP) score += 30;

        // Bonus for being near other extensions (clustering)
        const nearbyExtensions = countNearbyExtensions(room, x, y);
        score -= nearbyExtensions * 5;

        candidates.push({ x, y, score });
      }
    }
  }

  // Sort by score (lowest first) and return best
  candidates.sort((a, b) => a.score - b.score);
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Calculate tiles that should be protected (critical paths)
 */
function getProtectedTiles(room: Room, spawnPos: RoomPosition): Set<string> {
  const protectedSet = new Set<string>();

  // Get all path destinations
  const destinations: RoomPosition[] = [];

  // Sources
  const sources = room.find(FIND_SOURCES);
  destinations.push(...sources.map(s => s.pos));

  // Controller
  if (room.controller) {
    destinations.push(room.controller.pos);
  }

  // Storage (if exists)
  if (room.storage) {
    destinations.push(room.storage.pos);
  }

  // Minerals (for future)
  const minerals = room.find(FIND_MINERALS);
  destinations.push(...minerals.map(m => m.pos));

  // Calculate paths and mark tiles
  for (const dest of destinations) {
    const path = room.findPath(spawnPos, dest, {
      ignoreCreeps: true,
      ignoreRoads: true,  // Calculate natural path
      swampCost: 2,
      plainCost: 1,
    });

    // Mark path tiles as protected
    for (const step of path) {
      protectedSet.add(`${step.x},${step.y}`);
    }
  }

  // Also protect tiles adjacent to spawn (8 tiles around spawn)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      protectedSet.add(`${spawnPos.x + dx},${spawnPos.y + dy}`);
    }
  }

  return protectedSet;
}

/**
 * Check if position is adjacent to any source
 */
function isAdjacentToSource(room: Room, x: number, y: number): boolean {
  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    if (Math.abs(source.pos.x - x) <= 1 && Math.abs(source.pos.y - y) <= 1) {
      return true;
    }
  }
  return false;
}

/**
 * Check if position is adjacent to controller
 */
function isAdjacentToController(room: Room, x: number, y: number): boolean {
  const controller = room.controller;
  if (!controller) return false;
  return Math.abs(controller.pos.x - x) <= 1 && Math.abs(controller.pos.y - y) <= 1;
}

/**
 * Count extensions within range 2 (for clustering bonus)
 */
function countNearbyExtensions(room: Room, x: number, y: number): number {
  const extensions = room.find(FIND_MY_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION
  });

  const sites = room.find(FIND_CONSTRUCTION_SITES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION
  });

  let count = 0;
  for (const ext of [...extensions, ...sites]) {
    const dist = Math.max(Math.abs(ext.pos.x - x), Math.abs(ext.pos.y - y));
    if (dist <= 2) count++;
  }
  return count;
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

/**
 * Find optimal link position based on link type needed:
 * - First link: Controller link - near controller for upgraders
 * - Second link: Storage link - on hauler path near storage
 */
function findLinkPosition(
  room: Room,
  spawnPos: RoomPosition,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  const controller = room.controller;
  const storage = room.storage;
  const spawn = room.find(FIND_MY_SPAWNS)[0];

  // Count existing links
  const existingLinks = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  });
  const linkSites = room.find(FIND_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  });

  // Check if controller already has a link nearby
  const controllerHasLink =
    controller &&
    existingLinks.some((l) => l.pos.getRangeTo(controller) <= 4);

  // First priority: Controller link (if not present)
  if (controller && !controllerHasLink) {
    return findControllerLinkPosition(room, controller, terrain);
  }

  // Second priority: Storage link (on hauler path)
  if (storage && spawn) {
    // Check if storage already has a link nearby
    const storageHasLink = existingLinks.some(
      (l) => l.pos.getRangeTo(storage) <= 3
    );
    if (!storageHasLink) {
      return findStorageLinkPosition(room, storage, spawn, terrain);
    }
  }

  // Fallback: near spawn
  return findNearSpawnPosition(room, spawnPos, terrain);
}

/**
 * Find position for controller link - near controller for upgraders
 */
function findControllerLinkPosition(
  room: Room,
  controller: StructureController,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  const candidates: Array<{ x: number; y: number; score: number }> = [];

  // Search in range 2-4 of controller (upgraders work at range 3)
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      const x = controller.pos.x + dx;
      const y = controller.pos.y + dy;
      const range = Math.max(Math.abs(dx), Math.abs(dy));

      if (range < 2 || range > 4) continue;
      if (!isValidBuildPos(room, x, y, terrain)) continue;

      // Prefer range 2-3 (closer to upgraders)
      let score = range === 2 ? 0 : range === 3 ? 1 : 2;

      // Bonus for being on a road (existing infrastructure)
      const hasRoad = room
        .lookForAt(LOOK_STRUCTURES, x, y)
        .some((s) => s.structureType === STRUCTURE_ROAD);
      if (hasRoad) score -= 1;

      // Bonus for plain terrain
      if (terrain.get(x, y) === 0) score -= 0.5;

      candidates.push({ x, y, score });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

/**
 * Find position for storage link - ON the hauler traffic path
 */
function findStorageLinkPosition(
  room: Room,
  storage: StructureStorage,
  spawn: StructureSpawn,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  const candidates: Array<{ x: number; y: number; score: number }> = [];

  // Strategy: Find road tiles that are:
  // 1. Within 2-3 tiles of storage
  // 2. Between storage and spawn (on the path)
  // 3. Preferably on existing roads

  // Get all roads near storage
  const nearbyRoads = room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_ROAD && s.pos.getRangeTo(storage) <= 3,
  });

  // Score each road position
  for (const road of nearbyRoads) {
    const { x, y } = road.pos;

    // Skip if something already built there (other than road)
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    const hasNonRoad = structures.some((s) => s.structureType !== STRUCTURE_ROAD);
    if (hasNonRoad) continue;

    // Skip if construction site exists
    const hasSite = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0;
    if (hasSite) continue;

    const distToStorage = road.pos.getRangeTo(storage);
    const distToSpawn = road.pos.getRangeTo(spawn);
    const storageToSpawn = storage.pos.getRangeTo(spawn);

    // Must be closer to spawn than storage is (between them)
    if (distToSpawn >= storageToSpawn) continue;

    // Score: prefer closer to storage, but on the spawn side
    let score = distToStorage * 10;

    // Bonus for being directly between spawn and storage
    const onPath = isOnPathBetween(storage.pos, spawn.pos, x, y);
    if (onPath) score -= 20;

    candidates.push({ x, y, score });
  }

  // If no roads found, search for plain tiles between storage and spawn
  if (candidates.length === 0) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const x = storage.pos.x + dx;
        const y = storage.pos.y + dy;

        if (!isValidBuildPos(room, x, y, terrain)) continue;

        const distToSpawn = Math.max(
          Math.abs(x - spawn.pos.x),
          Math.abs(y - spawn.pos.y)
        );
        const storageToSpawn = storage.pos.getRangeTo(spawn);

        // Must be toward spawn
        if (distToSpawn >= storageToSpawn) continue;

        let score = Math.max(Math.abs(dx), Math.abs(dy)) * 10;

        // Bonus for plain terrain
        if (terrain.get(x, y) === 0) score -= 5;

        candidates.push({ x, y, score });
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

/**
 * Check if a point is roughly on the line between two positions
 */
function isOnPathBetween(
  from: RoomPosition,
  to: RoomPosition,
  x: number,
  y: number
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const px = x - from.x;
  const py = y - from.y;

  // Project point onto line and check distance
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return false;

  // Cross product gives distance from line
  const cross = Math.abs(dx * py - dy * px) / length;

  // Within 2 tiles of the direct line
  return cross <= 2;
}

/**
 * Fallback: find position near spawn
 */
function findNearSpawnPosition(
  room: Room,
  spawnPos: RoomPosition,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  for (let radius = 2; radius <= 5; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

        const x = spawnPos.x + dx;
        const y = spawnPos.y + dy;

        if (isValidBuildPos(room, x, y, terrain)) {
          return { x, y };
        }
      }
    }
  }
  return null;
}
