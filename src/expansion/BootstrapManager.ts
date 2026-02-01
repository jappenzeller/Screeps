/**
 * BootstrapManager - State machine managing one expansion at a time
 *
 * State flow:
 * IDLE → CLAIMING → PLACING_SPAWN → BUILDING_SPAWN → RAMPING → COMPLETE
 *          ↓            ↓              ↓             ↓
 *        FAILED      FAILED         FAILED       (abandon)
 */

import { SpawnPlacementCalculator } from "./SpawnPlacementCalculator";

const DEFAULT_CONFIG: BootstrapConfig = {
  maxAttempts: 3,
  claimerTimeout: 3000,
  spawnBuildTimeout: 10000,
  minParentEnergy: 50000,
  minParentRCL: 4,
  builderCount: 2,
  haulerCount: 3,
};

export class BootstrapManager {
  private memory: BootstrapMemory;

  constructor() {
    this.initializeMemory();
    this.memory = Memory.bootstrap as BootstrapMemory;
  }

  private initializeMemory(): void {
    if (!Memory.bootstrap) {
      Memory.bootstrap = {
        active: null,
        queue: [],
        history: [],
        config: { ...DEFAULT_CONFIG },
      };
    }
  }

  /**
   * Main tick function - run every tick
   */
  run(): void {
    if (!this.memory.active) {
      this.checkQueue();
      return;
    }

    const state = this.memory.active;

    switch (state.state) {
      case "CLAIMING":
        this.runClaiming(state);
        break;
      case "PLACING_SPAWN":
        this.runPlacingSpawn(state);
        break;
      case "BUILDING_SPAWN":
        this.runBuildingSpawn(state);
        break;
      case "RAMPING":
        this.runRamping(state);
        break;
      case "FAILED":
        this.handleFailure(state);
        break;
      case "COMPLETE":
        this.completeBootstrap(state);
        break;
    }
  }

  /**
   * Queue a room for bootstrap
   */
  queueExpansion(targetRoom: string, parentRoom: string): boolean {
    if (!this.canExpand(parentRoom)) {
      console.log(`[Bootstrap] Cannot expand: parent ${parentRoom} not ready`);
      return false;
    }

    if (this.memory.active?.targetRoom === targetRoom) return false;
    if (this.memory.queue.includes(targetRoom)) return false;

    this.memory.queue.push(targetRoom);
    console.log(`[Bootstrap] Queued ${targetRoom} for expansion from ${parentRoom}`);
    return true;
  }

  /**
   * Start expansion immediately (called when claimer is en route)
   */
  startExpansion(targetRoom: string, parentRoom: string): boolean {
    if (this.memory.active) {
      console.log(`[Bootstrap] Cannot start: already bootstrapping ${this.memory.active.targetRoom}`);
      return false;
    }

    if (!this.canExpand(parentRoom)) {
      console.log(`[Bootstrap] Cannot expand: parent ${parentRoom} not ready`);
      return false;
    }

    this.memory.active = {
      targetRoom,
      parentRoom,
      state: "CLAIMING",
      stateChangedAt: Game.time,
      startedAt: Game.time,
      attempts: 1,
      claimer: null,
      spawnSitePos: null,
      spawnSiteId: null,
      assignedBuilders: [],
      assignedHaulers: [],
      spawnProgress: 0,
      energyDelivered: 0,
      lastFailure: null,
      failureCount: 0,
    };

    console.log(`[Bootstrap] Started expansion to ${targetRoom} from ${parentRoom}`);
    return true;
  }

  /**
   * Check if parent colony can support expansion
   */
  canExpand(parentRoom: string): boolean {
    const room = Game.rooms[parentRoom];
    if (!room || !room.controller?.my) return false;

    const rcl = room.controller.level;
    if (rcl < this.memory.config.minParentRCL) return false;

    const stored = room.storage?.store[RESOURCE_ENERGY] || 0;
    if (stored < this.memory.config.minParentEnergy) return false;

    // Check GCL headroom
    const ownedRooms = Object.values(Game.rooms).filter((r) => r.controller?.my).length;
    if (ownedRooms >= Game.gcl.level) return false;

    return true;
  }

  /**
   * Register claimer creep with bootstrap
   */
  registerClaimer(creepName: string): void {
    if (this.memory.active && this.memory.active.state === "CLAIMING") {
      this.memory.active.claimer = creepName;
    }
  }

