/**
 * MilitaryEvaluator - Utility-based military decisions
 *
 * Replaces manual military.attack() calls with automated decisions.
 * Evaluates attack opportunities and defense needs with weighted factors.
 *
 * Key features:
 * - Evaluates potential attack targets from intel
 * - Evaluates defense needs based on colony threat levels
 * - Factors: threat level, strategic value, win probability, economic impact
 * - Respects empire-wide military capacity
 *
 * Note: This evaluator produces MilitaryAction options. The Arbitrator decides
 * which actions to execute based on scores and constraints.
 */

import {
  ScoredOption,
  FactorBreakdown,
  WorldState,
  ColonySnapshot,
  MilitaryAction,
  ThreatLevel,
} from "../types";
import { BaseEvaluator } from "../Evaluator";
import * as CampaignChain from "../../military/CampaignChain";
import * as MilitaryManager from "../../military/MilitaryManager";

// ============================================================================
// MILITARY EVALUATOR
// ============================================================================

export class MilitaryEvaluator extends BaseEvaluator<MilitaryAction> {
  readonly domain = "military";

  evaluate(state: WorldState, colony: ColonySnapshot): ScoredOption<MilitaryAction>[] {
    const options: ScoredOption<MilitaryAction>[] = [];
    const w = state.weights.military;

    // Get military memory state
    const militaryMem = MilitaryManager.getMilitaryMemory();

    // === DEFENSE EVALUATION ===
    // Check if this colony needs defense
    const defenseOption = this.evaluateDefense(colony, state, w);
    if (defenseOption) options.push(defenseOption);

    // === ATTACK EVALUATION ===
    // Only consider attacks if:
    // 1. No active campaigns (one at a time)
    // 2. Colony is stable (RCL 4+, good economy)
    // 3. Empire posture allows offensive action
    const activeCampaigns = Object.values(militaryMem.campaigns).filter(
      (c) => c.state !== "COMPLETE" && c.state !== "ABORTED"
    );

    if (activeCampaigns.length === 0 && this.canLaunchAttack(colony, state)) {
      const attackOptions = this.evaluateAttackTargets(colony, state, w);
      options.push(...attackOptions);
    }

    // === PATROL EVALUATION ===
    // Consider patrols for high-value remotes
    const patrolOption = this.evaluatePatrol(colony, state, w);
    if (patrolOption) options.push(patrolOption);

    // Sort by score descending
    options.sort((a, b) => b.score - a.score);

    this.logEvaluation(colony.roomName, options);

    return options;
  }

  // ==========================================================================
  // DEFENSE EVALUATION
  // ==========================================================================

  private evaluateDefense(
    colony: ColonySnapshot,
    state: WorldState,
    w: WorldState["weights"]["military"]
  ): ScoredOption<MilitaryAction> | null {
    // No threat = no defense needed
    if (colony.threatLevel === ThreatLevel.NONE) return null;

    const factors: FactorBreakdown = {};
    let score = 0;

    // Base score from threat level
    switch (colony.threatLevel) {
      case ThreatLevel.LOW:
        score = 20;
        break;
      case ThreatLevel.MEDIUM:
        score = 50;
        break;
      case ThreatLevel.HIGH:
        score = 80;
        break;
      case ThreatLevel.CRITICAL:
        score = 100;
        break;
    }

    // Factor: Threat level weight
    const threatContribution = (colony.threatLevel / 4) * w.factors.threatLevel;
    this.addFactor(factors, "threatLevel", colony.threatLevel, w.factors.threatLevel, threatContribution);
    score *= 1 + threatContribution;

    // Factor: Strategic value of colony
    // Higher RCL = more strategic value
    const strategicValue = colony.rcl / 8;
    const strategicContribution = strategicValue * w.factors.strategicValue;
    this.addFactor(factors, "strategicValue", colony.rcl, w.factors.strategicValue, strategicContribution);
    score *= 1 + strategicContribution;

    // Factor: Economic loss if colony falls
    // More stored energy = more to lose
    const economicValue = Math.min(colony.energyStored / 100000, 1);
    const economicContribution = economicValue * w.factors.economicLoss;
    this.addFactor(factors, "economicLoss", colony.energyStored, w.factors.economicLoss, economicContribution);
    score *= 1 + economicContribution;

    // Factor: Spawn under attack = critical priority
    if (colony.spawnUnderAttack) {
      const spawnThreatBoost = 2.0;
      this.addFactor(factors, "spawnThreat", 1, 1.0, spawnThreatBoost - 1);
      score *= spawnThreatBoost;
    }

    // Cap score at 100
    score = Math.min(100, score);

    // Determine priority
    let priority: "CRITICAL" | "HIGH" | "NORMAL" = "NORMAL";
    if (colony.threatLevel >= ThreatLevel.CRITICAL || colony.spawnUnderAttack) {
      priority = "CRITICAL";
    } else if (colony.threatLevel >= ThreatLevel.HIGH) {
      priority = "HIGH";
    }

    return this.createOption(
      {
        type: "defend",
        targetRoom: colony.roomName,
        homeRoom: colony.roomName,
        priority,
      },
      `Defend ${colony.roomName} (threat: ${ThreatLevel[colony.threatLevel]})`,
      score,
      factors
    );
  }

