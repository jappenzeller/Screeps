/**
 * ColonyManager: Single source of truth for colony coordination.
 * Manages colony phase detection and task assignment.
 */

import { ColonyStateManager, CachedColonyState } from "./ColonyState";
import { DecisionLogger } from "../logging/DecisionLogger";

/**
 * Colony development phases
 */
export enum ColonyPhase {
  BOOTSTRAP = "BOOTSTRAP", // RCL 1-2, or < 3 creeps
  DEVELOPING = "DEVELOPING", // RCL 3-4
  STABLE = "STABLE", // RCL 5+
  EMERGENCY = "EMERGENCY", // Under attack or no harvesters
}

/**
 * Task types that can be assigned to creeps
 */
export type TaskType =
  | "HARVEST"
  | "SUPPLY_SPAWN"
  | "SUPPLY_TOWER"
  | "BUILD"
  | "UPGRADE"
  | "HAUL"
  | "DEFEND";

/**
 * Task definition
 */
export interface Task {
  id: string;
  type: TaskType;
  targetId: Id<any>;
  priority: number; // lower = more urgent
  assignedCreep: string | null;
  createdAt: number;
}

/**
 * Workforce needs by role
 */
export interface WorkforceNeeds {
  HARVESTER: number;
  HAULER: number;
  UPGRADER: number;
  BUILDER: number;
  DEFENDER: number;
  REMOTE_MINER: number;
  REMOTE_HAULER: number;
  RESERVER: number;
  SCOUT: number;
}

// Singleton instances per room
const instances: Map<string, ColonyManager> = new Map();

/**
 * ColonyManager - Coordinates all colony activities
 */
export class ColonyManager {
  private roomName: string;

  constructor(roomName: string) {
    this.roomName = roomName;
  }

  /**
   * Get singleton instance for a room
   */
  static getInstance(roomName: string): ColonyManager {
    let instance = instances.get(roomName);
    if (!instance) {
      instance = new ColonyManager(roomName);
      instances.set(roomName, instance);
    }
    return instance;
  }

  /**
   * Get cached colony state (delegates to ColonyStateManager)
   */
  getState(): CachedColonyState | null {
    return ColonyStateManager.getState(this.roomName);
  }

  /**
   * Main run method - call every tick to manage tasks
   */
  run(): void {
    // Initialize colony memory (first run or after reset)
    this.initializeColonyMemory();

    // Periodic re-sync of remote rooms (every 1000 ticks, rate-limited per colony)
    // Check timestamp to avoid all colonies syncing on the same tick
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    var lastSync = mem && mem.remoteRoomsLastSync || 0;
    if (Game.time - lastSync >= 1000) {
      this.syncRemoteRooms();
    }

    // Update remote creep assignments (every 50 ticks)
    if (Game.time % 50 === 0) {
      this.updateRemoteAssignments();
    }

    // Refresh tasks every 10 ticks or when task list is empty
    if (Game.time % 10 === 0 || this.getTasks().length === 0) {
      this.refreshTasks();
    }
  }

  /**
   * Determine current colony phase
   */
  getPhase(): ColonyPhase {
    const state = this.getState();
    if (!state) return ColonyPhase.BOOTSTRAP;

    const room = state.room;
    const controller = room.controller;

    // === EMERGENCY CONDITIONS ===

    // 1. No harvesters - economy dead
    const harvesters = this.getCreepCount("HARVESTER");
    if (harvesters === 0) {
      return ColonyPhase.EMERGENCY;
    }

    // 2. Spawn under attack or critically damaged
    const spawn = state.structures.spawns[0];
    if (spawn && spawn.hits < spawn.hitsMax * 0.5) {
      return ColonyPhase.EMERGENCY;
    }

    // 3. Significant hostile presence
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const hostileThreat = hostiles.reduce((sum, h) => {
      return (
        sum + h.getActiveBodyparts(ATTACK) * 30 + h.getActiveBodyparts(RANGED_ATTACK) * 10
      );
    }, 0);
    if (hostileThreat > 150) {
      return ColonyPhase.EMERGENCY;
    }

    // 4. Controller about to downgrade
    if (controller && controller.ticksToDowngrade && controller.ticksToDowngrade < 5000) {
      return ColonyPhase.EMERGENCY;
    }

    // 5. Legacy emergency state check
    if (state.emergency.isEmergency || state.threat.level >= 3) {
      return ColonyPhase.EMERGENCY;
    }

    // === NORMAL PHASES ===

    if (!controller) return ColonyPhase.BOOTSTRAP;

    const rcl = controller.level;
    const creepCount = Object.values(Game.creeps).filter(
      (c) => c.memory.room === this.roomName
    ).length;

    // Bootstrap: RCL 1-2 or very few creeps
    if (rcl <= 2 || creepCount < 4) {
      return ColonyPhase.BOOTSTRAP;
    }

    // Developing: RCL 3-4
    if (rcl <= 4) {
      return ColonyPhase.DEVELOPING;
    }

    // Stable: RCL 5+
    return ColonyPhase.STABLE;
  }

  /**
   * Get current task list from memory
   */
  getTasks(): Task[] {
    this.ensureMemory();
    return Memory.rooms[this.roomName].tasks || [];
  }

