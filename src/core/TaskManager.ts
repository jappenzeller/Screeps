import { logger } from "../utils/Logger";
import { CachedColonyState } from "./ColonyState";

/**
 * Task types
 */
export enum TaskType {
  HAUL_COLLECT = "HAUL_COLLECT", // Pick up energy from container/ground
  HAUL_DELIVER = "HAUL_DELIVER", // Deliver energy to spawn/extension/tower
  BUILD = "BUILD", // Build a construction site
  REPAIR = "REPAIR", // Repair a structure
  UPGRADE = "UPGRADE", // Upgrade controller
}

/**
 * Task priority (higher = more urgent)
 */
export enum TaskPriority {
  CRITICAL = 100, // Emergency - spawn needs energy
  HIGH = 75, // Important - towers need energy
  NORMAL = 50, // Standard priority
  LOW = 25, // Can wait
}

/**
 * A task that can be assigned to a creep
 */
export interface Task {
  id: string;
  type: TaskType;
  targetId: Id<_HasId>;
  targetPos: RoomPosition;
  priority: TaskPriority;
  resourceType?: ResourceConstant;
  amount?: number;
  assignedTo?: string; // creep name
  roomName: string;
}

// Global task storage
declare const global: {
  tasksByRoom?: Map<string, Task[]>;
  taskLastTick?: number;
};

/**
 * TaskManager - Generates and assigns tasks to creeps
 */
export class TaskManager {
  private static ensureGlobalInit(): void {
    if (!global.tasksByRoom || global.taskLastTick !== Game.time) {
      global.tasksByRoom = new Map();
      global.taskLastTick = Game.time;
    }
  }

  /**
   * Generate all tasks for a room based on colony state
   */
  static generateTasks(state: CachedColonyState): Task[] {
    this.ensureGlobalInit();

    const tasks: Task[] = [];

    // Generate delivery tasks (where energy needs to go)
    this.generateDeliveryTasks(state, tasks);

    // Generate collection tasks (where to get energy)
    this.generateCollectionTasks(state, tasks);

    // Generate build tasks
    this.generateBuildTasks(state, tasks);

    // Generate repair tasks (only if energy is abundant)
    if (state.energy.storageAmount > 10000 || state.energy.available > state.energy.capacity * 0.8) {
      this.generateRepairTasks(state, tasks);
    }

    // Sort by priority
    tasks.sort((a, b) => b.priority - a.priority);

    // Store in global
    global.tasksByRoom!.set(state.room.name, tasks);

    return tasks;
  }

  /**
   * Generate tasks for delivering energy
   */
  private static generateDeliveryTasks(state: CachedColonyState, tasks: Task[]): void {
    // Spawn/extensions needing energy (CRITICAL if spawn empty, HIGH otherwise)
    if (state.energy.spawnNeedsEnergy) {
      const priority =
        state.energy.available < 300 ? TaskPriority.CRITICAL : TaskPriority.HIGH;

      // Find spawn needing energy
      for (const spawn of state.structures.spawns) {
        if (spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          tasks.push({
            id: `deliver-${spawn.id}`,
            type: TaskType.HAUL_DELIVER,
            targetId: spawn.id,
            targetPos: spawn.pos,
            priority,
            resourceType: RESOURCE_ENERGY,
            amount: spawn.store.getFreeCapacity(RESOURCE_ENERGY),
            roomName: state.room.name,
          });
        }
      }

      // Find extensions needing energy
      for (const ext of state.structures.extensions) {
        if (ext.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          tasks.push({
            id: `deliver-${ext.id}`,
            type: TaskType.HAUL_DELIVER,
            targetId: ext.id,
            targetPos: ext.pos,
            priority: TaskPriority.HIGH,
            resourceType: RESOURCE_ENERGY,
            amount: ext.store.getFreeCapacity(RESOURCE_ENERGY),
            roomName: state.room.name,
          });
        }
      }
    }

    // Towers needing energy
    if (state.energy.towersNeedEnergy) {
      const priority =
        state.threat.level > 0 ? TaskPriority.CRITICAL : TaskPriority.NORMAL;

      for (const tower of state.structures.towers) {
        const freeCapacity = tower.store.getFreeCapacity(RESOURCE_ENERGY);
        if (freeCapacity > 200) {
          tasks.push({
            id: `deliver-${tower.id}`,
            type: TaskType.HAUL_DELIVER,
            targetId: tower.id,
            targetPos: tower.pos,
            priority,
            resourceType: RESOURCE_ENERGY,
            amount: freeCapacity,
            roomName: state.room.name,
          });
        }
      }
    }

    // Storage (LOW priority - only if nothing else needs energy)
    if (state.structures.storage && !state.energy.spawnNeedsEnergy && !state.energy.towersNeedEnergy) {
      const freeCapacity = state.structures.storage.store.getFreeCapacity(RESOURCE_ENERGY);
      if (freeCapacity > 0) {
        tasks.push({
          id: `deliver-${state.structures.storage.id}`,
          type: TaskType.HAUL_DELIVER,
          targetId: state.structures.storage.id,
          targetPos: state.structures.storage.pos,
          priority: TaskPriority.LOW,
          resourceType: RESOURCE_ENERGY,
          amount: freeCapacity,
          roomName: state.room.name,
        });
      }
    }
  }

