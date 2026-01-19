import { logger } from "../utils/Logger";

/**
 * ExtensionPlanner - Places extension construction sites with traffic-aware layout
 * Maintains 2-tile-wide corridors between spawn and key destinations
 */
export class ExtensionPlanner {
  private room: Room;
  private highways: Set<string>; // "x,y" positions to keep clear

  constructor(room: Room) {
    this.room = room;
    this.highways = this.calculateHighways();
  }

  /**
   * Calculate highway positions - tiles that should remain clear for traffic
   */
  private calculateHighways(): Set<string> {
    const clear = new Set<string>();
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return clear;

    // Targets to maintain corridors to
    const targets: RoomPosition[] = [];

    // Add sources
    for (const source of this.room.find(FIND_SOURCES)) {
      targets.push(source.pos);
    }

    // Add controller
    if (this.room.controller) {
      targets.push(this.room.controller.pos);
    }

    // Add storage if exists
    if (this.room.storage) {
      targets.push(this.room.storage.pos);
    }

    // For each target, calculate path and mark corridor
    for (const targetPos of targets) {
      const path = this.room.findPath(spawn.pos, targetPos, {
        ignoreCreeps: true,
        ignoreRoads: true,
        swampCost: 1,
        plainCost: 1,
      });

      // Mark each step and adjacent tiles as highway (creates ~3-wide corridor)
      for (const step of path) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const x = step.x + dx;
            const y = step.y + dy;
            if (x >= 0 && x <= 49 && y >= 0 && y <= 49) {
              clear.add(`${x},${y}`);
            }
          }
        }
      }
    }

    // Clear area around spawn (5x5 for maneuvering)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const x = spawn.pos.x + dx;
        const y = spawn.pos.y + dy;
        if (x >= 0 && x <= 49 && y >= 0 && y <= 49) {
          clear.add(`${x},${y}`);
        }
      }
    }

    return clear;
  }

  /**
   * Check if a position is on a highway (should be kept clear)
   */
  private isOnHighway(x: number, y: number): boolean {
    return this.highways.has(`${x},${y}`);
  }

  /**
   * Run extension planning - call periodically (every 20 ticks)
   */
  run(): void {
    const controller = this.room.controller;
    if (!controller || !controller.my || controller.level < 2) {
      return;
    }

    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return;

    // Get max extensions for current RCL
    const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][controller.level];

    // Count existing extensions and sites
    const existingExtensions = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;

    const extensionSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;

    const totalPlanned = existingExtensions + extensionSites;

    // Don't place more if we're at max
    if (totalPlanned >= maxExtensions) {
      return;
    }

    // Limit new sites per run to avoid spam
    const sitesToPlace = Math.min(2, maxExtensions - totalPlanned);
    const positions = this.findExtensionPositions(spawn.pos, sitesToPlace);

    for (const pos of positions) {
      const result = this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_EXTENSION);
      if (result === OK) {
        logger.info("ExtensionPlanner", `Placed extension at ${pos.x},${pos.y}`);
      }
    }
  }

  /**
   * Find valid positions for extensions, avoiding highways
   */
  private findExtensionPositions(spawnPos: RoomPosition, needed: number): RoomPosition[] {
    const terrain = this.room.getTerrain();
    const candidates: Array<{ pos: RoomPosition; score: number }> = [];

    // Search in expanding rings from spawn (range 3-10)
    for (let radius = 3; radius <= 10; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const x = spawnPos.x + dx;
          const y = spawnPos.y + dy;

          // Bounds check (stay away from edges)
          if (x < 2 || x > 47 || y < 2 || y > 47) continue;

          // Skip walls
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

          // CRITICAL: Skip highway tiles to maintain traffic corridors
          if (this.isOnHighway(x, y)) continue;

          // Skip if structure exists
          const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
          if (structures.length > 0) continue;

          // Skip if construction site exists
          const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
          if (sites.length > 0) continue;

          // Skip tiles adjacent to sources (harvesters need those)
          if (this.isAdjacentToSource(x, y)) continue;

          // Skip tiles adjacent to controller (upgraders need those)
          if (this.isAdjacentToController(x, y)) continue;

          // Use checkerboard pattern (allows walking between extensions)
          if ((x + y) % 2 !== (spawnPos.x + spawnPos.y) % 2) continue;

          // Score: prefer closer to spawn, plain terrain, and clustered
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          const terrainPenalty = terrain.get(x, y) === TERRAIN_MASK_SWAMP ? 5 : 0;
          const clusterBonus = this.getClusterScore(x, y);

          const score = distance + terrainPenalty - clusterBonus;

          candidates.push({
            pos: new RoomPosition(x, y, this.room.name),
            score,
          });
        }
      }
    }

    // Sort by score (lower = better) and take what we need
    candidates.sort((a, b) => a.score - b.score);
    return candidates.slice(0, needed).map((p) => p.pos);
  }

  /**
   * Check if a position is adjacent to any source
   */
  private isAdjacentToSource(x: number, y: number): boolean {
    const sources = this.room.find(FIND_SOURCES);
    for (const source of sources) {
      if (source.pos.inRangeTo(x, y, 1)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a position is adjacent to the controller
   */
  private isAdjacentToController(x: number, y: number): boolean {
    const controller = this.room.controller;
    if (!controller) return false;
    return controller.pos.inRangeTo(x, y, 1);
  }

  /**
   * Get cluster score - bonus for being adjacent to existing extensions
   */
  private getClusterScore(x: number, y: number): number {
    let score = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;

        const structures = this.room.lookForAt(LOOK_STRUCTURES, x + dx, y + dy);
        const hasExtension = structures.some((s) => s.structureType === STRUCTURE_EXTENSION);
        if (hasExtension) score += 2;

        const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x + dx, y + dy);
        const hasExtensionSite = sites.some((s) => s.structureType === STRUCTURE_EXTENSION);
        if (hasExtensionSite) score += 1;
      }
    }
    return score;
  }

  /**
   * Visualize highways for debugging
   * Call via: new ExtensionPlanner(Game.rooms['roomName']).visualizeHighways()
   */
  visualizeHighways(): void {
    const visual = this.room.visual;
    for (const key of this.highways) {
      const [x, y] = key.split(",").map(Number);
      visual.rect(x - 0.5, y - 0.5, 1, 1, {
        fill: "#00ff00",
        opacity: 0.2,
      });
    }
  }
}
