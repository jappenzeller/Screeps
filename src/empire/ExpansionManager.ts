/**
 * ExpansionManager - Handles colony expansion lifecycle
 * Per empire-architecture.md Module 2: Expansion Manager
 *
 * State machine: IDLE → EVALUATING → QUEUED → CLAIMING → BOOTSTRAPPING → INTEGRATING → COMPLETE
 */

import { eventBus } from "./EventBus";
import { getConfig } from "./EmpireConfig";
import {
  EmpireExpansionState,
  ExpansionStateType,
  initializeEmpireMemory,
} from "./EmpireMemory";
import { SpawnPlacementCalculator } from "./SpawnPlacementCalculator";
import { RoomEvaluator, RoomScore } from "./RoomEvaluator";
import { ExpansionReadiness, ReadinessCheck } from "./ExpansionReadiness";

export class ExpansionManager {
  private config = getConfig().expansion;

  constructor() {
    initializeEmpireMemory();
  }

  /**
   * Main run loop - call every tick
   */
  run(): void {
    const expansions = Memory.empire!.expansion!.active;

    for (const roomName in expansions) {
      const state = expansions[roomName];
      this.syncBootstrapCreeps(state); // Discover untracked creeps first
      this.cleanupDeadCreeps(state); // Then remove dead ones
      this.runStateMachine(state);
    }

    // Check for queued expansions
    this.processQueue();
  }

  /**
   * Start a new expansion
   */
  startExpansion(targetRoom: string, parentRoom: string): boolean {
    // Validate: only one active at a time
    const activeCount = Object.keys(Memory.empire!.expansion!.active).length;
    if (activeCount >= this.config.maxSimultaneous) {
      console.log(
        `[Expansion] Cannot start: ${activeCount} active (max ${this.config.maxSimultaneous})`
      );
      return false;
    }

    // Validate parent colony
    const parent = Game.rooms[parentRoom];
    if (!parent?.controller?.my) {
      console.log(`[Expansion] Parent ${parentRoom} not owned`);
      return false;
    }

    if (parent.controller.level < this.config.minParentRCL) {
      console.log(
        `[Expansion] Parent RCL ${parent.controller.level} < ${this.config.minParentRCL}`
      );
      return false;
    }

    const reserves = this.getStoredEnergy(parent);
    if (reserves < this.config.minReserves) {
      console.log(`[Expansion] Parent reserves ${reserves} < ${this.config.minReserves}`);
      return false;
    }

    // Validate GCL
    const ownedRooms = Object.values(Game.rooms).filter((r) => r.controller?.my).length;
    if (ownedRooms >= Game.gcl.level) {
      console.log(`[Expansion] GCL ${Game.gcl.level} doesn't allow more rooms`);
      return false;
    }

    // Determine initial state
    const targetVision = Game.rooms[targetRoom];
    const alreadyClaimed = targetVision?.controller?.my;

    const initialState: ExpansionStateType = alreadyClaimed ? "BOOTSTRAPPING" : "CLAIMING";

    Memory.empire!.expansion!.active[targetRoom] = {
      roomName: targetRoom,
      parentRoom,
      state: initialState,
      startedAt: Game.time,
      stateChangedAt: Game.time,
      attempts: 1,
      claimer: null,
      bootstrapCreeps: [],
      spawnSiteId: null,
      spawnSitePos: null,
      blockers: [],
      lastFailure: null,
    };

    console.log(`[Expansion] Started ${targetRoom} from ${parentRoom} (state: ${initialState})`);
    return true;
  }

