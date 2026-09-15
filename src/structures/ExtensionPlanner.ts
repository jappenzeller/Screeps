import { logger } from "../utils/Logger";
import * as Liveness from "../core/Liveness";
import { ExtensionTileQuery, blocksMovement, pickExtensionTiles } from "./buildGrid";

/**
 * ExtensionPlanner - places extension construction sites with a traffic-aware layout.
 *
 * Its search used to stop at radius 10 from the spawn, and both mature rooms had exhausted
 * that area. E43N39 sat at 31 extensions of 40 and E47N41 at 40 of 50, each with zero
 * valid tiles inside radius 10 and 183 and 92 respectively outside it. The planner logged
 * only on success and had no liveness coverage, so nothing reported that 19 extensions had
 * quietly stopped being built. A preferred region had become the only region, the same
 * defect the terminal placement had.
 *
 * Geometry now lives in buildGrid, shared with placeStructures, which also means a
 * widened placement is checked against the corridor guard - this planner is what sealed
 * E47N41's only route north in the first place.
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

    for (const source of this.room.find(FIND_SOURCES)) {
      targets.push(source.pos);
    }

    if (this.room.controller) {
      targets.push(this.room.controller.pos);
    }

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

    // Clear area around spawn (5x5 for manoeuvring)
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

  /** Check if a position is on a highway (should be kept clear) */
  private isOnHighway(x: number, y: number): boolean {
    return this.highways.has(`${x},${y}`);
  }

  /**
   * Run extension planning - call periodically, gated by ConstructionCoordinator.
   */
  run(): void {
    const controller = this.room.controller;
    if (!controller || !controller.my || controller.level < 2) {
      return;
    }

    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return;

    Liveness.ran("ExtensionPlanner");

    const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][controller.level];

    const existingExtensions = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;

    const extensionSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;

    const totalPlanned = existingExtensions + extensionSites;
    const missing = maxExtensions - totalPlanned;

    if (missing <= 0) {
      // Genuinely nothing to do at this RCL. Reported as idle so it cannot be mistaken
      // for a planner that had work and failed - which is the state below.
      Liveness.idle("ExtensionPlanner");
      return;
    }

    // Limit new sites per run to avoid spam
    const sitesToPlace = Math.min(2, missing);
    const tiles = pickExtensionTiles(
      { x: spawn.pos.x, y: spawn.pos.y },
      sitesToPlace,
      this.buildQuery()
    );

    if (tiles.length === 0) {
      // Deliberately NOT idle: extensions are missing and none could be placed. This is
      // the state that went unreported while two rooms stalled 19 extensions short.
      logger.warn(
        "ExtensionPlanner",
        `${this.room.name}: ${missing} extensions missing, no valid tile found`
      );
      return;
    }

    for (const tile of tiles) {
      const result = this.room.createConstructionSite(tile.x, tile.y, STRUCTURE_EXTENSION);
      if (result === OK) {
        Liveness.acted("ExtensionPlanner");
        logger.info("ExtensionPlanner", `Placed extension at ${tile.x},${tile.y}`);
      } else {
        // Failures used to be silent, which hid everything about why nothing appeared.
        logger.warn(
          "ExtensionPlanner",
          `${this.room.name}: createConstructionSite at ${tile.x},${tile.y} returned ${result}`
        );
      }
    }
  }

  /**
   * Describe the room's tiles for buildGrid.
   *
   * Everything is precomputed into sets rather than queried per tile: the search now
   * sweeps rings out to radius 22, and a lookForAt call per tile at that scale is enough
   * CPU to matter.
   */
  private buildQuery(): ExtensionTileQuery {
    const terrain = this.room.getTerrain();
    const occupied = new Set<string>();
    const movement = new Set<string>();
    const extensions = new Set<string>();
    const extensionSites = new Set<string>();

    for (const s of this.room.find(FIND_STRUCTURES)) {
      const key = `${s.pos.x},${s.pos.y}`;
      occupied.add(key);
      if (blocksMovement(s.structureType)) movement.add(key);
      if (s.structureType === STRUCTURE_EXTENSION) extensions.add(key);
    }

    for (const s of this.room.find(FIND_CONSTRUCTION_SITES)) {
      const key = `${s.pos.x},${s.pos.y}`;
      occupied.add(key);
      if (s.structureType === STRUCTURE_EXTENSION) extensionSites.add(key);
    }

    const sources = this.room.find(FIND_SOURCES).map((s) => s.pos);
    const controller = this.room.controller ? this.room.controller.pos : null;

    const isAdjacent = (px: number, py: number, x: number, y: number): boolean =>
      Math.max(Math.abs(px - x), Math.abs(py - y)) <= 1;

    return {
      isWall: (x, y) => (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0,
      isSwamp: (x, y) => (terrain.get(x, y) & TERRAIN_MASK_SWAMP) !== 0,
      isOccupied: (x, y) => occupied.has(`${x},${y}`),
      isReserved: (x, y) => this.isOnHighway(x, y),
      isNearSource: (x, y) => sources.some((p) => isAdjacent(p.x, p.y, x, y)),
      isNearController: (x, y) => !!controller && isAdjacent(controller.x, controller.y, x, y),
      blocksMovementAt: (x, y) => movement.has(`${x},${y}`),
      clusterScore: (x, y) => {
        let score = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const key = `${x + dx},${y + dy}`;
            if (extensions.has(key)) score += 2;
            else if (extensionSites.has(key)) score += 1;
          }
        }
        return score;
      },
    };
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
