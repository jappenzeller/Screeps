/**
 * Evaluator - Registry and initialization for utility-based decision evaluators
 *
 * Each evaluator owns one decision domain. It reads WorldState + WeightTable
 * and produces scored options. It never executes anything.
 */

import {
  ScoredOption,
  WorldState,
  ColonySnapshot,
  FrameworkAction,
} from "./types";
import { logger } from "../utils/Logger";

// Re-export BaseEvaluator and FactorUtils for backwards compatibility
export { BaseEvaluator, FactorUtils } from "./BaseEvaluator";

// Import BaseEvaluator for use in this file
import { BaseEvaluator } from "./BaseEvaluator";

// Import evaluators (after BaseEvaluator is defined to avoid circular deps)
// Retained for future migration - see initializeEvaluators()
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { SpawnEvaluator } from "./evaluators/SpawnEvaluator";
import { ConstructionEvaluator } from "./evaluators/ConstructionEvaluator";
import { RemoteMiningEvaluator } from "./evaluators/RemoteMiningEvaluator";
import { MilitaryEvaluator } from "./evaluators/MilitaryEvaluator";

// ============================================================================
// EVALUATOR REGISTRY
// ============================================================================

/**
 * Registry of all evaluators
 */
class EvaluatorRegistry {
  private evaluators: Map<string, BaseEvaluator<FrameworkAction>> = new Map();

  /**
   * Register an evaluator
   */
  register<T extends FrameworkAction>(evaluator: BaseEvaluator<T>): void {
    this.evaluators.set(evaluator.domain, evaluator as BaseEvaluator<FrameworkAction>);
  }

  /**
   * Get an evaluator by domain
   */
  get(domain: string): BaseEvaluator<FrameworkAction> | undefined {
    return this.evaluators.get(domain);
  }

  /**
   * Get all evaluators
   */
  getAll(): BaseEvaluator<FrameworkAction>[] {
    return Array.from(this.evaluators.values());
  }

  /**
   * Evaluate all domains for a colony
   */
  evaluateAll(
    state: WorldState,
    colony: ColonySnapshot
  ): Map<string, ScoredOption<FrameworkAction>[]> {
    const results = new Map<string, ScoredOption<FrameworkAction>[]>();

    for (const [domain, evaluator] of this.evaluators) {
      try {
        const options = evaluator.evaluate(state, colony);
        results.set(domain, options);
      } catch (error) {
        logger.error("Evaluator", `Error in ${domain} evaluator: ${error}`);
        results.set(domain, []);
      }
    }

    return results;
  }
}

// Global registry instance
export const evaluatorRegistry = new EvaluatorRegistry();

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize all evaluators
 */
export function initializeEvaluators(): void {
  // ONLY remotes. This is a deliberate scoping decision, not an unfinished migration.
  //
  // The framework duplicates four domains that already have working owners, and its
  // executors are real - every action type routes to something that acts. Measuring what
  // it actually achieved over ~140 ticks settled it:
  //
  //   spawn   0 ok / 191 fail  "Not enough energy"
  //   build   0 ok / 101 fail  "No valid position for lab"
  //   defend  7 ok /   0 fail  - and every success is a no-op that logs and returns true
  //   remote  acts for real, and is the only arm doing useful work
  //
  // So three of four arms produced ~292 failed operations per 140 ticks, every tick,
  // forever. Worse, the spawn arm was not idle by design: it runs BEFORE spawnCreeps and
  // failed only because its minCost gate is stricter than utilitySpawning's body sizing.
  // Had energy ever cleared that bar it would have spawned a creep of its own choosing
  // ahead of the real spawner. The military arm's attack path likewise creates a real
  // MilitaryManager campaign.
  //
  // Registering only the remote evaluator gives every domain exactly one owner:
  //   spawning     -> utilitySpawning
  //   construction -> the planners + ConstructionCoordinator
  //   military     -> MilitaryManager
  //   remotes      -> ColonyManager (config, cap, expiry) + this (threat pausing)
  //
  // The other three evaluators are kept on disk, not deleted - they are a reasonable
  // design that was never finished, and re-registering one is a single line if a domain
  // is ever genuinely migrated. What is not acceptable is a second system half-owning a
  // domain while failing silently.
  evaluatorRegistry.register(new RemoteMiningEvaluator());

  logger.info("Evaluator", "Evaluator registry: remotes only (see initializeEvaluators for why)");
}
