/**
 * Telemetry - Decision logging for AI advisor analysis
 *
 * Every decision is logged with its score breakdown. The AI advisor reads
 * telemetry to evaluate whether weight adjustments improved outcomes.
 */

import {
  DecisionLogEntry,
  TelemetryExport,
  WeightPatch,
  WorldState,
  ColonySnapshot,
} from "./types";
import { logger } from "../utils/Logger";
import { getWorldState } from "./WorldState";

// ============================================================================
// MEMORY SCHEMA
// ============================================================================

interface TelemetryMemory {
  enabled: boolean;
  lastExport: number;
  exportInterval: number; // Ticks between exports (default: 100)
  maxDecisions: number; // Max decisions to buffer (default: 500)

  // Rolling buffers
  decisions: DecisionLogEntry[];
  weightPatches: WeightPatch[];

  // Stats
  totalDecisions: number;
  totalExports: number;
}

declare global {
  interface Memory {
    telemetry?: TelemetryMemory;
  }
}

// ============================================================================
// TELEMETRY MANAGER
// ============================================================================

/**
 * Manages decision logging and telemetry export
 */
export class TelemetryManager {
  private static readonly SEGMENT_ID = 92; // Segment for telemetry export
  private static readonly MAX_SEGMENT_SIZE = 90 * 1024; // 90KB (leave margin under 100KB limit)
  private static pendingDecisions: DecisionLogEntry[] = [];
  private static pendingPatches: WeightPatch[] = [];

  /**
   * Initialize telemetry memory
   */
  static initialize(): void {
    if (!Memory.telemetry) {
      Memory.telemetry = {
        enabled: true,
        lastExport: Game.time,
        exportInterval: 100,
        maxDecisions: 200, // Reduced from 500 to help stay under 100KB segment limit
        decisions: [],
        weightPatches: [],
        totalDecisions: 0,
        totalExports: 0,
      };
    }
  }

  /**
   * Log a decision
   */
  static logDecision(decision: DecisionLogEntry): void {
    if (!Memory.telemetry?.enabled) return;

    this.pendingDecisions.push(decision);
    Memory.telemetry.totalDecisions++;

    // Flush to memory periodically
    if (this.pendingDecisions.length >= 10) {
      this.flushToMemory();
    }
  }

  /**
   * Log multiple decisions
   */
  static logDecisions(decisions: DecisionLogEntry[]): void {
    for (const decision of decisions) {
      this.logDecision(decision);
    }
  }

  /**
   * Log a weight patch
   */
  static logWeightPatch(patch: WeightPatch): void {
    if (!Memory.telemetry) return;

    this.pendingPatches.push(patch);
    Memory.telemetry.weightPatches.push(patch);

    // Keep only recent patches
    if (Memory.telemetry.weightPatches.length > 50) {
      Memory.telemetry.weightPatches.shift();
    }
  }

  /**
   * Flush pending decisions to memory
   */
  private static flushToMemory(): void {
    if (!Memory.telemetry) return;

    Memory.telemetry.decisions.push(...this.pendingDecisions);
    this.pendingDecisions = [];

    // Trim to max size
    while (Memory.telemetry.decisions.length > Memory.telemetry.maxDecisions) {
      Memory.telemetry.decisions.shift();
    }
  }

  /**
   * Check if export is due and export if so
   */
  static maybeExport(state: WorldState): void {
    if (!Memory.telemetry?.enabled) return;

    const mem = Memory.telemetry;
    if (Game.time - mem.lastExport < mem.exportInterval) return;

    // Flush any pending decisions
    this.flushToMemory();

    // Export to segment
    this.exportToSegment(state);
  }

  /**
   * Export telemetry to memory segment with size-aware truncation
   */
  private static exportToSegment(state: WorldState): void {
    if (!Memory.telemetry) return;

    const mem = Memory.telemetry;

    // Build colony metrics
    const colonyMetrics: TelemetryExport["colonyMetrics"] = {};
    for (const [roomName, colony] of state.colonies) {
      colonyMetrics[roomName] = {
        rcl: colony.rcl,
        rclProgress: colony.rclProgress / colony.rclProgressTotal,
        energyStored: colony.energyStored,
        netFlow: colony.netFlow,
        creepCount: colony.creeps.length,
      };
    }

    // Build export with all decisions
    let decisions = [...mem.decisions];
    let truncated = false;

    // Helper to build export payload
    const buildExport = (): TelemetryExport & { truncated?: boolean } => ({
      exportedAt: Game.time,
      windowStart: mem.lastExport,
      windowEnd: Game.time,
      decisions,
      weightPatches: mem.weightPatches,
      colonyMetrics,
      truncated: truncated || undefined,
    });

    let json = JSON.stringify(buildExport());

    // Truncate if over limit (remove oldest decisions progressively)
    while (json.length > this.MAX_SEGMENT_SIZE && decisions.length > 10) {
      const removeCount = Math.max(1, Math.floor(decisions.length * 0.1));
      decisions = decisions.slice(removeCount);
      truncated = true;
      json = JSON.stringify(buildExport());
    }

    // Write to segment
    try {
      RawMemory.segments[this.SEGMENT_ID] = json;
      RawMemory.setPublicSegments([this.SEGMENT_ID]);

      const sizeKB = (json.length / 1024).toFixed(1);
      logger.info(
        "Telemetry",
        `Exported ${decisions.length} decisions to segment ${this.SEGMENT_ID} (${sizeKB}KB)${truncated ? " [truncated]" : ""}`
      );
    } catch (error) {
      logger.error("Telemetry", `Export failed: ${error}`);
    }

    // Reset buffers
    mem.decisions = [];
    mem.lastExport = Game.time;
    mem.totalExports++;
  }

