/**
 * RemoteContainerPlanner - Places container construction sites at remote mining sources.
 * Only places containers in rooms we actively have visibility and miners.
 */

import { logger } from "../utils/Logger";

export class RemoteContainerPlanner {
  private homeRoom: Room;

  constructor(homeRoom: Room) {
    this.homeRoom = homeRoom;
  }

  /**
   * Check all remote rooms and place containers at sources.
   * Call periodically (every 100 ticks).
   */
  run(): void {
    // Gate: RCL 4+ required for remote mining
    const rcl = this.homeRoom.controller?.level || 0;
    if (rcl < 4) return;

    // Get remote rooms where we have active miners
    const remoteRooms = this.getActiveRemoteRooms();

    for (const roomName of remoteRooms) {
      const room = Game.rooms[roomName];
      if (!room) continue; // No visibility

      this.planContainersInRoom(room);
    }
  }

  /**
   * Get list of rooms with active remote miners.
   */
  private getActiveRemoteRooms(): string[] {
    const rooms = new Set<string>();

    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.room === this.homeRoom.name &&
        creep.memory.role === "REMOTE_MINER" &&
        creep.memory.targetRoom
      ) {
        rooms.add(creep.memory.targetRoom);
      }
    }

    return Array.from(rooms);
  }

  /**
   * Place containers at sources in a remote room.
   */
  private planContainersInRoom(room: Room): void {
    const sources = room.find(FIND_SOURCES);

    for (const source of sources) {
      // Check if container already exists or is being built
      const existingContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });
      if (existingContainer.length > 0) continue;

      const existingSite = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });
      if (existingSite.length > 0) continue;

      // Find best position for container (adjacent to source)
      const containerPos = this.findContainerPosition(room, source);
      if (!containerPos) {
        logger.warn("RemoteContainerPlanner", `No valid container position for source ${source.id} in ${room.name}`);
        continue;
      }

      // Place construction site
      const result = room.createConstructionSite(containerPos.x, containerPos.y, STRUCTURE_CONTAINER);
      if (result === OK) {
        logger.info("RemoteContainerPlanner", `Placed container site at ${containerPos.x},${containerPos.y} in ${room.name}`);
      } else if (result !== ERR_FULL) {
        logger.warn("RemoteContainerPlanner", `Failed to place container in ${room.name}: ${result}`);
      }
    }
  }

  /**
   * Find the best position adjacent to a source for a container.
   * Prefers positions toward home room exit for shorter hauler trips.
   */
  private findContainerPosition(room: Room, source: Source): RoomPosition | null {
    const terrain = room.getTerrain();
    const candidates: Array<{ pos: RoomPosition; score: number }> = [];

    // Find exit direction toward home room
    const exitDir = room.findExitTo(this.homeRoom.name);
    const homeDirection = this.exitDirToDirection(exitDir);

    // Check all adjacent tiles
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;

        const x = source.pos.x + dx;
        const y = source.pos.y + dy;

        // Bounds check
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;

        // Terrain check - no walls
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        // No existing structures
        const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
        if (structures.length > 0) continue;

        // No existing construction sites
        const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
        if (sites.length > 0) continue;

        // Calculate score - lower is better
        // Prefer plain over swamp
        let score = terrain.get(x, y) === TERRAIN_MASK_SWAMP ? 10 : 0;

        // Prefer positions toward home room exit
        if (homeDirection) {
          const dirToTile = this.getDirection(source.pos.x, source.pos.y, x, y);
          if (dirToTile === homeDirection) {
            score -= 5; // Strong preference for direct path home
          } else if (this.isAdjacentDirection(dirToTile, homeDirection)) {
            score -= 2; // Slight preference for adjacent directions
          }
        }

        candidates.push({
          pos: new RoomPosition(x, y, room.name),
          score,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score (lower is better)
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0].pos;
  }

  /**
   * Convert exit direction constant to a direction constant.
   */
  private exitDirToDirection(exitDir: ExitConstant | number): DirectionConstant | null {
    switch (exitDir) {
      case FIND_EXIT_TOP:
        return TOP;
      case FIND_EXIT_RIGHT:
        return RIGHT;
      case FIND_EXIT_BOTTOM:
        return BOTTOM;
      case FIND_EXIT_LEFT:
        return LEFT;
      default:
        return null;
    }
  }

  /**
   * Get direction from one position to another.
   */
  private getDirection(fromX: number, fromY: number, toX: number, toY: number): DirectionConstant {
    const dx = toX - fromX;
    const dy = toY - fromY;

    if (dx === 0 && dy < 0) return TOP;
    if (dx > 0 && dy < 0) return TOP_RIGHT;
    if (dx > 0 && dy === 0) return RIGHT;
    if (dx > 0 && dy > 0) return BOTTOM_RIGHT;
    if (dx === 0 && dy > 0) return BOTTOM;
    if (dx < 0 && dy > 0) return BOTTOM_LEFT;
    if (dx < 0 && dy === 0) return LEFT;
    return TOP_LEFT; // dx < 0 && dy < 0
  }

  /**
   * Check if two directions are adjacent (within 45 degrees).
   */
  private isAdjacentDirection(dir1: DirectionConstant, dir2: DirectionConstant): boolean {
    const diff = Math.abs(dir1 - dir2);
    return diff === 1 || diff === 7; // Wrap-around for TOP_LEFT <-> TOP
  }
}
