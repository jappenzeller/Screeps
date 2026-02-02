/**
 * RoomEvaluator - Scores rooms for expansion viability
 * Uses Memory.intel (populated by Scout.ts) to rank candidates
 *
 * Memory.intel stores RoomIntel objects with comprehensive data:
 * - sources: { id, pos }[]
 * - mineral: { type, amount, id, pos }
 * - terrain: { swampPercent, wallPercent, plainPercent }
 * - roomType: "normal" | "sourceKeeper" | "center" | "highway"
 * - owner, reservation, hostileStructures, etc.
 */

export interface RoomScore {
  roomName: string;
  totalScore: number;
  viable: boolean;
  blockers: string[];

  // Component scores (0-100)
  economic: number;
  strategic: number;
  defensive: number;

  // Details for debugging
  details: {
    sources: number;
    mineral: MineralConstant | null;
    mineralValue: number;
    swampPercent: number;
    wallPercent: number;
    distanceFromParent: number;
    distanceFromEnemies: number;
    remotePotential: number;
  };
}

// Simplified internal format for scoring
interface ScoutedRoom {
  sources: number;
  mineral: MineralConstant | null;
  controller: boolean;
  owner: string | null;
  reserved: string | null;
  roomType: string;
  hasKeepers: boolean;
  hasInvaderCore: boolean;
  swampPercent: number;
  wallPercent: number;
  scannedAt: number;
  distance?: number;
}

// Mineral values for diversity scoring (higher = more valuable)
const MINERAL_VALUES: Record<string, number> = {
  X: 100, // Catalyst - rare, needed for all T3 boosts
  H: 60, // Common but essential
  O: 60,
  U: 50,
  L: 50,
  K: 50,
  Z: 50,
};

export class RoomEvaluator {
  private myRooms: string[];
  private myMinerals: Set<MineralConstant>;
  private enemyRooms: Set<string>;
  private scoutData: Record<string, ScoutedRoom>;
  private myUsername: string;

  constructor() {
    // Get our username
    this.myUsername = Object.values(Game.spawns)[0]?.owner?.username || "unknown";

    // Get our owned rooms
    this.myRooms = Object.keys(Game.rooms).filter((r) => Game.rooms[r].controller?.my);

    // Get minerals we already have
    this.myMinerals = new Set();
    for (const roomName of this.myRooms) {
      const room = Game.rooms[roomName];
      const mineral = room.find(FIND_MINERALS)[0];
      if (mineral) {
        this.myMinerals.add(mineral.mineralType);
      }
    }

    // Build enemy room set from scouted data
    // Scout data is stored in Memory.intel by Scout.ts
    this.enemyRooms = new Set();
    const rawIntel = Memory.intel || {};
    this.scoutData = {};

    // Transform RoomIntel format to ScoutedRoom format
    for (const [roomName, intel] of Object.entries(rawIntel)) {
      const ri = intel as RoomIntel;
      this.scoutData[roomName] = {
        sources: ri.sources?.length || 0,
        mineral: ri.mineral?.type || null,
        controller: ri.roomType === "normal",
        owner: ri.owner,
        reserved: ri.reservation?.username || null,
        roomType: ri.roomType,
        hasKeepers: ri.roomType === "sourceKeeper",
        hasInvaderCore: ri.invaderCore || false,
        swampPercent: ri.terrain?.swampPercent || 0,
        wallPercent: ri.terrain?.wallPercent || 0,
        scannedAt: ri.lastScanned || 0,
        distance: ri.distanceFromHome,
      };

      if (ri.owner && ri.owner !== this.myUsername) {
        this.enemyRooms.add(roomName);
      }
    }
  }

  /**
   * Get all viable expansion candidates, ranked by score
   */
  rankCandidates(maxResults: number = 10): RoomScore[] {
    const candidates: RoomScore[] = [];

    for (const [roomName, data] of Object.entries(this.scoutData)) {
      const score = this.evaluateRoom(roomName, data as ScoutedRoom);
      if (score.viable) {
        candidates.push(score);
      }
    }

    // Sort by total score descending
    candidates.sort((a, b) => b.totalScore - a.totalScore);

    return candidates.slice(0, maxResults);
  }

  /**
   * Get the single best expansion target
   */
  getBestTarget(): RoomScore | null {
    const ranked = this.rankCandidates(1);
    return ranked[0] || null;
  }

