/**
 * SpawnEvaluator - Utility-based spawning decisions
 *
 * Replaces the gate-based logic in utilitySpawning.ts with factor-based scoring.
 * Every role gets a score based on weighted factors. No hardcoded gates.
 *
 * Key differences from old system:
 * - Instead of `if (isPioneerPhase) return 0`, pioneer phase is a factor
 * - Instead of `if (rcl < 4) return 0`, RCL is a soft penalty factor
 * - Economy health is a multiplicative factor, not a gate
 * - minCount guarantees ensure critical roles always score above threshold
 */

import {
  ScoredOption,
  FactorBreakdown,
  WorldState,
  ColonySnapshot,
  SpawnAction,
} from "../types";
import { BaseEvaluator } from "../BaseEvaluator";

// ============================================================================
// TYPES
// ============================================================================

// Home room roles - don't need targetRoom in memory
const HOME_ROLES = [
  "PIONEER",
  "HARVESTER",
  "HAULER",
  "FILLER",
  "UPGRADER",
  "BUILDER",
  "DEFENDER",
  "SCOUT",
  "LINK_FILLER",
  "MINERAL_HARVESTER",
  "ROAD_BUILDER",
] as const;

// Remote roles - need targetRoom in memory
const REMOTE_ROLES = [
  "REMOTE_MINER",
  "REMOTE_HAULER",
  "REMOTE_BUILDER",
  "REMOTE_DEFENDER",
  "RESERVER",
] as const;

// Expansion role - handled separately
const EXPANSION_ROLES = ["CLAIMER"] as const;

// Combined for backwards compatibility
const ALL_ROLES = [...HOME_ROLES, ...REMOTE_ROLES, ...EXPANSION_ROLES] as const;

type SpawnRole = (typeof ALL_ROLES)[number];

// ============================================================================
// SPAWN EVALUATOR
// ============================================================================

export class SpawnEvaluator extends BaseEvaluator<SpawnAction> {
  readonly domain = "spawning";

  evaluate(state: WorldState, colony: ColonySnapshot): ScoredOption<SpawnAction>[] {
    const options: ScoredOption<SpawnAction>[] = [];
    const w = state.weights.spawning;

    // Pre-compute common metrics
    const isPioneer = this.isPioneerPhase(colony);
    const economyHealth = this.computeEconomyHealth(colony);

    // Process home roles
    for (const role of HOME_ROLES) {
      const option = this.evaluateHomeRole(role, colony, state, isPioneer, economyHealth, w);
      if (option) options.push(option);
    }

    // Process remote roles (per-remote options)
    this.evaluateRemoteRoles(options, colony, state, isPioneer, economyHealth, w);

    // Skip expansion roles (CLAIMER) - handled by expansion system

    // Sort by score descending
    options.sort((a, b) => b.score - a.score);

    this.logEvaluation(colony.roomName, options);

    return options;
  }

  // ==========================================================================
  // HOME ROLE EVALUATION
  // ==========================================================================