  /**
   * Get spawning needs for active expansions
   * Uses PIONEER role - self-sufficient creeps that harvest and build
   */
  getSpawnRequests(
    parentRoom: string
  ): Array<{ role: string; memory: Partial<CreepMemory>; priority: number }> {
    const requests: Array<{ role: string; memory: Partial<CreepMemory>; priority: number }> = [];

    for (const roomName in Memory.empire!.expansion!.active) {
      const state = Memory.empire!.expansion!.active[roomName];
      if (state.parentRoom !== parentRoom) continue;

      // CRITICAL: Sync creeps before counting to avoid over-spawning
      this.syncBootstrapCreeps(state);

      // CLAIMING state: need claimer
      if (state.state === "CLAIMING" && !state.claimer) {
        requests.push({
          role: "CLAIMER",
          memory: { role: "CLAIMER", room: parentRoom, targetRoom: roomName },
          priority: 90,
        });
      }

      // BOOTSTRAPPING state: need pioneers (self-sufficient expansion builders)
      if (state.state === "BOOTSTRAPPING") {
        // Count pioneers
        const pioneers = state.bootstrapCreeps.filter((n) => {
          const role = Game.creeps[n]?.memory.role;
          return role === "PIONEER";
        }).length;

        // Target: builderCount pioneers (haulers are no longer needed - pioneers are self-sufficient)
        const targetPioneers = this.config.builderCount;

        for (let i = pioneers; i < targetPioneers; i++) {
          requests.push({
            role: "PIONEER",
            memory: {
              role: "PIONEER",
              room: parentRoom,
              targetRoom: roomName,
              parentRoom: parentRoom,
            },
            priority: 85,
          });
        }
      }
    }

    return requests;
  }

  /**
   * Register a spawned creep with expansion system
   */
  registerCreep(creepName: string, role: string, targetRoom: string): void {
    const state = Memory.empire!.expansion!.active[targetRoom];
    if (!state) return;

    if (role === "CLAIMER") {
      state.claimer = creepName;
      console.log(`[Expansion] Registered claimer ${creepName} for ${targetRoom}`);
    } else if (role === "PIONEER") {
      if (!state.bootstrapCreeps.includes(creepName)) {
        state.bootstrapCreeps.push(creepName);
        console.log(`[Expansion] Registered pioneer ${creepName} for ${targetRoom}`);
      }
    }
  }

  /**
   * Cancel an expansion in progress
   */
  cancelExpansion(targetRoom: string): boolean {
    const state = Memory.empire!.expansion!.active[targetRoom];
    if (!state) {
      // Check queue
      const queueIndex = Memory.empire!.expansion!.queue.findIndex((q) => q.target === targetRoom);
      if (queueIndex >= 0) {
        Memory.empire!.expansion!.queue.splice(queueIndex, 1);
        console.log(`[Expansion] Removed ${targetRoom} from queue`);
        return true;
      }
      console.log(`[Expansion] No expansion found for ${targetRoom}`);
      return false;
    }

    // Kill bootstrap creeps
    for (const name of state.bootstrapCreeps) {
      const creep = Game.creeps[name];
      if (creep) creep.suicide();
    }
    if (state.claimer && Game.creeps[state.claimer]) {
      Game.creeps[state.claimer].suicide();
    }

    delete Memory.empire!.expansion!.active[targetRoom];
    console.log(`[Expansion] Cancelled ${targetRoom}`);
    return true;
  }

  // === STATE MACHINE ===

  private runStateMachine(state: EmpireExpansionState): void {
    switch (state.state) {
      case "CLAIMING":
        this.runClaiming(state);
        break;
      case "BOOTSTRAPPING":
        this.runBootstrapping(state);
        break;
      case "INTEGRATING":
        this.runIntegrating(state);
        break;
      case "COMPLETE":
        this.completeExpansion(state);
        break;
      case "FAILED":
        this.handleFailure(state);
        break;
    }
  }

  private transitionTo(state: EmpireExpansionState, newState: ExpansionStateType): void {
    console.log(`[Expansion] ${state.roomName}: ${state.state} -> ${newState}`);
    state.state = newState;
    state.stateChangedAt = Game.time;
  }

