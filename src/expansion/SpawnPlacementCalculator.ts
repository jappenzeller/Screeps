/**
 * SpawnPlacementCalculator - Determines optimal spawn position in newly claimed room
 * All other base planning derives from this foundational placement.
 */

interface SpawnPlacementResult {
  pos: { x: number; y: number };
  score: number;
  reasoning: string[];
}

interface PositionScore {
  x: number;
  y: number;
  total: number;
  components: {
    sourceDistance: number;
    controllerDistance: number;
    exitDistance: number;
    openSpace: number;
    terrainQuality: number;
    centroidBonus: number;
  };
}

const WEIGHTS = {
  sourceDistance: 0.25, // 25% - economy critical
  controllerDistance: 0.15, // 15% - upgrading efficiency
  exitDistance: 0.2, // 20% - defense important
  openSpace: 0.25, // 25% - base layout critical
  terrainQuality: 0.1, // 10% - nice to have
  centroidBonus: 0.05, // 5% - tiebreaker
};

export class SpawnPlacementCalculator {
  private room: Room;
  private terrain: RoomTerrain;
  private sources: Source[];
  private controller: StructureController;

  constructor(room: Room) {
    this.room = room;
    this.terrain = room.getTerrain();
    this.sources = room.find(FIND_SOURCES);
    this.controller = room.controller!;
  }

  /**
   * Calculate optimal spawn position
   * Call this after claiming, before placing construction site
   */
  calculate(): SpawnPlacementResult {
    const candidates: PositionScore[] = [];

    // Scan all valid positions (avoid edges, walls)
    for (let x = 4; x <= 45; x++) {
      for (let y = 4; y <= 45; y++) {
        if (this.terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        const score = this.scorePosition(x, y);
        if (score.total > 0) {
          candidates.push(score);
        }
      }
    }

    // Sort by total score descending
    candidates.sort((a, b) => b.total - a.total);

    const best = candidates[0];
    if (!best) {
      // Fallback to room center if no valid positions found
      return {
        pos: { x: 25, y: 25 },
        score: 0,
        reasoning: ["No valid positions found, using room center fallback"],
      };
    }

    return {
      pos: { x: best.x, y: best.y },
      score: best.total,
      reasoning: this.explainScore(best),
    };
  }

  private scorePosition(x: number, y: number): PositionScore {
    const pos = new RoomPosition(x, y, this.room.name);

    // Source distance: average distance to all sources
    // Ideal: 4-6 range (close but room for mining infrastructure)
    const sourceDistances = this.sources.map((s) => pos.getRangeTo(s));
    const avgSourceDist =
      sourceDistances.length > 0
        ? sourceDistances.reduce((a, b) => a + b, 0) / sourceDistances.length
        : 25;
    const sourceScore = this.scoreDistance(avgSourceDist, 5, 3, 10);

    // Controller distance: ideal 5-8 range
    const controllerDist = pos.getRangeTo(this.controller);
    const controllerScore = this.scoreDistance(controllerDist, 6, 4, 12);

    // Exit distance: minimum distance to any exit
    const exitDist = this.getMinExitDistance(x, y);
    const exitScore = Math.min(100, exitDist * 10); // Further = better, cap at 100

    // Open space: count walkable tiles in 5x5 area around position
    const openTiles = this.countOpenTiles(x, y, 5);
    const openScore = (openTiles / 25) * 100; // 25 tiles max in 5x5

    // Terrain quality: count swamps in 7x7 area (larger for base footprint)
    const swampCount = this.countSwamps(x, y, 7);
    const terrainScore = Math.max(0, 100 - swampCount * 5);

    // Centroid bonus: distance from room center (25, 25)
    const centerDist = Math.sqrt(Math.pow(x - 25, 2) + Math.pow(y - 25, 2));
    const centroidScore = Math.max(0, 100 - centerDist * 3);

    // Check for hard disqualifiers
    if (openTiles < 15) return this.zeroScore(x, y); // Not enough space
    if (exitDist < 4) return this.zeroScore(x, y); // Too close to exit
    if (this.hasAdjacentSource(x, y)) return this.zeroScore(x, y); // Blocks mining

    const components = {
      sourceDistance: sourceScore,
      controllerDistance: controllerScore,
      exitDistance: exitScore,
      openSpace: openScore,
      terrainQuality: terrainScore,
      centroidBonus: centroidScore,
    };

    const total =
      components.sourceDistance * WEIGHTS.sourceDistance +
      components.controllerDistance * WEIGHTS.controllerDistance +
      components.exitDistance * WEIGHTS.exitDistance +
      components.openSpace * WEIGHTS.openSpace +
      components.terrainQuality * WEIGHTS.terrainQuality +
      components.centroidBonus * WEIGHTS.centroidBonus;

    return { x, y, total, components };
  }

  /**
   * Score a distance value based on ideal range
   * Returns 100 at ideal, decreasing as distance moves away
   */
  private scoreDistance(actual: number, ideal: number, min: number, max: number): number {
    if (actual < min || actual > max) return 0;
    const deviation = Math.abs(actual - ideal);
    const maxDeviation = Math.max(ideal - min, max - ideal);
    return Math.max(0, 100 - (deviation / maxDeviation) * 100);
  }

  private getMinExitDistance(x: number, y: number): number {
    // Distance to nearest room edge
    return Math.min(x, y, 49 - x, 49 - y);
  }

  private countOpenTiles(cx: number, cy: number, radius: number): number {
    let count = 0;
    const half = Math.floor(radius / 2);
    for (let dx = -half; dx <= half; dx++) {
      for (let dy = -half; dy <= half; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x > 49 || y < 0 || y > 49) continue;
        if (this.terrain.get(x, y) !== TERRAIN_MASK_WALL) count++;
      }
    }
    return count;
  }

  private countSwamps(cx: number, cy: number, radius: number): number {
    let count = 0;
    const half = Math.floor(radius / 2);
    for (let dx = -half; dx <= half; dx++) {
      for (let dy = -half; dy <= half; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x > 49 || y < 0 || y > 49) continue;
        if (this.terrain.get(x, y) === TERRAIN_MASK_SWAMP) count++;
      }
    }
    return count;
  }

  private hasAdjacentSource(x: number, y: number): boolean {
    for (const source of this.sources) {
      if (Math.abs(source.pos.x - x) <= 2 && Math.abs(source.pos.y - y) <= 2) {
        return true;
      }
    }
    return false;
  }

  private zeroScore(x: number, y: number): PositionScore {
    return {
      x,
      y,
      total: 0,
      components: {
        sourceDistance: 0,
        controllerDistance: 0,
        exitDistance: 0,
        openSpace: 0,
        terrainQuality: 0,
        centroidBonus: 0,
      },
    };
  }

  private explainScore(score: PositionScore): string[] {
    const reasons: string[] = [];
    const c = score.components;

    if (c.sourceDistance >= 80) reasons.push("Optimal source distance");
    else if (c.sourceDistance >= 50) reasons.push("Acceptable source distance");

    if (c.openSpace >= 80) reasons.push("Excellent build space");
    else if (c.openSpace >= 60) reasons.push("Adequate build space");

    if (c.exitDistance >= 60) reasons.push("Good defensive distance from exits");

    if (c.terrainQuality >= 80) reasons.push("Minimal swamp terrain");

    if (c.controllerDistance >= 60) reasons.push("Good controller proximity");

    return reasons;
  }
}