  private evaluateHomeRole(
    role: string,
    colony: ColonySnapshot,
    state: WorldState,
    isPioneer: boolean,
    economyHealth: number,
    w: WorldState["weights"]["spawning"]
  ): ScoredOption<SpawnAction> | null {
    const roleConfig = w.roles[role];
    if (!roleConfig) return null;

    // Compute target for this role
    const target = this.computeTarget(role, colony, state);
    const current = colony.counts[role] || 0;
    const dyingSoon = colony.dyingSoon[role] || 0;
    const effectiveDeficit = target - current + dyingSoon;

    // Start with base priority
    const basePriority = w.basePriority[role] || 0;
    let score = basePriority;
    const factors: FactorBreakdown = {};

    // === FACTOR: Deficit ===
    const deficitContribution = this.computeDeficitContribution(effectiveDeficit, w.factors.deficit);
    this.addFactor(factors, "deficit", effectiveDeficit, w.factors.deficit, deficitContribution);
    score *= 1 + deficitContribution;

    // === FACTOR: Economy Health ===
    const isEconomyRole = ["HARVESTER", "HAULER", "PIONEER", "FILLER"].includes(role);
    const econFactor = isEconomyRole ? Math.max(economyHealth, 0.8) : economyHealth;
    this.addFactor(factors, "economy", economyHealth, w.factors.economy, econFactor - 1);
    score *= econFactor;

    // === FACTOR: RCL Appropriateness ===
    const rclDelta = colony.rcl - roleConfig.minRcl;
    const rclFactor = rclDelta >= 0 ? 1.0 : roleConfig.rclPenalty;
    this.addFactor(factors, "rcl", colony.rcl, w.factors.rcl, rclFactor - 1);
    score *= rclFactor;

    // === FACTOR: Pioneer Phase ===
    if (isPioneer && !["PIONEER", "DEFENDER"].includes(role)) {
      const pioneerPenalty = 0.05;
      this.addFactor(factors, "pioneerPhase", 1, 1.0, pioneerPenalty - 1);
      score *= pioneerPenalty;
    }

    // === FACTOR: Threat Boost ===
    if (colony.hostileCount > 0 && role === "DEFENDER") {
      const threatFactor = 1 + Math.min(colony.hostileDPS * 0.01, 2);
      this.addFactor(factors, "threat", colony.hostileDPS, w.factors.threat, threatFactor - 1);
      score *= threatFactor;
    }

    // === EXCLUSION: no target ===
    // Not a factor of zero but an absence of candidacy. Expressing "never spawn this"
    // as a score annihilates it inside the same product that carries every other signal,
    // which is indistinguishable from a genuine input reading zero. Returning null says
    // it plainly and keeps the score meaningful for everything that IS a candidate.
    if (target === 0) return null;

    // === FACTOR: Saturation ===
    if (current > 0 && target > 0) {
      const satRatio = current / target;
      const satFactor = satRatio >= 1.0 ? 0.1 : 1 - satRatio * w.factors.saturation;
      this.addFactor(factors, "saturation", satRatio, w.factors.saturation, satFactor - 1);
      score *= Math.max(0.05, satFactor);
    }

    // === FACTOR: Role-Specific ===
    const roleMultiplier = this.computeRoleSpecificFactor(role, colony, state, factors);
    score *= roleMultiplier;

    // === FLOOR: minCount guarantee ===
    // minCount stays: it is a floor expressed as a boost, not a competing target.
    if (current < roleConfig.minCount) {
      score = Math.max(score, basePriority * 0.8);
      this.addFactor(factors, "minCountBoost", roleConfig.minCount - current, 1.0, 0.5);
    }

    // maxCount deliberately does NOT gate here.
    //
    // It was a second target table. `targets` already says how many of a role the colony
    // wants, and the saturation factor above already scores down past it - so maxCount
    // answering the same question with a different number just meant the two disagreed.
    // Concretely: SCOUT.maxCount was 1 while E46N37 ran 2 scouts, so the evaluator
    // excluded SCOUT entirely and proposed nothing on the ticks the live system spawned
    // one. Targets are the single authority; a role's ceiling belongs in
    // core/ColonyTargets where its target is computed, not in a parallel table.

    if (score <= 1) return null;

    return this.createOption(
      { type: "spawn", role, colony: colony.roomName },
      `Spawn ${role} (${current}/${target})`,
      score,
      factors
    );
  }

  // ==========================================================================
  // REMOTE ROLE EVALUATION
  // ==========================================================================

