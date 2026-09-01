/**
 * Arbitrator - Conflict resolution for competing options
 *
 * Multiple evaluators compete for the same resources (spawn time, construction
 * site slots, energy). The arbitrator merges all scored options and allocates
 * resources fairly based on scores.
 */

import {
  Arbitrator,
  ScoredOption,
  FrameworkAction,
  SpawnAction,
  BuildAction,
  RemoteAction,
  MilitaryAction,
  WorldState,
  ColonySnapshot,
  DecisionLogEntry,
} from "./types";
import { logger } from "../utils/Logger";
import { buildBody, calculateCost, getMinCost, resolveSpawnEnergyBudget } from "../spawning/bodyBuilder";
import { findBuildPosition } from "../structures/placeStructures";
import { ColonyManager } from "../core/ColonyManager";
import * as MilitaryManager from "../military/MilitaryManager";

// ============================================================================
// COLONY ARBITRATOR
// ============================================================================

/**
 * Resolves conflicts between competing options for a single colony.
 */
export class ColonyArbitrator implements Arbitrator {
  private decisions: DecisionLogEntry[] = [];

  /**
   * Resolve scored options from all evaluators into executable actions.
   */
  resolve(
    options: Map<string, ScoredOption<FrameworkAction>[]>,
    state: WorldState,
    colony: ColonySnapshot
  ): FrameworkAction[] {
    const actions: FrameworkAction[] = [];
    this.decisions = [];

    // Resolve each domain
    const spawnAction = this.resolveSpawning(options.get("spawning") || [], state, colony);
    if (spawnAction) actions.push(spawnAction);

    const buildActions = this.resolveConstruction(options.get("construction") || [], state, colony);
    actions.push(...buildActions);

    const remoteActions = this.resolveRemotes(options.get("remotes") || [], state, colony);
    actions.push(...remoteActions);

    const militaryActions = this.resolveMilitary(options.get("military") || [], state, colony);
    actions.push(...militaryActions);

    return actions;
  }

  /**
   * Get decisions made this tick (for telemetry)
   */
  getDecisions(): DecisionLogEntry[] {
    return this.decisions;
  }

  // ========== SPAWNING RESOLUTION ==========

  private resolveSpawning(
    options: ScoredOption<FrameworkAction>[],
    state: WorldState,
    colony: ColonySnapshot
  ): FrameworkAction | null {
    if (options.length === 0) return null;

    // Check if spawn is available
    const room = Game.rooms[colony.roomName];
    if (!room) return null;

    const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
    if (!spawn) return null;

    // Pick highest scored option
    const sorted = [...options].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    // Only spawn if score is above threshold
    if (winner.score < 10) {
      return null;
    }

    // Log the decision
    this.logDecision(state.tick, colony.roomName, "spawning", winner, sorted.slice(1, 4));

    return winner.action;
  }

  // ========== CONSTRUCTION RESOLUTION ==========

  private resolveConstruction(
    options: ScoredOption<FrameworkAction>[],
    state: WorldState,
    colony: ColonySnapshot
  ): FrameworkAction[] {
    const actions: FrameworkAction[] = [];

    if (options.length === 0) return actions;

    // Calculate available construction site budget
    const maxSites = 100; // Game limit per player
    const currentSites = colony.constructionSites.length;
    let siteBudget = Math.min(5, maxSites - currentSites); // Max 5 new sites per tick

    if (siteBudget <= 0) return actions;

    // Sort by score
    const sorted = [...options].sort((a, b) => b.score - a.score);

    // Pick top N options up to budget
    for (const option of sorted) {
      if (siteBudget <= 0) break;
      if (option.score < 5) break; // Minimum score threshold

      const buildAction = option.action as BuildAction;

      // Check if we already have too many sites of this type
      const typeConfig = state.weights.construction.types[buildAction.structureType];
      const currentTypeSites = colony.siteCounts[buildAction.structureType] || 0;
      const maxConcurrent = typeConfig?.maxConcurrentSites || 3;

      if (currentTypeSites >= maxConcurrent) continue;

      actions.push(option.action);
      siteBudget--;

      // Log the decision
      this.logDecision(state.tick, colony.roomName, "construction", option, []);
    }

    return actions;
  }

  // ========== REMOTE MINING RESOLUTION ==========

