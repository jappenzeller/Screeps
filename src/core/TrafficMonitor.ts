/**
 * TrafficMonitor - Tracks creep movement to identify high-traffic tiles for road placement.
 * Records position visits in a heatmap that decays over time.
 */

import { logger } from "../utils/Logger";

// Configuration
const DEFAULT_WINDOW_SIZE = 1000; // Ticks per measurement window
const DECAY_FACTOR = 0.5; // How much to keep on window reset
const MIN_VISITS_TO_KEEP = 10; // Minimum visits to keep after decay
const HIGH_TRAFFIC_THRESHOLD = 300; // Visits to trigger road suggestion

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
   * Call once per tick to record all creep positions in the room
   */
  recordTick(): void {
    // Reset window if expired
    if (Game.time - this.mem.lastReset > this.mem.windowSize) {
      this.resetWindow();
    }

    // Record each creep's position
    const creeps = this.room.find(FIND_MY_CREEPS);
    for (const creep of creeps) {
      // Skip stationary creeps (harvesters at container)
      if (creep.memory.role === "HARVESTER" && this.isAtWorkPosition(creep)) {
        continue;
      }

      const key = `${creep.pos.x}:${creep.pos.y}`;
      this.mem.heatmap[key] = (this.mem.heatmap[key] || 0) + 1;
    }
  }

  private isAtWorkPosition(creep: Creep): boolean {
    // Stationary if at assigned source container
    const container = creep.pos.findInRange(FIND_STRUCTURES, 0, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    })[0];
    return !!container;
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

      // Skip if road already exists
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
      logger.info("TrafficMonitor", `${this.room.name}: ${suggestions.length} road candidates`);
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
   * Get top N highest-traffic tiles without roads
   */
  getHotspots(limit: number = 10): Array<{ x: number; y: number; visits: number }> {
    const results: Array<{ x: number; y: number; visits: number }> = [];

    for (const key in this.mem.heatmap) {
      const [x, y] = key.split(":").map(Number);
      if (this.hasRoad(x, y)) continue;
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
