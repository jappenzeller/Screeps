/**
 * SmartRoadPlanner - Analyzes traffic data and places roads intelligently.
 * Falls back to static planning when no traffic data is available.
 * Includes remote mining route planning.
 */

import { TrafficMonitor } from "./TrafficMonitor";
import { ColonyManager } from "./ColonyManager";
import { logger } from "../utils/Logger";

// Configuration - lower threshold for unroaded-only tracking
const MIN_VISITS_FOR_ROAD = 30; // Minimum traffic to build a road
const MAX_CONCURRENT_ROAD_SITES = 5; // Don't queue too many roads at once

export class SmartRoadPlanner {
  private room: Room;
  private monitor: TrafficMonitor;

  constructor(room: Room) {
    this.room = room;
    this.monitor = new TrafficMonitor(room);
  }

  /**
   * Main entry - call every 100 ticks
   */
  run(): void {
    // Gate: need RCL 3+ and extensions mostly done
    if (!this.shouldPlanRoads()) return;

    // Count existing road construction sites (home + remote)
    const homeRoom = this.room;
    const existingHomeSites = homeRoom.find(FIND_CONSTRUCTION_SITES, {
      filter: (s: ConstructionSite) => s.structureType === STRUCTURE_ROAD,
    }).length;

    // Phase 1: Home room roads (traffic-based or static fallback)
    let homePlaced = 0;
    const homeMax = Math.min(MAX_CONCURRENT_ROAD_SITES, MAX_CONCURRENT_ROAD_SITES - existingHomeSites);

    if (homeMax > 0) {
      homePlaced = this.planHomeRoads(homeMax);
    }

    // Phase 2: Remote route roads (home room side - storage to exit)
    // These use a separate budget so they aren't starved by home roads
    const routeMax = MAX_CONCURRENT_ROAD_SITES - existingHomeSites - homePlaced;
    let routePlaced = 0;
    if (routeMax > 0) {
      routePlaced = this.planRemoteRoutes(routeMax);
    }

    // Phase 3: Via room transit roads (for distance-2 remotes)
    // Uses its own budget based on via room sites only
    const viaRoadSites = this.countViaRoomSites();
    const viaMax = MAX_CONCURRENT_ROAD_SITES - viaRoadSites;
    if (viaMax > 0) {
      this.planViaRoomRoads(viaMax);
    }

    // Phase 4: Remote room roads (inside remote rooms - exit to sources)
    // Count remote road sites separately - don't let home room sites block remote
    const remoteRoadSites = this.countRemoteRoadSites();
    const remoteMax = MAX_CONCURRENT_ROAD_SITES - remoteRoadSites;
    if (remoteMax > 0) {
      this.planRemoteRoads(remoteMax);
    }
  }

  /**
   * Plan roads in the home room using traffic data or static fallback
   */
  private planHomeRoads(maxToPlace: number): number {
    // Get hotspots from traffic data
    const hotspots = this.monitor.getHotspots(10);

    if (hotspots.length === 0 || hotspots[0].visits < MIN_VISITS_FOR_ROAD) {
      // Fallback to static planning if no traffic data or low traffic
      return this.planStaticRoads(maxToPlace);
    }

    // Build roads at highest-traffic tiles first
    let placed = 0;

    for (const spot of hotspots) {
      if (placed >= maxToPlace) break;

      if (spot.visits < MIN_VISITS_FOR_ROAD) continue;

      if (!this.canPlaceRoad(this.room, spot.x, spot.y)) continue;

      const result = this.room.createConstructionSite(spot.x, spot.y, STRUCTURE_ROAD);
      if (result === OK) {
        placed++;
        logger.info("SmartRoadPlanner", `Road at ${spot.x},${spot.y} (${spot.visits} visits)`);

        if (Memory.traffic && Memory.traffic[this.room.name]) {
          Memory.traffic[this.room.name].roadsBuilt.push(`${spot.x}:${spot.y}`);
        }
      }
    }

    // Fill gaps if we placed some traffic roads but have budget left
    if (placed < maxToPlace && placed > 0) {
      this.fillRoadGaps(maxToPlace - placed);
    }

    return placed;
  }