  private runClaiming(state: EmpireExpansionState): void {
    const room = Game.rooms[state.roomName];

    // Check if claimed
    if (room?.controller?.my) {
      eventBus.emit("ROOM_CLAIMED", state.roomName);
      this.transitionTo(state, "BOOTSTRAPPING");
      return;
    }

    // Check timeout
    const elapsed = Game.time - state.stateChangedAt;
    if (elapsed > this.config.claimerTimeout) {
      state.lastFailure = `Claiming timeout after ${elapsed} ticks`;
      this.transitionTo(state, "FAILED");
      return;
    }

    // Log progress
    if (elapsed % 500 === 0 && elapsed > 0) {
      console.log(
        `[Expansion] Claiming ${state.roomName}... ${elapsed}/${this.config.claimerTimeout}`
      );
    }
  }

  private runBootstrapping(state: EmpireExpansionState): void {
    const room = Game.rooms[state.roomName];

    // Lost visibility - wait for creeps to restore
    if (!room) {
      if ((Game.time - state.stateChangedAt) % 100 === 0) {
        console.log(`[Expansion] Waiting for visibility to ${state.roomName}...`);
      }
      return;
    }

    // Check if spawn exists
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (spawn) {
      eventBus.emit("SPAWN_BUILT", state.roomName);
      this.transitionTo(state, "INTEGRATING");
      return;
    }

    // Place spawn site if needed
    if (!state.spawnSitePos) {
      const calculator = new SpawnPlacementCalculator(room);
      const result = calculator.calculate();

      if (!result.pos) {
        state.lastFailure = "No valid spawn position";
        this.transitionTo(state, "FAILED");
        return;
      }

      const createResult = room.createConstructionSite(result.pos.x, result.pos.y, STRUCTURE_SPAWN);
      if (createResult === OK) {
        state.spawnSitePos = { x: result.pos.x, y: result.pos.y };
        console.log(`[Expansion] Placed spawn site at ${result.pos}`);
      } else {
        state.lastFailure = `createConstructionSite: ${createResult}`;
        this.transitionTo(state, "FAILED");
        return;
      }
    }

    // Update spawn site ID
    if (!state.spawnSiteId && state.spawnSitePos) {
      const site = room
        .lookForAt(LOOK_CONSTRUCTION_SITES, state.spawnSitePos.x, state.spawnSitePos.y)
        .find((s) => s.structureType === STRUCTURE_SPAWN);
      if (site) {
        state.spawnSiteId = site.id;
      }
    }

    // Log progress
    if (Game.time % 200 === 0) {
      const site = state.spawnSiteId
        ? Game.getObjectById(state.spawnSiteId as Id<ConstructionSite>)
        : null;
      if (site) {
        const pct = ((site.progress / site.progressTotal) * 100).toFixed(1);
        const pioneers = state.bootstrapCreeps.filter((n) => {
          const role = Game.creeps[n]?.memory.role;
          return role === "PIONEER";
        }).length;
        console.log(`[Expansion] ${state.roomName} spawn: ${pct}% (${pioneers} pioneers)`);
      }
    }

    // Check timeout
    const elapsed = Game.time - state.stateChangedAt;
    if (elapsed > this.config.bootstrapTimeout) {
      state.lastFailure = `Bootstrap timeout after ${elapsed} ticks`;
      this.transitionTo(state, "FAILED");
    }
  }

  private runIntegrating(state: EmpireExpansionState): void {
    const room = Game.rooms[state.roomName];
    if (!room?.controller?.my) {
      state.lastFailure = "Lost room control";
      this.transitionTo(state, "FAILED");
      return;
    }

    // Check self-sufficiency: RCL 2 + local economy
    const localCreeps = Object.values(Game.creeps).filter(
      (c) => c.memory.room === state.roomName && c.room.name === state.roomName
    );
    const hasHarvester = localCreeps.some((c) => c.memory.role === "HARVESTER");
    const hasHauler = localCreeps.some((c) => c.memory.role === "HAULER");

    if (room.controller.level >= 2 && hasHarvester && hasHauler) {
      this.transitionTo(state, "COMPLETE");
      return;
    }

    // Log status
    if (Game.time % 500 === 0) {
      console.log(
        `[Expansion] Integrating ${state.roomName}: RCL ${room.controller.level}, H:${hasHarvester}, U:${hasHauler}`
      );
    }
  }