  /**
   * Get bootstrap creep assignments for spawner
   */
  getCreepNeeds(): { role: string; targetRoom: string; parentRoom: string }[] {
    const needs: { role: string; targetRoom: string; parentRoom: string }[] = [];
    const state = this.memory.active;

    if (!state) return needs;
    if (state.state !== "BUILDING_SPAWN" && state.state !== "PLACING_SPAWN") return needs;

    // Count existing assigned creeps that are alive
    const aliveBuilders = state.assignedBuilders.filter((n) => Game.creeps[n]).length;
    const aliveHaulers = state.assignedHaulers.filter((n) => Game.creeps[n]).length;

    // Request more if needed
    const neededBuilders = this.memory.config.builderCount - aliveBuilders;
    const neededHaulers = this.memory.config.haulerCount - aliveHaulers;

    for (let i = 0; i < neededBuilders; i++) {
      needs.push({
        role: "BOOTSTRAP_BUILDER",
        targetRoom: state.targetRoom,
        parentRoom: state.parentRoom,
      });
    }

    for (let i = 0; i < neededHaulers; i++) {
      needs.push({
        role: "BOOTSTRAP_HAULER",
        targetRoom: state.targetRoom,
        parentRoom: state.parentRoom,
      });
    }

    return needs;
  }

  /**
   * Register spawned bootstrap creep
   */
  registerBootstrapCreep(creepName: string, role: string): void {
    if (!this.memory.active) return;

    if (role === "BOOTSTRAP_BUILDER") {
      this.memory.active.assignedBuilders.push(creepName);
    } else if (role === "BOOTSTRAP_HAULER") {
      this.memory.active.assignedHaulers.push(creepName);
    }
  }

  // === State Handlers ===

  private runClaiming(state: BootstrapState): void {
    const room = Game.rooms[state.targetRoom];

    // Check if claimed
    if (room && room.controller?.my) {
      this.transitionState(state, "PLACING_SPAWN");
      return;
    }

    // Check for claimer
    const claimer = state.claimer ? Game.creeps[state.claimer] : null;
    if (!claimer) {
      // Claimer died or doesn't exist
      const elapsed = Game.time - state.stateChangedAt;
      if (elapsed > this.memory.config.claimerTimeout) {
        state.lastFailure = "Claimer timeout - no claimer arrived";
        this.transitionState(state, "FAILED");
      }
      return;
    }

    // Claimer exists but room not claimed yet - wait
  }

