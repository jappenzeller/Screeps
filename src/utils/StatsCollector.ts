/**
 * StatsCollector: Collects colony metrics for external analysis.
 * Stores stats in Memory.stats for AWS Lambda to pull via Screeps API.
 */

// Event types for tracking significant occurrences
export enum EventType {
  CREEP_DEATH = "CREEP_DEATH",
  CREEP_SPAWNED = "CREEP_SPAWNED",
  PHASE_CHANGE = "PHASE_CHANGE",
  HOSTILE_DETECTED = "HOSTILE_DETECTED",
  HOSTILE_ELIMINATED = "HOSTILE_ELIMINATED",
  STRUCTURE_BUILT = "STRUCTURE_BUILT",
  STRUCTURE_DESTROYED = "STRUCTURE_DESTROYED",
  RCL_UPGRADE = "RCL_UPGRADE",
  ENERGY_CRISIS = "ENERGY_CRISIS",
  CPU_THROTTLE = "CPU_THROTTLE",
  // Traffic events
  CREEP_STUCK = "CREEP_STUCK",
  CREEP_OSCILLATING = "CREEP_OSCILLATING",
  TRAFFIC_HOTSPOT = "TRAFFIC_HOTSPOT",
  ROAD_SUGGESTED = "ROAD_SUGGESTED",
  ROAD_BUILT = "ROAD_BUILT",
}

export interface ColonyEvent {
  timestamp: number;
  gameTick: number;
  type: EventType;
  roomName: string;
  data: Record<string, unknown>;
}

export interface TickStats {
  tick: number;
  energyHarvested: number;
  energySpent: {
    spawning: number;
    building: number;
    upgrading: number;
    repairing: number;
  };
  creepActions: {
    harvests: number;
    transfers: number;
    builds: number;
    repairs: number;
    upgrades: number;
    attacks: number;
  };
  // Traffic tracking per tick
  traffic: {
    stuckEvents: Array<{
      creepName: string;
      role: string;
      pos: { x: number; y: number };
      resolution: string;
    }>;
    oscillationEvents: Array<{
      creepName: string;
      role: string;
      positions: Array<{ x: number; y: number }>;
    }>;
  };
}

export interface ColonySnapshot {
  timestamp: number;
  gameTick: number;
  roomName: string;

  energy: {
    spawnAvailable: number;
    spawnCapacity: number;
    storage: number;
    containers: number;
    dropped: number;
    total: number;
  };

  creeps: {
    total: number;
    byRole: Record<string, number>;
    byState: Record<string, number>;
    avgTicksToLive: number;
  };

  economy: {
    harvestEfficiency: number;
  };

  controller: {
    level: number;
    progress: number;
    progressTotal: number;
    ticksToDowngrade: number;
  };

  structures: {
    constructionSites: number;
    containers: number;
    extensions: number;
    towers: number;
    roads: number;
    damagedCount: number;
  };

  threats: {
    hostileCreeps: number;
    hostileDPS: number;
  };

  cpu: {
    used: number;
    bucket: number;
    limit: number;
  };
}

// Extend Memory interface
declare global {
  interface Memory {
    stats?: {
      tickStats: TickStats[];
      snapshots: ColonySnapshot[];
      events: ColonyEvent[];
      lastSnapshotTick: number;
    };
  }
}

export class StatsCollector {
  private static currentTickStats: TickStats;
  private static SNAPSHOT_INTERVAL = 100; // Every 100 ticks (~5 min at 3s/tick)
  private static MAX_TICK_STATS = 100;
  private static MAX_SNAPSHOTS = 288; // 24 hours at 5min intervals
  private static MAX_EVENTS = 500;

  /**
   * Initialize stats tracking for this tick
   */
  static startTick(): void {
    this.currentTickStats = {
      tick: Game.time,
      energyHarvested: 0,
      energySpent: { spawning: 0, building: 0, upgrading: 0, repairing: 0 },
      creepActions: { harvests: 0, transfers: 0, builds: 0, repairs: 0, upgrades: 0, attacks: 0 },
      traffic: { stuckEvents: [], oscillationEvents: [] },
    };
  }

