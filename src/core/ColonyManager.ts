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
  | "HAUL";

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

    // Emergency takes priority
    if (state.emergency.isEmergency || state.threat.level >= 3) {
      return ColonyPhase.EMERGENCY;
    }

    // Check creep count for bootstrap
    const creepCount = state.creeps.all.length;
    if (creepCount < 3) {
      return ColonyPhase.BOOTSTRAP;
    }

    // Phase based on RCL
    const rcl = state.rcl;
    if (rcl <= 2) {
      return ColonyPhase.BOOTSTRAP;
    } else if (rcl <= 4) {
      return ColonyPhase.DEVELOPING;
    } else {
      return ColonyPhase.STABLE;
    }
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

    const tasks: Task[] = [];
    const existingTasks = this.getTasks();

    // Helper to check if a task type already exists (not completed)
    const hasActiveTask = (type: TaskType, targetId?: Id<any>): boolean => {
      return existingTasks.some(
        (t) => t.type === type && (targetId === undefined || t.targetId === targetId)
      );
    };

    // Priority 1: SUPPLY_SPAWN - one task for the spawn cluster
    if (state.energy.available < state.energy.capacity) {
      if (!hasActiveTask("SUPPLY_SPAWN")) {
        // Use spawn as the target for the cluster
        const spawn = state.structures.spawns[0];
        if (spawn) {
          tasks.push({
            id: `supply_spawn_${spawn.id}_${Game.time}`,
            type: "SUPPLY_SPAWN",
            targetId: spawn.id,
            priority: 1,
            assignedCreep: null,
            createdAt: Game.time,
          });
        }
      }
    }

    // Priority 2: HARVEST - one task per source without assigned harvester
    for (const assignment of state.sourceAssignments) {
      // Only generate if no harvester assigned to this source
      if (!assignment.creepName && !hasActiveTask("HARVEST", assignment.sourceId)) {
        tasks.push({
          id: `harvest_${assignment.sourceId}_${Game.time}`,
          type: "HARVEST",
          targetId: assignment.sourceId,
          priority: 2,
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // Priority 3: SUPPLY_TOWER - towers below 500 energy
    for (const tower of state.structures.towers) {
      if (tower.store[RESOURCE_ENERGY] < 500 && !hasActiveTask("SUPPLY_TOWER", tower.id)) {
        tasks.push({
          id: `supply_tower_${tower.id}_${Game.time}`,
          type: "SUPPLY_TOWER",
          targetId: tower.id,
          priority: 3,
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // Priority 4: BUILD - max 3 active, prioritize container > extension > road
    const existingBuildTasks = existingTasks.filter((t) => t.type === "BUILD").length;
    if (existingBuildTasks < 3 && state.constructionSites.length > 0) {
      // Sort sites by priority: container > extension > road > other
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

      // Add tasks up to max 3
      let buildTasksToAdd = 3 - existingBuildTasks;
      for (const site of sortedSites) {
        if (buildTasksToAdd <= 0) break;
        if (!hasActiveTask("BUILD", site.id)) {
          tasks.push({
            id: `build_${site.id}_${Game.time}`,
            type: "BUILD",
            targetId: site.id,
            priority: 4,
            assignedCreep: null,
            createdAt: Game.time,
          });
          buildTasksToAdd--;
        }
      }
    }

    // Priority 5: UPGRADE - always 1-2 upgrade tasks available
    const controller = state.room.controller;
    if (controller) {
      const existingUpgradeTasks = existingTasks.filter((t) => t.type === "UPGRADE").length;
      const upgradeTasksNeeded = 2 - existingUpgradeTasks;
      for (let i = 0; i < upgradeTasksNeeded; i++) {
        tasks.push({
          id: `upgrade_${controller.id}_${Game.time}_${i}`,
          type: "UPGRADE",
          targetId: controller.id,
          priority: 5,
          assignedCreep: null,
          createdAt: Game.time,
        });
      }
    }

    // Priority 6: HAUL - containers with > 500 energy or dropped resources
    for (const container of state.energy.containersWithEnergy) {
      if (container.amount > 500 && !hasActiveTask("HAUL", container.id)) {
        tasks.push({
          id: `haul_${container.id}_${Game.time}`,
          type: "HAUL",
          targetId: container.id,
          priority: 6,
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
          priority: 6,
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
