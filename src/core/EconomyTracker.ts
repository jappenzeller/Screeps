/**
 * Economy Tracker - Passive economy metrics collection
 * Collects data over time for /live endpoint and decision making
 */

interface EconomySnapshot {
  tick: number;
  stored: number;
  income: number;
  burn: number;
}

interface EconomyMemory {
  snapshots: EconomySnapshot[];
  tickIncome: number;
  tickBurn: number;
  localIncome: number;
  remoteIncome: number;
  lastStored?: number;
}

export interface ColonyEconomyMetrics {
  // Current state
  stored: number;
  available: number;
  capacity: number;

  // Calculated rates (per tick, smoothed)
  harvestIncome: number;
  remoteIncome: number;
  totalIncome: number;

  spawnBurn: number;
  upgradeBurn: number;
  buildBurn: number;
  towerBurn: number;
  totalBurn: number;

  // Derived
  netFlow: number;
  runway: number; // Ticks until empty (-1 = infinite if positive flow)

  // Health
  healthScore: number; // 0-100
  status: "CRITICAL" | "STRUGGLING" | "STABLE" | "THRIVING" | "SURPLUS";
}

declare global {
  interface Memory {
    economy?: Record<string, EconomyMemory>;
  }
}

export class EconomyTracker {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  /**
   * Call every tick to track energy changes
   */
  public track(): void {
    const mem = this.getMemory();
    const currentStored = this.getTotalStored();

    // Record snapshot every 100 ticks
    if (Game.time % 100 === 0) {
      mem.snapshots.push({
        tick: Game.time,
        stored: currentStored,
        income: mem.tickIncome || 0,
        burn: mem.tickBurn || 0,
      });

      // Keep last 50 snapshots (5000 ticks of history)
      if (mem.snapshots.length > 50) {
        mem.snapshots.shift();
      }

      // Reset tick counters
      mem.tickIncome = 0;
      mem.tickBurn = 0;
    }

    mem.lastStored = currentStored;
  }

  /**
   * Call when energy is harvested
   */
  public recordHarvest(amount: number, isRemote: boolean = false): void {
    const mem = this.getMemory();
    mem.tickIncome = (mem.tickIncome || 0) + amount;
    if (isRemote) {
      mem.remoteIncome = (mem.remoteIncome || 0) + amount;
    } else {
      mem.localIncome = (mem.localIncome || 0) + amount;
    }
  }

  /**
   * Call when energy is spent
   */
  public recordSpend(
    amount: number,
    _category: "spawn" | "upgrade" | "build" | "tower" | "repair"
  ): void {
    const mem = this.getMemory();
    mem.tickBurn = (mem.tickBurn || 0) + amount;
  }

  /**
   * Get computed metrics for /live export
   */
  public getMetrics(): ColonyEconomyMetrics {
    const stored = this.getTotalStored();

    // Calculate rates from active creeps
    const harvestIncome = this.calculateHarvestRate();
    const remoteIncome = this.calculateRemoteHarvestRate();
    const totalIncome = harvestIncome + remoteIncome;

    const spawnBurn = this.estimateSpawnBurn();
    const upgradeBurn = this.estimateUpgradeBurn();
    const buildBurn = this.estimateBuildBurn();
    const towerBurn = this.estimateTowerBurn();
    const totalBurn = spawnBurn + upgradeBurn + buildBurn + towerBurn;

    const netFlow = totalIncome - totalBurn;
    const runway = netFlow >= 0 ? -1 : Math.floor(stored / -netFlow);

    // Health assessment
    const { healthScore, status } = this.assessHealth(stored, netFlow, runway);

    return {
      stored,
      available: this.room.energyAvailable,
      capacity: this.room.energyCapacityAvailable,

      harvestIncome: Math.round(harvestIncome * 100) / 100,
      remoteIncome: Math.round(remoteIncome * 100) / 100,
      totalIncome: Math.round(totalIncome * 100) / 100,

      spawnBurn: Math.round(spawnBurn * 100) / 100,
      upgradeBurn: Math.round(upgradeBurn * 100) / 100,
      buildBurn: Math.round(buildBurn * 100) / 100,
      towerBurn: Math.round(towerBurn * 100) / 100,
      totalBurn: Math.round(totalBurn * 100) / 100,

      netFlow: Math.round(netFlow * 100) / 100,
      runway,

      healthScore,
      status,
    };
  }