  private completeExpansion(state: EmpireExpansionState): void {
    Memory.empire!.expansion!.history[state.roomName] = {
      completedAt: Game.time,
      success: true,
      duration: Game.time - state.startedAt,
    };

    eventBus.emit("EXPANSION_COMPLETE", state.roomName);
    console.log(`[Expansion] ${state.roomName} COMPLETE (${Game.time - state.startedAt} ticks)`);

    delete Memory.empire!.expansion!.active[state.roomName];
  }

  private handleFailure(state: EmpireExpansionState): void {
    state.attempts++;

    if (state.attempts <= this.config.maxAttempts) {
      console.log(
        `[Expansion] Retry ${state.attempts}/${this.config.maxAttempts} for ${state.roomName}`
      );

      // Reset to appropriate state
      const room = Game.rooms[state.roomName];
      if (room?.controller?.my) {
        this.transitionTo(state, "BOOTSTRAPPING");
      } else {
        this.transitionTo(state, "CLAIMING");
      }
    } else {
      Memory.empire!.expansion!.history[state.roomName] = {
        completedAt: Game.time,
        success: false,
        reason: state.lastFailure || "Max attempts",
        duration: Game.time - state.startedAt,
      };

      eventBus.emit("EXPANSION_FAILED", state.roomName, { reason: state.lastFailure });
      console.log(`[Expansion] ${state.roomName} ABANDONED: ${state.lastFailure}`);

      delete Memory.empire!.expansion!.active[state.roomName];
    }
  }

  // === HELPERS ===

  /**
   * Sync bootstrapCreeps array with actual Game.creeps
   * This catches creeps that were spawned but never registered
   */
  private syncBootstrapCreeps(state: EmpireExpansionState): void {
    // Find all creeps targeting this expansion room
    const actualCreeps = Object.keys(Game.creeps).filter((name) => {
      const creep = Game.creeps[name];
      if (!creep) return false;
      if (creep.memory.targetRoom !== state.roomName) return false;
      return creep.memory.role === "PIONEER";
    });

    // Find creeps that exist but aren't tracked
    for (const name of actualCreeps) {
      if (!state.bootstrapCreeps.includes(name)) {
        state.bootstrapCreeps.push(name);
        console.log(`[Expansion] Discovered untracked ${Game.creeps[name].memory.role}: ${name}`);
      }
    }

    // Also sync claimer if one exists but isn't tracked
    if (!state.claimer) {
      const claimer = Object.values(Game.creeps).find(
        (c) => c.memory.role === "CLAIMER" && c.memory.targetRoom === state.roomName
      );
      if (claimer) {
        state.claimer = claimer.name;
        console.log(`[Expansion] Discovered untracked claimer: ${claimer.name}`);
      }
    }
  }

  private cleanupDeadCreeps(state: EmpireExpansionState): void {
    if (state.claimer && !Game.creeps[state.claimer]) {
      console.log(`[Expansion] Claimer ${state.claimer} died`);
      state.claimer = null;
    }

    const alive = state.bootstrapCreeps.filter((name) => {
      if (!Game.creeps[name]) {
        console.log(`[Expansion] Bootstrap creep ${name} died`);
        return false;
      }
      return true;
    });
    state.bootstrapCreeps = alive;
  }

  private processQueue(): void {
    if (Object.keys(Memory.empire!.expansion!.active).length > 0) return;

    const next = Memory.empire!.expansion!.queue.shift();
    if (next) {
      this.startExpansion(next.target, next.parent);
    }
  }

