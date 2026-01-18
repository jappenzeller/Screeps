/**
 * ColonyManager: Single source of truth for colony coordination.
 * Manages colony phase detection and task assignment.
 */

import { ColonyStateManager, CachedColonyState } from "./ColonyState";

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

    if (suitableTasks.length === 0) return null;

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

    // Return the best match
    return suitableTasks[0];
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
   * Get list of valid remote mining room targets
   */
  getRemoteMiningTargets(): string[] {
    const targets: string[] = [];
    const homeRoom = this.roomName;
    const exits = Game.map.describeExits(homeRoom);

    if (!exits || !Memory.rooms) return targets;

    // Get our username dynamically
    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

    for (const dir in exits) {
      const roomName = exits[dir as ExitKey];
      if (!roomName) continue;

      const intel = Memory.rooms[roomName];
      if (!intel || !intel.lastScan) continue;

      // Check if room is a valid remote mining target
      const isOwnedByOther = intel.controller?.owner && intel.controller.owner !== myUsername;
      const isReservedByOther =
        intel.controller?.reservation &&
        intel.controller.reservation.username !== myUsername;
      const hasSources = intel.sources && intel.sources.length > 0;
      const isSafe = !intel.hasKeepers && !intel.hasInvaderCore && (intel.hostiles || 0) === 0;
      const recentScan = Game.time - intel.lastScan < 2000;

      if (!isOwnedByOther && !isReservedByOther && hasSources && isSafe && recentScan) {
        targets.push(roomName);
      }
    }

    return targets;
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

    const phase = this.getPhase();
    const sources = state.sources.length;
    const hasContainers = state.structures.containers.length > 0;
    const hasStorage = !!state.structures.storage;
    const constructionSites = state.constructionSites.length;

    // Harvesters: 1 per source with containers, 2 per source without
    const harvesters = hasContainers ? sources : sources * 2;

    // Haulers: 0 without containers, 2 with containers, 3 with storage
    let haulers = 0;
    if (hasContainers) haulers = 2;
    if (hasStorage) haulers = 3;

    // Upgraders: varies by phase
    let upgraders = 1;
    if (phase === ColonyPhase.DEVELOPING) upgraders = 2;
    if (phase === ColonyPhase.STABLE) upgraders = 3;

    // Builders: 0 if no sites, 1-2 based on site count
    let builders = 0;
    if (constructionSites > 0) {
      builders = Math.min(2, Math.ceil(constructionSites / 5));
    }

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

    // Remote mining (RCL 4+)
    let remoteMiners = 0;
    let remoteHaulers = 0;
    let reservers = 0;

    const rcl = state.room.controller?.level || 0;
    if (rcl >= 4) {
      const remoteTargets = this.getRemoteMiningTargets();

      // 1 remote miner per source in remote rooms
      for (const roomName of remoteTargets) {
        const intel = Memory.rooms?.[roomName];
        const sourcesInRoom = intel?.sources?.length || 0;
        remoteMiners += sourcesInRoom;
      }

      // 1 reserver per 2 remote rooms (to maintain reservation)
      if (remoteTargets.length > 0) {
        reservers = Math.ceil(remoteTargets.length / 2);
      }

      // 2 remote haulers per remote room
      remoteHaulers = remoteTargets.length * 2;
    }

    // Scouts (RCL 4+): 1 if any adjacent room needs intel
    let scouts = 0;
    if (rcl >= 4) {
      const exits = Game.map.describeExits(this.roomName);
      if (exits) {
        for (const dir in exits) {
          const adjacentRoom = exits[dir as ExitKey];
          if (!adjacentRoom) continue;

          const intel = Memory.rooms?.[adjacentRoom];
          const lastScan = intel?.lastScan || 0;

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
