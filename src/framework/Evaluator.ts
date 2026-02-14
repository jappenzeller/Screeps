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
  // Phase 2: Real SpawnEvaluator
  evaluatorRegistry.register(new SpawnEvaluator());

  // Phase 3: Real ConstructionEvaluator
  evaluatorRegistry.register(new ConstructionEvaluator());

  // Phase 4: Real RemoteMiningEvaluator
  evaluatorRegistry.register(new RemoteMiningEvaluator());

  // Phase 5: Real MilitaryEvaluator
  evaluatorRegistry.register(new MilitaryEvaluator());

  logger.info("Evaluator", "Initialized evaluator registry (Phase 2-5: Spawn + Construction + Remotes + Military active)");
}
