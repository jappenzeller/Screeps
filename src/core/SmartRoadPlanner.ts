/**
 * SmartRoadPlanner - Analyzes traffic data and places roads intelligently.
 * Falls back to static planning when no traffic data is available.
 */

import { TrafficMonitor } from "./TrafficMonitor";
import { logger } from "../utils/Logger";

// Configuration
const MIN_VISITS_FOR_ROAD = 200; // Minimum traffic to build a road
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
}