  /**
   * Count road construction sites in remote rooms and via rooms
   */
  private countRemoteRoadSites(): number {
    let count = 0;
    const countedRooms = new Set<string>();

    // Count sites in active remote rooms
    const remoteRooms = this.getActiveRemoteRooms();
    for (const roomName of remoteRooms) {
      if (countedRooms.has(roomName)) continue;
      countedRooms.add(roomName);

      const room = Game.rooms[roomName];
      if (!room) continue;
      count += room.find(FIND_CONSTRUCTION_SITES, {
        filter: (s: ConstructionSite) => s.structureType === STRUCTURE_ROAD,
      }).length;
    }

    // Also count sites in via rooms for distance-2 remotes
    const manager = ColonyManager.getInstance(this.room.name);
    const remoteConfigs = manager.getRemoteConfigs();
    for (const remoteName in remoteConfigs) {
      const config = remoteConfigs[remoteName];
      if (!config.active || !config.via) continue;

      const viaRoomName = config.via;
      if (countedRooms.has(viaRoomName)) continue;
      countedRooms.add(viaRoomName);

      const viaRoom = Game.rooms[viaRoomName];
      if (!viaRoom) continue;
      count += viaRoom.find(FIND_CONSTRUCTION_SITES, {
        filter: (s: ConstructionSite) => s.structureType === STRUCTURE_ROAD,
      }).length;
    }

    return count;
  }

  /**
   * Count road construction sites only in via rooms (for separate budget)
   */
  private countViaRoomSites(): number {
    let count = 0;
    const countedRooms = new Set<string>();

    const manager = ColonyManager.getInstance(this.room.name);
    const remoteConfigs = manager.getRemoteConfigs();

    for (const remoteName in remoteConfigs) {
      const config = remoteConfigs[remoteName];
      if (!config.active || !config.via) continue;

      const viaRoomName = config.via;
      if (countedRooms.has(viaRoomName)) continue;
      countedRooms.add(viaRoomName);

      const viaRoom = Game.rooms[viaRoomName];
      if (!viaRoom) continue;
      count += viaRoom.find(FIND_CONSTRUCTION_SITES, {
        filter: (s: ConstructionSite) => s.structureType === STRUCTURE_ROAD,
      }).length;
    }

    return count;
  }

  private shouldPlanRoads(): boolean {
    const rcl = this.room.controller ? this.room.controller.level : 0;
    if (rcl < 3) return false;

    // Extensions should be mostly done first
    const maxExt = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl];
    const builtExt = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;

