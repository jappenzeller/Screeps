import { logger } from "../utils/Logger";

/**
 * TowerPlanner - Places tower construction sites near spawn for defense
 */
export class TowerPlanner {
  constructor(private room: Room) {}

  run(): void {
    const controller = this.room.controller;
    if (!controller || !controller.my || controller.level < 3) {
      return;
    }

    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return;

    // Get max towers for current RCL
    const maxTowers = CONTROLLER_STRUCTURES[STRUCTURE_TOWER][controller.level];

    // Count existing towers and sites
    const existingTowers = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    }).length;

    const towerSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    }).length;

    const totalPlanned = existingTowers + towerSites;

    if (totalPlanned >= maxTowers) {
      return;
    }

    // Place one tower at a time
    const pos = this.findTowerPosition(spawn.pos);
    if (pos) {
      const result = this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_TOWER);
      if (result === OK) {
        logger.info("TowerPlanner", `Placed tower site at ${pos.x},${pos.y}`);
      }
    }
  }

  /**
   * Find a good position for a tower - near spawn for defense coverage
   */
  private findTowerPosition(spawnPos: RoomPosition): RoomPosition | null {
    // Search in expanding rings around spawn, range 2-4
    for (let range = 2; range <= 4; range++) {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          // Only check positions at exactly this range (ring, not filled square)
          if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;

          const x = spawnPos.x + dx;
          const y = spawnPos.y + dy;

          // Bounds check
          if (x < 2 || x > 47 || y < 2 || y > 47) continue;

          const pos = new RoomPosition(x, y, this.room.name);

          if (this.isValidTowerPosition(pos)) {
            return pos;
          }
        }
      }
    }

    return null;
  }

  private isValidTowerPosition(pos: RoomPosition): boolean {
    const terrain = this.room.getTerrain();

    // Can't build on walls
    if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
      return false;
    }

    // Check for existing structures or construction sites
    const structures = pos.lookFor(LOOK_STRUCTURES);
    if (structures.length > 0) {
      return false;
    }

    const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
    if (sites.length > 0) {
      return false;
    }

    return true;
  }
}
