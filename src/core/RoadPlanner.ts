import { logger } from "../utils/Logger";

/**
 * RoadPlanner - Automatically plans and places road construction sites
 */
export class RoadPlanner {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  /**
   * Plan roads for the room - call periodically (every 100+ ticks)
   */
  run(): void {
    // Only plan roads in owned rooms with RCL >= 2
    if (!this.room.controller || !this.room.controller.my || this.room.controller.level < 2) {
      return;
    }

    // Check if we should plan roads (limit construction sites)
    const existingSites = this.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (existingSites.length > 10) {
      return; // Don't overload with construction sites
    }

    const spawns = this.room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) return;

    const spawn = spawns[0];
    const sources = this.room.find(FIND_SOURCES);

    // Plan roads from spawn to each source
    for (const source of sources) {
      this.planRoadBetween(spawn.pos, source.pos);
    }

    // Plan road from spawn to controller
    if (this.room.controller) {
      this.planRoadBetween(spawn.pos, this.room.controller.pos);
    }

    // Plan roads around spawn (3x3 grid for extension placement)
    this.planSpawnRoads(spawn.pos);
  }

  private planRoadBetween(from: RoomPosition, to: RoomPosition): void {
    const path = this.room.findPath(from, to, {
      ignoreCreeps: true,
      swampCost: 2,
      plainCost: 2,
      range: 1,
    });

    for (const step of path) {
      this.tryPlaceRoad(step.x, step.y);
    }
  }

  private planSpawnRoads(spawnPos: RoomPosition): void {
    // Create roads in a ring around spawn for traffic
    const offsets = [
      { x: -2, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: -2 },
      { x: 0, y: 2 },
      { x: -2, y: -2 },
      { x: 2, y: -2 },
      { x: -2, y: 2 },
      { x: 2, y: 2 },
    ];

    for (const offset of offsets) {
      const x = spawnPos.x + offset.x;
      const y = spawnPos.y + offset.y;
      if (x > 0 && x < 49 && y > 0 && y < 49) {
        this.tryPlaceRoad(x, y);
      }
    }
  }

  private tryPlaceRoad(x: number, y: number): boolean {
    // Check if there's already a road or construction site
    const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
    if (structures.some((s) => s.structureType === STRUCTURE_ROAD)) {
      return false;
    }

    const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    if (sites.length > 0) {
      return false;
    }

    // Check terrain - don't place on walls
    const terrain = this.room.getTerrain();
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
      return false;
    }

    // Place road construction site
    const result = this.room.createConstructionSite(x, y, STRUCTURE_ROAD);
    if (result === OK) {
      logger.debug("RoadPlanner", `Placed road site at ${x},${y} in ${this.room.name}`);
      return true;
    }

    return false;
  }
}