    // Allow road planning when at least 80% of extensions are built
    return builtExt >= maxExt * 0.8;
  }

  /**
   * Connect road segments that have gaps
   */
  private fillRoadGaps(limit: number): void {
    const roads = this.room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    });

    if (roads.length < 2) return;

    let placed = 0;

    // Find road tiles that have non-road walkable neighbors
    // which are adjacent to OTHER road tiles (indicating a gap)
    for (const road of roads) {
      if (placed >= limit) break;

      const neighbors = this.getAdjacentPositions(road.pos);

      for (const pos of neighbors) {
        if (placed >= limit) break;

        // Use canPlaceRoad to check for containers and other structures
        if (!this.canPlaceRoad(this.room, pos.x, pos.y)) continue;

        // Check if this position bridges to another road
        const itsNeighbors = this.getAdjacentPositions(
          new RoomPosition(pos.x, pos.y, this.room.name)
        );
        const touchesOtherRoad = itsNeighbors.some(
          (n) => this.hasRoad(n.x, n.y) && (n.x !== road.pos.x || n.y !== road.pos.y)
        );

        if (touchesOtherRoad) {
          const result = this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD);
          if (result === OK) {
            placed++;
            logger.debug("SmartRoadPlanner", `Gap fill at ${pos.x},${pos.y}`);
          }
        }
      }
    }
  }

  /**
   * Fallback: static road planning (spawn→sources→controller)
   */
  private planStaticRoads(limit: number): number {
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return 0;

    let placed = 0;

    // Path to sources
    const sources = this.room.find(FIND_SOURCES);
    for (const source of sources) {
      if (placed >= limit) return placed;
      placed += this.planPath(spawn.pos, source.pos, limit - placed);
    }

    // Path to controller
    if (this.room.controller && placed < limit) {
      placed += this.planPath(spawn.pos, this.room.controller.pos, limit - placed);
    }

    // Path from sources to storage (if exists)
    if (this.room.storage && placed < limit) {
      for (const source of sources) {
        if (placed >= limit) return placed;
        placed += this.planPath(source.pos, this.room.storage.pos, limit - placed);
      }
    }

    return placed;
  }

  private planPath(from: RoomPosition, to: RoomPosition, limit: number): number {
    const path = this.room.findPath(from, to, {
      ignoreCreeps: true,
      swampCost: 2,
      plainCost: 2,
      range: 1,
    });

    let placed = 0;
    for (const step of path) {
      if (placed >= limit) break;

      // Use canPlaceRoad to check for containers and other structures
      if (!this.canPlaceRoad(this.room, step.x, step.y)) continue;

      const result = this.room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
      if (result === OK) {
        placed++;
      }
    }
    return placed;
  }

  private getAdjacentPositions(pos: RoomPosition): Array<{ x: number; y: number }> {
    const results: Array<{ x: number; y: number }> = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = pos.x + dx;
        const y = pos.y + dy;
        if (x > 0 && x < 49 && y > 0 && y < 49) {
          results.push({ x, y });
        }
      }
    }
    return results;
  }

  private hasRoad(x: number, y: number): boolean {
    return this.room
      .lookForAt(LOOK_STRUCTURES, x, y)
      .some((s) => s.structureType === STRUCTURE_ROAD);
  }

  private hasRoadOrSite(x: number, y: number): boolean {
    const hasRoad = this.room
      .lookForAt(LOOK_STRUCTURES, x, y)
      .some((s) => s.structureType === STRUCTURE_ROAD);
    const hasSite = this.room
      .lookForAt(LOOK_CONSTRUCTION_SITES, x, y)
      .some((s) => s.structureType === STRUCTURE_ROAD);
    return hasRoad || hasSite;
  }

  /**
   * Check if a road can be placed at this position without destroying important structures.
   */
  private canPlaceRoad(room: Room, x: number, y: number): boolean {
    // Boundary tiles cannot have structures
    if (x === 0 || x === 49 || y === 0 || y === 49) return false;

    // Check for existing structures we don't want to replace
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (const struct of structures) {
      // Don't place roads on containers, spawns, extensions, etc.
      if (struct.structureType === STRUCTURE_CONTAINER) return false;
      if (struct.structureType === STRUCTURE_SPAWN) return false;
      if (struct.structureType === STRUCTURE_EXTENSION) return false;
      if (struct.structureType === STRUCTURE_STORAGE) return false;
      if (struct.structureType === STRUCTURE_TOWER) return false;
      if (struct.structureType === STRUCTURE_LINK) return false;
      if (struct.structureType === STRUCTURE_TERMINAL) return false;
      if (struct.structureType === STRUCTURE_LAB) return false;
      if (struct.structureType === STRUCTURE_ROAD) return false; // Already has road
    }

    // Check for construction sites too
    const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    if (sites.length > 0) return false;

    // Check terrain
    const terrain = room.getTerrain();
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    // Check for sources (game objects, not structures)
    const sources = room.lookForAt(LOOK_SOURCES, x, y);
    if (sources.length > 0) return false;

    // Check for minerals
    const minerals = room.lookForAt(LOOK_MINERALS, x, y);
    if (minerals.length > 0) return false;

    return true;
  }

  /**
   * Plan roads toward active remote mining exits.
   * Only runs when core roads are complete.
   * Supports distance-2 remotes by routing to via room exit.
   */
  planRemoteRoutes(limit: number): number {
    // Gate: only at RCL 4+ with storage
    const rcl = this.room.controller ? this.room.controller.level : 0;
    if (rcl < 4 || !this.room.storage) return 0;

    // Gate: core roads must be complete first
    if (!this.areCoreRoadsComplete()) return 0;

    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return 0;

    // Use remote configs instead of just room names to get distance/via info
    const manager = ColonyManager.getInstance(this.room.name);
    const remoteConfigs = manager.getRemoteConfigs();

    let placed = 0;

    // Plan roads from storage to exits leading to remote rooms
    for (const remoteName in remoteConfigs) {
      if (placed >= limit) break;

      const config = remoteConfigs[remoteName];
      if (!config.active) continue;

      // For distance-2 remotes, route to via room exit; for distance-1, route to remote directly
      const routeTarget = (config.distance >= 2 && config.via) ? config.via : remoteName;
      const exitDir = this.room.findExitTo(routeTarget);
      if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) continue;

      // Find center of exit tiles
      const exitCenter = this.findExitCenter(exitDir);
      if (!exitCenter) continue;

      // Plan road from storage to exit center
      placed += this.planPath(this.room.storage.pos, exitCenter, limit - placed);
    }

    if (placed > 0) {
      logger.info("SmartRoadPlanner", `Placed ${placed} remote route road(s)`);
    }

    return placed;
  }

  /**
   * Get list of rooms currently being actively mined.
   * Based on presence of remote miners assigned to those rooms.
   */
  getActiveRemoteRooms(): string[] {
    const activeRooms = new Set<string>();

    // Look for remote miners/haulers actively working in adjacent rooms
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.room === this.room.name &&
        creep.memory.targetRoom &&
        (creep.memory.role === "REMOTE_MINER" || creep.memory.role === "REMOTE_HAULER")
      ) {
        activeRooms.add(creep.memory.targetRoom);
      }
    }

    // Also check ColonyManager for valid targets (even if no creeps yet)
    const manager = ColonyManager.getInstance(this.room.name);
    const targets = manager.getRemoteMiningTargets();
    for (const target of targets) {
      activeRooms.add(target);
    }

    return Array.from(activeRooms);
  }

  /**
   * Find the center position of exit tiles to a specific direction.
   */
  findExitCenter(exitDir: ExitConstant): RoomPosition | null {
    const exitTiles = this.room.find(exitDir);
    if (exitTiles.length === 0) return null;

    // Find the middle exit tile
    const midIndex = Math.floor(exitTiles.length / 2);
    return exitTiles[midIndex];
  }

  /**
   * Check if roads from spawn to sources and controller are complete.
   * "Complete" means >80% coverage on each path.
   */
  areCoreRoadsComplete(): boolean {
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return false;

    const sources = this.room.find(FIND_SOURCES);
    const controller = this.room.controller;

    // Check spawn-to-source paths
    for (const source of sources) {
      const coverage = this.getPathRoadCoverage(spawn.pos, source.pos);
      if (coverage < 0.8) return false;
    }

    // Check spawn-to-controller path
    if (controller) {
      const coverage = this.getPathRoadCoverage(spawn.pos, controller.pos);
      if (coverage < 0.8) return false;
    }

    return true;
  }

  /**
   * Calculate the percentage of a path that has roads.
   */
  private getPathRoadCoverage(from: RoomPosition, to: RoomPosition): number {
    const path = this.room.findPath(from, to, {
      ignoreCreeps: true,
      swampCost: 2,
      plainCost: 2,
      range: 1,
    });

    if (path.length === 0) return 1; // No path = assume complete

    let roadsOnPath = 0;
    for (const step of path) {
      if (this.hasRoad(step.x, step.y)) {
        roadsOnPath++;
      }
    }

    return roadsOnPath / path.length;
  }

  /**
   * Plan roads from room exit to remote sources.
   * Only builds in rooms with active reservation (to prevent rapid decay).
   * Supports both distance-1 (adjacent) and distance-2 remote rooms.
   */
  planRemoteRoads(limit: number): number {
    // Gate: only at RCL 4+
    const rcl = this.room.controller ? this.room.controller.level : 0;
    if (rcl < 4) return 0;

    const spawns = Object.values(Game.spawns);
    const myUsername = spawns.length > 0 && spawns[0].owner ? spawns[0].owner.username : null;
    if (!myUsername) return 0;

    const homeRoom = this.room.name;
    let placed = 0;

    // Get remote configs to know which rooms are active
    const manager = ColonyManager.getInstance(this.room.name);
    const remoteConfigs = manager.getRemoteConfigs();

    // Phase 1: Distance-1 (adjacent) rooms - use describeExits
    const exits = Game.map.describeExits(homeRoom);
    if (exits) {
      for (const dir in exits) {
        if (placed >= limit) break;

        const roomName = exits[dir as ExitKey];
        if (!roomName) continue;

        // Check if this is an active remote
        const config = remoteConfigs[roomName];
        if (!config || !config.active) continue;

        const room = Game.rooms[roomName];
        if (!room) continue; // No visibility

        // Only build roads in reserved rooms (otherwise they decay too fast)
        const reservation = room.controller && room.controller.reservation;
        if (!reservation || reservation.username !== myUsername) continue;

        // Find the exit tiles back to home room
        const exitDir = this.reverseDirection(dir);
        const exitPositions = room.find(exitDir as FindConstant) as RoomPosition[];
        if (exitPositions.length === 0) continue;

        // Use center of exit as reference point
        const exitCenter = exitPositions[Math.floor(exitPositions.length / 2)];

        placed += this.planRoadsToSources(room, exitCenter, limit - placed);
      }
    }

    // Phase 2: Distance-2+ rooms - iterate remote configs directly
    for (const remoteName in remoteConfigs) {
      if (placed >= limit) break;

      const config = remoteConfigs[remoteName];
      if (!config.active || config.distance < 2 || !config.via) continue;

      const room = Game.rooms[remoteName];
      if (!room) continue; // No visibility

      // Only build roads in reserved rooms
      const reservation = room.controller && room.controller.reservation;
      if (!reservation || reservation.username !== myUsername) continue;

      // For distance-2 rooms, find exit toward via room (which leads back home)
      const exitDir = room.findExitTo(config.via);
      if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) continue;

      const exitPositions = room.find(exitDir) as RoomPosition[];
      if (exitPositions.length === 0) continue;

      const exitCenter = exitPositions[Math.floor(exitPositions.length / 2)];

      placed += this.planRoadsToSources(room, exitCenter, limit - placed);
    }

    if (placed > 0) {
      logger.info("SmartRoadPlanner", `Placed ${placed} remote road(s)`);
    }

    return placed;
  }

  /**
   * Plan roads from an exit point to all mined sources in a room.
   * Helper method for planRemoteRoads.
   */
  private planRoadsToSources(room: Room, exitCenter: RoomPosition, limit: number): number {
    let placed = 0;

    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      if (placed >= limit) break;

      // Check if we have a miner on this source
      let hasMiner = false;
      for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (c.memory.role === "REMOTE_MINER" && c.memory.sourceId === source.id) {
          hasMiner = true;
          break;
        }
      }
      if (!hasMiner) continue;

      // Find container near source (if exists)
      const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: (s: Structure) => s.structureType === STRUCTURE_CONTAINER,
      });
      const container = containers.length > 0 ? containers[0] : null;

      const target = container ? container.pos : source.pos;

      // Get path from exit to source/container
      const path = room.findPath(exitCenter, target, {
        ignoreCreeps: true,
        swampCost: 2,
        plainCost: 1,
      });

      // Place road construction sites along path
      for (const step of path) {
        if (placed >= limit) break;

        // Use canPlaceRoad to check for containers and other structures
        if (!this.canPlaceRoad(room, step.x, step.y)) continue;

        // Check global construction site limit
        const totalSites = Object.keys(Game.constructionSites).length;
        if (totalSites >= 100) return placed;

        const result = room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        if (result === OK) {
          placed++;
        }
      }
    }

    return placed;
  }

  /**
   * Plan roads through via (intermediate) rooms for distance-2 remotes.
   * Routes from home-side exit to far-side exit through the via room.
   */
  planViaRoomRoads(limit: number): number {
    // Gate: only at RCL 4+
    const rcl = this.room.controller ? this.room.controller.level : 0;
    if (rcl < 4) return 0;

    const spawns = Object.values(Game.spawns);
    const myUsername = spawns.length > 0 && spawns[0].owner ? spawns[0].owner.username : null;
    if (!myUsername) return 0;

    const homeRoom = this.room.name;
    let placed = 0;

    // Get remote configs to find distance-2 remotes with via rooms
    const manager = ColonyManager.getInstance(this.room.name);
    const remoteConfigs = manager.getRemoteConfigs();

    // Track which via rooms we've already processed (avoid duplicates)
    const processedViaRooms = new Set<string>();

    for (const remoteName in remoteConfigs) {
      if (placed >= limit) break;

      const config = remoteConfigs[remoteName];
      if (!config.active || config.distance < 2 || !config.via) continue;

      const viaRoomName = config.via;

      // Skip if we already processed this via room
      if (processedViaRooms.has(viaRoomName)) continue;
      processedViaRooms.add(viaRoomName);

      const viaRoom = Game.rooms[viaRoomName];
      if (!viaRoom) continue; // No visibility

      // Only build roads in reserved rooms (or rooms we own)
      const isOwned = viaRoom.controller && viaRoom.controller.my;
      const reservation = viaRoom.controller && viaRoom.controller.reservation;
      const isReserved = reservation && reservation.username === myUsername;
      if (!isOwned && !isReserved) continue;

      // Find entry exit (from home room side)
      const entryExitDir = viaRoom.findExitTo(homeRoom);
      if (entryExitDir === ERR_NO_PATH || entryExitDir === ERR_INVALID_ARGS) continue;

      const entryExitPositions = viaRoom.find(entryExitDir) as RoomPosition[];
      if (entryExitPositions.length === 0) continue;
      const entryCenter = entryExitPositions[Math.floor(entryExitPositions.length / 2)];

      // Find far exit (toward the target remote room)
      const farExitDir = viaRoom.findExitTo(remoteName);
      if (farExitDir === ERR_NO_PATH || farExitDir === ERR_INVALID_ARGS) continue;

      const farExitPositions = viaRoom.find(farExitDir) as RoomPosition[];
      if (farExitPositions.length === 0) continue;
      const farCenter = farExitPositions[Math.floor(farExitPositions.length / 2)];

      // Plan road from entry exit to far exit
      const path = viaRoom.findPath(entryCenter, farCenter, {
        ignoreCreeps: true,
        swampCost: 2,
        plainCost: 1,
      });

      for (const step of path) {
        if (placed >= limit) break;

        if (!this.canPlaceRoad(viaRoom, step.x, step.y)) continue;

        // Check global construction site limit
        const totalSites = Object.keys(Game.constructionSites).length;
        if (totalSites >= 100) return placed;

        const result = viaRoom.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        if (result === OK) {
          placed++;
        }
      }
    }

    if (placed > 0) {
      logger.info("SmartRoadPlanner", `Placed ${placed} via room transit road(s)`);
    }

    return placed;
  }

  /**
   * Convert exit direction to opposite direction for finding exit back.
   */
  private reverseDirection(dir: string): FindConstant {
    const map: Record<string, FindConstant> = {
      "1": FIND_EXIT_BOTTOM, // TOP -> BOTTOM
      "3": FIND_EXIT_LEFT, // RIGHT -> LEFT
      "5": FIND_EXIT_TOP, // BOTTOM -> TOP
      "7": FIND_EXIT_RIGHT, // LEFT -> RIGHT
    };
    return map[dir] || FIND_EXIT_TOP;
  }
}