  /**
   * Generate tasks for collecting energy
   */
  private static generateCollectionTasks(state: CachedColonyState, tasks: Task[]): void {
    // Dropped resources (HIGH priority - energy decays)
    for (const dropped of state.energy.droppedResources) {
      tasks.push({
        id: `collect-${dropped.id}`,
        type: TaskType.HAUL_COLLECT,
        targetId: dropped.id,
        targetPos: dropped.pos,
        priority: TaskPriority.HIGH,
        resourceType: RESOURCE_ENERGY,
        amount: dropped.amount,
        roomName: state.room.name,
      });
    }

    // Containers with energy
    for (const container of state.energy.containersWithEnergy) {
      tasks.push({
        id: `collect-${container.id}`,
        type: TaskType.HAUL_COLLECT,
        targetId: container.id,
        targetPos: Game.getObjectById(container.id)?.pos ?? new RoomPosition(25, 25, state.room.name),
        priority: TaskPriority.NORMAL,
        resourceType: RESOURCE_ENERGY,
        amount: container.amount,
        roomName: state.room.name,
      });
    }

    // Storage (only if spawn/towers need energy and containers are empty)
    if (
      state.structures.storage &&
      state.energy.storageAmount > 0 &&
      (state.energy.spawnNeedsEnergy || state.energy.towersNeedEnergy) &&
      state.energy.containersWithEnergy.length === 0
    ) {
      tasks.push({
        id: `collect-${state.structures.storage.id}`,
        type: TaskType.HAUL_COLLECT,
        targetId: state.structures.storage.id,
        targetPos: state.structures.storage.pos,
        priority: TaskPriority.NORMAL,
        resourceType: RESOURCE_ENERGY,
        amount: state.energy.storageAmount,
        roomName: state.room.name,
      });
    }
  }