  private getTotalStored(): number {
    let total = 0;

    if (this.room.storage) {
      total += this.room.storage.store[RESOURCE_ENERGY] || 0;
    }
    if (this.room.terminal) {
      total += this.room.terminal.store[RESOURCE_ENERGY] || 0;
    }

    // Include containers
    const containers = this.room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];

    for (const container of containers) {
      total += container.store[RESOURCE_ENERGY] || 0;
    }

    return total;
  }

  private calculateHarvestRate(): number {
    // 2 sources × 10 energy/tick max = 20/tick theoretical
    const harvesters = Object.values(Game.creeps).filter(
      (c) => c.memory.role === "HARVESTER" && c.memory.room === this.room.name
    );

    let totalWorkParts = 0;
    for (const h of harvesters) {
      totalWorkParts += h.getActiveBodyparts(WORK);
    }

    // Each WORK harvests 2 energy/tick, capped at source regen (10/source)
    const sources = this.room.find(FIND_SOURCES).length;
    return Math.min(totalWorkParts * 2, sources * 10);
  }

  private calculateRemoteHarvestRate(): number {
    const remoteMiners = Object.values(Game.creeps).filter(
      (c) => c.memory.role === "REMOTE_MINER" && c.memory.room === this.room.name
    );

    let totalWorkParts = 0;
    for (const m of remoteMiners) {
      // Only count if not fleeing
      if ((m.memory as any).isFleeing) continue;
      totalWorkParts += m.getActiveBodyparts(WORK);
    }

    // Count remote sources from Memory.rooms
    let remoteSources = 0;
    const exits = Game.map.describeExits(this.room.name);
    if (exits) {
      for (const dir in exits) {
        const roomName = exits[dir as ExitKey];
        if (roomName) {
          const intel = Memory.rooms?.[roomName];
          if (intel?.sources) {
            remoteSources += intel.sources.length;
          }
        }
      }
    }

    const maxRemote = remoteSources * 10;
    return Math.min(totalWorkParts * 2, maxRemote);
  }

  private estimateSpawnBurn(): number {
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn?.spawning) return 0;

    // Rough estimate: spawning consumes ~2 energy/tick on average
    return 2;
  }

  private estimateUpgradeBurn(): number {
    const upgraders = Object.values(Game.creeps).filter(
      (c) => c.memory.role === "UPGRADER" && c.memory.room === this.room.name
    );

    let totalWorkParts = 0;
    for (const u of upgraders) {
      totalWorkParts += u.getActiveBodyparts(WORK);
    }

    // Each WORK uses 1 energy/tick for upgrading
    return totalWorkParts;
  }

  private estimateBuildBurn(): number {
    const builders = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "BUILDER" &&
        c.memory.room === this.room.name &&
        c.memory.state === "BUILDING"
    );

    let totalWorkParts = 0;
    for (const b of builders) {
      totalWorkParts += b.getActiveBodyparts(WORK);
    }

    // Each WORK uses 5 energy per build action
    return totalWorkParts * 5;
  }

  private estimateTowerBurn(): number {
    const towers = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    }) as StructureTower[];

    // Towers use 10 energy per action
    const hostiles = this.room.find(FIND_HOSTILE_CREEPS).length;
    if (hostiles > 0) {
      return towers.length * 10; // Full combat burn
    }

    // Repair burn - estimate 1 action per 10 ticks per tower
    return towers.length * 0.1;
  }

  private assessHealth(
    stored: number,
    netFlow: number,
    runway: number
  ): { healthScore: number; status: ColonyEconomyMetrics["status"] } {
    let score: number;
    let status: ColonyEconomyMetrics["status"];

    if (runway !== -1 && runway < 1000) {
      score = 10;
      status = "CRITICAL";
    } else if (runway !== -1 && runway < 5000) {
      score = 30;
      status = "STRUGGLING";
    } else if (netFlow < 0) {
      score = 50;
      status = "STABLE";
    } else if (stored > 300000) {
      score = 90;
      status = "SURPLUS";
    } else if (stored > 100000) {
      score = 75;
      status = "THRIVING";
    } else {
      score = 60;
      status = "STABLE";
    }

    return { healthScore: score, status };
  }

  private getMemory(): EconomyMemory {
    if (!Memory.economy) Memory.economy = {};
    if (!Memory.economy[this.room.name]) {
      Memory.economy[this.room.name] = {
        snapshots: [],
        tickIncome: 0,
        tickBurn: 0,
        localIncome: 0,
        remoteIncome: 0,
      };
    }
    return Memory.economy[this.room.name];
  }
}