  /**
   * Generate tasks based on current room needs
   */
  private generateTasks(): Task[] {
    const state = this.getState();
    if (!state) return [];

    const phase = this.getPhase();

    // In emergency, generate only survival-critical tasks
    if (phase === ColonyPhase.EMERGENCY) {
      return this.generateEmergencyTasks(state);
    }

    const tasks: Task[] = [];
    const existingTasks = this.getTasks();

    // Priority adjustments by phase (negative = more urgent)
    const priorityMod: Record<ColonyPhase, Record<string, number>> = {
      [ColonyPhase.BOOTSTRAP]: { HARVEST: -2, SUPPLY_SPAWN: -2, UPGRADE: +2, BUILD: +1, HAUL: 0, DEFEND: 0 },
      [ColonyPhase.DEVELOPING]: { HARVEST: 0, SUPPLY_SPAWN: -1, UPGRADE: 0, BUILD: 0, HAUL: 0, DEFEND: 0 },
      [ColonyPhase.STABLE]: { HARVEST: 0, SUPPLY_SPAWN: 0, UPGRADE: -1, BUILD: 0, HAUL: 0, DEFEND: 0 },
      [ColonyPhase.EMERGENCY]: { HARVEST: -2, SUPPLY_SPAWN: -3, UPGRADE: +5, BUILD: +3, HAUL: -1, DEFEND: -1 },
    };

    const mod = priorityMod[phase];

    // Helper to check if a task type already exists (not completed)
    const hasActiveTask = (type: TaskType, targetId?: Id<any>): boolean => {
      return existingTasks.some(
        (t) => t.type === type && (targetId === undefined || t.targetId === targetId)
      );
    };

    // SUPPLY_SPAWN - critical when spawn needs energy
    if (state.energy.available < state.energy.capacity) {
      if (!hasActiveTask("SUPPLY_SPAWN")) {
        const spawn = state.structures.spawns[0];
        if (spawn) {
          // Extra urgent if very low energy
          const basePriority = state.energy.available < 300 ? 0 : 1;
          tasks.push({
            id: `supply_spawn_${spawn.id}_${Game.time}`,
            type: "SUPPLY_SPAWN",
            targetId: spawn.id,
            priority: basePriority + (mod.SUPPLY_SPAWN || 0),
            assignedCreep: null,
            createdAt: Game.time,
          });
        }
      }
    }

    // HARVEST - one task per source without assigned harvester
    for (const assignment of state.sourceAssignments) {
      if (!assignment.creepName && !hasActiveTask("HARVEST", assignment.sourceId)) {
        tasks.push({
          id: `harvest_${assignment.sourceId}_${Game.time}`,
          type: "HARVEST",
          targetId: assignment.sourceId,
          priority: 2 + (mod.HARVEST || 0),
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // SUPPLY_TOWER - towers below 500 energy
    for (const tower of state.structures.towers) {
      if (tower.store[RESOURCE_ENERGY] < 500 && !hasActiveTask("SUPPLY_TOWER", tower.id)) {
        tasks.push({
          id: `supply_tower_${tower.id}_${Game.time}`,
          type: "SUPPLY_TOWER",
          targetId: tower.id,
          priority: 3, // Emergency tower supply handled in generateEmergencyTasks
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // BUILD - max 3 active, prioritize container > extension > road
    const existingBuildTasks = existingTasks.filter((t) => t.type === "BUILD").length;
    if (existingBuildTasks < 3 && state.constructionSites.length > 0) {
      const sortedSites = [...state.constructionSites].sort((a, b) => {
        const priorityOrder: Record<string, number> = {
          [STRUCTURE_CONTAINER]: 1,
          [STRUCTURE_EXTENSION]: 2,
          [STRUCTURE_ROAD]: 3,
        };
        const aPriority = priorityOrder[a.structureType] ?? 4;
        const bPriority = priorityOrder[b.structureType] ?? 4;
        return aPriority - bPriority;
      });

      let buildTasksToAdd = 3 - existingBuildTasks;
      for (const site of sortedSites) {
        if (buildTasksToAdd <= 0) break;
        if (!hasActiveTask("BUILD", site.id)) {
          tasks.push({
            id: `build_${site.id}_${Game.time}`,
            type: "BUILD",
            targetId: site.id,
            priority: 4 + (mod.BUILD || 0),
            assignedCreep: null,
            createdAt: Game.time,
          });
          buildTasksToAdd--;
        }
      }
    }

    // UPGRADE - always 1-2 upgrade tasks available
    const controller = state.room.controller;
    if (controller) {
      const existingUpgradeTasks = existingTasks.filter((t) => t.type === "UPGRADE").length;
      const upgradeTasksNeeded = 2 - existingUpgradeTasks;
      for (let i = 0; i < upgradeTasksNeeded; i++) {
        tasks.push({
          id: `upgrade_${controller.id}_${Game.time}_${i}`,
          type: "UPGRADE",
          targetId: controller.id,
          priority: 5 + (mod.UPGRADE || 0),
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // HAUL - containers with > 500 energy or dropped resources
    for (const container of state.energy.containersWithEnergy) {
      if (container.amount > 500 && !hasActiveTask("HAUL", container.id)) {
        tasks.push({
          id: `haul_${container.id}_${Game.time}`,
          type: "HAUL",
          targetId: container.id,
          priority: 6 + (mod.HAUL || 0),
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // Also haul dropped resources
    for (const resource of state.energy.droppedResources) {
      if (!hasActiveTask("HAUL", resource.id)) {
        tasks.push({
          id: `haul_${resource.id}_${Game.time}`,
          type: "HAUL",
          targetId: resource.id,
          priority: 6 + (mod.HAUL || 0),
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // DEFEND - when hostiles present
    const hostiles = state.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
      // Prioritize by threat level (ATTACK parts most dangerous)
      const sortedHostiles = [...hostiles].sort((a, b) => {
        const threatA = a.getActiveBodyparts(ATTACK) * 30 + a.getActiveBodyparts(RANGED_ATTACK) * 10;
        const threatB = b.getActiveBodyparts(ATTACK) * 30 + b.getActiveBodyparts(RANGED_ATTACK) * 10;
        return threatB - threatA; // Highest threat first
      });

      // Create DEFEND task for each hostile (max 3)
      for (let i = 0; i < Math.min(3, sortedHostiles.length); i++) {
        const hostile = sortedHostiles[i];
        if (!hasActiveTask("DEFEND", hostile.id)) {
          tasks.push({
            id: `defend_${hostile.id}_${Game.time}`,
            type: "DEFEND",
            targetId: hostile.id,
            priority: 0 + (mod.DEFEND || 0), // Highest priority
            assignedCreep: null,
            createdAt: Game.time,
          });
        }
      }
    }

    return tasks;
  }

  /**
   * Generate emergency-only tasks - survival critical operations
   * Only SUPPLY_SPAWN, SUPPLY_TOWER, DEFEND, HARVEST, and minimal UPGRADE
   */
  private generateEmergencyTasks(state: CachedColonyState): Task[] {
    const tasks: Task[] = [];
    const existingTasks = this.getTasks();

    const hasActiveTask = (type: TaskType, targetId?: Id<any>): boolean => {
      return existingTasks.some(
        (t) => t.type === type && (targetId === undefined || t.targetId === targetId)
      );
    };

    // 1. SUPPLY_SPAWN - top priority in emergency
    if (state.energy.available < state.energy.capacity) {
      const spawn = state.structures.spawns[0];
      if (spawn && !hasActiveTask("SUPPLY_SPAWN")) {
        tasks.push({
          id: `supply_spawn_${spawn.id}_${Game.time}`,
          type: "SUPPLY_SPAWN",
          targetId: spawn.id,
          priority: 0, // Absolute top priority
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // 2. SUPPLY_TOWER - critical for defense
    for (const tower of state.structures.towers) {
      if (tower.store[RESOURCE_ENERGY] < 500 && !hasActiveTask("SUPPLY_TOWER", tower.id)) {
        tasks.push({
          id: `supply_tower_${tower.id}_${Game.time}`,
          type: "SUPPLY_TOWER",
          targetId: tower.id,
          priority: 1, // Very high priority
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // 3. DEFEND - eliminate threats
    const hostiles = state.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
      const sortedHostiles = [...hostiles].sort((a, b) => {
        const threatA =
          a.getActiveBodyparts(ATTACK) * 30 +
          a.getActiveBodyparts(RANGED_ATTACK) * 10 +
          a.getActiveBodyparts(HEAL) * 20;
        const threatB =
          b.getActiveBodyparts(ATTACK) * 30 +
          b.getActiveBodyparts(RANGED_ATTACK) * 10 +
          b.getActiveBodyparts(HEAL) * 20;
        return threatB - threatA;
      });

      for (let i = 0; i < Math.min(3, sortedHostiles.length); i++) {
        const hostile = sortedHostiles[i];
        if (!hasActiveTask("DEFEND", hostile.id)) {
          tasks.push({
            id: `defend_${hostile.id}_${Game.time}`,
            type: "DEFEND",
            targetId: hostile.id,
            priority: 2, // High priority
            assignedCreep: null,
            createdAt: Game.time,
          });
        }
      }
    }

    // 4. HARVEST - keep economy alive (one per source)
    for (const assignment of state.sourceAssignments) {
      if (!assignment.creepName && !hasActiveTask("HARVEST", assignment.sourceId)) {
        tasks.push({
          id: `harvest_${assignment.sourceId}_${Game.time}`,
          type: "HARVEST",
          targetId: assignment.sourceId,
          priority: 3,
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // 5. HAUL - only if spawn needs energy and no haulers collecting
    if (state.energy.available < state.energy.capacity * 0.5) {
      for (const container of state.energy.containersWithEnergy) {
        if (container.amount > 200 && !hasActiveTask("HAUL", container.id)) {
          tasks.push({
            id: `haul_${container.id}_${Game.time}`,
            type: "HAUL",
            targetId: container.id,
            priority: 4,
            assignedCreep: null,
            createdAt: Game.time,
          });
          break; // Only one haul task in emergency
        }
      }
    }

    // 6. UPGRADE - only if controller critically low (prevent downgrade)
    const controller = state.room.controller;
    if (controller && controller.ticksToDowngrade && controller.ticksToDowngrade < 5000) {
      if (!hasActiveTask("UPGRADE")) {
        tasks.push({
          id: `upgrade_${controller.id}_${Game.time}`,
          type: "UPGRADE",
          targetId: controller.id,
          priority: 5, // Lower priority but still needed
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    return tasks;
  }

  /**
   * Refresh task list - remove completed/stale tasks and add new ones
   */
  refreshTasks(): void {
    this.ensureMemory();

    // Get current tasks and filter out stale ones
    let tasks = this.getTasks().filter((task) => {
      // Remove tasks older than 1000 ticks
      if (Game.time - task.createdAt > 1000) return false;

      // Remove tasks for objects that no longer exist
      const target = Game.getObjectById(task.targetId);
      if (!target) return false;

      // Remove tasks assigned to dead creeps
      if (task.assignedCreep && !Game.creeps[task.assignedCreep]) {
        return false;
      }

      // Keep the task
      return true;
    });

    // Generate new tasks
    const newTasks = this.generateTasks();

    // Merge: keep existing tasks, add new ones
    const existingTargetTypes = new Set(tasks.map((t) => `${t.type}_${t.targetId}`));
    for (const newTask of newTasks) {
      const key = `${newTask.type}_${newTask.targetId}`;
      // For UPGRADE tasks, check by type only since multiple can exist
      if (newTask.type === "UPGRADE") {
        const upgradeCount = tasks.filter((t) => t.type === "UPGRADE").length;
        if (upgradeCount < 2) {
          tasks.push(newTask);
        }
      } else if (!existingTargetTypes.has(key)) {
        tasks.push(newTask);
      }
    }

    // Sort by priority
    tasks.sort((a, b) => a.priority - b.priority);

    // Store back to memory
    Memory.rooms[this.roomName].tasks = tasks;

    // Log task generation decision
    const phase = this.getPhase() as "BOOTSTRAP" | "DEVELOPING" | "STABLE" | "EMERGENCY";
    const state = this.getState();
    const tasksByType: Record<string, number> = {};
    const priorities: Record<string, number> = {};

    for (const task of tasks) {
      tasksByType[task.type] = (tasksByType[task.type] || 0) + 1;
      // Track min priority for each type
      if (priorities[task.type] === undefined || task.priority < priorities[task.type]) {
        priorities[task.type] = task.priority;
      }
    }

    DecisionLogger.logTaskGeneration(
      this.roomName,
      phase,
      state ? state.energy.available : 0,
      state ? state.energy.capacity : 0,
      tasksByType,
      priorities
    );
  }

  /**
   * Check if creep has required body parts for a task type
   */
  private canDoTask(creep: Creep, taskType: TaskType): boolean {
    const hasWork = creep.getActiveBodyparts(WORK) > 0;
    const hasCarry = creep.getActiveBodyparts(CARRY) > 0;
    const hasAttack = creep.getActiveBodyparts(ATTACK) > 0;
    const hasRangedAttack = creep.getActiveBodyparts(RANGED_ATTACK) > 0;

    switch (taskType) {
      case "HARVEST":
        return hasWork;
      case "SUPPLY_SPAWN":
      case "SUPPLY_TOWER":
      case "HAUL":
        return hasCarry;
      case "BUILD":
      case "UPGRADE":
        return hasWork && hasCarry;
      case "DEFEND":
        return hasAttack || hasRangedAttack;
      default:
        return false;
    }
  }

  /**
   * Find an available task that the creep can perform
   */
  getAvailableTask(creep: Creep): Task | null {
    const tasks = this.getTasks();

    // Filter to unassigned tasks the creep can do based on body parts
    const suitableTasks = tasks.filter((task) => {
      // Skip already assigned tasks
      if (task.assignedCreep !== null) {
        return false;
      }

      // Check if creep has required body parts
      return this.canDoTask(creep, task.type);
    });

    if (suitableTasks.length === 0) {
      // Log no suitable tasks found
      DecisionLogger.logTaskAssignment(
        this.roomName,
        creep.name,
        creep.memory.role || "UNKNOWN",
        null,
        null,
        0,
        0,
        0
      );
      return null;
    }

    // Sort by priority first, then by distance
    suitableTasks.sort((a, b) => {
      // Priority takes precedence
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      // Same priority - sort by distance
      const targetA = Game.getObjectById(a.targetId);
      const targetB = Game.getObjectById(b.targetId);

      if (!targetA || !targetB) return 0;

      const distA = creep.pos.getRangeTo(targetA.pos);
      const distB = creep.pos.getRangeTo(targetB.pos);

      return distA - distB;
    });

    // Get the best match
    const selected = suitableTasks[0];

    // Calculate distance to selected target
    const target = Game.getObjectById(selected.targetId);
    const distance = target ? creep.pos.getRangeTo(target.pos) : 0;

    // Log task assignment decision
    DecisionLogger.logTaskAssignment(
      this.roomName,
      creep.name,
      creep.memory.role || "UNKNOWN",
      selected.type,
      selected.id,
      selected.priority,
      distance,
      suitableTasks.length - 1  // Alternative count (excluding selected)
    );

    return selected;
  }

  /**
   * Assign a task to a creep
   */
  assignTask(taskId: string, creepName: string): void {
    this.ensureMemory();
    const tasks = this.getTasks();

    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.assignedCreep = creepName;
      Memory.rooms[this.roomName].tasks = tasks;

      // Also set the creep's taskId
      const creep = Game.creeps[creepName];
      if (creep) {
        creep.memory.taskId = taskId;
      }
    }
  }

  /**
   * Mark a task as completed and remove it
   */
  completeTask(taskId: string): void {
    this.ensureMemory();
    const tasks = this.getTasks();

    // Find the task to get the assigned creep before removing
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.assignedCreep) {
      const creep = Game.creeps[task.assignedCreep];
      if (creep && creep.memory.taskId === taskId) {
        delete creep.memory.taskId;
      }
    }

    // Remove the task
    Memory.rooms[this.roomName].tasks = tasks.filter((t) => t.id !== taskId);
  }

  /**
   * Abandon a task (unassign creep but keep task)
   */
  abandonTask(taskId: string): void {
    this.ensureMemory();
    const tasks = this.getTasks();

    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      // Clear creep's taskId if still assigned to this task
      if (task.assignedCreep) {
        const creep = Game.creeps[task.assignedCreep];
        if (creep && creep.memory.taskId === taskId) {
          delete creep.memory.taskId;
        }
      }

      task.assignedCreep = null;
      Memory.rooms[this.roomName].tasks = tasks;
    }
  }

  /**
   * Initialize Memory.colonies[roomName] if it doesn't exist.
   * Migrates old format and auto-populates remotes from exits + Memory.intel.
   */
  initializeColonyMemory(): void {
    if (!Memory.colonies) {
      Memory.colonies = {};
    }

    if (!Memory.colonies[this.roomName]) {
      // First-time initialization: derive remote rooms from intel
      // Use deriveAllRemoteTargets to get proper distance values
      var empireAssignments = this.getEmpireRemoteAssignments();
      var derivedWithMeta = this.deriveAllRemoteTargets(empireAssignments);
      var remotes: Record<string, RemoteRoomConfig> = {};

      for (var i = 0; i < derivedWithMeta.length; i++) {
        var candidate = derivedWithMeta[i];

        remotes[candidate.roomName] = {
          room: candidate.roomName,
          homeColony: this.roomName,
          distance: candidate.distance,
          via: candidate.via,
          sources: candidate.sources,
          active: true,
          activatedAt: Game.time,
          miners: [],
          haulers: [],
        };
      }

      Memory.colonies[this.roomName] = {
        remotes: remotes,
        remoteRoomsLastSync: 0, // Force immediate sync on first run
        remoteSettings: {
          maxDistance: 2,
          maxRemotes: 4,
          minScoreThreshold: 30,
          autoExpand: false,
        },
      };
      console.log("[Colony] Initialized " + this.roomName + " with " + derivedWithMeta.length + " remote rooms");
    } else {
      // Migration: convert old remoteRooms[] to new remotes{}
      this.migrateRemoteRooms();
    }
  }

  /**
   * Migrate from old remoteRooms string[] format to new remotes Record format.
   */
  private migrateRemoteRooms(): void {
    if (!Memory.colonies) return;
    var mem = Memory.colonies[this.roomName];
    if (!mem) return;

    // Check if migration is needed
    if (Array.isArray(mem.remoteRooms) && !mem.remotes) {
      mem.remotes = {};

      for (var i = 0; i < mem.remoteRooms.length; i++) {
        var roomName = mem.remoteRooms[i];
        var intel = Memory.intel && Memory.intel[roomName];
        var sources = intel && intel.sources ? intel.sources.length : 2;

        mem.remotes[roomName] = {
          room: roomName,
          homeColony: this.roomName,
          distance: 1,
          sources: sources,
          active: true,
          activatedAt: Game.time,
          miners: [],
          haulers: [],
        };
      }

      delete mem.remoteRooms;
      // Reset sync timestamp to force immediate re-sync with new rules
      mem.remoteRoomsLastSync = 0;

      console.log("[Colony] Migrated " + this.roomName + " to new remote format: " + Object.keys(mem.remotes).length + " rooms");
    }

    // Initialize remoteSettings if missing
    if (!mem.remoteSettings) {
      mem.remoteSettings = {
        maxDistance: 2,
        maxRemotes: 4,
        minScoreThreshold: 30,
        autoExpand: false,
      };
    }

    // Ensure remoteRoomsLastSync exists (force sync if missing)
    if (mem.remoteRoomsLastSync === undefined) {
      mem.remoteRoomsLastSync = 0;
    }
  }

  /**
   * Re-derive remote rooms and update Memory.colonies.
   * Enforces: distance cap (2), overlap prevention, per-colony limit.
   * Cleans up invalid remotes and adds new valid candidates.
   */
  private syncRemoteRooms(): void {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem) {
      console.log("[remotes] " + this.roomName + ": sync skipped - no colony memory");
      return;
    }
    if (!mem.remotes) mem.remotes = {};

    // Update sync timestamp FIRST (proves the function ran)
    mem.remoteRoomsLastSync = Game.time;
    console.log("[remotes] " + this.roomName + ": sync started at tick " + Game.time + " (bucket: " + Game.cpu.bucket + ")");

    // Only auto-discover remotes at RCL 4+ (remote mining unlocks at RCL 4)
    var room = Game.rooms[this.roomName];
    var rcl = room && room.controller ? room.controller.level : 0;
    if (rcl < 4) {
      console.log("[remotes] " + this.roomName + ": sync skipped - RCL " + rcl + " < 4");
      return;
    }

    // Get empire-wide remote assignments (for overlap check)
    var empireAssignments = this.getEmpireRemoteAssignments();

    // Get intel and username for validation
    var intel = Memory.intel || {};
    var firstSpawn = Object.values(Game.spawns)[0];
    var myUsername = firstSpawn && firstSpawn.owner ? firstSpawn.owner.username : "";

    // === PHASE 1: Clean up invalid existing remotes ===
    var removed: string[] = [];
    var reactivated: string[] = [];
    for (var remoteName in mem.remotes) {
      var config = mem.remotes[remoteName];

      // Still inside its pause window - leave it alone.
      if (config.pausedUntil && config.pausedUntil > Game.time) continue;

      // Indefinite pause (reason, no expiry) - deliberate, respect it.
      if (config.pauseReason && !config.pausedUntil) continue;

      // Pause window has expired: clear it and let the validity checks below decide
      // the remote's fate. Without this an auto-pause (e.g. "Hostile detected") is
      // permanent — nothing else ever clears pauseReason, so the entry is skipped
      // forever AND still counts against maxRemotes, which silently kills the
      // colony's entire remote economy.
      if (config.pausedUntil) {
        delete config.pausedUntil;
        delete config.pauseReason;
        config.active = true;
        config.activatedAt = Game.time;
        reactivated.push(remoteName);
      }

      var removeReason = this.getRemoteInvalidReason(remoteName, config, empireAssignments, myUsername, intel);
      if (removeReason) {
        console.log("[remotes] " + this.roomName + ": removed " + remoteName + " (" + removeReason + ")");
        delete mem.remotes[remoteName];
        removed.push(remoteName);
      }
    }

    if (reactivated.length > 0) {
      console.log("[remotes] " + this.roomName + ": pause expired, reactivated " + reactivated.join(", "));
    }

    // Refresh empire assignments after removals
    if (removed.length > 0) {
      empireAssignments = this.getEmpireRemoteAssignments();
    }

    // === PHASE 2: Get valid candidates ===
    var candidates = this.deriveAllRemoteTargets(empireAssignments);

    // === PHASE 3: Calculate per-colony limit ===
    var homeSources = room.find(FIND_SOURCES).length;
    var maxRemotes = Math.min(homeSources * 2, 6);

    // Count only ACTIVE remotes toward the cap. Counting paused/inactive entries lets
    // a pile of dead config permanently saturate the limit, so no new remote is ever
    // added even when the colony is mining nothing at all.
    var currentCount = 0;
    for (var activeName in mem.remotes) {
      if (mem.remotes[activeName].active) currentCount++;
    }

    // === PHASE 3b: Trim over-cap actives ===
    // Clearing a batch of expired pauses can leave more active remotes than the colony
    // can staff. Deactivate the weakest until we are back at the cap, so the surviving
    // remotes get enough miners and haulers to actually be profitable.
    if (currentCount > maxRemotes) {
      var activeRemotes: Array<{ name: string; score: number }> = [];
      for (var scoreName in mem.remotes) {
        var rc = mem.remotes[scoreName];
        if (!rc.active) continue;
        var scoreIntel = intel[scoreName];
        var rcThreat = scoreIntel && scoreIntel.hostiles ? scoreIntel.hostiles : 0;
        activeRemotes.push({
          name: scoreName,
          score: (rc.sources || 1) * 10 - (rc.distance || 1) * 5 - rcThreat * 3,
        });
      }

      activeRemotes.sort(function (a, b) { return a.score - b.score; }); // weakest first

      var trimmed: string[] = [];
      for (var t = 0; t < activeRemotes.length && currentCount > maxRemotes; t++) {
        mem.remotes[activeRemotes[t].name].active = false;
        currentCount--;
        trimmed.push(activeRemotes[t].name);
      }

      if (trimmed.length > 0) {
        console.log("[remotes] " + this.roomName + ": over cap, deactivated " + trimmed.join(", "));
      }
    }

    // === PHASE 4: Score and add candidates within limit ===
    // Score candidates: (sources * 10) - (distance * 5) - (threatLevel * 3)
    var scoredCandidates = candidates.map(function(c) {
      var ri = intel[c.roomName];
      var threatLevel = ri && ri.hostiles ? ri.hostiles : 0;
      var score = (c.sources * 10) - (c.distance * 5) - (threatLevel * 3);
      return { candidate: c, score: score };
    });

    // Sort by score descending
    scoredCandidates.sort(function(a, b) { return b.score - a.score; });

    var added: string[] = [];
    for (var i = 0; i < scoredCandidates.length; i++) {
      if (currentCount >= maxRemotes) break;

      var sc = scoredCandidates[i];
      var candidate = sc.candidate;

      // Already known: never overwrite its config. But if it is merely inactive
      // (trimmed by the cap earlier, not paused), bring it back rather than skipping —
      // otherwise a trimmed remote is stranded off forever even once there is room.
      var existingRemote = mem.remotes[candidate.roomName];
      if (existingRemote) {
        if (!existingRemote.active && !existingRemote.pauseReason && !existingRemote.pausedUntil) {
          existingRemote.active = true;
          existingRemote.activatedAt = Game.time;
          empireAssignments[candidate.roomName] = this.roomName;
          currentCount++;
          added.push(candidate.roomName + "(reactivated)");
        }
        continue;
      }

      // Double-check overlap (another colony may have added it)
      if (empireAssignments[candidate.roomName] && empireAssignments[candidate.roomName] !== this.roomName) {
        continue;
      }

      mem.remotes[candidate.roomName] = {
        room: candidate.roomName,
        homeColony: this.roomName,
        distance: candidate.distance,
        via: candidate.via,
        sources: candidate.sources,
        active: true,
        activatedAt: Game.time,
        miners: [],
        haulers: [],
      };

      // Update empire assignments
      empireAssignments[candidate.roomName] = this.roomName;
      currentCount++;
      added.push(candidate.roomName + "(D" + candidate.distance + ",S" + sc.score + ")");
    }

    if (added.length > 0) {
      console.log("[remotes] " + this.roomName + " auto-added: " + added.join(", "));
    }
    if (removed.length > 0 || added.length > 0) {
      console.log("[remotes] " + this.roomName + " now has " + currentCount + "/" + maxRemotes + " remotes");
    }
  }

  /**
   * Build a map of all assigned remotes across the entire empire.
   * Returns { roomName: colonyName } for overlap checking.
   */
  private getEmpireRemoteAssignments(): Record<string, string> {
    var assignments: Record<string, string> = {};
    var colonies = Memory.colonies || {};
    for (var colName in colonies) {
      var remotes = colonies[colName].remotes || {};
      for (var remoteName in remotes) {
        assignments[remoteName] = colName;
      }
    }
    return assignments;
  }

  /**
   * Check if an existing remote is invalid and should be removed.
   * Returns the reason string if invalid, null if still valid.
   */
  private getRemoteInvalidReason(
    remoteName: string,
    _config: RemoteRoomConfig, // Prefixed with _ to indicate intentionally unused (may use in future for via validation)
    empireAssignments: Record<string, string>,
    myUsername: string,
    intel: Record<string, any>
  ): string | null {
    // Check overlap: if assigned to a different colony, we lose it
    var assignedTo = empireAssignments[remoteName];
    if (assignedTo && assignedTo !== this.roomName) {
      // Check which colony is closer (closer wins)
      var ourDist = this.getRouteDistance(this.roomName, remoteName, intel, myUsername);
      var theirDist = this.getRouteDistance(assignedTo, remoteName, intel, myUsername);

      if (theirDist < ourDist) {
        return "overlap - " + assignedTo + " is closer";
      } else if (theirDist === ourDist) {
        // Equal distance: higher RCL wins
        var ourRoom = Game.rooms[this.roomName];
        var theirRoom = Game.rooms[assignedTo];
        var ourRcl = ourRoom && ourRoom.controller ? ourRoom.controller.level : 0;
        var theirRcl = theirRoom && theirRoom.controller ? theirRoom.controller.level : 0;
        if (theirRcl > ourRcl) {
          return "overlap - " + assignedTo + " has higher RCL";
        }
      }
      // We're closer or equal RCL, we keep it (they should remove theirs)
    }

    // Check distance: must be <= 2 via findRoute
    // BUT: if CPU is low, don't remove existing remotes (conservative)
    if (Game.cpu.bucket < 3000) {
      // Can't validate distance - keep existing remote
      return null;
    }
    var routeDist = this.getRouteDistance(this.roomName, remoteName, intel, myUsername);
    if (routeDist === -1) {
      return "route blocked";
    }
    if (routeDist > 2) {
      return "distance " + routeDist + " > 2";
    }

    // Check if room is still valid target
    var ri = intel[remoteName];
    if (ri) {
      // Owned by hostile
      if (ri.owner && ri.owner !== myUsername) {
        return "hostile owned";
      }
      // Reserved by hostile
      if (ri.reservation && ri.reservation.username !== myUsername) {
        return "hostile reserved";
      }
      // No sources
      if (!ri.sources || ri.sources.length === 0) {
        return "no sources";
      }
      // Source keeper room
      if (ri.roomType === "sourceKeeper") {
        return "source keeper room";
      }
    }

    return null; // Still valid
  }

  /**
   * Get route distance between two rooms using findRoute.
   * Returns -1 if no valid route exists.
   * Uses CPU guard to avoid expensive calculations when bucket is low.
   */
  private getRouteDistance(from: string, to: string, intel: Record<string, any>, myUsername: string): number {
    if (from === to) return 0;

    // CPU guard: if bucket is low, assume invalid
    if (Game.cpu.bucket < 3000) {
      return -1;
    }

    var route = Game.map.findRoute(from, to, {
      routeCallback: function(checkRoom: string) {
        var roomIntel = intel[checkRoom];
        // Block owned rooms (not ours)
        if (roomIntel && roomIntel.owner && roomIntel.owner !== myUsername) {
          return Infinity;
        }
        // Block SK rooms
        if (roomIntel && roomIntel.roomType === "sourceKeeper") {
          return Infinity;
        }
        return 1;
      }
    });

    if (route === ERR_NO_PATH) return -1;
    return (route as any[]).length;
  }

  /**
   * Remote candidate with metadata for distance and path.
   * Filters out rooms already assigned to other colonies (overlap prevention).
   * Uses findRoute for accurate distance calculation.
   *
   * @param empireAssignments - Map of roomName -> colonyName for overlap checking
   */
  private deriveAllRemoteTargets(empireAssignments: Record<string, string>): Array<{
    roomName: string;
    distance: number;
    via?: string;
    sources: number;
  }> {
    var homeRoom = this.roomName;
    var exits = Game.map.describeExits(homeRoom);
    if (!exits) return [];

    var intel = Memory.intel || {};
    var firstSpawn = Object.values(Game.spawns)[0];
    var myUsername = firstSpawn && firstSpawn.owner
      ? firstSpawn.owner.username
      : "";

    var candidates: Array<{
      roomName: string;
      distance: number;
      via?: string;
      sources: number;
    }> = [];
    var distance1Rooms: string[] = [];

    // CPU guard: skip discovery if bucket is critically low
    if (Game.cpu.bucket < 3000) {
      return candidates;
    }

    // === Distance 1: all safe adjacent rooms with sources ===
    for (var dir in exits) {
      var roomName = exits[dir as ExitKey];
      if (!roomName) continue;

      // Skip if already assigned to another colony (overlap prevention)
      if (empireAssignments[roomName] && empireAssignments[roomName] !== homeRoom) {
        continue;
      }

      if (!this.isValidRemoteTarget(roomName, myUsername, intel)) continue;

      var ri = intel[roomName];
      var sources = ri && ri.sources ? ri.sources.length : 0;
      if (sources === 0) continue;

      candidates.push({
        roomName: roomName,
        distance: 1,
        sources: sources,
      });
      distance1Rooms.push(roomName);
    }

    // === Distance 2: rooms beyond adjacent ===
    for (var i = 0; i < distance1Rooms.length; i++) {
      var viaRoom = distance1Rooms[i];
      var viaExits = Game.map.describeExits(viaRoom);
      if (!viaExits) continue;

      for (var dir2 in viaExits) {
        var d2Room = viaExits[dir2 as ExitKey];
        if (!d2Room) continue;

        // Skip if it's the home room or already a distance-1 target
        if (d2Room === homeRoom) continue;
        if (distance1Rooms.indexOf(d2Room) !== -1) continue;
        // Skip if already in candidates (reachable via different path)
        if (candidates.some(function(c) { return c.roomName === d2Room; })) continue;

        // Skip if already assigned to another colony (overlap prevention)
        if (empireAssignments[d2Room] && empireAssignments[d2Room] !== homeRoom) {
          continue;
        }

        if (!this.isValidRemoteTarget(d2Room, myUsername, intel)) continue;

        var ri2 = intel[d2Room];
        var sources2 = ri2 && ri2.sources ? ri2.sources.length : 0;

        // Distance 2 should have sources (prefer 2, but accept 1 if close)
        if (sources2 === 0) continue;

        // Verify actual pathability using Game.map.findRoute
        var route = Game.map.findRoute(homeRoom, d2Room, {
          routeCallback: function(checkRoom: string) {
            // Avoid owned rooms (not ours)
            var roomIntel = intel[checkRoom];
            if (roomIntel && roomIntel.owner && roomIntel.owner !== myUsername) {
              return Infinity; // blocked
            }
            // Avoid SK rooms
            if (roomIntel && roomIntel.roomType === "sourceKeeper") {
              return Infinity;
            }
            return 1; // normal cost
          }
        });

        // Route must exist and be exactly 2 hops (max distance = 2)
        if (route === ERR_NO_PATH) continue;
        if ((route as any).length !== 2) continue;

        // Determine via room from the route
        var actualVia = (route as Array<{exit: ExitConstant, room: string}>)[0].room;

        candidates.push({
          roomName: d2Room,
          distance: 2,
          via: actualVia,
          sources: sources2,
        });
      }
    }

    return candidates;
  }

  /**
   * Check if a room is a valid remote mining target
   */
  private isValidRemoteTarget(roomName: string, myUsername: string, intel: Record<string, any>): boolean {
    var ri = intel[roomName];

    // Must have intel
    if (!ri || !ri.lastScanned) return false;

    // Skip rooms without sources
    if (!ri.sources || ri.sources.length === 0) return false;

    // Skip source keeper rooms
    if (ri.roomType === "sourceKeeper") return false;

    // Skip highway rooms (no controller)
    if (ri.roomType === "highway" || ri.roomType === "center") return false;

    // Skip owned rooms (not ours)
    if (ri.owner && ri.owner !== myUsername) return false;

    // Skip rooms reserved by others
    if (ri.reservation && ri.reservation.username !== myUsername) return false;

    return true;
  }

  /**
   * Derive valid remote mining targets from exits + Memory.intel.
   * Used for initial population and periodic re-sync.
   * Backward compatibility wrapper for deriveAllRemoteTargets.
   */
  private deriveRemoteTargets(): string[] {
    var empireAssignments = this.getEmpireRemoteAssignments();
    return this.deriveAllRemoteTargets(empireAssignments).map(function(c) { return c.roomName; });
  }

  /**
   * Get remote mining target rooms (active only).
   * Reads from Memory.colonies — the single source of truth.
   */
  getRemoteMiningTargets(): string[] {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem || !mem.remotes) {
      return this.deriveRemoteTargets();
    }

    var targets: string[] = [];
    for (var roomName in mem.remotes) {
      var config = mem.remotes[roomName];
      if (config.active) {
        targets.push(roomName);
      }
    }
    return targets;
  }

  /**
   * Get all remote room configurations (for spawning calculations).
   */
  getRemoteConfigs(): Record<string, RemoteRoomConfig> {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem || !mem.remotes) return {};
    return mem.remotes;
  }

  /**
   * Get a specific remote room configuration.
   */
  getRemoteConfig(roomName: string): RemoteRoomConfig | null {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem || !mem.remotes || !mem.remotes[roomName]) return null;
    return mem.remotes[roomName];
  }

  /**
   * Add a remote room to this colony.
   */
  addRemote(roomName: string, distance: number, via?: string): boolean {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem) return false;

    if (!mem.remotes) mem.remotes = {};
    if (mem.remotes[roomName]) return false; // Already exists

    var intel = Memory.intel && Memory.intel[roomName];
    var sources = intel && intel.sources ? intel.sources.length : 2;

    mem.remotes[roomName] = {
      room: roomName,
      homeColony: this.roomName,
      distance: distance,
      via: via,
      sources: sources,
      active: true,
      activatedAt: Game.time,
      miners: [],
      haulers: [],
    };

    console.log("[Colony] " + this.roomName + " added remote " + roomName + " (distance: " + distance + (via ? ", via: " + via : "") + ")");
    return true;
  }

  /**
   * Remove a remote room from this colony.
   */
  removeRemote(roomName: string): boolean {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem || !mem.remotes || !mem.remotes[roomName]) return false;

    delete mem.remotes[roomName];
    console.log("[Colony] " + this.roomName + " removed remote " + roomName);
    return true;
  }

  /**
   * Pause/unpause a remote room.
   */
  toggleRemote(roomName: string, reason?: string): boolean {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem || !mem.remotes || !mem.remotes[roomName]) return false;

    var config = mem.remotes[roomName];
    config.active = !config.active;

    if (!config.active) {
      config.pausedUntil = Game.time + 5000;
      config.pauseReason = reason || "Manual pause";
      console.log("[Colony] " + this.roomName + " paused remote " + roomName);
    } else {
      delete config.pausedUntil;
      delete config.pauseReason;
      console.log("[Colony] " + this.roomName + " unpaused remote " + roomName);
    }

    return true;
  }

  /**
   * Update creep assignments for remotes.
   * Called periodically to track which creeps are assigned to which remote.
   */
  updateRemoteAssignments(): void {
    var mem = Memory.colonies && Memory.colonies[this.roomName];
    if (!mem || !mem.remotes) return;

    // Clear existing assignments
    for (var roomName in mem.remotes) {
      mem.remotes[roomName].miners = [];
      mem.remotes[roomName].haulers = [];
    }

    // Reassign based on current creeps
    for (var name in Game.creeps) {
      var creep = Game.creeps[name];
      if (creep.memory.room !== this.roomName) continue;

      var targetRoom = creep.memory.targetRoom;
      if (!targetRoom || !mem.remotes[targetRoom]) continue;

      if (creep.memory.role === "REMOTE_MINER") {
        mem.remotes[targetRoom].miners.push(name);
      } else if (creep.memory.role === "REMOTE_HAULER") {
        mem.remotes[targetRoom].haulers.push(name);
      }
    }
  }

  /**
   * Calculate how many creeps of each role we need
   */
  getWorkforceNeeds(): WorkforceNeeds {
    const state = this.getState();
    if (!state) {
      return {
        HARVESTER: 2,
        HAULER: 0,
        UPGRADER: 1,
        BUILDER: 0,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 0,
      };
    }

    const sources = state.sources.length;
    const rcl = state.room.controller?.level || 0;
    const constructionSites = state.constructionSites.length;

    // Harvesters: 1 per source (static miners at containers)
    const harvesters = sources;

    // Haulers: 1 per source (matches spawning logic)
    const haulers = sources;

    // Upgraders: scales with RCL, cap at 3 until RCL 8
    const upgraders = rcl < 8 ? Math.min(rcl, 3) : 1;

    // Builders: floor of 2 when sites exist, scales 1 per 10 sites
    // Matches spawning logic: Math.max(2, Math.min(rcl, 4)) cap
    const maxBuildersByEconomy = Math.max(2, Math.min(rcl, 4));
    const builders = constructionSites > 0
      ? Math.min(Math.ceil(constructionSites / 10), maxBuildersByEconomy)
      : 0;

    // Defenders: based on threat level
    let defenders = 0;
    const hostiles = state.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
      // Calculate total threat level
      const totalThreat = hostiles.reduce((sum, h) => {
        return (
          sum +
          h.getActiveBodyparts(ATTACK) * 30 +
          h.getActiveBodyparts(RANGED_ATTACK) * 10 +
          h.getActiveBodyparts(HEAL) * 12
        );
      }, 0);

      // Scale defenders to threat
      if (totalThreat > 0) defenders = 1;
      if (totalThreat > 100) defenders = 2;
      if (totalThreat > 300) defenders = 3;
    }

    // Remote mining (RCL 4+) - use new remote config format
    let remoteMiners = 0;
    let remoteHaulers = 0;
    let reservers = 0;

    if (rcl >= 4) {
      var remoteConfigs = this.getRemoteConfigs();
      var activeRemoteCount = 0;

      for (var roomName in remoteConfigs) {
        var config = remoteConfigs[roomName];
        if (!config.active) continue;

        activeRemoteCount++;

        // 1 remote miner per source
        remoteMiners += config.sources || 2;

        // Haulers scale with distance
        // Distance 1: 2 haulers per remote
        // Distance 2: 3 haulers per remote (longer round trip)
        var haulersForRemote = config.distance >= 2 ? 3 : 2;
        remoteHaulers += haulersForRemote;
      }

      // 1 reserver per active remote room
      reservers = activeRemoteCount;
    }

    // Scouts (RCL 4+): 1 if any adjacent room needs intel
    let scouts = 0;
    if (rcl >= 4) {
      const exits = Game.map.describeExits(this.roomName);
      if (exits) {
        for (const dir in exits) {
          const adjacentRoom = exits[dir as ExitKey];
          if (!adjacentRoom) continue;

          const intel = Memory.intel && Memory.intel[adjacentRoom];
          const lastScan = intel ? intel.lastScanned : 0;

          // Need scout if any adjacent room hasn't been scanned in 2000 ticks
          if (Game.time - lastScan > 2000) {
            scouts = 1;
            break;
          }
        }
      }
    }

    return {
      HARVESTER: harvesters,
      HAULER: haulers,
      UPGRADER: upgraders,
      BUILDER: builders,
      DEFENDER: defenders,
      REMOTE_MINER: remoteMiners,
      REMOTE_HAULER: remoteHaulers,
      RESERVER: reservers,
      SCOUT: scouts,
    };
  }

  /**
   * Check if we need more of a specific role
   */
  needsCreep(role: string): boolean {
    const needs = this.getWorkforceNeeds();
    const target = needs[role as keyof WorkforceNeeds] ?? 0;
    const current = this.getCreepCount(role);
    return current < target;
  }

  /**
   * Get count of creeps with a role in this room
   */
  getCreepCount(role: string): number {
    return Object.values(Game.creeps).filter(
      (c) => c.memory.room === this.roomName && c.memory.role === role
    ).length;
  }

  /**
   * Ensure room memory structure exists
   */
  private ensureMemory(): void {
    if (!Memory.rooms) {
      Memory.rooms = {};
    }
    if (!Memory.rooms[this.roomName]) {
      Memory.rooms[this.roomName] = {};
    }
    if (!Memory.rooms[this.roomName].tasks) {
      Memory.rooms[this.roomName].tasks = [];
    }
  }
}