  /**
   * Generate build tasks
   */
  private static generateBuildTasks(state: CachedColonyState, tasks: Task[]): void {
    // Prioritize by structure type
    const sitePriorities: Record<string, number> = {
      [STRUCTURE_SPAWN]: TaskPriority.CRITICAL,
      [STRUCTURE_EXTENSION]: TaskPriority.HIGH,
      [STRUCTURE_TOWER]: TaskPriority.HIGH,
      [STRUCTURE_STORAGE]: TaskPriority.NORMAL,
      [STRUCTURE_CONTAINER]: TaskPriority.NORMAL,
      [STRUCTURE_ROAD]: TaskPriority.LOW,
      [STRUCTURE_WALL]: TaskPriority.LOW,
      [STRUCTURE_RAMPART]: TaskPriority.LOW,
    };

    // Get spawn position for distance-based priority
    const spawn = state.structures.spawns[0];

    // Sort sites by distance from spawn (closer first) for roads and containers
    const sortedSites = [...state.constructionSites].sort((a, b) => {
      if (!spawn) return 0;
      // Apply distance sorting to roads and containers
      const aIsDistancePriority = a.structureType === STRUCTURE_ROAD || a.structureType === STRUCTURE_CONTAINER;
      const bIsDistancePriority = b.structureType === STRUCTURE_ROAD || b.structureType === STRUCTURE_CONTAINER;
      if (aIsDistancePriority && bIsDistancePriority && a.structureType === b.structureType) {
        return a.pos.getRangeTo(spawn) - b.pos.getRangeTo(spawn);
      }
      return 0;
    });

    for (const site of sortedSites) {
      let priority = sitePriorities[site.structureType] ?? TaskPriority.LOW;

      // For roads and containers, prioritize by distance from spawn (closer = higher priority)
      if ((site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER) && spawn) {
        const distance = site.pos.getRangeTo(spawn);
        // Closer sites get higher priority (50 - distance)
        priority += Math.max(0, 50 - distance);
      }

      tasks.push({
        id: `build-${site.id}`,
        type: TaskType.BUILD,
        targetId: site.id,
        targetPos: site.pos,
        priority,
        roomName: state.room.name,
      });
    }
  }

  /**
   * Generate repair tasks
   */
  private static generateRepairTasks(state: CachedColonyState, tasks: Task[]): void {
    // Find damaged structures (not walls/ramparts)
    const damaged = state.room.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return s.hits < 10000; // Only very low walls
        }
        return s.hits < s.hitsMax * 0.5;
      },
    });

    for (const structure of damaged) {
      tasks.push({
        id: `repair-${structure.id}`,
        type: TaskType.REPAIR,
        targetId: structure.id,
        targetPos: structure.pos,
        priority: structure.structureType === STRUCTURE_CONTAINER ? TaskPriority.NORMAL : TaskPriority.LOW,
        roomName: state.room.name,
      });
    }
  }

  /**
   * Request a task for a creep
   * @param creep The creep requesting a task
   * @param taskTypes Types of tasks the creep can do
   * @param filter Optional filter function to narrow down tasks
   * @returns The assigned task, or null if none available
   */
  static requestTask(
    creep: Creep,
    taskTypes: TaskType[],
    filter?: (task: Task) => boolean
  ): Task | null {
    this.ensureGlobalInit();

    const tasks = global.tasksByRoom!.get(creep.memory.room);
    if (!tasks) return null;

    // Find highest priority unassigned task that this creep can do
    for (const task of tasks) {
      if (!task.assignedTo && taskTypes.includes(task.type)) {
        // Apply optional filter
        if (filter && !filter(task)) continue;

        // Assign the task
        task.assignedTo = creep.name;
        creep.memory.taskId = task.id;
        logger.debug("TaskManager", `Assigned ${task.type} to ${creep.name}`);
        return task;
      }
    }

    return null;
  }

  /**
   * Get a creep's current task
   */
  static getCreepTask(creep: Creep): Task | null {
    if (!creep.memory.taskId) return null;

    this.ensureGlobalInit();
    const tasks = global.tasksByRoom!.get(creep.memory.room);
    if (!tasks) return null;

    return tasks.find((t) => t.id === creep.memory.taskId) ?? null;
  }

  /**
   * Complete a task (remove assignment)
   */
  static completeTask(creep: Creep): void {
    delete creep.memory.taskId;
  }

  /**
   * Release a task (allow reassignment)
   */
  static releaseTask(creep: Creep): void {
    const task = this.getCreepTask(creep);
    if (task) {
      task.assignedTo = undefined;
    }
    delete creep.memory.taskId;
  }

  /**
   * Get tasks for a room (for debugging)
   */
  static getTasks(roomName: string): Task[] {
    this.ensureGlobalInit();
    return global.tasksByRoom!.get(roomName) ?? [];
  }

  /**
   * Get count of unassigned tasks by type
   */
  static getUnassignedTaskCount(roomName: string, type: TaskType): number {
    this.ensureGlobalInit();
    const tasks = global.tasksByRoom!.get(roomName) ?? [];
    return tasks.filter((t) => t.type === type && !t.assignedTo).length;
  }
}
