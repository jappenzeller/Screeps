/**
 * Declarative Framework - Main Entry Point
 *
 * A second decision system, running every tick alongside the creep roles and utility
 * spawning in src/spawning. Four evaluators score options; an arbitrator resolves them.
 *
 * WHAT ACTUALLY EXECUTES - this is not uniform, and the difference matters:
 *
 *   remotes       EXECUTES. Arbitrator.executeRemote() calls ColonyManager.addRemote(),
 *                 removeRemote() and toggleRemote(), changing live colony config. This
 *                 is a real second writer to remote state, which ColonyManager's
 *                 syncRemoteRooms() also owns, on a different cadence.
 *   spawn         logs only
 *   construction  logs only
 *   military      logs only
 *
 * An earlier version of this header claimed evaluators returned empty arrays and nothing
 * executed. That was wrong, and it cost real time: every remote in the empire was paused
 * by RemoteMiningEvaluator with the reason "Hostile detected" while the main loop had no
 * indication of where the decision came from. Do not restore that claim without checking
 * Arbitrator.executeRemote().
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
import { recordShadowProposals, recordShadowScores } from "./ShadowSpawn";
import type { FrameworkAction } from "./types";
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

  logger.info("Framework", "Declarative framework initialized (remotes execute; other domains log only)");
}

/**
 * Run the declarative framework for a tick.
 * Call this from the main loop.
 *
 * Captures world state, scores options, logs decisions to telemetry, and executes the
 * domains that have real executors - currently remotes only. See the file header.
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

    // Capture the shadow domains' full ranking before arbitration collapses it to one
    // action. The winner alone cannot tell a confident choice from a flat one.
    for (const [domain, scored] of options) {
      if (evaluatorRegistry.isShadow(domain)) recordShadowScores(roomName, scored);
    }

    // Resolve conflicts into a chosen action set.
    const actions = arbitrator.resolve(options, state, colony);

    // Log decisions to telemetry
    const decisions = arbitrator.getDecisions();
    TelemetryManager.logDecisions(decisions);

    // Execute. NOT a placeholder for every domain - read Arbitrator.executeRemote()
    // before assuming otherwise. Remote actions (activate / deactivate / pause) call
    // straight into ColonyManager and change live colony config; spawn, construction and
    // military currently only log.
    //
    // This matters because it makes the framework a SECOND decision system writing to
    // the same remote config that ColonyManager.syncRemoteRooms() owns, on a different
    // cadence, with no coordination between them. The comments here previously claimed
    // nothing executed, which made an empire-wide remote shutdown look unexplained from
    // the main loop. Ownership is documented in docs/ARCHITECTURE.md.
    // Split off shadow domains. They are scored and recorded, never executed, so a
    // candidate owner can be compared with the incumbent on live data before cutover.
    const shadow: FrameworkAction[] = [];
    const live: FrameworkAction[] = [];
    for (const a of actions) {
      if (evaluatorRegistry.isShadowAction(a)) shadow.push(a);
      else live.push(a);
    }
    recordShadowProposals(roomName, shadow);

    if (live.length > 0) {
      const results = executor.execute(live, colony);

      // Probe: record what the framework actually EXECUTES, by domain and outcome.
      // The code path says all four domains execute, but observed spawns have all
      // matched utilitySpawning's choices - so one of those two readings is wrong and
      // guessing between them is how the remote shutdown went unexplained for weeks.
      const fx = (Memory as any)._fxExec || ((Memory as any)._fxExec = {});
      for (const r of results || []) {
        const key = (r.action && r.action.type) || "unknown";
        const slot = fx[key] || (fx[key] = { ok: 0, fail: 0, wait: 0, lastError: "" });
        if (r.success) slot.ok++;
        else if (r.deferred) {
          // Declined on purpose (cannot afford it yet), not a defect. Counted apart so a
          // real failure still stands out the way the 191/191 spawn failures did.
          slot.wait = (slot.wait || 0) + 1;
          if (r.error) slot.lastWait = String(r.error).slice(0, 60);
        } else {
          slot.fail++;
          if (r.error) slot.lastError = String(r.error).slice(0, 60);
        }
      }
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