  /**
   * Record energy harvested this tick
   */
  static recordHarvest(amount: number): void {
    if (this.currentTickStats) {
      this.currentTickStats.energyHarvested += amount;
      this.currentTickStats.creepActions.harvests++;
    }
  }

  /**
   * Record energy spent on spawning
   */
  static recordSpawn(cost: number): void {
    if (this.currentTickStats) {
      this.currentTickStats.energySpent.spawning += cost;
    }
  }

  /**
   * Record energy spent on building
   */
  static recordBuild(amount: number): void {
    if (this.currentTickStats) {
      this.currentTickStats.energySpent.building += amount;
      this.currentTickStats.creepActions.builds++;
    }
  }

  /**
   * Record energy spent on upgrading
   */
  static recordUpgrade(amount: number): void {
    if (this.currentTickStats) {
      this.currentTickStats.energySpent.upgrading += amount;
      this.currentTickStats.creepActions.upgrades++;
    }
  }

  /**
   * Record energy spent on repairing
   */
  static recordRepair(amount: number): void {
    if (this.currentTickStats) {
      this.currentTickStats.energySpent.repairing += amount;
      this.currentTickStats.creepActions.repairs++;
    }
  }

  /**
   * Record a transfer action
   */
  static recordTransfer(): void {
    if (this.currentTickStats) {
      this.currentTickStats.creepActions.transfers++;
    }
  }

  /**
   * Record an attack action
   */
  static recordAttack(): void {
    if (this.currentTickStats) {
      this.currentTickStats.creepActions.attacks++;
    }
  }

  /**
   * Record a creep stuck event
   */
  static recordStuckEvent(creep: Creep, resolution: string): void {
    if (this.currentTickStats) {
      this.currentTickStats.traffic.stuckEvents.push({
        creepName: creep.name,
        role: creep.memory.role,
        pos: { x: creep.pos.x, y: creep.pos.y },
        resolution,
      });
    }

    // Also record as event for longer-term tracking
    this.recordEvent(EventType.CREEP_STUCK, creep.room?.name || "unknown", {
      creepName: creep.name,
      role: creep.memory.role,
      position: { x: creep.pos.x, y: creep.pos.y },
      resolution,
    });
  }

  /**
   * Record a creep oscillation event
   */
  static recordOscillation(creep: Creep, positions: Array<{ x: number; y: number }>): void {
    if (this.currentTickStats) {
      this.currentTickStats.traffic.oscillationEvents.push({
        creepName: creep.name,
        role: creep.memory.role,
        positions,
      });
    }

    // Also record as event for longer-term tracking
    this.recordEvent(EventType.CREEP_OSCILLATING, creep.room?.name || "unknown", {
      creepName: creep.name,
      role: creep.memory.role,
      positions,
    });
  }

  /**
   * Record a significant event
   */
  static recordEvent(type: EventType, roomName: string, data: Record<string, unknown> = {}): void {
    this.ensureStatsMemory();

    Memory.stats!.events.push({
      timestamp: Date.now(),
      gameTick: Game.time,
      type,
      roomName,
      data,
    });

    // Trim events if too many
    while (Memory.stats!.events.length > this.MAX_EVENTS) {
      Memory.stats!.events.shift();
    }
  }

  /**
   * Finalize stats for this tick
   */
  static endTick(): void {
    this.ensureStatsMemory();

    // Store tick stats
    Memory.stats!.tickStats.push(this.currentTickStats);
    while (Memory.stats!.tickStats.length > this.MAX_TICK_STATS) {
      Memory.stats!.tickStats.shift();
    }

    // Take snapshot periodically
    if (Game.time - Memory.stats!.lastSnapshotTick >= this.SNAPSHOT_INTERVAL) {
      this.takeSnapshots();
      Memory.stats!.lastSnapshotTick = Game.time;
    }
  }

