/**
 * TrafficMonitor - Tracks creep movement on UNROADED tiles only.
 * This captures "desire paths" - where creeps want to walk but no road exists.
 * Once a road is built, that tile stops being tracked (self-correcting feedback).
 */

import { logger } from "../utils/Logger";

// Configuration - lower thresholds since we only track unroaded tiles
const DEFAULT_WINDOW_SIZE = 1000; // Ticks per measurement window
const DECAY_FACTOR = 0.5; // How much to keep on window reset
const MIN_VISITS_TO_KEEP = 5; // Minimum visits to keep after decay
const HIGH_TRAFFIC_THRESHOLD = 75; // Visits to trigger road suggestion (was 300)

export class TrafficMonitor {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
    this.initMemory();
  }

  private initMemory(): void {
    Memory.traffic ??= {};
    Memory.traffic[this.room.name] ??= {
      heatmap: {},
      lastReset: Game.time,
      windowSize: DEFAULT_WINDOW_SIZE,
      roadsSuggested: [],
      roadsBuilt: [],
    };
  }

  private get mem(): TrafficMemory {
    return Memory.traffic![this.room.name];
  }

  /**
   * Call once per tick to record creep positions on UNROADED tiles only.
   * This inverts the signal: high count = desire path = build road here.
   */
  recordTick(): void {
    // Reset window if expired
    if (Game.time - this.mem.lastReset > this.mem.windowSize) {
      this.resetWindow();
    }

    // Record each creep's position (only on unroaded tiles)
    const creeps = this.room.find(FIND_MY_CREEPS);
    for (const creep of creeps) {
      // Skip stationary creeps (at work positions)
      if (this.isStationary(creep)) continue;

      const x = creep.pos.x;
      const y = creep.pos.y;

      // ONLY track unroaded tiles - this IS the signal
      if (this.hasRoad(x, y)) continue;

      // Skip walls (shouldn't happen but defensive)
      if (this.room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) continue;

      const key = `${x}:${y}`;
      this.mem.heatmap[key] = (this.mem.heatmap[key] || 0) + 1;
    }
  }

  /**
   * Check if creep is at a stationary work position (shouldn't count as traffic)
   */
  private isStationary(creep: Creep): boolean {
    // Harvester at container
    if (creep.memory.role === "HARVESTER") {
      const atContainer =
        creep.pos.findInRange(FIND_STRUCTURES, 0, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        }).length > 0;
      if (atContainer) return true;
    }

    // Upgrader at controller (within range 3)
    if (creep.memory.role === "UPGRADER" && this.room.controller) {
      if (creep.pos.inRangeTo(this.room.controller.pos, 3)) return true;
    }

    // Any creep standing on storage
    if (this.room.storage && creep.pos.isEqualTo(this.room.storage.pos)) {
      return true;
    }

    // Any creep standing on a container (haulers loading/unloading)
    const onContainer =
      creep.pos.findInRange(FIND_STRUCTURES, 0, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }).length > 0;
    if (onContainer) return true;

    return false;
  }

  private resetWindow(): void {
    // Before clearing, analyze and generate suggestions
    this.analyzeWindow();

    // Decay instead of full reset (keeps history)
    for (const key in this.mem.heatmap) {
      this.mem.heatmap[key] = Math.floor(this.mem.heatmap[key] * DECAY_FACTOR);
      if (this.mem.heatmap[key] < MIN_VISITS_TO_KEEP) {
        delete this.mem.heatmap[key];
      }
    }

    this.mem.lastReset = Game.time;
  }

  private analyzeWindow(): void {
    const suggestions: string[] = [];

    for (const key in this.mem.heatmap) {
      const visits = this.mem.heatmap[key];
      const [x, y] = key.split(":").map(Number);

      // Skip if road was built since we recorded this
      if (this.hasRoad(x, y)) continue;

      // Skip terrain walls
      if (this.room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) continue;

      // High traffic threshold
      if (visits >= HIGH_TRAFFIC_THRESHOLD) {
        suggestions.push(key);
      }
    }

    this.mem.roadsSuggested = suggestions;

    if (suggestions.length > 0) {
      logger.info("TrafficMonitor", `${this.room.name}: ${suggestions.length} road candidates (desire paths)`);
    }
  }

  private hasRoad(x: number, y: number): boolean {
    const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
    const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);

    return (
      structures.some((s) => s.structureType === STRUCTURE_ROAD) ||
      sites.some((s) => s.structureType === STRUCTURE_ROAD)
    );
  }

  /**
   * Get top N highest-traffic unroaded tiles
   */
  getHotspots(limit: number = 10): Array<{ x: number; y: number; visits: number }> {
    const results: Array<{ x: number; y: number; visits: number }> = [];

    for (const key in this.mem.heatmap) {
      const [x, y] = key.split(":").map(Number);

      // Skip if road was built since we recorded this
      if (this.hasRoad(x, y)) continue;

      // Skip walls (shouldn't happen but defensive)
      if (this.room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) continue;

      results.push({ x, y, visits: this.mem.heatmap[key] });
    }

    return results.sort((a, b) => b.visits - a.visits).slice(0, limit);
  }

  /**
   * Get suggested road positions
   */
  getSuggestedRoads(): string[] {
    return this.mem.roadsSuggested;
  }

  /**
   * Get traffic stats for a room
   */
  getStats(): {
    trackedTiles: number;
    highTrafficTiles: number;
    suggestedRoads: number;
    windowProgress: number;
  } {
    const highTrafficTiles = Object.values(this.mem.heatmap).filter(
      (v) => v >= HIGH_TRAFFIC_THRESHOLD
    ).length;

    return {
      trackedTiles: Object.keys(this.mem.heatmap).length,
      highTrafficTiles,
      suggestedRoads: this.mem.roadsSuggested.length,
      windowProgress: Game.time - this.mem.lastReset,
    };
  }

  /**
   * Visualize heatmap (call for debugging)
   */
  visualize(): void {
    const visual = this.room.visual;

    let maxVisits = 0;
    for (const key in this.mem.heatmap) {
      maxVisits = Math.max(maxVisits, this.mem.heatmap[key]);
    }

    if (maxVisits === 0) return;

    for (const key in this.mem.heatmap) {
      const [x, y] = key.split(":").map(Number);
      const visits = this.mem.heatmap[key];

      // Skip tiles that now have roads
      if (this.hasRoad(x, y)) continue;

      const intensity = visits / maxVisits;

      // Color from green (low) to red (high)
      const r = Math.floor(255 * intensity);
      const g = Math.floor(255 * (1 - intensity));
      const color = `rgb(${r},${g},0)`;

      visual.rect(x - 0.5, y - 0.5, 1, 1, {
        fill: color,
        opacity: 0.3 + intensity * 0.4,
      });

      // Show visit count for high-traffic tiles
      if (visits >= HIGH_TRAFFIC_THRESHOLD) {
        visual.text(String(visits), x, y + 0.25, {
          font: 0.4,
          color: "#ffffff",
        });
      }
    }
  }

  /**
   * Clear all traffic data for this room
   */
  clear(): void {
    this.mem.heatmap = {};
    this.mem.lastReset = Game.time;
    this.mem.roadsSuggested = [];
  }
}
