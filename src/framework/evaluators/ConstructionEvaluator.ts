/**
 * ConstructionEvaluator - Utility-based structure placement decisions
 *
 * Replaces the priority-based logic in placeStructures.ts with factor-based scoring.
 * Every structure type gets a score based on weighted factors.
 *
 * Key differences from old system:
 * - Instead of fixed priority order, scores determine what to build
 * - RCL requirements are soft penalties, not hard gates
 * - Economy health affects non-essential structures
 * - Dependencies are factors, not gates (e.g., terminal without storage gets penalized)
 *
 * Note: Extensions, Containers, and Roads are still handled by their specialized
 * planners (ExtensionPlanner, ContainerPlanner, SmartRoadPlanner). This evaluator
 * focuses on: Spawn, Tower, Storage, Link, Terminal, Extractor, Lab
 */

import {
  ScoredOption,
  FactorBreakdown,
  WorldState,
  ColonySnapshot,
  BuildAction,
} from "../types";
import { BaseEvaluator } from "../Evaluator";

// ============================================================================
// TYPES
// ============================================================================

// Structure types handled by this evaluator (not by specialized planners)
const EVALUATED_STRUCTURES = [
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_LINK,
  STRUCTURE_TERMINAL,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_LAB,
] as const;

type EvaluatedStructure = (typeof EVALUATED_STRUCTURES)[number];

// ============================================================================
// CONSTRUCTION EVALUATOR
// ============================================================================

export class ConstructionEvaluator extends BaseEvaluator<BuildAction> {
  readonly domain = "construction";

  evaluate(state: WorldState, colony: ColonySnapshot): ScoredOption<BuildAction>[] {
    const options: ScoredOption<BuildAction>[] = [];
    const w = state.weights.construction;

    // Don't evaluate construction during pioneer phase - focus on bootstrapping
    if (this.isPioneerPhase(colony)) return options;

    // Pre-compute common metrics
    const economyHealth = this.computeEconomyHealth(colony);

    for (const structureType of EVALUATED_STRUCTURES) {
      const option = this.evaluateStructureType(
        structureType,
        colony,
        state,
        economyHealth,
        w
      );
      if (option) options.push(option);
    }

    // Sort by score descending
    options.sort((a, b) => b.score - a.score);

    this.logEvaluation(colony.roomName, options);

    return options;
  }

  // ==========================================================================
  // STRUCTURE EVALUATION
  // ==========================================================================

  private evaluateStructureType(
    structureType: EvaluatedStructure,
    colony: ColonySnapshot,
    state: WorldState,
    economyHealth: number,
    w: WorldState["weights"]["construction"]
  ): ScoredOption<BuildAction> | null {
    const rcl = colony.rcl;

    // Get max allowed at this RCL
    const maxAllowed = CONTROLLER_STRUCTURES[structureType][rcl] || 0;
    if (maxAllowed === 0) return null;

    // Count existing + sites
    const existing = colony.structureCounts[structureType] || 0;
    const sites = colony.siteCounts[structureType] || 0;
    const total = existing + sites;

    // No deficit = no option
    const deficit = maxAllowed - total;
    if (deficit <= 0) return null;

    // Get type configuration
    const typeConfig = w.types[structureType];
    if (!typeConfig) return null;

    // Start with base priority
    const basePriority = w.basePriority[structureType] || 0;
    let score = basePriority;
    const factors: FactorBreakdown = {};

    // === FACTOR: Deficit ===
    // More deficit = higher score
    const deficitContribution = Math.min(deficit, 3) / 3 * w.factors.completionGap;
    this.addFactor(factors, "deficit", deficit, w.factors.completionGap, deficitContribution);
    score *= 1 + deficitContribution;

    // === FACTOR: RCL Appropriateness ===
    // Soft penalty when below recommended RCL
    const rclDelta = rcl - typeConfig.minRcl;
    const rclFactor = rclDelta >= 0 ? 1.0 : typeConfig.rclPenalty;
    this.addFactor(factors, "rcl", rcl, w.factors.rclProgress, rclFactor - 1);
    score *= rclFactor;

    // === FACTOR: Economy Health ===
    // Low economy penalizes non-essential structures
    const isEssential = this.isEssentialStructure(structureType);
    const econFactor = isEssential ? Math.max(economyHealth, 0.7) : economyHealth;
    this.addFactor(factors, "economy", economyHealth, w.factors.economyImpact, econFactor - 1);
    score *= econFactor;

    // === FACTOR: Storage Requirement ===
    // Some structures need storage first
    if (typeConfig.requiresStorage && !colony.hasStorage) {
      const noStoragePenalty = typeConfig.noStoragePenalty;
      this.addFactor(factors, "noStorage", 1, 1.0, noStoragePenalty - 1);
      score *= noStoragePenalty;
    }

    // === FACTOR: Dependencies ===
    const dependencyFactor = this.computeDependencyFactor(structureType, colony, factors);
    score *= dependencyFactor;

    // === FACTOR: Strategic Value ===
    const strategicFactor = this.computeStrategicFactor(structureType, colony, state, factors);
    score *= strategicFactor;

    // === FACTOR: Concurrent Sites ===
    // Penalize if already have max concurrent sites of this type
    if (sites >= typeConfig.maxConcurrentSites) {
      score = 0;
    }

    if (score <= 1) return null;

    return this.createOption(
      {
        type: "build",
        structureType,
        colony: colony.roomName,
      },
      `Build ${structureType} (${total}/${maxAllowed})`,
      score,
      factors
    );
  }

