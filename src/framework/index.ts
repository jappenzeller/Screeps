/**
 * Declarative Framework - Main Entry Point
 *
 * Phase 1: Framework foundation
 * - WorldState capture
 * - WeightTable management
 * - Evaluator/Arbitrator skeleton
 * - Telemetry logging
 *
 * The framework runs alongside existing systems in Phase 1.
 * Evaluators return empty arrays, so existing code continues to make decisions.
 */

// Export types
export * from "./types";

// Export core modules
export { captureWorldState, getWorldState, getColonySnapshot, showWorldState } from "./WorldState";

export {
  WeightTableManager,
  DEFAULT_WEIGHTS,
  showWeights,
  setWeight,
  resetWeights,
} from "./WeightTable";

export {
  BaseEvaluator,
  evaluatorRegistry,
  initializeEvaluators,
  FactorUtils,
} from "./Evaluator";

export { ColonyArbitrator, ActionExecutor, arbitrator, executor } from "./Arbitrator";

export {
  TelemetryManager,
  OutcomeTracker,
  showTelemetry,
  setTelemetry,
  exportTelemetry,
  clearTelemetry,
  recentDecisions,
} from "./Telemetry";

import { captureWorldState, getWorldState } from "./WorldState";
import { evaluatorRegistry, initializeEvaluators } from "./Evaluator";
import { arbitrator, executor } from "./Arbitrator";
import { TelemetryManager, OutcomeTracker } from "./Telemetry";
import { logger } from "../utils/Logger";

// ============================================================================
// FRAMEWORK RUNNER
// ============================================================================

let initialized = false;

/**
 * Initialize the declarative framework.
 * Call once at the start of the game.
 */
export function initializeFramework(): void {
  if (initialized) return;

  TelemetryManager.initialize();
  initializeEvaluators();
  initialized = true;

  logger.info("Framework", "Declarative framework initialized (Phase 1)");
}

/**
 * Run the declarative framework for a tick.
 * Call this from the main loop.
 *
 * In Phase 1, this captures world state and logs decisions,
 * but doesn't override existing systems.
 */
export function runFramework(): void {
  if (!initialized) {
    initializeFramework();
  }

  const startCpu = Game.cpu.getUsed();

  // Capture world state
  const state = captureWorldState();

  // Run evaluators for each colony
  for (const [roomName, colony] of state.colonies) {
    // Evaluate all domains
    const options = evaluatorRegistry.evaluateAll(state, colony);

    // Resolve conflicts (in Phase 1, this just logs - doesn't execute)
    const actions = arbitrator.resolve(options, state, colony);

    // Log decisions to telemetry
    const decisions = arbitrator.getDecisions();
    TelemetryManager.logDecisions(decisions);

    // Execute actions (in Phase 1, executors are placeholders)
    if (actions.length > 0) {
      executor.execute(actions, colony);
    }
  }

  // Check outcome tracking
  OutcomeTracker.checkOutcomes(state);

  // Maybe export telemetry
  TelemetryManager.maybeExport(state);

  const cpuUsed = Game.cpu.getUsed() - startCpu;
  if (cpuUsed > 20) {
    logger.warn("Framework", `Framework tick took ${cpuUsed.toFixed(2)} CPU`);
  }
}

/**
 * Get framework status for debugging
 */
export function getFrameworkStatus(): FrameworkStatus {
  const state = getWorldState();

  return {
    initialized,
    tick: state.tick,
    colonies: state.colonies.size,
    evaluators: evaluatorRegistry.getAll().map((e) => e.domain),
    telemetry: TelemetryManager.getStats(),
    weights: {
      version: state.weights.version,
      updatedAt: state.weights.updatedAt,
      updatedBy: state.weights.updatedBy,
    },
  };
}

export interface FrameworkStatus {
  initialized: boolean;
  tick: number;
  colonies: number;
  evaluators: string[];
  telemetry: {
    enabled: boolean;
    bufferedDecisions: number;
    totalDecisions: number;
    totalExports: number;
  };
  weights: {
    version: number;
    updatedAt: number;
    updatedBy: string;
  };
}

// ============================================================================
// CONSOLE COMMANDS
// ============================================================================

/**
 * Console command: Show framework status
 */
export function framework(): string {
  const status = getFrameworkStatus();
  return JSON.stringify(status, null, 2);
}
