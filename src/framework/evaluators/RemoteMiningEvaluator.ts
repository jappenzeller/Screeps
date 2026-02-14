/**
 * RemoteMiningEvaluator - Utility-based remote mining decisions
 *
 * Replaces manual addRemote()/removeRemote() calls with automated decisions.
 * Every potential remote room gets a score based on weighted factors.
 *
 * Key features:
 * - Evaluates existing remotes for deactivation/pause
 * - Evaluates potential remotes (from intel) for activation
 * - Factors: distance, source count, safety, profitability, colony capacity
 * - Respects maxActive limit from WeightTable
 *
 * Note: This evaluator produces RemoteAction options. The Arbitrator decides
 * which actions to execute based on scores and constraints.
 */

import {
  ScoredOption,
  FactorBreakdown,
  WorldState,
  ColonySnapshot,
  RemoteAction,
  RoomIntelSnapshot,
} from "../types";
import { BaseEvaluator } from "../BaseEvaluator";

// ============================================================================
// REMOTE MINING EVALUATOR
// ============================================================================

export class RemoteMiningEvaluator extends BaseEvaluator<RemoteAction> {
  readonly domain = "remotes";

  evaluate(state: WorldState, colony: ColonySnapshot): ScoredOption<RemoteAction>[] {
    const options: ScoredOption<RemoteAction>[] = [];
    const w = state.weights.remotes;

    // Don't evaluate remotes in early game
    if (colony.rcl < 3) return options;

    // Don't evaluate if economy is struggling
    const economyHealth = this.computeEconomyHealth(colony);
    if (economyHealth < 0.5) return options;

    // Evaluate existing remotes for pause/deactivate
    for (const remote of colony.remotes) {
      // Check for pause (hostile present)
      if (remote.active && !remote.paused && remote.hostilePresent) {
        const pauseOption = this.evaluatePause(remote, colony, state, w);
        if (pauseOption) options.push(pauseOption);
      }

      // Check for deactivation (underperforming)
      if (remote.active && !remote.paused) {
        const deactivateOption = this.evaluateDeactivate(remote, colony, state, economyHealth, w);
        if (deactivateOption) options.push(deactivateOption);
      }
    }

    // Evaluate potential new remotes from intel
    const potentialRemotes = this.findPotentialRemotes(colony, state);
    for (const intel of potentialRemotes) {
      const activateOption = this.evaluateActivate(intel, colony, state, economyHealth, w);
      if (activateOption) options.push(activateOption);
    }

    // Sort by score descending
    options.sort((a, b) => b.score - a.score);

    this.logEvaluation(colony.roomName, options);

    return options;
  }

  // ==========================================================================
  // PAUSE EVALUATION
  // ==========================================================================

  private evaluatePause(
    remote: ColonySnapshot["remotes"][0],
    colony: ColonySnapshot,
    state: WorldState,
    w: WorldState["weights"]["remotes"]
  ): ScoredOption<RemoteAction> | null {
    // High score for pausing when hostiles present
    const factors: FactorBreakdown = {};
    let score = 80; // Base high score for safety

    // Boost for immediate threat
    const threatBoost = 1.5;
    this.addFactor(factors, "hostileThreat", 1, w.factors.safety, threatBoost - 1);
    score *= threatBoost;

    return this.createOption(
      {
        type: "pause_remote",
        room: remote.roomName,
        colony: colony.roomName,
        reason: "Hostile detected",
      },
      `Pause ${remote.roomName} (hostile)`,
      score,
      factors
    );
  }

  // ==========================================================================
  // DEACTIVATE EVALUATION
  // ==========================================================================