  private resolveRemotes(
    options: ScoredOption<FrameworkAction>[],
    state: WorldState,
    colony: ColonySnapshot
  ): FrameworkAction[] {
    const actions: FrameworkAction[] = [];

    if (options.length === 0) return actions;

    // Sort by score
    const sorted = [...options].sort((a, b) => b.score - a.score);

    // Get max active remotes from weights
    const maxActive = state.weights.remotes.maxActive;
    let currentActive = colony.activeRemoteCount;

    for (const option of sorted) {
      const remoteAction = option.action as RemoteAction;

      if (remoteAction.type === "activate_remote") {
        // Only activate if under limit and score is high enough
        if (currentActive >= maxActive) continue;
        if (option.score < 30) continue; // Minimum score for activation

        actions.push(option.action);
        currentActive++;

        this.logDecision(state.tick, colony.roomName, "remotes", option, []);
      } else if (remoteAction.type === "deactivate_remote") {
        // Deactivate if score is very low
        if (option.score > 20) continue;

        actions.push(option.action);
        currentActive--;

        this.logDecision(state.tick, colony.roomName, "remotes", option, []);
      } else if (remoteAction.type === "pause_remote") {
        // Pause actions always execute (usually due to hostiles)
        actions.push(option.action);
        this.logDecision(state.tick, colony.roomName, "remotes", option, []);
      }
    }

    return actions;
  }

  // ========== MILITARY RESOLUTION ==========

  private resolveMilitary(
    options: ScoredOption<FrameworkAction>[],
    state: WorldState,
    colony: ColonySnapshot
  ): FrameworkAction[] {
    const actions: FrameworkAction[] = [];

    if (options.length === 0) return actions;

    // Sort by score
    const sorted = [...options].sort((a, b) => b.score - a.score);

    // Execute high-priority military actions
    for (const option of sorted) {
      if (option.score < 50) break; // Military actions need high confidence

      const militaryAction = option.action as MilitaryAction;

      // Only one attack action per tick
      if (militaryAction.type === "attack" && actions.some((a) => (a as MilitaryAction).type === "attack")) {
        continue;
      }

      actions.push(option.action);
      this.logDecision(state.tick, colony.roomName, "military", option, []);
    }

    return actions;
  }

  // ========== DECISION LOGGING ==========

  private logDecision(
    tick: number,
    colony: string,
    domain: string,
    chosen: ScoredOption<FrameworkAction>,
    alternatives: ScoredOption<FrameworkAction>[]
  ): void {
    this.decisions.push({
      tick,
      colony,
      domain,
      chosen: {
        action: chosen.label,
        score: chosen.score,
        factors: chosen.factors,
      },
      alternatives: alternatives.map((alt) => ({
        action: alt.label,
        score: alt.score,
      })),
    });
  }
}

// ============================================================================
// ACTION EXECUTOR
// ============================================================================

/**
 * Executes resolved actions.
 * This is the only place where game API mutations happen.
 */
export class ActionExecutor {
  /**
   * Execute all resolved actions for a colony
   */
  execute(actions: FrameworkAction[], colony: ColonySnapshot): ExecutionResult[] {
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      try {
        const result = this.executeAction(action, colony);
        results.push(result);
      } catch (error) {
        logger.error("Executor", `Error executing action: ${error}`);
        results.push({
          action,
          success: false,
          error: String(error),
        });
      }
    }