  private evaluateRemoteRoles(
    options: ScoredOption<SpawnAction>[],
    colony: ColonySnapshot,
    state: WorldState,
    isPioneer: boolean,
    economyHealth: number,
    w: WorldState["weights"]["spawning"]
  ): void {
    // Skip remote roles during pioneer phase
    if (isPioneer) return;

    // Gate: need stable home economy before remote mining
    const harvesterCount = colony.counts["HARVESTER"] || 0;
    const haulerCount = colony.counts["HAULER"] || 0;
    if (harvesterCount < 2 || haulerCount < 1) return;

    for (const remote of colony.remotes) {
      if (!remote.active || remote.paused) continue;

      // Evaluate REMOTE_MINER for this remote
      const minerOption = this.evaluateRemoteRole(
        "REMOTE_MINER",
        remote,
        colony,
        state,
        economyHealth,
        w
      );
      if (minerOption) options.push(minerOption);

      // Evaluate REMOTE_HAULER for this remote
      const haulerOption = this.evaluateRemoteRole(
        "REMOTE_HAULER",
        remote,
        colony,
        state,
        economyHealth,
        w
      );
      if (haulerOption) options.push(haulerOption);

      // Evaluate RESERVER for this remote
      const reserverOption = this.evaluateRemoteRole(
        "RESERVER",
        remote,
        colony,
        state,
        economyHealth,
        w
      );
      if (reserverOption) options.push(reserverOption);

      // Evaluate REMOTE_BUILDER if remote needs containers
      if (!remote.hasContainers) {
        const builderOption = this.evaluateRemoteRole(
          "REMOTE_BUILDER",
          remote,
          colony,
          state,
          economyHealth,
          w
        );
        if (builderOption) options.push(builderOption);
      }

      // Evaluate REMOTE_DEFENDER if hostiles present
      if (remote.hostilePresent) {
        const defenderOption = this.evaluateRemoteRole(
          "REMOTE_DEFENDER",
          remote,
          colony,
          state,
          economyHealth,
          w
        );
        if (defenderOption) options.push(defenderOption);
      }
    }
  }

  private evaluateRemoteRole(
    role: string,
    remote: ColonySnapshot["remotes"][0],
    colony: ColonySnapshot,
    state: WorldState,
    economyHealth: number,
    w: WorldState["weights"]["spawning"]
  ): ScoredOption<SpawnAction> | null {
    const roleConfig = w.roles[role];
    if (!roleConfig) return null;

    // Compute target and current for this specific remote
    const { target, current } = this.computeRemoteRoleCounts(role, remote, colony);
    const effectiveDeficit = target - current;

    if (effectiveDeficit <= 0) return null;

    // Start with base priority
    const basePriority = w.basePriority[role] || 0;
    let score = basePriority;
    const factors: FactorBreakdown = {};

    // === FACTOR: Deficit ===
    const deficitContribution = this.computeDeficitContribution(effectiveDeficit, w.factors.deficit);
    this.addFactor(factors, "deficit", effectiveDeficit, w.factors.deficit, deficitContribution);
    score *= 1 + deficitContribution;

    // === FACTOR: Economy Health ===
    this.addFactor(factors, "economy", economyHealth, w.factors.economy, economyHealth - 1);
    score *= economyHealth;

    // === FACTOR: Distance Penalty ===
    const distance = remote.distance ?? 1;
    const distancePenalty = Math.max(0.5, 1 - distance * 0.15);
    this.addFactor(factors, "distance", distance, 1.0, distancePenalty - 1);
    score *= distancePenalty;

    // === FACTOR: Threat ===
    if (role === "REMOTE_DEFENDER" && remote.hostilePresent) {
      const threatBoost = 1.5;
      this.addFactor(factors, "threat", 1, w.factors.threat, threatBoost - 1);
      score *= threatBoost;
    }

    if (score <= 1) return null;

    return this.createOption(
      {
        type: "spawn",
        role,
        colony: colony.roomName,
        memory: { targetRoom: remote.roomName },
      },
      `Spawn ${role} -> ${remote.roomName} (${current}/${target})`,
      score,
      factors
    );
  }

  private computeRemoteRoleCounts(
    role: string,
    remote: ColonySnapshot["remotes"][0],
    colony: ColonySnapshot
  ): { target: number; current: number } {
    // Count current creeps assigned to this remote
    const currentForRemote = colony.creeps.filter(
      (c) => c.role === role && (c as any).targetRoom === remote.roomName
    ).length;

    switch (role) {
      case "REMOTE_MINER":
        return { target: remote.sources, current: remote.minerCount };
      case "REMOTE_HAULER": {
        const target = remote.distance >= 2 ? 3 : 2;
        return { target, current: remote.haulerCount };
      }
      case "RESERVER":
        return { target: remote.hasReserver ? 0 : 1, current: remote.hasReserver ? 1 : 0 };
      case "REMOTE_BUILDER":
        return { target: remote.hasContainers ? 0 : 1, current: currentForRemote };
      case "REMOTE_DEFENDER":
        return { target: remote.hostilePresent ? 1 : 0, current: currentForRemote };
      default:
        return { target: 0, current: 0 };
    }
  }

  // ==========================================================================
  // TARGET COMPUTATION
  // ==========================================================================