  /**
   * Take snapshots of all owned rooms
   */
  private static takeSnapshots(): void {
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      const snapshot = this.createSnapshot(room);
      Memory.stats!.snapshots.push(snapshot);
    }

    // Trim old snapshots
    while (Memory.stats!.snapshots.length > this.MAX_SNAPSHOTS) {
      Memory.stats!.snapshots.shift();
    }
  }

  /**
   * Create a snapshot of a room's state
   */
  private static createSnapshot(room: Room): ColonySnapshot {
    const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === room.name);
    const hostiles = room.find(FIND_HOSTILE_CREEPS);

    // Count creeps by role and state
    const byRole: Record<string, number> = {};
    const byState: Record<string, number> = {};
    let totalTTL = 0;
    let ttlCount = 0;

    for (const creep of creeps) {
      byRole[creep.memory.role] = (byRole[creep.memory.role] || 0) + 1;
      const state = creep.memory.state || "UNKNOWN";
      byState[state] = (byState[state] || 0) + 1;
      if (creep.ticksToLive) {
        totalTTL += creep.ticksToLive;
        ttlCount++;
      }
    }

    // Calculate energy totals
    const containers = room.find(FIND_STRUCTURES, {
      filter: { structureType: STRUCTURE_CONTAINER },
    }) as StructureContainer[];
    const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);

    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: { resourceType: RESOURCE_ENERGY },
    });
    const droppedEnergy = dropped.reduce((sum, d) => sum + d.amount, 0);

    const storageEnergy = room.storage?.store[RESOURCE_ENERGY] || 0;

    // Calculate harvest efficiency (actual vs theoretical max)
    const sources = room.find(FIND_SOURCES);
    const theoreticalMax = sources.length * 10; // 10 energy/tick per source with 5 WORK parts
    const recentStats = Memory.stats!.tickStats.slice(-10);
    const avgHarvested = recentStats.length > 0
      ? recentStats.reduce((sum, s) => sum + s.energyHarvested, 0) / recentStats.length
      : 0;
    const harvestEfficiency = theoreticalMax > 0 ? avgHarvested / theoreticalMax : 0;

    // Count structures
    const allStructures = room.find(FIND_STRUCTURES);
    const roads = allStructures.filter((s) => s.structureType === STRUCTURE_ROAD).length;
    const towers = allStructures.filter((s) => s.structureType === STRUCTURE_TOWER).length;
    const extensions = allStructures.filter((s) => s.structureType === STRUCTURE_EXTENSION).length;
    const damagedCount = allStructures.filter((s) => {
      if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
        return s.hits < 10000;
      }
      return s.hits < s.hitsMax * 0.75;
    }).length;

    // Calculate hostile DPS
    const hostileDPS = hostiles.reduce((sum, h) => {
      const attackParts = h.body.filter((p) => p.type === ATTACK && p.hits > 0).length;
      const rangedParts = h.body.filter((p) => p.type === RANGED_ATTACK && p.hits > 0).length;
      return sum + attackParts * 30 + rangedParts * 10;
    }, 0);

    return {
      timestamp: Date.now(),
      gameTick: Game.time,
      roomName: room.name,

      energy: {
        spawnAvailable: room.energyAvailable,
        spawnCapacity: room.energyCapacityAvailable,
        storage: storageEnergy,
        containers: containerEnergy,
        dropped: droppedEnergy,
        total: room.energyAvailable + storageEnergy + containerEnergy + droppedEnergy,
      },

      creeps: {
        total: creeps.length,
        byRole,
        byState,
        avgTicksToLive: ttlCount > 0 ? Math.round(totalTTL / ttlCount) : 0,
      },

      economy: {
        harvestEfficiency: Math.min(1, harvestEfficiency),
      },

      controller: {
        level: room.controller?.level || 0,
        progress: room.controller?.progress || 0,
        progressTotal: room.controller?.progressTotal || 1,
        ticksToDowngrade: room.controller?.ticksToDowngrade || 0,
      },

      structures: {
        constructionSites: room.find(FIND_CONSTRUCTION_SITES).length,
        containers: containers.length,
        extensions,
        towers,
        roads,
        damagedCount,
      },

      threats: {
        hostileCreeps: hostiles.length,
        hostileDPS,
      },

      cpu: {
        used: Game.cpu.getUsed(),
        bucket: Game.cpu.bucket,
        limit: Game.cpu.limit,
      },
    };
  }

  /**
   * Ensure stats memory structure exists
   */
  private static ensureStatsMemory(): void {
    // Check if stats exists and has the correct structure
    // (handles migration from old stats schema)
    if (!Memory.stats || !Array.isArray(Memory.stats.tickStats)) {
      Memory.stats = {
        tickStats: [],
        snapshots: [],
        events: [],
        lastSnapshotTick: Game.time,
      };
    }
  }

  /**
   * Get current stats for debugging
   */
  static getStats(): typeof Memory.stats {
    return Memory.stats;
  }

  /**
   * Get rolling average energy income per tick
   */
  static getAverageIncome(ticks: number = 20): number {
    if (!Memory.stats?.tickStats || Memory.stats.tickStats.length === 0) {
      return 0;
    }

    const recent = Memory.stats.tickStats.slice(-ticks);
    if (recent.length === 0) return 0;

    const totalHarvested = recent.reduce((sum, s) => sum + s.energyHarvested, 0);
    return totalHarvested / recent.length;
  }

  /**
   * Get rolling average energy spent per category
   */
  static getAverageSpending(ticks: number = 20): { spawning: number; building: number; upgrading: number; repairing: number } {
    if (!Memory.stats?.tickStats || Memory.stats.tickStats.length === 0) {
      return { spawning: 0, building: 0, upgrading: 0, repairing: 0 };
    }

    const recent = Memory.stats.tickStats.slice(-ticks);
    if (recent.length === 0) return { spawning: 0, building: 0, upgrading: 0, repairing: 0 };

    const totals = recent.reduce(
      (acc, s) => ({
        spawning: acc.spawning + s.energySpent.spawning,
        building: acc.building + s.energySpent.building,
        upgrading: acc.upgrading + s.energySpent.upgrading,
        repairing: acc.repairing + s.energySpent.repairing,
      }),
      { spawning: 0, building: 0, upgrading: 0, repairing: 0 }
    );

    return {
      spawning: totals.spawning / recent.length,
      building: totals.building / recent.length,
      upgrading: totals.upgrading / recent.length,
      repairing: totals.repairing / recent.length,
    };
  }

  /**
   * Clear all stats (useful for reset)
   */
  static clearStats(): void {
    delete Memory.stats;
  }

  /**
   * Export traffic metrics for AWS analysis (desire-path model)
   *
   * In the desire-path model, we ONLY track unroaded tiles.
   * High traffic on unroaded tiles = places that NEED roads.
   * Once a road is built, that tile stops being tracked (self-correcting).
   */
  static exportTrafficMetrics(room: Room): TrafficExport {
    const mem = Memory.traffic?.[room.name];
    if (!mem) {
      return {
        trackedTiles: 0,
        desirePaths: 0,
        windowSize: 1000,
        windowProgress: 0,
        roads: { total: 0, builtByPlanner: 0 },
        hotspots: [],
        efficiency: { swampTraffic: 0 },
        pathCoverage: {
          spawnToSources: [],
          spawnToController: { coverage: 0, distance: 0 },
          spawnToStorage: null,
        },
      };
    }

    const terrain = room.getTerrain();
    const roads = room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_ROAD,
    });

    // Count desire paths (tiles with 50+ visits = road candidates)
    // Note: All tracked tiles are unroaded by definition in the desire-path model
    let desirePaths = 0;
    for (const key in mem.heatmap) {
      if (mem.heatmap[key] >= 50) {
        desirePaths++;
      }
    }

    // Build hotspots array (all entries are unroaded tiles)
    const hotspots: TrafficExport["hotspots"] = [];
    for (const key in mem.heatmap) {
      const visits = mem.heatmap[key];
      if (visits < 10) continue; // Skip very low traffic

      const [x, y] = key.split(":").map(Number);
      const isSwamp = terrain.get(x, y) === TERRAIN_MASK_SWAMP;

      hotspots.push({
        x,
        y,
        visits,
        terrain: isSwamp ? "swamp" : "plain",
        priority: visits * (isSwamp ? 3 : 1), // Swamp roads save more fatigue
      });
    }

    // Sort by priority and take top 10
    hotspots.sort((a, b) => b.priority - a.priority);
    const topHotspots = hotspots.slice(0, 10);

    // Count swamp traffic (total visits on unroaded swamp tiles)
    let swampTraffic = 0;
    for (const key in mem.heatmap) {
      const [x, y] = key.split(":").map(Number);
      if (terrain.get(x, y) === TERRAIN_MASK_SWAMP) {
        swampTraffic += mem.heatmap[key];
      }
    }

    // Calculate path coverage (separate from heatmap - just road presence)
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    const sources = room.find(FIND_SOURCES);

    const spawnToSources = sources.map((source) =>
      this.calculatePathCoverage(room, spawn?.pos, source.pos, roads, source.id)
    );

    const spawnToController = this.calculatePathCoverage(
      room,
      spawn?.pos,
      room.controller?.pos,
      roads
    );

    const spawnToStorage = room.storage
      ? this.calculatePathCoverage(room, spawn?.pos, room.storage.pos, roads)
      : null;

    return {
      trackedTiles: Object.keys(mem.heatmap).length,
      desirePaths,
      windowSize: mem.windowSize,
      windowProgress: Game.time - mem.lastReset,
      roads: {
        total: roads.length,
        builtByPlanner: mem.roadsBuilt.length,
      },
      hotspots: topHotspots,
      efficiency: {
        swampTraffic,
      },
      pathCoverage: {
        spawnToSources,
        spawnToController,
        spawnToStorage,
      },
    };
  }

  /**
   * Calculate road coverage for a path (simple: just roads on path, no traffic data)
   */
  private static calculatePathCoverage(
    room: Room,
    from: RoomPosition | undefined,
    to: RoomPosition | undefined,
    roads: Structure[],
    sourceId?: string
  ): { sourceId?: string; coverage: number; distance: number } {
    if (!from || !to) {
      return { sourceId, coverage: 0, distance: 0 };
    }

    const path = room.findPath(from, to, { ignoreCreeps: true, range: 1 });
    if (path.length === 0) {
      return { sourceId, coverage: 1, distance: 0 };
    }

    let roadsOnPath = 0;
    for (const step of path) {
      if (roads.some((r) => r.pos.x === step.x && r.pos.y === step.y)) {
        roadsOnPath++;
      }
    }

    return {
      sourceId,
      coverage: roadsOnPath / path.length,
      distance: path.length,
    };
  }
}

// Traffic export interfaces for desire-path model
// Only unroaded tiles are tracked, so high traffic = places that NEED roads
export interface TrafficExport {
  // Desire path tracking
  trackedTiles: number;         // Total unroaded tiles with any traffic
  desirePaths: number;          // Tiles with 50+ visits (road candidates)
  windowSize: number;
  windowProgress: number;

  // Road status
  roads: {
    total: number;              // Total roads in room
    builtByPlanner: number;     // Roads placed by SmartRoadPlanner
  };

  // Hotspots - the main output (unroaded tiles with highest traffic)
  hotspots: Array<{
    x: number;
    y: number;
    visits: number;
    terrain: "plain" | "swamp";
    priority: number;           // visits * terrain multiplier (swamp=3x)
  }>;

  // Efficiency indicators
  efficiency: {
    swampTraffic: number;       // Total visits on unroaded swamps (high = bad)
  };

  // Path coverage (calculated separately, not from heatmap)
  pathCoverage: {
    spawnToSources: Array<{ sourceId?: string; coverage: number; distance: number }>;
    spawnToController: { coverage: number; distance: number };
    spawnToStorage: { coverage: number; distance: number } | null;
  };
}
