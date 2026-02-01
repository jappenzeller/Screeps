/**
 * SpawnPlacementCalculator - Finds optimal spawn position
 * Per empire-architecture.md: "Scoring functions over hardcoded decisions"
 */

interface SpawnCandidate {
  pos: RoomPosition;
  score: number;
  components: {
    sourceDistance: number;
    openSpace: number;
    exitDistance: number;
    controllerDistance: number;
    terrain: number;
    centroid: number;
  };
}

export interface PlacementResult {
  pos: RoomPosition | null;
  score: number;
  candidates: number;
  reason: string;
}

export class SpawnPlacementCalculator {
  private room: Room;
  private terrain: RoomTerrain;
  private sources: Source[];
  private controller: StructureController | undefined;

  // Weights from architecture principle: scoring functions
  private readonly WEIGHTS = {
    sourceDistance: 0.25,
    openSpace: 0.25,
    exitDistance: 0.2,
    controllerDistance: 0.15,
    terrain: 0.1,
    centroid: 0.05,
  };

  constructor(room: Room) {
    this.room = room;
    this.terrain = room.getTerrain();
    this.sources = room.find(FIND_SOURCES);
    this.controller = room.controller;
  }

  /**
   * Calculate optimal spawn position
   */
  calculate(): PlacementResult {
    const candidates: SpawnCandidate[] = [];

    // Scan valid positions (avoid edges)
    for (let x = 4; x <= 45; x++) {
      for (let y = 4; y <= 45; y++) {
        if (this.terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        const pos = new RoomPosition(x, y, this.room.name);
        const result = this.scorePosition(pos);

        if (result) {
          candidates.push(result);
        }
      }
    }

    if (candidates.length === 0) {
      return { pos: null, score: 0, candidates: 0, reason: "No valid positions" };
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    console.log(`[SpawnPlacement] Best: ${best.pos} (score: ${best.score.toFixed(1)})`);
    console.log(
      `[SpawnPlacement] Components: src=${best.components.sourceDistance.toFixed(0)}, ` +
        `space=${best.components.openSpace.toFixed(0)}, exit=${best.components.exitDistance.toFixed(0)}, ` +
        `ctrl=${best.components.controllerDistance.toFixed(0)}`
    );

    return {
      pos: best.pos,
      score: best.score,
      candidates: candidates.length,
      reason: "Found optimal position",
    };
  }

  /**
   * Score a position - returns null if disqualified
   */
  private scorePosition(pos: RoomPosition): SpawnCandidate | null {
    // === HARD DISQUALIFIERS ===

    // Must have enough open space (5x5 needs 15+ walkable)
    const openTiles = this.countOpenTiles(pos, 2);
    if (openTiles < 15) return null;

    // Must be 4+ from any exit
    const exitDist = this.getMinExitDistance(pos);
    if (exitDist < 4) return null;

    // Must not be adjacent to source (within 2 tiles)
    for (const source of this.sources) {
      if (pos.getRangeTo(source) <= 2) return null;
    }

    // === COMPONENT SCORES (0-100 each) ===
    const components = {
      sourceDistance: this.scoreSourceDistance(pos),
      openSpace: this.scoreOpenSpace(openTiles),
      exitDistance: this.scoreExitDistance(exitDist),
      controllerDistance: this.scoreControllerDistance(pos),
      terrain: this.scoreTerrainQuality(pos),
      centroid: this.scoreCentroid(pos),
    };

    // Weighted total
    const score =
      components.sourceDistance * this.WEIGHTS.sourceDistance +
      components.openSpace * this.WEIGHTS.openSpace +
      components.exitDistance * this.WEIGHTS.exitDistance +
      components.controllerDistance * this.WEIGHTS.controllerDistance +
      components.terrain * this.WEIGHTS.terrain +
      components.centroid * this.WEIGHTS.centroid;

    return { pos, score, components };
  }

  private scoreSourceDistance(pos: RoomPosition): number {
    if (this.sources.length === 0) return 50;
    const avgDist =
      this.sources.reduce((sum, s) => sum + pos.getRangeTo(s), 0) / this.sources.length;
    // Ideal: 4-6 range
    if (avgDist >= 4 && avgDist <= 6) return 100;
    if (avgDist < 4) return Math.max(0, 100 - (4 - avgDist) * 25);
    return Math.max(0, 100 - (avgDist - 6) * 10);
  }

  private scoreOpenSpace(openTiles: number): number {
    // 15 minimum, 25 ideal
    return Math.min(100, (openTiles - 15) * 10 + 50);
  }

  private scoreExitDistance(dist: number): number {
    // 4 minimum, 10+ ideal
    return Math.min(100, (dist - 4) * 15 + 20);
  }

  private scoreControllerDistance(pos: RoomPosition): number {
    if (!this.controller) return 50;
    const dist = pos.getRangeTo(this.controller);
    // Ideal: 5-8 range
    if (dist >= 5 && dist <= 8) return 100;
    if (dist < 5) return Math.max(0, 100 - (5 - dist) * 20);
    return Math.max(0, 100 - (dist - 8) * 8);
  }

  private scoreTerrainQuality(pos: RoomPosition): number {
    const swamps = this.countSwamps(pos, 3);
    return Math.max(0, 100 - swamps * 10);
  }

  private scoreCentroid(pos: RoomPosition): number {
    const centerDist = Math.abs(pos.x - 25) + Math.abs(pos.y - 25);
    return Math.max(0, 100 - centerDist * 2);
  }

  private countOpenTiles(center: RoomPosition, radius: number): number {
    let count = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = center.x + dx;
        const y = center.y + dy;
        if (x < 0 || x > 49 || y < 0 || y > 49) continue;
        if (this.terrain.get(x, y) !== TERRAIN_MASK_WALL) count++;
      }
    }
    return count;
  }

  private getMinExitDistance(pos: RoomPosition): number {
    return Math.min(pos.x, pos.y, 49 - pos.x, 49 - pos.y);
  }

  private countSwamps(center: RoomPosition, radius: number): number {
    let count = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = center.x + dx;
        const y = center.y + dy;
        if (x < 0 || x > 49 || y < 0 || y > 49) continue;
        if (this.terrain.get(x, y) === TERRAIN_MASK_SWAMP) count++;
      }
    }
    return count;
  }
}