  // ==========================================================================
  // ATTACK EVALUATION
  // ==========================================================================

  private canLaunchAttack(colony: ColonySnapshot, state: WorldState): boolean {
    // Minimum requirements for launching an attack
    if (colony.rcl < 4) return false; // Need CLAIM parts capability
    if (colony.threatLevel >= ThreatLevel.MEDIUM) return false; // Don't attack while under threat
    if (!colony.hasStorage) return false; // Need economic stability

    // Need sufficient energy reserves
    const targetReserve = state.weights.economy.storageTargets[colony.rcl] || 50000;
    if (colony.energyStored < targetReserve * 0.7) return false;

    // Check economy health
    const economyHealth = this.computeEconomyHealth(colony);
    if (economyHealth < 0.8) return false;

    return true;
  }

  private evaluateAttackTargets(
    colony: ColonySnapshot,
    state: WorldState,
    w: WorldState["weights"]["military"]
  ): ScoredOption<MilitaryAction>[] {
    const options: ScoredOption<MilitaryAction>[] = [];

    // Get potential targets from CampaignChain
    const targets = CampaignChain.evaluateTargets();

    for (const target of targets) {
      const option = this.evaluateAttackTarget(target, colony, state, w);
      if (option) options.push(option);
    }

    return options;
  }

