import { logger } from "../utils/Logger";

/**
 * Bucket state thresholds
 */
export enum BucketState {
  CRITICAL = "CRITICAL", // < 1000 - emergency mode
  LOW = "LOW", // < 2000 - skip non-essential
  NORMAL = "NORMAL", // 2000-9000 - normal operation
  HIGH = "HIGH", // > 9000 - can run expensive operations
}

/**
 * CPU usage tracking per system
 */
interface SystemCPU {
  colonyState: number;
  tasks: number;
  spawner: number;
  towers: number;
  creeps: number;
  other: number;
}

/**
 * CPUBudget - Tracks CPU usage and determines throttle level
 *
 * Usage:
 *   CPUBudget.startTick();
 *   // ... do work ...
 *   CPUBudget.trackSystem("spawner", cpuBefore);
 *   // ... end of tick ...
 *   CPUBudget.endTick();
 */
export class CPUBudget {
  private static tickStart: number = 0;
  private static systemCPU: SystemCPU = {
    colonyState: 0,
    tasks: 0,
    spawner: 0,
    towers: 0,
    creeps: 0,
    other: 0,
  };
  private static bucketState: BucketState = BucketState.NORMAL;
  private static creepLimit: number = Infinity;

  // Rolling average for smoothing
  private static avgCPU: number = 0;
  private static readonly AVG_WEIGHT = 0.1; // 10% new, 90% old

  /**
   * Call at start of each tick
   */
  static startTick(): void {
    this.tickStart = Game.cpu.getUsed();

    // Reset per-tick tracking
    this.systemCPU = {
      colonyState: 0,
      tasks: 0,
      spawner: 0,
      towers: 0,
      creeps: 0,
      other: 0,
    };

    // Determine bucket state
    const bucket = Game.cpu.bucket;
    if (bucket < 1000) {
      this.bucketState = BucketState.CRITICAL;
      this.creepLimit = 10; // Only process 10 creeps
    } else if (bucket < 2000) {
      this.bucketState = BucketState.LOW;
      this.creepLimit = 30; // Process up to 30 creeps
    } else if (bucket > 9000) {
      this.bucketState = BucketState.HIGH;
      this.creepLimit = Infinity;
    } else {
      this.bucketState = BucketState.NORMAL;
      this.creepLimit = Infinity;
    }
  }

  /**
   * Track CPU usage for a specific system
   * @param system The system name
   * @param startCPU CPU usage at start of system's work (from Game.cpu.getUsed())
   */
  static trackSystem(system: keyof SystemCPU, startCPU: number): void {
    const used = Game.cpu.getUsed() - startCPU;
    this.systemCPU[system] += used;
  }

  /**
   * Call at end of each tick
   */
  static endTick(): void {
    const totalCPU = Game.cpu.getUsed() - this.tickStart;

    // Update rolling average
    this.avgCPU = this.avgCPU * (1 - this.AVG_WEIGHT) + totalCPU * this.AVG_WEIGHT;

    // Log periodically or when bucket is concerning
    if (Game.time % 20 === 0 || this.bucketState === BucketState.CRITICAL) {
      logger.debug(
        "CPUBudget",
        `Tick CPU: ${totalCPU.toFixed(2)} | Avg: ${this.avgCPU.toFixed(2)} | ` +
          `Bucket: ${Game.cpu.bucket} (${this.bucketState}) | ` +
          `Systems: state=${this.systemCPU.colonyState.toFixed(1)} ` +
          `tasks=${this.systemCPU.tasks.toFixed(1)} ` +
          `spawn=${this.systemCPU.spawner.toFixed(1)} ` +
          `towers=${this.systemCPU.towers.toFixed(1)} ` +
          `creeps=${this.systemCPU.creeps.toFixed(1)}`
      );
    }
  }

  /**
   * Get current bucket state
   */
  static getBucketState(): BucketState {
    return this.bucketState;
  }

  /**
   * Check if we can run expensive operations (pathfinding, large finds)
   */
  static canRunExpensive(): boolean {
    return this.bucketState === BucketState.HIGH || this.bucketState === BucketState.NORMAL;
  }

  /**
   * Check if we can run non-essential operations (road planning, stats)
   */
  static canRunNonEssential(): boolean {
    return this.bucketState === BucketState.HIGH;
  }

  /**
   * Check if we're in emergency mode (critical bucket)
   */
  static isEmergencyMode(): boolean {
    return this.bucketState === BucketState.CRITICAL;
  }

  /**
   * Get max number of creeps to process this tick
   */
  static getCreepLimit(): number {
    return this.creepLimit;
  }

  /**
   * Check if we have CPU budget remaining for this tick
   * @param buffer CPU to reserve for end-of-tick operations
   */
  static hasBudget(buffer: number = 5): boolean {
    const used = Game.cpu.getUsed();
    const limit = Game.cpu.limit;
    return used < limit - buffer;
  }

  /**
   * Get remaining CPU for this tick
   */
  static getRemainingCPU(): number {
    return Math.max(0, Game.cpu.limit - Game.cpu.getUsed());
  }

  /**
   * Get average CPU usage (smoothed)
   */
  static getAverageCPU(): number {
    return this.avgCPU;
  }

  /**
   * Get CPU used so far this tick
   */
  static getCurrentTickCPU(): number {
    return Game.cpu.getUsed() - this.tickStart;
  }

  /**
   * Get system CPU breakdown for current tick
   */
  static getSystemCPU(): Readonly<SystemCPU> {
    return { ...this.systemCPU };
  }
}