  /**
   * Evaluate a single room
   */
  evaluateRoom(roomName: string, data: ScoutedRoom): RoomScore {
    const blockers: string[] = [];

    // === HARD DISQUALIFIERS ===

    if (data.owner) {
      return this.inviable(roomName, ["Owned by " + data.owner]);
    }

    if (data.hasKeepers || data.roomType === "sourceKeeper") {
      return this.inviable(roomName, ["Source Keeper room"]);
    }

    if (data.roomType === "highway" || data.roomType === "center") {
      return this.inviable(roomName, ["No controller"]);
    }

    if (!data.controller) {
      return this.inviable(roomName, ["No controller"]);
    }

    if (data.sources === 0) {
      return this.inviable(roomName, ["No sources"]);
    }

    // Reserved by enemy
    if (data.reserved && data.reserved !== this.myUsername) {
      blockers.push("Reserved by " + data.reserved);
    }

    // Check minimum distance from our colonies (avoid remote overlap)
    const minDistanceFromOwned = this.getMinDistanceFromOwnedRooms(roomName);
    if (minDistanceFromOwned < 3) {
      return this.inviable(roomName, ["Too close to existing colony (would overlap remotes)"]);
    }

    // Check distance from enemies
    const minDistanceFromEnemy = this.getMinDistanceFromEnemies(roomName);
    if (minDistanceFromEnemy < 2) {
      blockers.push("Adjacent to enemy");
    }

    // Stale data warning (but don't disqualify)
    const dataAge = Game.time - data.scannedAt;
    if (dataAge > 50000) {
      blockers.push("Stale scout data (" + Math.floor(dataAge / 1000) + "k ticks old)");
    }

    // === SCORING ===

    // Economic score (0-100)
    const economicScore = this.scoreEconomic(data, roomName);

    // Strategic score (0-100)
    const strategicScore = this.scoreStrategic(roomName, minDistanceFromOwned, minDistanceFromEnemy);

    // Defensive score (0-100)
    const defensiveScore = this.scoreDefensive(data, minDistanceFromEnemy);

    // Weighted total
    const weights = { economic: 0.45, strategic: 0.3, defensive: 0.25 };
    const totalScore =
      economicScore * weights.economic +
      strategicScore * weights.strategic +
      defensiveScore * weights.defensive;

    // Viable if score > 40 and no hard blockers
    const viable = totalScore > 40 && blockers.length === 0;

    return {
      roomName,
      totalScore,
      viable,
      blockers,
      economic: economicScore,
      strategic: strategicScore,
      defensive: defensiveScore,
      details: {
        sources: data.sources,
        mineral: data.mineral,
        mineralValue: data.mineral ? MINERAL_VALUES[data.mineral] || 50 : 0,
        swampPercent: data.swampPercent,
        wallPercent: data.wallPercent,
        distanceFromParent: minDistanceFromOwned,
        distanceFromEnemies: minDistanceFromEnemy,
        remotePotential: this.countRemotePotential(roomName),
      },
    };
  }

  private scoreEconomic(data: ScoutedRoom, roomName: string): number {
    let score = 0;

    // Sources: 2 sources = 40 points, 1 source = 15 points
    score += data.sources === 2 ? 40 : 15;

    // Mineral value
    if (data.mineral) {
      const baseValue = MINERAL_VALUES[data.mineral] || 50;
      // Bonus if we don't have this mineral yet
      const diversityBonus = this.myMinerals.has(data.mineral) ? 0 : 20;
      score += (baseValue / 100) * 15 + diversityBonus;
    }

    // Terrain quality (low swamp = better)
    const swampPenalty = Math.min(data.swampPercent * 0.5, 15);
    score += 15 - swampPenalty;

    // Remote potential (adjacent rooms with sources we can mine)
    const remotePotential = this.countRemotePotential(roomName);
    score += Math.min(remotePotential * 5, 20);

    return Math.min(100, Math.max(0, score));
  }

  private scoreStrategic(roomName: string, distFromOwned: number, distFromEnemy: number): number {
    let score = 50; // Start neutral

    // Distance from nearest owned room
    // Ideal: 4-6 rooms (close enough to bootstrap, far enough for remotes)
    if (distFromOwned >= 4 && distFromOwned <= 6) {
      score += 25;
    } else if (distFromOwned === 3) {
      score += 15; // Acceptable but tight
    } else if (distFromOwned > 6) {
      score -= (distFromOwned - 6) * 5; // Penalty for distance
    }

    // Distance from enemies
    // Further is better (up to a point)
    if (distFromEnemy >= 5) {
      score += 20;
    } else if (distFromEnemy >= 3) {
      score += 10;
    } else if (distFromEnemy === 2) {
      score -= 10;
    } else if (distFromEnemy === 1) {
      score -= 30;
    }

    return Math.min(100, Math.max(0, score));
  }

  private scoreDefensive(data: ScoutedRoom, distFromEnemy: number): number {
    let score = 50;

    // High wall percentage = natural chokepoints
    score += Math.min(data.wallPercent * 0.3, 15);

    // Low swamp = easier to defend
    score += Math.max(0, 10 - data.swampPercent * 0.2);

    // Far from enemies = safer
    if (distFromEnemy >= 4) {
      score += 20;
    } else if (distFromEnemy >= 2) {
      score += 10;
    }

    return Math.min(100, Math.max(0, score));
  }

  private countRemotePotential(roomName: string): number {
    const exits = Game.map.describeExits(roomName);
    if (!exits) return 0;

    let potential = 0;
    for (const exitRoom of Object.values(exits)) {
      const data = this.scoutData[exitRoom] as ScoutedRoom | undefined;
      if (!data) continue;

      // Good remote: normal room, not owned, has sources
      if (data.roomType === "normal" && !data.owner && data.sources > 0) {
        potential += data.sources;
      }
      // SK rooms are bonus potential for later
      if (data.roomType === "sourceKeeper" && !data.hasInvaderCore) {
        potential += 1;
      }
    }

    return potential;
  }

  private getMinDistanceFromOwnedRooms(roomName: string): number {
    let minDist = Infinity;
    for (const owned of this.myRooms) {
      const dist = Game.map.getRoomLinearDistance(roomName, owned);
      if (dist < minDist) minDist = dist;
    }
    return minDist === Infinity ? 99 : minDist;
  }

  private getMinDistanceFromEnemies(roomName: string): number {
    let minDist = Infinity;
    for (const enemy of this.enemyRooms) {
      const dist = Game.map.getRoomLinearDistance(roomName, enemy);
      if (dist < minDist) minDist = dist;
    }
    return minDist === Infinity ? 99 : minDist;
  }

  private inviable(roomName: string, blockers: string[]): RoomScore {
    return {
      roomName,
      totalScore: 0,
      viable: false,
      blockers,
      economic: 0,
      strategic: 0,
      defensive: 0,
      details: {
        sources: 0,
        mineral: null,
        mineralValue: 0,
        swampPercent: 0,
        wallPercent: 0,
        distanceFromParent: 0,
        distanceFromEnemies: 0,
        remotePotential: 0,
      },
    };
  }
}
