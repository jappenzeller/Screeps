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

/** Maps each action type to the evaluator domain that produces it. */
const ACTION_DOMAIN: Record<string, string> = {
  spawn: "spawning",
  build: "construction",
  activate_remote: "remotes",
  deactivate_remote: "remotes",
  pause_remote: "remotes",
  attack: "military",
  defend: "military",
  retreat: "military",
  patrol: "military",
};

/**
 * Registry of all evaluators
 */
class EvaluatorRegistry {
  private evaluators: Map<string, BaseEvaluator<FrameworkAction>> = new Map();

  /**
   * Domains that are scored but never executed. Shadow domains let a candidate owner run
   * against live state and be compared with the incumbent before it is trusted with the
   * room - the framework's spawn arm looked healthy in code review and failed 191 times
   * out of 191 in production, which is the argument for measuring instead of reasoning.
   */
  private shadowDomains: Set<string> = new Set();

  /**
   * Register an evaluator
   */
  register<T extends FrameworkAction>(evaluator: BaseEvaluator<T>): void {
    this.evaluators.set(evaluator.domain, evaluator as BaseEvaluator<FrameworkAction>);
  }

  /**
   * Register an evaluator that is scored and logged but whose actions are never executed.
   */
  registerShadow<T extends FrameworkAction>(evaluator: BaseEvaluator<T>): void {
    this.register(evaluator);
    this.shadowDomains.add(evaluator.domain);
  }

  /** True when the domain is scored for comparison only. */
  isShadow(domain: string): boolean {
    return this.shadowDomains.has(domain);
  }

  /**
   * True when an action came from a shadow domain. Action types and domain names differ
   * (a "spawn" action comes from the "spawning" domain), so the mapping is explicit
   * rather than inferred - guessing it would silently execute what should be shadowed.
   */
  isShadowAction(action: FrameworkAction): boolean {
    return this.shadowDomains.has(ACTION_DOMAIN[action.type] || action.type);
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

  // Spawning is the first domain being migrated back. It runs in SHADOW: scored every
  // tick against live state, compared with what utilitySpawning actually spawns, and
  // never executed. Read the comparison with fxShadow(). Promote it to register() only
  // once the two agree - see docs/ARCHITECTURE.md, "Framework migration".
  evaluatorRegistry.registerShadow(new SpawnEvaluator());

  logger.info(
    "Evaluator",
    "Evaluator registry: remotes execute, spawn shadows (see initializeEvaluators)"
  );
}