  // ==========================================================================
  // FACTOR COMPUTATION
  // ==========================================================================

  private isPioneerPhase(colony: ColonySnapshot): boolean {
    if (colony.hasStorage) return false;
    if (colony.rcl >= 2) return false;
    return !colony.milestones.hasSourceContainers;
  }

  private computeEconomyHealth(colony: ColonySnapshot): number {
    if (colony.harvestIncome === 0) return 0.3;
    if (colony.netFlow >= 0) return 1.0;
    return Math.max(0.2, 1 + colony.netFlow / colony.harvestIncome);
  }

  private isEssentialStructure(type: EvaluatedStructure): boolean {
    // Essential structures are always needed for colony function
    return type === STRUCTURE_SPAWN || type === STRUCTURE_TOWER || type === STRUCTURE_STORAGE;
  }

  private computeDependencyFactor(
    type: EvaluatedStructure,
    colony: ColonySnapshot,
    factors: FactorBreakdown
  ): number {
    switch (type) {
      case STRUCTURE_TERMINAL: {
        // Terminal without storage is much less useful
        if (!colony.hasStorage) {
          const penalty = 0.1;
          this.addFactor(factors, "needsStorage", 1, 1.0, penalty - 1);
          return penalty;
        }
        // Bonus if storage is well-stocked
        if (colony.energyStored > 50000) {
          const bonus = 1.3;
          this.addFactor(factors, "storageReady", colony.energyStored, 1.0, bonus - 1);
          return bonus;
        }
        return 1.0;
      }

      case STRUCTURE_LAB: {
        // Labs need terminal for minerals
        if (!colony.hasTerminal) {
          const penalty = 0.2;
          this.addFactor(factors, "needsTerminal", 1, 1.0, penalty - 1);
          return penalty;
        }
        return 1.0;
      }

      case STRUCTURE_EXTRACTOR: {
        // Extractor without storage/terminal is less useful
        if (!colony.hasStorage) {
          const penalty = 0.3;
          this.addFactor(factors, "needsStorage", 1, 1.0, penalty - 1);
          return penalty;
        }
        return 1.0;
      }

      case STRUCTURE_LINK: {
        // First link should go to controller
        // Second link should go near storage
        const linkCount = colony.linkCount;
        if (linkCount === 0) {
          // First link: boost if controller doesn't have link
          if (!colony.milestones.hasControllerLink) {
            const bonus = 1.5;
            this.addFactor(factors, "controllerLinkNeeded", 1, 1.0, bonus - 1);
            return bonus;
          }
        } else if (linkCount === 1) {
          // Second link: boost if storage doesn't have link
          if (colony.hasStorage && !colony.milestones.hasStorageLink) {
            const bonus = 1.4;
            this.addFactor(factors, "storageLinkNeeded", 1, 1.0, bonus - 1);
            return bonus;
          }
        }
        return 1.0;
      }

      default:
        return 1.0;
    }
  }

  private computeStrategicFactor(
    type: EvaluatedStructure,
    colony: ColonySnapshot,
    state: WorldState,
    factors: FactorBreakdown
  ): number {
    switch (type) {
      case STRUCTURE_TOWER: {
        // Boost tower priority if under threat
        if (colony.hostileCount > 0) {
          const threatBoost = 1 + Math.min(colony.hostileDPS * 0.02, 1.5);
          this.addFactor(factors, "threat", colony.hostileDPS, 1.0, threatBoost - 1);
          return threatBoost;
        }
        // Boost if we don't have any towers yet (critical defense)
        if (colony.towerCount === 0 && colony.rcl >= 3) {
          const firstTowerBoost = 1.5;
          this.addFactor(factors, "firstTower", 1, 1.0, firstTowerBoost - 1);
          return firstTowerBoost;
        }
        return 1.0;
      }

      case STRUCTURE_STORAGE: {
        // Storage is critical at RCL 4 - major economy upgrade
        if (colony.rcl >= 4 && !colony.hasStorage) {
          const criticalBoost = 2.0;
          this.addFactor(factors, "rcl4Storage", 1, 1.0, criticalBoost - 1);
          return criticalBoost;
        }
        return 1.0;
      }

      case STRUCTURE_SPAWN: {
        // Additional spawns are critical for large colonies
        const spawnCount = colony.structureCounts[STRUCTURE_SPAWN] || 0;
        if (spawnCount === 1 && colony.rcl >= 7) {
          // Need second spawn at RCL 7
          const boost = 1.5;
          this.addFactor(factors, "needMoreSpawns", 1, 1.0, boost - 1);
          return boost;
        }
        return 1.0;
      }

      case STRUCTURE_LINK: {
        // Links are strategic for energy distribution
        // Boost when economy is strong and we're producing excess
        if (colony.energyStored > 100000 && colony.linkCount < colony.maxLinks) {
          const boost = 1.2;
          this.addFactor(factors, "excessEnergy", colony.energyStored, 1.0, boost - 1);
          return boost;
        }
        return 1.0;
      }

      default:
        return 1.0;
    }
  }
}
