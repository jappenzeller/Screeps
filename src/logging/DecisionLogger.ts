/**
 * DecisionLogger: Captures decision-making context for AWS analysis.
 * Logs spawn decisions, task generation, task assignments, and creep decisions
 * to memory segment 93 for external analysis and outcome correlation.
 */

const DECISION_SEGMENT = 93;
const DEFAULT_WINDOW_SIZE = 100;  // Export every 100 ticks
const DEFAULT_SAMPLE_RATE = 0.1;  // Sample 10% of creep decisions
const MAX_SPAWN_DECISIONS = 50;   // Max spawn decisions per export window
const MAX_TASK_ASSIGNS = 100;     // Max task assignments per export window
const MAX_CREEP_DECISIONS = 200;  // Max creep decisions per export window

/**
 * Initialize decision logging memory if not present
 */
function initMemory(): DecisionMemory {
  if (!Memory.decisions) {
    Memory.decisions = {
      enabled: true,
      lastExport: Game.time,
      windowSize: DEFAULT_WINDOW_SIZE,
      sampleRate: DEFAULT_SAMPLE_RATE,
      spawn: [],
      taskGen: [],
      taskAssign: [],
      creep: [],
      totalSpawnDecisions: 0,
      totalTaskAssigns: 0,
      totalCreepDecisions: 0,
    };
  }
  return Memory.decisions;
}

/**
 * DecisionLogger class for capturing decision-making context
 */
export class DecisionLogger {
  /**
   * Check if logging is enabled
   */
  static isEnabled(): boolean {
    const mem = initMemory();
    return mem.enabled;
  }