  private evaluateDeactivate(
    remote: ColonySnapshot["remotes"][0],
    colony: ColonySnapshot,
    state: WorldState,
    economyHealth: number,
    w: WorldState["weights"]["remotes"]
  ): ScoredOption<RemoteAction> | null {
    const factors: FactorBreakdown = {};
    let score = 10; // Base low score - we don't want to deactivate easily

    // Factor: Profitability
    // Estimate profit = income - hauler cost
    const estimatedProfit = this.estimateProfit(remote, colony);
    if (estimatedProfit <= 0) {
      // Unprofitable - boost deactivation score
      const unprofitablePenalty = 3.0;
      this.addFactor(factors, "unprofitable", estimatedProfit, w.factors.profitability, unprofitablePenalty - 1);
      score *= unprofitablePenalty;
    } else {
      // Profitable - reduce deactivation score significantly
      const profitFactor = 0.1;
      this.addFactor(factors, "profitable", estimatedProfit, w.factors.profitability, profitFactor - 1);
      score *= profitFactor;
    }

    // Factor: Distance penalty for far remotes
    if (remote.distance >= 2) {
      const distancePenalty = 1 + remote.distance * 0.3;
      this.addFactor(factors, "distance", remote.distance, Math.abs(w.factors.distance), distancePenalty - 1);
      score *= distancePenalty;
    }

    // Factor: Economy stress - deactivate far remotes when economy is struggling
    if (economyHealth < 0.7 && remote.distance >= 2) {
      const economyPressure = 2.0;
      this.addFactor(factors, "economyPressure", economyHealth, 1.0, economyPressure - 1);
      score *= economyPressure;
    }

    // Factor: Over capacity - deactivate if we have too many active remotes
    const activeCount = colony.activeRemoteCount;
    const maxActive = state.weights.remotes.maxActive;
    if (activeCount > maxActive) {
      const overCapacity = 2.5;
      this.addFactor(factors, "overCapacity", activeCount - maxActive, 1.0, overCapacity - 1);
      score *= overCapacity;
    }

    // Only suggest deactivation if score is high enough
    if (score < 20) return null;

    return this.createOption(
      {
        type: "deactivate_remote",
        room: remote.roomName,
        colony: colony.roomName,
        reason: "Underperforming",
      },
      `Deactivate ${remote.roomName} (score: ${score.toFixed(1)})`,
      score,
      factors
    );
  }

  // ==========================================================================
  // ACTIVATE EVALUATION
  // ==========================================================================