  private getStoredEnergy(room: Room): number {
    let total = room.storage?.store[RESOURCE_ENERGY] || 0;
    for (const container of room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    })) {
      total += (container as StructureContainer).store[RESOURCE_ENERGY];
    }
    return total;
  }

  // === AUTO-EXPANSION ===

  /**
   * Check if automatic expansion should trigger
   * Call this every ~100 ticks from main loop
   */
  checkAutoExpansion(): void {
    // Skip if disabled
    if (!this.config.autoExpand) return;

    // Skip if already expanding
    const activeCount = Object.keys(Memory.empire!.expansion!.active).length;
    if (activeCount >= this.config.maxSimultaneous) return;

    // Check empire readiness
    const readiness = new ExpansionReadiness();
    const { ready, bestParent, blockers } = readiness.canExpand();

    if (!ready) {
      // Log occasionally for debugging
      if (Game.time % 1000 === 0) {
        console.log(`[Expansion] Not ready: ${blockers.join(", ")}`);
      }
      return;
    }

    // Find best target
    const evaluator = new RoomEvaluator();
    const bestTarget = evaluator.getBestTarget();

    if (!bestTarget) {
      if (Game.time % 1000 === 0) {
        console.log("[Expansion] No viable targets found");
      }
      return;
    }

    // Start expansion!
    console.log(
      `[Expansion] AUTO: Starting expansion to ${bestTarget.roomName} (score: ${bestTarget.totalScore.toFixed(1)}) from ${bestParent}`
    );
    this.startExpansion(bestTarget.roomName, bestParent!);
  }

  /**
   * Get expansion candidates for display/API
   */
  getCandidates(maxResults: number = 5): RoomScore[] {
    const evaluator = new RoomEvaluator();
    return evaluator.rankCandidates(maxResults);
  }

  /**
   * Get parent readiness for display/API
   */
  getParentReadiness(): { roomName: string; readiness: ReadinessCheck }[] {
    const checker = new ExpansionReadiness();
    return checker.rankParentColonies().map((p) => ({
      roomName: p.roomName,
      readiness: p.readiness,
    }));
  }

  // === CONSOLE API ===

  static status(): string {
    // Read FRESH from Memory each call - no caching
    var exp = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
    var active = exp ? exp.active : {};
    var queue = exp ? exp.queue : [];
    var history = exp ? exp.history : {};

    var lines: string[] = [
      "=== Empire Expansion Status ===",
      "(Memory.empire.expansion.active keys: " + (Object.keys(active).join(", ") || "none") + ")",
    ];

    // Active expansions
    const activeCount = Object.keys(active).length;
    if (activeCount === 0) {
      lines.push("No active expansions");
    } else {
      lines.push(`Active expansions: ${activeCount}`);
      for (const roomName in active) {
        const s = active[roomName];
        const elapsed = Game.time - s.stateChangedAt;
        const pioneers = s.bootstrapCreeps.filter((n) => {
          const role = Game.creeps[n]?.memory.role;
          return role === "PIONEER";
        }).length;

        let progress = "";
        if (s.spawnSiteId) {
          const site = Game.getObjectById(s.spawnSiteId as Id<ConstructionSite>);
          if (site) {
            progress = ` [${((site.progress / site.progressTotal) * 100).toFixed(0)}%]`;
          }
        }

        lines.push(
          `  ${roomName}: ${s.state}${progress} (${elapsed} ticks, ${pioneers}P)`
        );
        if (s.lastFailure) {
          lines.push(`    Last failure: ${s.lastFailure}`);
        }
      }
    }

    // Queue
    if (queue.length > 0) {
      lines.push(`\nQueued (${queue.length}):`);
      for (const q of queue) {
        lines.push(`  ${q.target} (from ${q.parent})`);
      }
    }

    // Recent history
    const historyEntries = Object.entries(history);
    if (historyEntries.length > 0) {
      lines.push(`\nHistory (${historyEntries.length}):`);
      for (const [room, h] of historyEntries.slice(-5)) {
        const status = h.success ? "OK" : "FAILED";
        lines.push(`  ${room}: ${status} (${h.duration} ticks${h.reason ? `, ${h.reason}` : ""})`);
      }
    }

    return lines.join("\n");
  }
}