    return results;
  }

  private executeAction(action: FrameworkAction, colony: ColonySnapshot): ExecutionResult {
    switch (action.type) {
      case "spawn":
        return this.executeSpawn(action as SpawnAction, colony);
      case "build":
        return this.executeBuild(action as BuildAction, colony);
      case "activate_remote":
      case "deactivate_remote":
      case "pause_remote":
        return this.executeRemote(action as RemoteAction, colony);
      case "attack":
      case "defend":
      case "retreat":
      case "patrol":
        return this.executeMilitary(action as MilitaryAction, colony);
      default:
        return { action, success: false, error: "Unknown action type" };
    }
  }

  private executeSpawn(action: SpawnAction, colony: ColonySnapshot): ExecutionResult {
    const room = Game.rooms[colony.roomName];
    if (!room) {
      return { action, success: false, error: "Room not visible" };
    }

    // Find available spawn
    const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
    if (!spawn) {
      return { action, success: false, error: "No available spawn" };
    }

    // Check minimum energy for role
    const minCost = getMinCost(action.role);
    if (room.energyAvailable < minCost) {
      return {
        action,
        success: false,
        deferred: true,
        error: `Waiting for energy (need ${minCost}, have ${room.energyAvailable})`,
      };
    }

    // Build body based on available energy
    // Same budget resolution utilitySpawning uses. Sizing to energyCapacityAvailable is
    // why this executor failed 191 times out of 191: E43N39 never reaches capacity, so a
    // capacity-sized body was never affordable and the framework never spawned anything.
    const counts = { HARVESTER: 0, HAULER: 0 };
    for (const n in Game.creeps) {
      const c = Game.creeps[n];
      if (c.memory.room !== colony.roomName) continue;
      if (c.memory.role === "HARVESTER") counts.HARVESTER++;
      else if (c.memory.role === "HAULER") counts.HAULER++;
    }

    const ctrl = room.controller;
    const downgradeMax = ctrl ? CONTROLLER_DOWNGRADE[ctrl.level] || 0 : 0;
    const downgradeRisk =
      !!ctrl && downgradeMax > 0 && ctrl.ticksToDowngrade < downgradeMax * 0.5;

    const budget = resolveSpawnEnergyBudget({
      role: action.role,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      energyStored: room.storage ? room.storage.store[RESOURCE_ENERGY] : 0,
      harvesterCount: counts.HARVESTER,
      haulerCount: counts.HAULER,
      downgradeRisk,
    });

    const body = buildBody(action.role, budget.energy);
    if (body.length === 0) {
      return { action, success: false, error: `Failed to build body for ${action.role}` };
    }

    // The "wait for capacity" budget deliberately sizes above what the room holds right
    // now. Attempting that spawn is guaranteed ERR_NOT_ENOUGH_ENERGY, so decline it here
    // rather than burning an intent and logging a failure every tick.
    const cost = calculateCost(body);
    if (cost > room.energyAvailable) {
      return {
        action,
        success: false,
        deferred: true,
        error: `Waiting for ${cost} (${budget.reason}), have ${room.energyAvailable}`,
      };
    }

    // Create unique name
    const name = `${action.role}_${Game.time}`;

    // Set up memory - merge any action-provided memory
    const memory: CreepMemory = {
      role: action.role,
      room: colony.roomName,
      ...action.memory,
    } as CreepMemory;

    // Attempt to spawn
    const result = spawn.spawnCreep(body, name, { memory });

    if (result === OK) {
      logger.info("Executor", `[${colony.roomName}] Spawning ${action.role} (framework)`);
      return { action, success: true };
    } else if (result === ERR_NOT_ENOUGH_ENERGY) {
      return { action, success: false, error: "Not enough energy" };
    } else {
      return { action, success: false, error: `Spawn failed: ${result}` };
    }
  }

  private executeBuild(action: BuildAction, colony: ColonySnapshot): ExecutionResult {
    const room = Game.rooms[colony.roomName];
    if (!room) {
      return { action, success: false, error: "Room not visible" };
    }

    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) {
      return { action, success: false, error: "No spawn found" };
    }

    // Use position from action if provided, otherwise find one
    let pos: { x: number; y: number } | null = action.pos || null;
    if (!pos) {
      pos = findBuildPosition(room, spawn.pos, action.structureType);
    }

    if (!pos) {
      return { action, success: false, error: `No valid position for ${action.structureType}` };
    }

    // Create construction site
    const result = room.createConstructionSite(pos.x, pos.y, action.structureType);

    if (result === OK) {
      logger.info("Executor", `[${colony.roomName}] Placing ${action.structureType} at (${pos.x},${pos.y}) (framework)`);
      return { action, success: true };
    } else if (result === ERR_FULL) {
      return { action, success: false, error: "Max construction sites reached" };
    } else if (result === ERR_INVALID_TARGET) {
      return { action, success: false, error: "Invalid target position" };
    } else if (result === ERR_RCL_NOT_ENOUGH) {
      return { action, success: false, error: "RCL not high enough" };
    } else {
      return { action, success: false, error: `Build failed: ${result}` };
    }
  }

  private executeRemote(action: RemoteAction, colony: ColonySnapshot): ExecutionResult {
    const manager = ColonyManager.getInstance(colony.roomName);
    if (!manager) {
      return { action, success: false, error: "Colony manager not found" };
    }

    switch (action.type) {
      case "activate_remote": {
        // No `|| 1` fallback: inventing a distance is worse than having none, because
        // addRemote now measures it. Pass the hint through only if the evaluator has one.
        // Proposing a remote that is already configured is a no-op, not a failure. Left
        // undistinguished it read as 622 failures against 21 successes and buried the
        // genuine rejections (a room past maxDistance) inside the noise - the same
        // mislabelling that let executeSpawn's 191/191 sit unexplained.
        const existing = manager.getRemote(action.room);

        // Discovery belongs to ColonyManager.syncRemoteRooms(), which owns validity,
        // distance, cap and overlap; this evaluator owns pause-on-threat and reactivation
        // (docs/ARCHITECTURE.md). Adding rooms from here crossed that line and looped:
        // the evaluator re-proposed E45N41 every tick, addRemote rejected it on distance
        // every tick, and neither side remembered. Staying in lane ends the loop without
        // needing a rejection cache.
        if (!existing) {
          return {
            action,
            success: false,
            deferred: true,
            error: `${action.room} not in remote config - discovery is syncRemoteRooms' job`,
          };
        }

        if (existing.active) {
          return { action, success: false, deferred: true, error: "Remote already active" };
        }

        // Respect a deliberate indefinite pause; an expiring one is syncRemoteRooms' to clear.
        if (existing.pauseReason && !existing.pausedUntil) {
          return { action, success: false, deferred: true, error: "Remote deliberately paused" };
        }

        const success = manager.toggleRemote(action.room);
        if (success) {
          logger.info("Executor", `[${colony.roomName}] Reactivated remote ${action.room} (framework)`);
          return { action, success: true };
        }
        return { action, success: false, error: `Could not reactivate ${action.room}` };
      }

      case "deactivate_remote": {
        const success = manager.removeRemote(action.room);
        if (success) {
          logger.info("Executor", `[${colony.roomName}] Deactivated remote ${action.room} (framework)`);
          return { action, success: true };
        }
        return { action, success: false, error: "Failed to deactivate remote" };
      }

      case "pause_remote": {
        const success = manager.toggleRemote(action.room, action.reason);
        if (success) {
          logger.info("Executor", `[${colony.roomName}] Paused remote ${action.room}: ${action.reason} (framework)`);
          return { action, success: true };
        }
        return { action, success: false, error: "Failed to pause remote" };
      }

      default:
        return { action, success: false, error: "Unknown remote action type" };
    }
  }

  private executeMilitary(action: MilitaryAction, colony: ColonySnapshot): ExecutionResult {
    switch (action.type) {
      case "attack": {
        // Create a new attack campaign via MilitaryManager
        const result = MilitaryManager.createCampaign({
          type: "CONTROLLER_ATTACK",
          targetRoom: action.targetRoom,
        });

        if (result === "ERROR") {
          return { action, success: false, error: "Failed to create attack campaign" };
        }

        logger.info("Executor", `[${colony.roomName}] Launched attack campaign against ${action.targetRoom} (framework)`);
        return { action, success: true, note: `Campaign ID: ${result}` };
      }

      case "defend": {
        // Defense is handled by existing tower/defender systems
        // The framework just signals the need - ColonyManager handles spawning defenders
        logger.debug("Executor", `[${colony.roomName}] Defense mode - existing systems active`);
        return { action, success: true, note: "Defense handled by existing systems" };
      }

      case "retreat": {
        // Retreat would pause/abort active campaigns
        const mem = MilitaryManager.getMilitaryMemory();
        let paused = 0;
        for (const id in mem.campaigns) {
          const campaign = mem.campaigns[id];
          if (campaign.state !== "COMPLETE" && campaign.state !== "ABORTED" && campaign.state !== "PAUSED") {
            MilitaryManager.pauseCampaign(id);
            paused++;
          }
        }

        if (paused > 0) {
          logger.info("Executor", `[${colony.roomName}] Paused ${paused} campaign(s) for retreat`);
        }
        return { action, success: true, note: `Paused ${paused} campaigns` };
      }

      case "patrol": {
        // Patrol would be handled by spawning defender/patrol creeps
        // The existing remote defense system handles this
        logger.debug("Executor", `[${colony.roomName}] Patrol requested for ${action.targetRoom}`);
        return { action, success: true, note: "Patrol handled by existing remote defense" };
      }

      default:
        return { action, success: false, error: "Unknown military action type" };
    }
  }
}

export interface ExecutionResult {
  action: FrameworkAction;
  success: boolean;
  error?: string;
  note?: string;
  /**
   * True when the action was correctly declined rather than attempted and failed - e.g.
   * a spawn deferred because the room cannot afford the body yet. Kept distinct from
   * `success` so the failure count stays a real defect signal: a framework that relabels
   * its deadlocks as successes cannot tell you it is deadlocked.
   */
  deferred?: boolean;
}

// ============================================================================
// GLOBAL INSTANCES
// ============================================================================

export const arbitrator = new ColonyArbitrator();
export const executor = new ActionExecutor();
