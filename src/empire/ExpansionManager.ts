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

export class ExpansionManager {
  private config = getConfig().expansion;

  constructor() {
    initializeEmpireMemory();
  }

  /**
   * Main run loop - call every tick
   */
  run(): void {
    const expansions = Memory.empireExpansion!.active;

    for (const roomName in expansions) {
      const state = expansions[roomName];
      this.cleanupDeadCreeps(state);
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
    const activeCount = Object.keys(Memory.empireExpansion!.active).length;
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

    Memory.empireExpansion!.active[targetRoom] = {
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
   */
  getSpawnRequests(
    parentRoom: string
  ): Array<{ role: string; memory: Partial<CreepMemory>; priority: number }> {
    const requests: Array<{ role: string; memory: Partial<CreepMemory>; priority: number }> = [];

    for (const roomName in Memory.empireExpansion!.active) {
      const state = Memory.empireExpansion!.active[roomName];
      if (state.parentRoom !== parentRoom) continue;

      // CLAIMING state: need claimer
      if (state.state === "CLAIMING" && !state.claimer) {
        requests.push({
          role: "CLAIMER",
          memory: { role: "CLAIMER", room: parentRoom, targetRoom: roomName },
          priority: 90,
        });
      }

      // BOOTSTRAPPING state: need builders and haulers
      if (state.state === "BOOTSTRAPPING") {
        const builders = state.bootstrapCreeps.filter(
          (n) => Game.creeps[n]?.memory.role === "BOOTSTRAP_BUILDER"
        ).length;
        const haulers = state.bootstrapCreeps.filter(
          (n) => Game.creeps[n]?.memory.role === "BOOTSTRAP_HAULER"
        ).length;

        for (let i = builders; i < this.config.builderCount; i++) {
          requests.push({
            role: "BOOTSTRAP_BUILDER",
            memory: {
              role: "BOOTSTRAP_BUILDER",
              room: parentRoom,
              targetRoom: roomName,
            },
            priority: 85,
          });
        }

        for (let i = haulers; i < this.config.haulerCount; i++) {
          requests.push({
            role: "BOOTSTRAP_HAULER",
            memory: {
              role: "BOOTSTRAP_HAULER",
              room: parentRoom,
              targetRoom: roomName,
            },
            priority: 80,
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
    const state = Memory.empireExpansion!.active[targetRoom];
    if (!state) return;

    if (role === "CLAIMER") {
      state.claimer = creepName;
      console.log(`[Expansion] Registered claimer ${creepName} for ${targetRoom}`);
    } else if (role === "BOOTSTRAP_BUILDER" || role === "BOOTSTRAP_HAULER") {
      if (!state.bootstrapCreeps.includes(creepName)) {
        state.bootstrapCreeps.push(creepName);
        console.log(`[Expansion] Registered ${role} ${creepName} for ${targetRoom}`);
      }
    }
  }

  /**
   * Cancel an expansion in progress
   */
  cancelExpansion(targetRoom: string): boolean {
    const state = Memory.empireExpansion!.active[targetRoom];
    if (!state) {
      // Check queue
      const queueIndex = Memory.empireExpansion!.queue.findIndex((q) => q.target === targetRoom);
      if (queueIndex >= 0) {
        Memory.empireExpansion!.queue.splice(queueIndex, 1);
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

    delete Memory.empireExpansion!.active[targetRoom];
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
        const builders = state.bootstrapCreeps.filter(
          (n) => Game.creeps[n]?.memory.role === "BOOTSTRAP_BUILDER"
        ).length;
        const haulers = state.bootstrapCreeps.filter(
          (n) => Game.creeps[n]?.memory.role === "BOOTSTRAP_HAULER"
        ).length;
        console.log(`[Expansion] ${state.roomName} spawn: ${pct}% (${builders}B/${haulers}H)`);
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
    Memory.empireExpansion!.history[state.roomName] = {
      completedAt: Game.time,
      success: true,
      duration: Game.time - state.startedAt,
    };

    eventBus.emit("EXPANSION_COMPLETE", state.roomName);
    console.log(`[Expansion] ${state.roomName} COMPLETE (${Game.time - state.startedAt} ticks)`);

    delete Memory.empireExpansion!.active[state.roomName];
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
      Memory.empireExpansion!.history[state.roomName] = {
        completedAt: Game.time,
        success: false,
        reason: state.lastFailure || "Max attempts",
        duration: Game.time - state.startedAt,
      };

      eventBus.emit("EXPANSION_FAILED", state.roomName, { reason: state.lastFailure });
      console.log(`[Expansion] ${state.roomName} ABANDONED: ${state.lastFailure}`);

      delete Memory.empireExpansion!.active[state.roomName];
    }
  }

  // === HELPERS ===

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
    if (Object.keys(Memory.empireExpansion!.active).length > 0) return;

    const next = Memory.empireExpansion!.queue.shift();
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

  // === CONSOLE API ===

  static status(): string {
    const active = Memory.empireExpansion?.active || {};
    const queue = Memory.empireExpansion?.queue || [];
    const history = Memory.empireExpansion?.history || {};

    const lines: string[] = ["=== Empire Expansion Status ==="];

    // Active expansions
    const activeCount = Object.keys(active).length;
    if (activeCount === 0) {
      lines.push("No active expansions");
    } else {
      lines.push(`Active expansions: ${activeCount}`);
      for (const roomName in active) {
        const s = active[roomName];
        const elapsed = Game.time - s.stateChangedAt;
        const builders = s.bootstrapCreeps.filter(
          (n) => Game.creeps[n]?.memory.role === "BOOTSTRAP_BUILDER"
        ).length;
        const haulers = s.bootstrapCreeps.filter(
          (n) => Game.creeps[n]?.memory.role === "BOOTSTRAP_HAULER"
        ).length;

        let progress = "";
        if (s.spawnSiteId) {
          const site = Game.getObjectById(s.spawnSiteId as Id<ConstructionSite>);
          if (site) {
            progress = ` [${((site.progress / site.progressTotal) * 100).toFixed(0)}%]`;
          }
        }

        lines.push(
          `  ${roomName}: ${s.state}${progress} (${elapsed} ticks, ${builders}B/${haulers}H)`
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
    Memory.empireExpansion!.queue.push({ target, parent });
    console.log(`[Expansion] Queued ${target} (from ${parent})`);
    return "OK";
  },
};