// Export singleton-like access for console
export const expansion = {
  status: () => ExpansionManager.status(),
  start: (target: string, parent: string) => new ExpansionManager().startExpansion(target, parent),
  cancel: (target: string) => new ExpansionManager().cancelExpansion(target),
  queue: (target: string, parent: string) => {
    initializeEmpireMemory();
    Memory.empire!.expansion!.queue.push({ target, parent });
    console.log("[Expansion] Queued " + target + " (from " + parent + ")");
    return "OK";
  },
  // Clear all expansion data (use when stuck)
  clear: () => {
    if (Memory.empire && Memory.empire.expansion) {
      var activeRooms = Object.keys(Memory.empire.expansion.active);
      Memory.empire.expansion.active = {};
      Memory.empire.expansion.queue = [];
      console.log("[Expansion] Cleared " + activeRooms.length + " active expansions: " + activeRooms.join(", "));
    }
    return "OK";
  },
  // Debug: show raw memory
  debug: () => {
    console.log("Memory.empire:", JSON.stringify(Memory.empire, null, 2));
    return "OK";
  },
  // Show expansion candidates
  candidates: (count?: number) => {
    const evaluator = new RoomEvaluator();
    const candidates = evaluator.rankCandidates(count || 10);

    console.log("=== EXPANSION CANDIDATES ===");
    for (const c of candidates) {
      const status = c.viable ? "Y" : "X";
      console.log(
        `${status} ${c.roomName}: ${c.totalScore.toFixed(1)} (E:${c.economic.toFixed(0)} S:${c.strategic.toFixed(0)} D:${c.defensive.toFixed(0)})`
      );
      console.log(
        `   ${c.details.sources} sources, ${c.details.mineral || "no mineral"}, ${c.details.remotePotential} remote sources`
      );
      if (c.blockers.length > 0) {
        console.log(`   Blockers: ${c.blockers.join(", ")}`);
      }
    }
    return `${candidates.length} candidates`;
  },
  // Show parent readiness
  readiness: () => {
    const checker = new ExpansionReadiness();
    const parents = checker.rankParentColonies();

    console.log("=== PARENT READINESS ===");
    for (const p of parents) {
      const r = p.readiness;
      const status = r.ready ? "Y READY" : "X NOT READY";
      console.log(`${p.roomName}: ${status} (score: ${r.score})`);
      if (r.blockers.length > 0) {
        console.log(`   Blockers: ${r.blockers.join(", ")}`);
      }
      if (r.warnings.length > 0) {
        console.log(`   Warnings: ${r.warnings.join(", ")}`);
      }
    }

    const overall = checker.canExpand();
    console.log(`\nEmpire can expand: ${overall.ready ? "YES" : "NO"}`);
    if (overall.bestParent) {
      console.log(`Best parent: ${overall.bestParent}`);
    }
    return overall.ready ? "Ready" : overall.blockers.join(", ");
  },
  // Toggle auto-expand
  auto: (enable?: boolean) => {
    initializeEmpireMemory();
    if (enable === undefined) {
      var current = Memory.empire && Memory.empire.config && Memory.empire.config.autoExpand !== undefined
        ? Memory.empire.config.autoExpand
        : true;
      return "Auto-expand is " + (current ? "ENABLED" : "DISABLED");
    }

    Memory.empire!.config = Memory.empire!.config || {};
    Memory.empire!.config.autoExpand = enable;
    return "Auto-expand " + (enable ? "ENABLED" : "DISABLED");
  },
};