  /**
   * Enable or disable decision logging
   */
  static setEnabled(enabled: boolean): void {
    const mem = initMemory();
    mem.enabled = enabled;
    console.log(`[DecisionLogger] Logging ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Set the export window size (ticks between exports)
   */
  static setWindowSize(ticks: number): void {
    const mem = initMemory();
    mem.windowSize = Math.max(10, Math.min(1000, ticks));
    console.log(`[DecisionLogger] Window size set to ${mem.windowSize} ticks`);
  }

  /**
   * Set the creep decision sample rate (0-1)
   */
  static setSampleRate(rate: number): void {
    const mem = initMemory();
    mem.sampleRate = Math.max(0, Math.min(1, rate));
    console.log(`[DecisionLogger] Sample rate set to ${(mem.sampleRate * 100).toFixed(0)}%`);
  }

  /**
   * Log a spawn decision with full context
   */
  static logSpawnDecision(
    room: string,
    decision: "SPAWN" | "WAIT_ENERGY" | "QUEUE_FULL" | "NO_CANDIDATES",
    phase: "BOOTSTRAP" | "DEVELOPING" | "STABLE" | "EMERGENCY",
    selectedRole: string | null,
    selectedUtility: number,
    selectedCost: number,
    energyAvailable: number,
    energyCapacity: number,
    candidates: SpawnCandidate[]
  ): void {
    const mem = initMemory();
    if (!mem.enabled) return;

    // Trim candidates to top 10 to save memory
    const topCandidates = candidates.slice(0, 10);

    const entry: SpawnDecision = {
      tick: Game.time,
      room,
      decision,
      selectedRole,
      selectedUtility,
      selectedCost,
      energyAvailable,
      energyCapacity,
      phase,
      candidates: topCandidates,
    };

    mem.spawn.push(entry);
    mem.totalSpawnDecisions++;

    // Trim if over limit
    if (mem.spawn.length > MAX_SPAWN_DECISIONS) {
      mem.spawn.shift();
    }
  }

  /**
   * Log task generation decision
   */
  static logTaskGeneration(
    room: string,
    phase: "BOOTSTRAP" | "DEVELOPING" | "STABLE" | "EMERGENCY",
    energyAvailable: number,
    energyCapacity: number,
    tasksByType: Record<string, number>,
    priorities: Record<string, number>
  ): void {
    const mem = initMemory();
    if (!mem.enabled) return;

    const entry: TaskGenDecision = {
      tick: Game.time,
      room,
      phase,
      energyAvailable,
      energyCapacity,
      tasksGenerated: Object.values(tasksByType).reduce((a, b) => a + b, 0),
      tasksByType,
      priorities,
    };

    mem.taskGen.push(entry);

    // Keep only last 10 per room (one per tick ideally)
    if (mem.taskGen.length > 20) {
      mem.taskGen.shift();
    }
  }

  /**
   * Log task assignment decision
   */
  static logTaskAssignment(
    room: string,
    creepName: string,
    creepRole: string,
    selectedTask: string | null,
    selectedTaskId: string | null,
    selectedPriority: number,
    selectedDistance: number,
    alternativeCount: number
  ): void {
    const mem = initMemory();
    if (!mem.enabled) return;

    const entry: TaskAssignDecision = {
      tick: Game.time,
      room,
      creepName,
      creepRole,
      selectedTask,
      selectedTaskId,
      selectedPriority,
      selectedDistance,
      alternativeCount,
    };

    mem.taskAssign.push(entry);
    mem.totalTaskAssigns++;

    // Trim if over limit
    if (mem.taskAssign.length > MAX_TASK_ASSIGNS) {
      mem.taskAssign.shift();
    }
  }

  /**
   * Log creep role decision (sampled based on sampleRate)
   */
  static logCreepDecision(
    room: string,
    creepName: string,
    creepRole: string,
    decisionType: "STATE_CHANGE" | "TARGET_SELECT" | "RENEWAL" | "ACTION",
    previousState: string | null,
    newState: string | null,
    targetId: string | null,
    targetType: string | null,
    reason: string,
    factors?: Record<string, number | string | boolean>
  ): void {
    const mem = initMemory();
    if (!mem.enabled) return;

    // Sample based on rate (but always log state changes)
    if (decisionType !== "STATE_CHANGE" && Math.random() > mem.sampleRate) {
      return;
    }

    const entry: CreepDecision = {
      tick: Game.time,
      room,
      creepName,
      creepRole,
      decisionType,
      previousState,
      newState,
      targetId,
      targetType,
      reason,
      factors,
    };

    mem.creep.push(entry);
    mem.totalCreepDecisions++;

    // Trim if over limit
    if (mem.creep.length > MAX_CREEP_DECISIONS) {
      mem.creep.shift();
    }
  }

  /**
   * Export decision data to segment 93
   * Called periodically (e.g., every windowSize ticks)
   */
  static export(): void {
    const mem = initMemory();
    if (!mem.enabled) return;

    // Check if it's time to export
    if (Game.time - mem.lastExport < mem.windowSize) {
      return;
    }

    // Request segment for writing
    RawMemory.setActiveSegments([DECISION_SEGMENT]);

    // Build export payload
    const payload: DecisionLog = {
      exportedAt: Game.time,
      windowStart: mem.lastExport,
      windowEnd: Game.time,
      spawn: mem.spawn,
      taskGen: mem.taskGen,
      taskAssign: mem.taskAssign,
      creep: mem.creep,
    };

    const json = JSON.stringify(payload);

    // Check size (segment limit is 100KB)
    if (json.length > 100000) {
      console.log(`[DecisionLogger] WARNING: Payload too large (${json.length} bytes), trimming`);
      // Trim arrays proportionally
      payload.spawn = mem.spawn.slice(-20);
      payload.taskAssign = mem.taskAssign.slice(-50);
      payload.creep = mem.creep.slice(-100);
    }

    // Write to segment
    RawMemory.segments[DECISION_SEGMENT] = JSON.stringify(payload);

    // Log periodically
    if (Game.time % 500 === 0) {
      console.log(
        `[DecisionLogger] Exported: ${mem.spawn.length} spawn, ` +
        `${mem.taskGen.length} taskGen, ${mem.taskAssign.length} taskAssign, ` +
        `${mem.creep.length} creep decisions (${json.length} bytes)`
      );
    }

    // Clear buffers and update last export time
    mem.spawn = [];
    mem.taskGen = [];
    mem.taskAssign = [];
    mem.creep = [];
    mem.lastExport = Game.time;
  }

  /**
   * Get current decision stats
   */
  static getStats(): {
    enabled: boolean;
    windowSize: number;
    sampleRate: number;
    bufferedSpawn: number;
    bufferedTaskGen: number;
    bufferedTaskAssign: number;
    bufferedCreep: number;
    totalSpawn: number;
    totalTaskAssign: number;
    totalCreep: number;
    lastExport: number;
    ticksSinceExport: number;
  } {
    const mem = initMemory();
    return {
      enabled: mem.enabled,
      windowSize: mem.windowSize,
      sampleRate: mem.sampleRate,
      bufferedSpawn: mem.spawn.length,
      bufferedTaskGen: mem.taskGen.length,
      bufferedTaskAssign: mem.taskAssign.length,
      bufferedCreep: mem.creep.length,
      totalSpawn: mem.totalSpawnDecisions,
      totalTaskAssign: mem.totalTaskAssigns,
      totalCreep: mem.totalCreepDecisions,
      lastExport: mem.lastExport,
      ticksSinceExport: Game.time - mem.lastExport,
    };
  }

  /**
   * Read the current export data (for debugging)
   */
  static read(): DecisionLog | null {
    const raw = RawMemory.segments[DECISION_SEGMENT];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DecisionLog;
    } catch {
      return null;
    }
  }

  /**
   * Clear all buffered decisions
   */
  static clear(): void {
    const mem = initMemory();
    mem.spawn = [];
    mem.taskGen = [];
    mem.taskAssign = [];
    mem.creep = [];
    console.log("[DecisionLogger] Buffers cleared");
  }
}

// Declare global for Screeps
declare const global: Record<string, unknown>;

// Export console commands for easy access
export function registerDecisionCommands(): void {
  global.decisions = {
    stats: () => DecisionLogger.getStats(),
    enable: () => DecisionLogger.setEnabled(true),
    disable: () => DecisionLogger.setEnabled(false),
    setWindow: (ticks: number) => DecisionLogger.setWindowSize(ticks),
    setSampleRate: (rate: number) => DecisionLogger.setSampleRate(rate),
    read: () => DecisionLogger.read(),
    clear: () => DecisionLogger.clear(),
    help: () => {
      console.log("Decision Logger Commands:");
      console.log("  decisions.stats() - Show current stats");
      console.log("  decisions.enable() - Enable logging");
      console.log("  decisions.disable() - Disable logging");
      console.log("  decisions.setWindow(ticks) - Set export window (default 100)");
      console.log("  decisions.setSampleRate(0.1) - Set creep sample rate (0-1)");
      console.log("  decisions.read() - Read last export from segment");
      console.log("  decisions.clear() - Clear all buffers");
    },
  };
}