  private evaluateActivate(
    intel: RoomIntelSnapshot,
    colony: ColonySnapshot,
    state: WorldState,
    economyHealth: number,
    w: WorldState["weights"]["remotes"]
  ): ScoredOption<RemoteAction> | null {
    const factors: FactorBreakdown = {};

    // Base priority from weights
    let score = 30;

    // Check if already at max active
    const activeCount = colony.activeRemoteCount;
    const maxActive = state.weights.remotes.maxActive;
    if (activeCount >= maxActive) {
      return null; // Don't activate if at capacity
    }

    // Factor: Source count (more = better)
    const sourceBonus = 1 + (intel.sources - 1) * w.factors.sourceCount * 0.5;
    this.addFactor(factors, "sources", intel.sources, w.factors.sourceCount, sourceBonus - 1);
    score *= sourceBonus;

    // Factor: Distance (closer = better)
    const distance = intel.distanceFromHome;
    const distancePenalty = Math.max(0.3, 1 + distance * w.factors.distance * 0.3);
    this.addFactor(factors, "distance", distance, Math.abs(w.factors.distance), distancePenalty - 1);
    score *= distancePenalty;

    // Factor: Minimum sources by distance
    const minSources = w.minSources[distance] || 1;
    if (intel.sources < minSources) {
      // Not enough sources for this distance - heavy penalty
      const insufficientSources = 0.1;
      this.addFactor(factors, "insufficientSources", intel.sources, 1.0, insufficientSources - 1);
      score *= insufficientSources;
    }

    // Factor: Safety (no hostiles = better)
    if (intel.hostile || intel.invaderCore) {
      const safetyPenalty = 0.2;
      this.addFactor(factors, "hostile", intel.hostileCount, w.factors.safety, safetyPenalty - 1);
      score *= safetyPenalty;
    } else {
      const safetyBonus = 1.2;
      this.addFactor(factors, "safe", 0, w.factors.safety, safetyBonus - 1);
      score *= safetyBonus;
    }

    // Factor: Economy health - only activate when economy is strong
    if (economyHealth < 0.8) {
      const economyPenalty = economyHealth;
      this.addFactor(factors, "economy", economyHealth, 1.0, economyPenalty - 1);
      score *= economyPenalty;
    }

    // Factor: Colony capacity (RCL determines how many remotes we can handle)
    const rclCapacity = this.getRclCapacity(colony.rcl);
    if (activeCount >= rclCapacity) {
      // At capacity for this RCL
      const capacityPenalty = 0.1;
      this.addFactor(factors, "rclCapacity", activeCount, 1.0, capacityPenalty - 1);
      score *= capacityPenalty;
    }

    // Factor: Storage requirement for distance 2+
    if (distance >= 2 && !colony.hasStorage) {
      const noStoragePenalty = 0.2;
      this.addFactor(factors, "noStorage", 1, 1.0, noStoragePenalty - 1);
      score *= noStoragePenalty;
    }

    // Only suggest activation if score is high enough
    if (score < 30) return null;

    return this.createOption(
      {
        type: "activate_remote",
        room: intel.roomName,
        colony: colony.roomName,
        distance: distance,
      },
      `Activate ${intel.roomName} (${intel.sources} src, dist ${distance})`,
      score,
      factors
    );
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  private computeEconomyHealth(colony: ColonySnapshot): number {
    if (colony.harvestIncome === 0) return 0.3;
    if (colony.netFlow >= 0) return 1.0;
    return Math.max(0.2, 1 + colony.netFlow / colony.harvestIncome);
  }

  private estimateProfit(remote: ColonySnapshot["remotes"][0], colony: ColonySnapshot): number {
    // Estimate income: sources * 10 energy/tick
    const income = remote.sources * 10;

    // Estimate hauler cost: based on distance and carry capacity
    // Rough estimate: more distance = more haulers needed
    const haulerCost = remote.distance * 2; // Energy equivalent per tick

    return income - haulerCost;
  }

  private getRclCapacity(rcl: number): number {
    // How many active remotes can we handle at each RCL?
    if (rcl <= 2) return 0;
    if (rcl === 3) return 1;
    if (rcl === 4) return 2;
    if (rcl === 5) return 3;
    if (rcl === 6) return 4;
    if (rcl >= 7) return 5;
    return 0;
  }

  private findPotentialRemotes(
    colony: ColonySnapshot,
    state: WorldState
  ): RoomIntelSnapshot[] {
    const potentials: RoomIntelSnapshot[] = [];
    const existingRemotes = new Set(colony.remotes.map((r) => r.roomName));

    // Check intel for nearby rooms that could be remotes
    for (const [roomName, intel] of state.intel) {
      // Skip if already a remote
      if (existingRemotes.has(roomName)) continue;

      // Skip owned rooms
      if (intel.owner) continue;

      // Skip source keeper rooms
      if (intel.roomType === "sourceKeeper") continue;

      // Skip center/highway rooms
      if (intel.roomType !== "normal") continue;

      // Skip if no sources
      if (intel.sources === 0) continue;

      // Skip if too far (distance > 2)
      if (intel.distanceFromHome > 2) continue;

      // Skip if stale intel (older than 10000 ticks)
      if (Game.time - intel.lastScanned > 10000) continue;

      potentials.push(intel);
    }

    // Sort by distance, then sources
    potentials.sort((a, b) => {
      if (a.distanceFromHome !== b.distanceFromHome) {
        return a.distanceFromHome - b.distanceFromHome;
      }
      return b.sources - a.sources;
    });

    return potentials;
  }
}
