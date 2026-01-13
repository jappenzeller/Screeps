import { logger } from "../utils/Logger";
import { StatsCollector } from "../utils/StatsCollector";

/**
 * StrategicCoordinator - High-level colony planning
 * Runs every 100 ticks to determine goals, budgets, and workforce needs
 */

export enum ColonyPhase {
  BOOTSTRAP = "BOOTSTRAP",   // RCL 1-2, growing population
  DEVELOPING = "DEVELOPING", // RCL 2-4, building infrastructure
  STABLE = "STABLE",         // RCL 5+, optimizing
  EMERGENCY = "EMERGENCY",   // Under attack or critical failure
}

export enum Bottleneck {
  ENERGY_INCOME = "ENERGY_INCOME",       // Not harvesting enough
  ENERGY_TRANSPORT = "ENERGY_TRANSPORT", // Energy stuck at sources
  ENERGY_CONSUMPTION = "ENERGY_CONSUMPTION", // Storage full, need more upgraders
  SPAWN_CAPACITY = "SPAWN_CAPACITY",     // Can't spawn fast enough
  POPULATION = "POPULATION",             // Too few creeps
  CONSTRUCTION = "CONSTRUCTION",         // Missing key structures
  CPU = "CPU",                           // CPU limited
}

export interface EnergyBudget {
  incomePerTick: number;
  maxIncomePerTick: number;
  harvestEfficiency: number;
  allocations: {
    spawning: number;
    upgrading: number;
    building: number;
    repair: number;
    reserve: number;
  };
}

export interface WorkforceRequirements {
  harvestWorkParts: number;
  upgradeWorkParts: number;
  buildWorkParts: number;
  carryThroughput: number;
  targetCreeps: Record<string, number>;
  gaps: Record<string, number>;
}

export interface CapacityTransition {
  inTransition: boolean;
  currentCapacity: number;
  futureCapacity: number;
  extensionsBuilding: number;
  estimatedTicksToCompletion: number;
  shouldSuppressRenewal: boolean;
  shouldDelaySpawning: boolean;
}

export interface StrategicState {
  phase: ColonyPhase;
  lastUpdated: number;
  budget: EnergyBudget;
  workforce: WorkforceRequirements;
  bottleneck: Bottleneck | null;
  recommendations: string[];
  rclProgress: {
    current: number;
    total: number;
    percent: number;
    eta: number; // ticks at current rate
  };
  capacityTransition: CapacityTransition;
}

// Phase-based energy allocations (percentages, should sum to 100)
const PHASE_ALLOCATIONS: Record<ColonyPhase, EnergyBudget["allocations"]> = {
  [ColonyPhase.BOOTSTRAP]: {
    spawning: 70,
    upgrading: 15,
    building: 15,
    repair: 0,
    reserve: 0,
  },
  [ColonyPhase.DEVELOPING]: {
    spawning: 35,
    upgrading: 30,
    building: 25,
    repair: 5,
    reserve: 5,
  },
  [ColonyPhase.STABLE]: {
    spawning: 20,
    upgrading: 45,
    building: 15,
    repair: 10,
    reserve: 10,
  },
  [ColonyPhase.EMERGENCY]: {
    spawning: 60,
    upgrading: 5,
    building: 5,
    repair: 25,
    reserve: 5,
  },
};

export class StrategicCoordinator {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  /**
   * Run strategic analysis - call every 100 ticks
   */
  run(): StrategicState {
    // 1. Determine colony phase
    const phase = this.determinePhase();

    // 2. Calculate energy budget
    const budget = this.calculateBudget(phase);

    // 3. Calculate workforce requirements
    const workforce = this.calculateWorkforce(budget);

    // 4. Identify bottleneck
    const bottleneck = this.identifyBottleneck(budget, workforce);

    // 5. Calculate RCL progress
    const rclProgress = this.calculateRCLProgress(budget);

    // 6. Detect capacity transition (extensions being built)
    const capacityTransition = this.detectCapacityTransition();

    // 7. Generate recommendations (including transition-specific)
    const recommendations = this.generateRecommendations(bottleneck, workforce, capacityTransition);

    const state: StrategicState = {
      phase,
      lastUpdated: Game.time,
      budget,
      workforce,
      bottleneck,
      recommendations,
      rclProgress,
      capacityTransition,
    };

    // Store in memory for other systems to read
    this.saveState(state);

    // Log summary periodically
    this.logSummary(state);

    return state;
  }