  /**
   * How many of this role the colony wants.
   *
   * This used to be a switch of the evaluator's own devising, parallel to
   * utilitySpawning's getCreepTargets(). The two disagreed: over 20,265 ticks of shadow
   * comparison the evaluator proposed nothing on 870 of the ticks where a spawn actually
   * happened - 62% - because its target came back 0 where the live system wanted a creep.
   * E46N37's SCOUT was the clearest case. That made the comparison measure schema drift
   * rather than judgement.
   *
   * A target is a fact about the colony, not a policy of whichever module asks, so both
   * spawners now read the one answer from core/ColonyTargets via the snapshot.
   */
  private computeTarget(role: string, colony: ColonySnapshot, _state: WorldState): number {
    return colony.targets[role] || 0;
  }








  // ==========================================================================
  // FACTOR COMPUTATION
  // ==========================================================================

  private isPioneerPhase(colony: ColonySnapshot): boolean {
    // Pioneer phase: RCL 1, no source containers, no storage
    if (colony.hasStorage) return false;
    if (colony.rcl >= 2) return false;
    return !colony.milestones.hasSourceContainers;
  }

  private computeEconomyHealth(colony: ColonySnapshot): number {
    if (colony.harvestIncome === 0) return 0.3; // Dead economy
    if (colony.netFlow >= 0) return 1.0; // Positive flow = healthy

    // Negative flow: scale down
    return Math.max(0.2, 1 + colony.netFlow / colony.harvestIncome);
  }

  private computeRoleSpecificFactor(
    role: string,
    colony: ColonySnapshot,
    state: WorldState,
    factors: FactorBreakdown
  ): number {
    switch (role) {
      case "HARVESTER": {
        // Boost when income is critically low
        if (colony.harvestIncome < colony.maxHarvestIncome * 0.3) {
          const scarcityBoost = 1.5;
          this.addFactor(factors, "incomeScarcity", colony.harvestIncome, 1.0, scarcityBoost - 1);
          return scarcityBoost;
        }
        return 1.0;
      }

      case "HAULER": {
        // Boost when no haulers exist but harvesters do
        const harvesterCount = colony.counts["HARVESTER"] || 0;
        const haulerCount = colony.counts["HAULER"] || 0;
        if (harvesterCount > 0 && haulerCount === 0 && colony.harvestIncome > 0) {
          const criticalBoost = 1.5;
          this.addFactor(factors, "noHaulers", 1, 1.0, criticalBoost - 1);
          return criticalBoost;
        }
        return 1.0;
      }

      case "UPGRADER": {
        // First upgrader in early colony is critical
        const upgraderCount = colony.counts["UPGRADER"] || 0;
        if (colony.rcl <= 3 && !colony.hasStorage && upgraderCount === 0) {
          const firstUpgraderBoost = 1.5;
          this.addFactor(factors, "firstUpgrader", 1, 1.0, firstUpgraderBoost - 1);
          return firstUpgraderBoost;
        }
        return 1.0;
      }

      case "BUILDER": {
        // Boost for first builder when sites exist
        const builderCount = colony.counts["BUILDER"] || 0;
        if (builderCount === 0 && colony.constructionSites.length > 0) {
          const firstBuilderBoost = 1.3;
          this.addFactor(factors, "firstBuilder", 1, 1.0, firstBuilderBoost - 1);
          return firstBuilderBoost;
        }
        return 1.0;
      }

      case "REMOTE_MINER":
      case "REMOTE_HAULER": {
        // Gate on home economy stability
        const harvesterCount = colony.counts["HARVESTER"] || 0;
        const haulerCount = colony.counts["HAULER"] || 0;
        if (harvesterCount < 2 || haulerCount < 1) {
          const homeEconomyPenalty = 0.1;
          this.addFactor(factors, "homeEconomyWeak", 1, 1.0, homeEconomyPenalty - 1);
          return homeEconomyPenalty;
        }
        return 1.0;
      }

      default:
        return 1.0;
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private computeDeficitContribution(deficit: number, weight: number): number {
    if (deficit <= 0) return -0.5 * weight; // Surplus = negative contribution
    return Math.min(deficit, 3) / 3 * weight; // Cap at 3 deficit
  }
}