  private runPlacingSpawn(state: BootstrapState): void {
    const room = Game.rooms[state.targetRoom];
    if (!room) {
      state.lastFailure = "Lost visibility of target room";
      this.transitionState(state, "FAILED");
      return;
    }

    // Calculate spawn position if not done
    if (!state.spawnSitePos) {
      const calculator = new SpawnPlacementCalculator(room);
      const result = calculator.calculate();
      state.spawnSitePos = result.pos;
      console.log(
        `[Bootstrap] Calculated spawn position for ${state.targetRoom}: ${result.pos.x},${result.pos.y} (score: ${result.score.toFixed(1)})`
      );
      console.log(`[Bootstrap] Reasoning: ${result.reasoning.join(", ")}`);
    }

    // Place construction site
    const pos = state.spawnSitePos;
    const result = room.createConstructionSite(pos.x, pos.y, STRUCTURE_SPAWN);

    if (result === OK) {
      // Find the site ID
      const site = room
        .lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y)
        .find((s) => s.structureType === STRUCTURE_SPAWN);
      if (site) {
        state.spawnSiteId = site.id;
      }
      this.transitionState(state, "BUILDING_SPAWN");
    } else if (result === ERR_INVALID_TARGET) {
      // Something blocking - try recalculating
      state.spawnSitePos = null;
      state.failureCount++;
      if (state.failureCount > 3) {
        state.lastFailure = "Cannot place spawn site - terrain blocked";
        this.transitionState(state, "FAILED");
      }
    }
  }

  private runBuildingSpawn(state: BootstrapState): void {
    const room = Game.rooms[state.targetRoom];
    if (!room) return;

    // Check if spawn is built
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length > 0) {
      console.log(`[Bootstrap] Spawn built in ${state.targetRoom}!`);
      this.transitionState(state, "RAMPING");
      return;
    }

    // Track progress
    const site = state.spawnSiteId
      ? Game.getObjectById(state.spawnSiteId as Id<ConstructionSite>)
      : null;
    if (site) {
      state.spawnProgress = site.progress;
    }

    // Check timeout
    const elapsed = Game.time - state.stateChangedAt;
    if (elapsed > this.memory.config.spawnBuildTimeout) {
      // Don't fail - just log warning, may need more builders
      if (elapsed % 1000 === 0) {
        console.log(
          `[Bootstrap] Warning: spawn build taking long (${elapsed} ticks, ${state.spawnProgress}/15000)`
        );
      }
    }

    // Clean up dead creeps from assigned lists
    state.assignedBuilders = state.assignedBuilders.filter((n) => Game.creeps[n]);
    state.assignedHaulers = state.assignedHaulers.filter((n) => Game.creeps[n]);
  }

  private runRamping(state: BootstrapState): void {
    const room = Game.rooms[state.targetRoom];
    if (!room) return;

    // Room is now self-sufficient when it has:
    // - Spawn built (already confirmed)
    // - At least 1 harvester
    // - At least 1 hauler
    // - RCL 2 (can build extensions)

    const rcl = room.controller?.level || 0;
    const creeps = room.find(FIND_MY_CREEPS);
    const harvesters = creeps.filter((c) => c.memory.role === "HARVESTER").length;
    const haulers = creeps.filter((c) => c.memory.role === "HAULER").length;

    if (rcl >= 2 && harvesters >= 1 && haulers >= 1) {
      this.transitionState(state, "COMPLETE");
    }
  }

  private handleFailure(state: BootstrapState): void {
    console.log(`[Bootstrap] Failed: ${state.lastFailure}`);

    if (state.attempts < this.memory.config.maxAttempts) {
      // Retry
      state.attempts++;
      state.failureCount = 0;
      state.lastFailure = null;
      this.transitionState(state, "CLAIMING");
      console.log(
        `[Bootstrap] Retrying (attempt ${state.attempts}/${this.memory.config.maxAttempts})`
      );
    } else {
      // Give up
      console.log(
        `[Bootstrap] Abandoning expansion to ${state.targetRoom} after ${state.attempts} attempts`
      );
      this.memory.history.push({
        targetRoom: state.targetRoom,
        parentRoom: state.parentRoom,
        startedAt: state.startedAt,
        completedAt: Game.time,
        finalState: "FAILED",
        totalTicks: Game.time - state.startedAt,
        energySpent: state.energyDelivered,
      });
      this.memory.active = null;
    }
  }

  private completeBootstrap(state: BootstrapState): void {
    console.log(
      `[Bootstrap] Completed expansion to ${state.targetRoom} in ${Game.time - state.startedAt} ticks`
    );

    this.memory.history.push({
      targetRoom: state.targetRoom,
      parentRoom: state.parentRoom,
      startedAt: state.startedAt,
      completedAt: Game.time,
      finalState: "COMPLETE",
      totalTicks: Game.time - state.startedAt,
      energySpent: state.energyDelivered,
    });

    this.memory.active = null;
  }

  private transitionState(state: BootstrapState, newState: BootstrapStateType): void {
    console.log(`[Bootstrap] ${state.targetRoom}: ${state.state} → ${newState}`);
    state.state = newState;
    state.stateChangedAt = Game.time;
  }

  private checkQueue(): void {
    if (this.memory.queue.length === 0) return;

    // Find a valid parent for the next queued room
    const targetRoom = this.memory.queue[0];

    // Find best parent (closest owned room with capacity)
    const parents = Object.values(Game.rooms)
      .filter((r) => r.controller?.my && this.canExpand(r.name))
      .sort((a, b) => {
        const distA = Game.map.getRoomLinearDistance(a.name, targetRoom);
        const distB = Game.map.getRoomLinearDistance(b.name, targetRoom);
        return distA - distB;
      });

    if (parents.length > 0) {
      this.memory.queue.shift();
      this.startExpansion(targetRoom, parents[0].name);
    }
  }

  // === API for external queries ===

  getStatus(): BootstrapState | null {
    return this.memory.active;
  }

  isBootstrapping(): boolean {
    return this.memory.active !== null;
  }

  getTargetRoom(): string | null {
    return this.memory.active?.targetRoom || null;
  }

  getParentRoom(): string | null {
    return this.memory.active?.parentRoom || null;
  }
}
