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

    // Limit concurrent road sites
    const existingSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    }).length;

    if (existingSites >= MAX_CONCURRENT_ROAD_SITES) return;

    // Get hotspots from traffic data
    const hotspots = this.monitor.getHotspots(10);

    if (hotspots.length === 0 || hotspots[0].visits < MIN_VISITS_FOR_ROAD) {
      // Fallback to static planning if no traffic data yet
      this.planStaticRoads(MAX_CONCURRENT_ROAD_SITES - existingSites);
      return;
    }

    // Build roads at highest-traffic tiles first
    let placed = 0;
    const maxToPlace = MAX_CONCURRENT_ROAD_SITES - existingSites;

    for (const spot of hotspots) {
      if (placed >= maxToPlace) break;

      // Only build if truly high traffic
      if (spot.visits < MIN_VISITS_FOR_ROAD) continue;

      const result = this.room.createConstructionSite(spot.x, spot.y, STRUCTURE_ROAD);
      if (result === OK) {
        placed++;
        logger.info("SmartRoadPlanner", `Road at ${spot.x},${spot.y} (${spot.visits} visits)`);

        // Record that we built this
        if (Memory.traffic?.[this.room.name]) {
          Memory.traffic[this.room.name].roadsBuilt.push(`${spot.x}:${spot.y}`);
        }
      }
    }

    // If we still have budget and hotspots weren't enough, fill gaps
    if (placed < maxToPlace && placed > 0) {
      this.fillRoadGaps(maxToPlace - placed);
    }

    // Plan remote routes if we have budget remaining
    const remaining = MAX_CONCURRENT_ROAD_SITES - existingSites - placed;
    if (remaining > 0) {
      this.planRemoteRoutes(remaining);
    }
  }

  private shouldPlanRoads(): boolean {
    const rcl = this.room.controller?.level || 0;
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
        if (this.hasRoadOrSite(pos.x, pos.y)) continue;
        if (this.room.getTerrain().get(pos.x, pos.y) === TERRAIN_MASK_WALL) continue;

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
  private planStaticRoads(limit: number): void {
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return;

    let placed = 0;

    // Path to sources
    const sources = this.room.find(FIND_SOURCES);
    for (const source of sources) {
      if (placed >= limit) return;
      placed += this.planPath(spawn.pos, source.pos, limit - placed);
    }

    // Path to controller
    if (this.room.controller && placed < limit) {
      placed += this.planPath(spawn.pos, this.room.controller.pos, limit - placed);
    }

    // Path from sources to storage (if exists)
    if (this.room.storage && placed < limit) {
      for (const source of sources) {
        if (placed >= limit) return;
        placed += this.planPath(source.pos, this.room.storage.pos, limit - placed);
      }
    }
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
      if (this.hasRoadOrSite(step.x, step.y)) continue;

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
   * Plan roads toward active remote mining exits.
   * Only runs when core roads are complete.
   */
  planRemoteRoutes(limit: number): number {
    // Gate: only at RCL 4+ with storage
    const rcl = this.room.controller?.level || 0;
    if (rcl < 4 || !this.room.storage) return 0;

    // Gate: core roads must be complete first
    if (!this.areCoreRoadsComplete()) return 0;

    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return 0;

    const remoteRooms = this.getActiveRemoteRooms();
    if (remoteRooms.length === 0) return 0;

    let placed = 0;

    // Plan roads from storage to exits leading to remote rooms
    for (const targetRoom of remoteRooms) {
      if (placed >= limit) break;

      const exitDir = this.room.findExitTo(targetRoom);
      if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) continue;

      // Find center of exit tiles
      const exitCenter = this.findExitCenter(exitDir);
      if (!exitCenter) continue;

      // Plan road from storage to exit center
      placed += this.planPath(this.room.storage!.pos, exitCenter, limit - placed);
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
}