  /**
   * Force export (for debugging)
   */
  static forceExport(state: WorldState): string {
    this.flushToMemory();
    this.exportToSegment(state);
    return `Exported to segment ${this.SEGMENT_ID}`;
  }

  /**
   * Get telemetry stats
   */
  static getStats(): TelemetryStats {
    const mem = Memory.telemetry;
    return {
      enabled: mem?.enabled ?? false,
      bufferedDecisions: (mem?.decisions.length ?? 0) + this.pendingDecisions.length,
      bufferedPatches: mem?.weightPatches.length ?? 0,
      totalDecisions: mem?.totalDecisions ?? 0,
      totalExports: mem?.totalExports ?? 0,
      lastExport: mem?.lastExport ?? 0,
      exportInterval: mem?.exportInterval ?? 100,
    };
  }

  /**
   * Enable/disable telemetry
   */
  static setEnabled(enabled: boolean): void {
    this.initialize();
    Memory.telemetry!.enabled = enabled;
    logger.info("Telemetry", `Telemetry ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Set export interval
   */
  static setExportInterval(ticks: number): void {
    this.initialize();
    Memory.telemetry!.exportInterval = Math.max(10, Math.min(1000, ticks));
    logger.info("Telemetry", `Export interval set to ${Memory.telemetry!.exportInterval} ticks`);
  }

  /**
   * Clear all telemetry data
   */
  static clear(): void {
    this.pendingDecisions = [];
    this.pendingPatches = [];
    if (Memory.telemetry) {
      Memory.telemetry.decisions = [];
      Memory.telemetry.weightPatches = [];
    }
    logger.info("Telemetry", "Telemetry data cleared");
  }
}

export interface TelemetryStats {
  enabled: boolean;
  bufferedDecisions: number;
  bufferedPatches: number;
  totalDecisions: number;
  totalExports: number;
  lastExport: number;
  exportInterval: number;
}

// ============================================================================
// OUTCOME TRACKING
// ============================================================================

/**
 * Track outcomes of decisions for feedback loop
 */
export class OutcomeTracker {
  private static pendingOutcomes: Map<string, PendingOutcome> = new Map();

  /**
   * Register a decision that we want to track the outcome of
   */
  static trackDecision(
    decisionId: string,
    metric: string,
    beforeValue: number,
    checkAfterTicks: number = 100
  ): void {
    this.pendingOutcomes.set(decisionId, {
      decisionId,
      metric,
      beforeValue,
      registeredAt: Game.time,
      checkAt: Game.time + checkAfterTicks,
    });
  }

  /**
   * Check pending outcomes and record results
   */
  static checkOutcomes(state: WorldState): void {
    const now = Game.time;
    const toRemove: string[] = [];

    for (const [id, pending] of this.pendingOutcomes) {
      if (now < pending.checkAt) continue;

      // Get current value of the metric
      const afterValue = this.getMetricValue(pending.metric, state);
      if (afterValue !== null) {
        // Find the decision and update it with outcome
        const decision = Memory.telemetry?.decisions.find(
          (d) => `${d.tick}-${d.domain}-${d.colony}` === id
        );
        if (decision) {
          decision.outcome = {
            metric: pending.metric,
            before: pending.beforeValue,
            after: afterValue,
            delta: afterValue - pending.beforeValue,
          };
        }
      }

      toRemove.push(id);
    }

    for (const id of toRemove) {
      this.pendingOutcomes.delete(id);
    }
  }

  /**
   * Get a metric value from the world state
   */
  private static getMetricValue(metric: string, state: WorldState): number | null {
    const [type, roomName, field] = metric.split(".");

    if (type === "colony") {
      const colony = state.colonies.get(roomName);
      if (!colony) return null;

      switch (field) {
        case "rcl":
          return colony.rcl;
        case "rclProgress":
          return colony.rclProgress;
        case "energyStored":
          return colony.energyStored;
        case "netFlow":
          return colony.netFlow;
        case "creepCount":
          return colony.creeps.length;
        case "harvestIncome":
          return colony.harvestIncome;
        default:
          return null;
      }
    }

    if (type === "empire") {
      switch (field) {
        case "totalCreeps":
          return state.empire.totalCreeps;
        case "totalEnergy":
          return state.empire.totalEnergy;
        case "bucket":
          return state.empire.bucket;
        default:
          return null;
      }
    }

    return null;
  }
}

interface PendingOutcome {
  decisionId: string;
  metric: string;
  beforeValue: number;
  registeredAt: number;
  checkAt: number;
}

// ============================================================================
// CONSOLE COMMANDS
// ============================================================================

/**
 * Console command: Show telemetry stats
 */
export function showTelemetry(): string {
  const stats = TelemetryManager.getStats();
  return JSON.stringify(stats, null, 2);
}

/**
 * Console command: Enable/disable telemetry
 */
export function setTelemetry(enabled: boolean): string {
  TelemetryManager.setEnabled(enabled);
  return `Telemetry ${enabled ? "enabled" : "disabled"}`;
}

/**
 * Console command: Force telemetry export
 */
export function exportTelemetry(): string {
  const state = getWorldState();
  return TelemetryManager.forceExport(state);
}

/**
 * Console command: Clear telemetry data
 */
export function clearTelemetry(): string {
  TelemetryManager.clear();
  return "Telemetry data cleared";
}

/**
 * Console command: Show recent decisions
 */
export function recentDecisions(count: number = 10): string {
  const mem = Memory.telemetry;
  if (!mem?.decisions.length) {
    return "No decisions logged";
  }

  const recent = mem.decisions.slice(-count);
  return JSON.stringify(
    recent.map((d) => ({
      tick: d.tick,
      colony: d.colony,
      domain: d.domain,
      action: d.chosen.action,
      score: d.chosen.score,
    })),
    null,
    2
  );
}