  private evaluateAttackTarget(
    target: CampaignChain.CampaignTarget,
    colony: ColonySnapshot,
    state: WorldState,
    w: WorldState["weights"]["military"]
  ): ScoredOption<MilitaryAction> | null {
    const factors: FactorBreakdown = {};

    // Check if this colony can reach the target
    const route = Game.map.findRoute(colony.roomName, target.roomName);
    if (route === ERR_NO_PATH || !Array.isArray(route) || route.length > 7) {
      return null; // Too far for CLAIM creeps
    }

    // CLAIM creeps only last 600 ticks, need time buffer
    if (route.length * 50 > 450) return null;

    // Base score starts moderate
    let score = 40;

    // Factor: Strategic value (eliminating threats, gaining territory)
    // Lower RCL targets are easier, but higher RCL targets may be more valuable to eliminate
    const strategicValue = target.threatLevel === "HIGH" ? 0.8 : target.threatLevel === "MEDIUM" ? 0.5 : 0.3;
    const strategicContribution = strategicValue * w.factors.strategicValue;
    this.addFactor(factors, "strategicValue", target.rcl, w.factors.strategicValue, strategicContribution);
    score *= 1 + strategicContribution;

    // Factor: Win probability (based on threat level and distance)
    let winProb = 1.0;
    if (target.threatLevel === "HIGH") winProb = 0.3;
    else if (target.threatLevel === "MEDIUM") winProb = 0.6;
    else winProb = 0.9;

    // Distance reduces win probability (creep decay)
    winProb *= Math.max(0.5, 1 - target.distance * 0.1);

    const winContribution = winProb * w.factors.winProbability;
    this.addFactor(factors, "winProbability", winProb, w.factors.winProbability, winContribution);
    score *= 1 + winContribution;

    // Factor: Threat level penalty
    // Harder targets get lower scores
    let threatPenalty = 1.0;
    if (target.threatLevel === "HIGH") {
      threatPenalty = 0.3;
      this.addFactor(factors, "highThreat", target.towers, w.factors.threatLevel, threatPenalty - 1);
      score *= threatPenalty;
    } else if (target.threatLevel === "MEDIUM") {
      threatPenalty = 0.7;
      this.addFactor(factors, "mediumThreat", target.towers, w.factors.threatLevel, threatPenalty - 1);
      score *= threatPenalty;
    }

    // Factor: Distance penalty
    const distancePenalty = Math.max(0.5, 1 - target.distance * 0.15);
    this.addFactor(factors, "distance", target.distance, 1.0, distancePenalty - 1);
    score *= distancePenalty;

    // Factor: No towers = easier target
    if (target.towers === 0) {
      const noTowersBoost = 1.5;
      this.addFactor(factors, "noTowers", 0, 1.0, noTowersBoost - 1);
      score *= noTowersBoost;
    }

    // Factor: Low RCL = easy target
    if (target.rcl <= 3) {
      const lowRclBoost = 1.3;
      this.addFactor(factors, "lowRcl", target.rcl, 1.0, lowRclBoost - 1);
      score *= lowRclBoost;
    }

    // Factor: Close proximity = territorial threat
    if (target.distance <= 2) {
      const proximityBoost = 1.4;
      this.addFactor(factors, "proximity", target.distance, 1.0, proximityBoost - 1);
      score *= proximityBoost;
    }

    // Factor: Terminal present = can resupply towers (harder)
    if (target.terminalPresent) {
      const terminalPenalty = 0.7;
      this.addFactor(factors, "terminal", 1, 1.0, terminalPenalty - 1);
      score *= terminalPenalty;
    }

    // Cap score at 100
    score = Math.min(100, score);

    // Only suggest attacks above threshold
    if (score < 35) return null;

    // Determine priority
    let priority: "CRITICAL" | "HIGH" | "NORMAL" = "NORMAL";
    if (target.distance <= 2 && target.threatLevel === "LOW") {
      priority = "HIGH";
    }

    return this.createOption(
      {
        type: "attack",
        targetRoom: target.roomName,
        homeRoom: colony.roomName,
        priority,
      },
      `Attack ${target.roomName} (${target.owner}, RCL ${target.rcl}, ${target.threatLevel})`,
      score,
      factors
    );
  }

  // ==========================================================================
  // PATROL EVALUATION
  // ==========================================================================

  private evaluatePatrol(
    colony: ColonySnapshot,
    state: WorldState,
    w: WorldState["weights"]["military"]
  ): ScoredOption<MilitaryAction> | null {
    // Only patrol if we have active remotes and sufficient economy
    if (colony.activeRemoteCount === 0) return null;
    if (colony.rcl < 5) return null; // Need sufficient military capacity

    // Check if any remotes recently had hostile activity
    let hostileRemoteCount = 0;
    let mostDangerousRemote: string | null = null;

    for (const remote of colony.remotes) {
      if (remote.hostilePresent) {
        hostileRemoteCount++;
        mostDangerousRemote = remote.roomName;
      }
    }

    // No hostile activity = no patrol needed
    if (hostileRemoteCount === 0) return null;

    const factors: FactorBreakdown = {};
    let score = 25; // Base patrol score

    // Factor: Number of threatened remotes
    const threatContribution = Math.min(hostileRemoteCount / 3, 1) * w.factors.threatLevel;
    this.addFactor(factors, "hostileRemotes", hostileRemoteCount, w.factors.threatLevel, threatContribution);
    score *= 1 + threatContribution;

    // Factor: Economic value of remotes at risk
    const remoteIncome = colony.remotes.reduce((sum, r) => sum + (r.active ? r.estimatedIncome : 0), 0);
    const economicContribution = Math.min(remoteIncome / 20, 1) * w.factors.economicLoss;
    this.addFactor(factors, "remoteIncome", remoteIncome, w.factors.economicLoss, economicContribution);
    score *= 1 + economicContribution;

    // Only patrol if score is significant
    if (score < 30) return null;

    return this.createOption(
      {
        type: "patrol",
        targetRoom: mostDangerousRemote || colony.roomName,
        homeRoom: colony.roomName,
        priority: "NORMAL",
      },
      `Patrol remotes (${hostileRemoteCount} hostile)`,
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
}