  /**
   * Determine current colony phase based on RCL and state
   */
  private determinePhase(): ColonyPhase {
    const controller = this.room.controller;
    if (!controller) return ColonyPhase.BOOTSTRAP;

    // Check for emergency conditions
    const hostiles = this.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
      const hostileDPS = hostiles.reduce((sum, h) => {
        const attack = h.getActiveBodyparts(ATTACK) * 30;
        const ranged = h.getActiveBodyparts(RANGED_ATTACK) * 10;
        return sum + attack + ranged;
      }, 0);
      if (hostileDPS > 50) return ColonyPhase.EMERGENCY;
    }

    // Check spawn dying
    const spawns = this.room.find(FIND_MY_SPAWNS);
    if (spawns.some(s => s.hits < s.hitsMax * 0.5)) {
      return ColonyPhase.EMERGENCY;
    }

    // Check for no harvesters
    const harvesters = Object.values(Game.creeps).filter(
      c => c.memory.room === this.room.name && c.memory.role === "HARVESTER"
    );
    if (harvesters.length === 0) return ColonyPhase.EMERGENCY;

    // Phase by RCL
    if (controller.level <= 2) return ColonyPhase.BOOTSTRAP;
    if (controller.level <= 4) return ColonyPhase.DEVELOPING;
    return ColonyPhase.STABLE;
  }

  /**
   * Calculate energy budget based on current income and phase
   */
  private calculateBudget(phase: ColonyPhase): EnergyBudget {
    const sources = this.room.find(FIND_SOURCES);
    const maxIncomePerTick = sources.length * 10; // 5 WORK parts per source × 2 energy/tick

    // Get actual income from stats
    const incomePerTick = StatsCollector.getAverageIncome(20) || maxIncomePerTick * 0.5;
    const harvestEfficiency = maxIncomePerTick > 0 ? incomePerTick / maxIncomePerTick : 0;

    return {
      incomePerTick,
      maxIncomePerTick,
      harvestEfficiency: Math.min(1, harvestEfficiency),
      allocations: PHASE_ALLOCATIONS[phase],
    };
  }

  /**
   * Calculate workforce requirements based on budget
   */
  private calculateWorkforce(budget: EnergyBudget): WorkforceRequirements {
    const sources = this.room.find(FIND_SOURCES);

    // Harvest: need 5 WORK parts per source to saturate
    const harvestWorkParts = sources.length * 5;

    // Upgrade: 1 WORK part = 1 upgrade energy/tick
    const upgradeEnergy = budget.incomePerTick * (budget.allocations.upgrading / 100);
    const upgradeWorkParts = Math.ceil(upgradeEnergy);

    // Build: 1 WORK part = 5 build energy/tick (but uses 1 energy per tick of work)
    const buildEnergy = budget.incomePerTick * (budget.allocations.building / 100);
    const buildWorkParts = Math.max(1, Math.ceil(buildEnergy / 5));

    // Hauling: need to move income energy per tick
    // Estimate: CARRY part moves ~2-3 energy/tick on average (varies by distance)
    const carryThroughput = budget.incomePerTick;

    // Calculate target creep counts based on typical body sizes
    const energyCapacity = this.room.energyCapacityAvailable;
    const avgWorkPerHarvester = Math.min(5, Math.floor(energyCapacity / 150));
    const avgWorkPerUpgrader = Math.min(4, Math.floor(energyCapacity / 150));
    const avgWorkPerBuilder = Math.max(1, Math.floor(energyCapacity / 200)); // No cap - scales with capacity
    const avgCarryPerHauler = Math.min(8, Math.floor(energyCapacity / 100));

    // Detect energy surplus - containers/storage filling up means we should build more
    const energySurplus = this.detectEnergySurplus();

    // Calculate builder target
    const constructionSites = this.room.find(FIND_CONSTRUCTION_SITES);
    let targetBuilders = 0;
    if (constructionSites.length > 0) {
      // Base: from energy budget
      const budgetBuilders = Math.ceil(buildWorkParts / Math.max(1, avgWorkPerBuilder));

      // Scale with construction need (more sites = more builders, diminishing returns)
      const siteBasedBuilders = Math.ceil(Math.sqrt(constructionSites.length));

      // If energy is accumulating, prioritize building to consume it
      const surplusBonus = energySurplus ? 1 : 0;

      targetBuilders = Math.max(1, budgetBuilders, siteBasedBuilders) + surplusBonus;
    }

    // Calculate upgrader target with bonus when there's nothing else to spend energy on
    let targetUpgraders = Math.max(1, Math.ceil(upgradeWorkParts / Math.max(1, avgWorkPerUpgrader)));

    // Add upgrader bonus when:
    // 1. No construction sites - upgrading is the only energy sink (add +2)
    // 2. Energy surplus AND destinations full - need consumers (add +1)
    if (constructionSites.length === 0) {
      // No building work - upgrading is only option, scale up more aggressively
      targetUpgraders += 2;
    } else if (energySurplus && !this.checkDestinationCapacity()) {
      targetUpgraders += 1;
    }

    const targetCreeps: Record<string, number> = {
      HARVESTER: Math.max(sources.length, Math.ceil(harvestWorkParts / Math.max(1, avgWorkPerHarvester))),
      HAULER: Math.max(1, Math.ceil(carryThroughput / (Math.max(1, avgCarryPerHauler) * 2.5))),
      UPGRADER: targetUpgraders,
      BUILDER: targetBuilders,
    };

    // Count current creeps
    const currentCreeps: Record<string, number> = {
      HARVESTER: 0,
      HAULER: 0,
      UPGRADER: 0,
      BUILDER: 0,
    };

    for (const creep of Object.values(Game.creeps)) {
      if (creep.memory.room === this.room.name && currentCreeps[creep.memory.role] !== undefined) {
        currentCreeps[creep.memory.role]++;
      }
    }

    // Calculate gaps
    const gaps: Record<string, number> = {};
    for (const role of Object.keys(targetCreeps)) {
      gaps[role] = targetCreeps[role] - (currentCreeps[role] || 0);
    }

    return {
      harvestWorkParts,
      upgradeWorkParts,
      buildWorkParts,
      carryThroughput,
      targetCreeps,
      gaps,
    };
  }

  /**
   * Detect if energy is accumulating (surplus) - containers/storage filling up
   * Returns true if we have excess energy that should be consumed by building
   */
  private detectEnergySurplus(): boolean {
    // Check containers - if any are > 50% full, we have surplus
    const containers = this.room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];

    for (const container of containers) {
      const fillRatio = container.store.energy / container.store.getCapacity(RESOURCE_ENERGY);
      if (fillRatio > 0.5) {
        return true;
      }
    }

    // Check storage - if > 30% full, we have surplus
    const storage = this.room.storage;
    if (storage) {
      const fillRatio = storage.store.energy / storage.store.getCapacity(RESOURCE_ENERGY);
      if (fillRatio > 0.3) {
        return true;
      }
    }

    // Check dropped energy at sources - indicates surplus
    const droppedAtSources = this.room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 200,
    });
    if (droppedAtSources.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Check if energy destinations have capacity to receive more energy
   * Returns true if haulers would have somewhere to deliver
   */
  private checkDestinationCapacity(): boolean {
    // Check spawn and extensions
    const spawnStructures = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (spawnStructures.length > 0) {
      return true;
    }

    // Check towers (they always want energy for defense)
    const towers = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_TOWER &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 100,
    });
    if (towers.length > 0) {
      return true;
    }

    // Check storage (if it exists and is less than 50% full)
    const storage = this.room.storage;
    if (storage) {
      const capacity = storage.store.getCapacity(RESOURCE_ENERGY);
      const used = storage.store[RESOURCE_ENERGY] || 0;
      const fillRatio = used / capacity;
      if (fillRatio < 0.5) {
        return true; // Storage has plenty of room
      }
    }

    // All destinations are full
    return false;
  }

  /**
   * Identify the primary bottleneck limiting colony progress
   */
  private identifyBottleneck(budget: EnergyBudget, workforce: WorkforceRequirements): Bottleneck | null {
    // Check harvest efficiency first
    if (budget.harvestEfficiency < 0.5) {
      return Bottleneck.ENERGY_INCOME;
    }

    // Check for energy stuck at sources (transport problem)
    const droppedEnergy = this.room.find(FIND_DROPPED_RESOURCES)
      .filter(r => r.resourceType === RESOURCE_ENERGY)
      .reduce((sum, r) => sum + r.amount, 0);

    const containers = this.room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];
    const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);

    const energyAccumulating = droppedEnergy > 500 || containerEnergy > 1500;

    if (energyAccumulating) {
      // Check if destinations have capacity - if not, it's a consumption problem, not transport
      const destinationsHaveCapacity = this.checkDestinationCapacity();
      if (destinationsHaveCapacity) {
        return Bottleneck.ENERGY_TRANSPORT;
      } else {
        // Destinations full - energy is accumulating because we're not consuming fast enough
        return Bottleneck.ENERGY_CONSUMPTION;
      }
    }

    // Check construction blockers (missing critical structures)
    const controller = this.room.controller;
    if (controller) {
      const extensions = this.room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_EXTENSION,
      }).length;
      const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][controller.level];
      if (extensions < maxExtensions) {
        return Bottleneck.CONSTRUCTION;
      }

      // Check containers at sources
      const sources = this.room.find(FIND_SOURCES);
      for (const source of sources) {
        const hasContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: s => s.structureType === STRUCTURE_CONTAINER,
        }).length > 0;
        if (!hasContainer) {
          return Bottleneck.CONSTRUCTION;
        }
      }
    }

    // Check population gaps
    const totalGap = Object.values(workforce.gaps).reduce((sum, g) => sum + Math.max(0, g), 0);
    if (totalGap >= 3) {
      return Bottleneck.POPULATION;
    }

    // Check spawn capacity
    const spawns = this.room.find(FIND_MY_SPAWNS);
    const busySpawns = spawns.filter(s => s.spawning).length;
    if (busySpawns === spawns.length && totalGap > 0) {
      return Bottleneck.SPAWN_CAPACITY;
    }

    // Check CPU
    if (Game.cpu.bucket < 3000) {
      return Bottleneck.CPU;
    }

    return null;
  }

  /**
   * Detect if colony is in capacity transition (extensions being built)
   */
  private detectCapacityTransition(): CapacityTransition {
    const currentCapacity = this.room.energyCapacityAvailable;

    // Count extension construction sites
    const extensionSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: s => s.structureType === STRUCTURE_EXTENSION,
    });

    const extensionsBuilding = extensionSites.length;
    const futureCapacity = currentCapacity + extensionsBuilding * 50;

    // Estimate completion time based on build progress
    const totalRemaining = extensionSites.reduce(
      (sum, s) => sum + (s.progressTotal - s.progress),
      0
    );

    // Estimate build rate: count WORK parts on builders
    const builders = Object.values(Game.creeps).filter(
      c => c.memory.room === this.room.name && c.memory.role === "BUILDER"
    );
    const buildWorkParts = builders.reduce(
      (sum, c) => sum + c.getActiveBodyparts(WORK),
      0
    );
    // Each WORK builds 5 progress/tick, but builders also need to collect energy
    // Estimate ~40% efficiency for building time
    const effectiveBuildRate = buildWorkParts * 5 * 0.4;
    const estimatedTicksToCompletion =
      effectiveBuildRate > 0 ? Math.ceil(totalRemaining / effectiveBuildRate) : Infinity;

    const inTransition = extensionsBuilding > 0;

    // Suppress renewal if capacity increasing by 30%+ AND extensions almost done
    const capacityIncrease = futureCapacity / currentCapacity;
    const shouldSuppressRenewal =
      inTransition && capacityIncrease >= 1.3 && estimatedTicksToCompletion < 500;

    // Delay non-critical spawning if extensions almost done (< 300 ticks)
    const shouldDelaySpawning = inTransition && estimatedTicksToCompletion < 300;

    return {
      inTransition,
      currentCapacity,
      futureCapacity,
      extensionsBuilding,
      estimatedTicksToCompletion,
      shouldSuppressRenewal,
      shouldDelaySpawning,
    };
  }

  /**
   * Generate actionable recommendations based on bottleneck
   */
  private generateRecommendations(
    bottleneck: Bottleneck | null,
    workforce: WorkforceRequirements,
    transition: CapacityTransition
  ): string[] {
    const recs: string[] = [];

    // Add capacity transition recommendations first
    if (transition.inTransition) {
      if (transition.shouldSuppressRenewal) {
        recs.push(
          `Suppressing renewal: ${transition.currentCapacity} → ${transition.futureCapacity} capacity in ~${transition.estimatedTicksToCompletion} ticks`
        );
      } else if (transition.shouldDelaySpawning) {
        recs.push(
          `Delaying non-critical spawns: extensions done in ~${transition.estimatedTicksToCompletion} ticks`
        );
      }
    }

    switch (bottleneck) {
      case Bottleneck.ENERGY_INCOME:
        recs.push(`Low harvest efficiency - need ${workforce.harvestWorkParts} WORK parts at sources`);
        if (workforce.gaps.HARVESTER > 0) {
          recs.push(`Spawn ${workforce.gaps.HARVESTER} more harvester(s)`);
        }
        break;

      case Bottleneck.ENERGY_TRANSPORT:
        recs.push("Energy stuck at sources - add haulers");
        recs.push(`Need ${workforce.carryThroughput.toFixed(1)} carry throughput/tick`);
        if (workforce.gaps.HAULER > 0) {
          recs.push(`Spawn ${workforce.gaps.HAULER} more hauler(s)`);
        }
        break;

      case Bottleneck.ENERGY_CONSUMPTION:
        recs.push("Storage full - need more energy consumers");
        recs.push("Add upgraders to burn excess energy");
        if (workforce.gaps.UPGRADER > 0) {
          recs.push(`Spawn ${workforce.gaps.UPGRADER} more upgrader(s)`);
        }
        break;

      case Bottleneck.CONSTRUCTION:
        const controller = this.room.controller;
        if (controller) {
          const extensions = this.room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION,
          }).length;
          const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][controller.level];
          if (extensions < maxExtensions) {
            recs.push(`Build extensions: ${extensions}/${maxExtensions}`);
          }
        }

        const sources = this.room.find(FIND_SOURCES);
        const containersNeeded = sources.filter(s => {
          return s.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: str => str.structureType === STRUCTURE_CONTAINER,
          }).length === 0;
        }).length;
        if (containersNeeded > 0) {
          recs.push(`Build containers at ${containersNeeded} source(s)`);
        }
        break;

      case Bottleneck.POPULATION:
        for (const [role, gap] of Object.entries(workforce.gaps)) {
          if (gap > 0) {
            recs.push(`Need ${gap} more ${role}`);
          }
        }
        break;

      case Bottleneck.SPAWN_CAPACITY:
        recs.push("Spawn at capacity - build more spawns or spawn larger creeps");
        break;

      case Bottleneck.CPU:
        recs.push(`CPU bucket low (${Game.cpu.bucket}) - optimize or reduce creeps`);
        break;

      default:
        if (recs.length === 0) {
          recs.push("Colony running smoothly");
        }
    }

    return recs;
  }

  /**
   * Calculate RCL upgrade progress and ETA
   */
  private calculateRCLProgress(budget: EnergyBudget): StrategicState["rclProgress"] {
    const controller = this.room.controller;
    if (!controller) {
      return { current: 0, total: 1, percent: 0, eta: Infinity };
    }

    const current = controller.progress;
    const total = controller.progressTotal;
    const percent = (current / total) * 100;

    // Calculate ETA based on current upgrade rate
    const upgradeRate = budget.incomePerTick * (budget.allocations.upgrading / 100);
    const remaining = total - current;
    const eta = upgradeRate > 0 ? Math.ceil(remaining / upgradeRate) : Infinity;

    return { current, total, percent, eta };
  }

  /**
   * Save state to memory for other systems
   */
  private saveState(state: StrategicState): void {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[this.room.name]) Memory.rooms[this.room.name] = {};

    // Store minimal strategic state
    (Memory.rooms[this.room.name] as RoomMemory & { strategic?: StrategicState }).strategic = state;
  }

  /**
   * Get cached strategic state (for use between runs)
   */
  static getState(roomName: string): StrategicState | null {
    const mem = Memory.rooms?.[roomName] as RoomMemory & { strategic?: StrategicState } | undefined;
    return mem?.strategic ?? null;
  }

  /**
   * Log strategic summary
   */
  private logSummary(state: StrategicState): void {
    logger.info(
      "Strategy",
      `[${this.room.name}] Phase: ${state.phase} | ` +
      `Income: ${state.budget.incomePerTick.toFixed(1)}/tick (${(state.budget.harvestEfficiency * 100).toFixed(0)}% eff) | ` +
      `Bottleneck: ${state.bottleneck || "none"} | ` +
      `RCL ${this.room.controller?.level}: ${state.rclProgress.percent.toFixed(1)}%`
    );

    if (state.recommendations.length > 0 && state.bottleneck) {
      logger.info("Strategy", `  Recommendations: ${state.recommendations[0]}`);
    }
  }
}
