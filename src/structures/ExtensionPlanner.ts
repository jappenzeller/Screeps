import { logger } from "../utils/Logger";

/**
 * ExtensionPlanner - Places extension construction sites near spawn
 * Extensions increase energy capacity, enabling larger creeps
 */
export class ExtensionPlanner {
  constructor(private room: Room) {}

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

    for (let i = 0; i < sitesToPlace; i++) {
      const pos = this.findExtensionPosition(spawn.pos);
      if (pos) {
        const result = this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_EXTENSION);
        if (result === OK) {
          logger.info("ExtensionPlanner", `Placed extension site at ${pos.x},${pos.y}`);
        }
      } else {
        logger.warn("ExtensionPlanner", "No valid position found for extension");
        break;
      }
    }
  }

  /**
   * Find a valid position for an extension near spawn
   */
  private findExtensionPosition(spawnPos: RoomPosition): RoomPosition | null {
    const terrain = this.room.getTerrain();
    const candidates: { pos: RoomPosition; score: number }[] = [];

    // Search in expanding rings from spawn (range 2-6)
    for (let range = 2; range <= 6; range++) {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          // Only check tiles at this exact range (perimeter)
          if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;

          const x = spawnPos.x + dx;
          const y = spawnPos.y + dy;

          // Skip edges of room
          if (x < 2 || x > 47 || y < 2 || y > 47) continue;

          // Skip walls
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

          // Skip if structure exists
          const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
          if (structures.length > 0) continue;

          // Skip if construction site exists
          const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
          if (sites.length > 0) continue;

          // Skip tiles adjacent to sources (harvesters need those)
          if (this.isAdjacentToSource(x, y)) continue;

          // Skip tiles adjacent to controller
          if (this.isAdjacentToController(x, y)) continue;

          // Prefer tiles that form a cluster (adjacent to existing extensions)
          const clusterBonus = this.getClusterScore(x, y);

          // Prefer plain over swamp
          const terrainPenalty = terrain.get(x, y) === TERRAIN_MASK_SWAMP ? 10 : 0;

          // Score: lower is better (closer to spawn, clustered, plain terrain)
          const distance = spawnPos.getRangeTo(x, y);
          const score = distance - clusterBonus + terrainPenalty;

          candidates.push({
            pos: new RoomPosition(x, y, this.room.name),
            score,
          });
        }
      }

      // If we found candidates at this range, pick the best
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.score - b.score);
        return candidates[0].pos;
      }
    }

    return null;
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
}
