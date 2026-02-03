import { logger } from "../utils/Logger";

/**
 * Threat level for a room
 */
export enum ThreatLevel {
  NONE = 0,
  LOW = 1, // Few weak hostiles
  MEDIUM = 2, // Multiple hostiles or some with combat parts
  HIGH = 3, // Strong hostile force
  CRITICAL = 4, // Spawn under attack
}

/**
 * Cached structure data (refreshed every 50 ticks)
 */
export interface StructureCache {
  containers: StructureContainer[];
  extensions: StructureExtension[];
  towers: StructureTower[];
  links: StructureLink[];
  storage: StructureStorage | null;
  terminal: StructureTerminal | null;
  spawns: StructureSpawn[];
  lastRefresh: number;
}

/**
 * Energy status (refreshed every tick)
 */
export interface EnergyStatus {
  available: number;
  capacity: number;
  storageAmount: number;
  spawnNeedsEnergy: boolean;
  towersNeedEnergy: boolean;
  containersWithEnergy: { id: Id<StructureContainer>; amount: number }[];
  droppedResources: Resource[];
}

/**
 * Threat assessment (refreshed every tick)
 */
export interface ThreatStatus {
  hostiles: Creep[];
  level: ThreatLevel;
  spawnUnderAttack: boolean;
  healers: Creep[];
  ranged: Creep[];
  melee: Creep[];
}

/**
 * Creep tracking (refreshed every tick)
 */
export interface CreepStatus {
  all: Creep[];
  byRole: Record<string, Creep[]>;
  dying: Creep[]; // ticksToLive < 100
}

/**
 * Source assignment tracking
 */
export interface SourceAssignment {
  sourceId: Id<Source>;
  creepName: string | null;
  hasContainer: boolean;
  containerId: Id<StructureContainer> | null;
}

/**
 * Emergency state detection
 */
export interface EmergencyState {
  noHarvesters: boolean;
  spawnDying: boolean;
  lowEnergy: boolean;
  isEmergency: boolean;
}

/**
 * Complete colony state
 */
export interface CachedColonyState {
  room: Room;
  structures: StructureCache;
  energy: EnergyStatus;
  threat: ThreatStatus;
  creeps: CreepStatus;
  sources: Source[];
  sourceAssignments: SourceAssignment[];
  constructionSites: ConstructionSite[];
  emergency: EmergencyState;
  rcl: number;
}

// Cache refresh intervals
const STRUCTURE_REFRESH_INTERVAL = 50;

// Global state storage (survives module re-execution within a tick)
declare const global: {
  colonyStates?: Map<string, CachedColonyState>;
  stateLastTick?: number;
};

/**
 * ColonyStateManager - Centralized state cache with tiered refresh
 */
export class ColonyStateManager {
  private static ensureGlobalInit(): void {
    if (!global.colonyStates || global.stateLastTick !== Game.time) {
      global.colonyStates = new Map();
      global.stateLastTick = Game.time;
    }
  }

  /**
   * Get cached state for a room, refreshing as needed
   */
  static getState(roomName: string): CachedColonyState | null {
    this.ensureGlobalInit();

    const room = Game.rooms[roomName];
    if (!room || !room.controller?.my) {
      return null;
    }

    let state = global.colonyStates!.get(roomName);

    if (!state) {
      // First time - full initialization
      state = this.createFullState(room);
      global.colonyStates!.set(roomName, state);
    } else {
      // Refresh based on intervals
      this.refreshState(state, room);
    }

    return state;
  }

  /**
   * Create full state from scratch
   */
  private static createFullState(room: Room): CachedColonyState {
    const structures = this.refreshStructures(room);
    const sources = room.find(FIND_SOURCES);

    return {
      room,
      structures,
      energy: this.refreshEnergy(room, structures),
      threat: this.refreshThreat(room, structures),
      creeps: this.refreshCreeps(room.name),
      sources,
      sourceAssignments: this.refreshSourceAssignments(room, sources, structures),
      constructionSites: room.find(FIND_CONSTRUCTION_SITES),
      emergency: { noHarvesters: false, spawnDying: false, lowEnergy: false, isEmergency: false },
      rcl: room.controller?.level ?? 0,
    };
  }

  /**
   * Refresh state based on intervals
   */
  private static refreshState(state: CachedColonyState, room: Room): void {
    // Always refresh these every tick
    state.room = room;
    state.energy = this.refreshEnergy(room, state.structures);
    state.threat = this.refreshThreat(room, state.structures);
    state.creeps = this.refreshCreeps(room.name);
    state.rcl = room.controller?.level ?? 0;

    // Refresh structures periodically
    if (Game.time - state.structures.lastRefresh >= STRUCTURE_REFRESH_INTERVAL) {
      state.structures = this.refreshStructures(room);
      state.sourceAssignments = this.refreshSourceAssignments(room, state.sources, state.structures);
      state.constructionSites = room.find(FIND_CONSTRUCTION_SITES);
    }

    // Update emergency state
    state.emergency = this.checkEmergency(state);
  }

  /**
   * Refresh structure cache
   */
  private static refreshStructures(room: Room): StructureCache {
    const structures = room.find(FIND_STRUCTURES);
    const myStructures = room.find(FIND_MY_STRUCTURES);

    return {
      containers: structures.filter(
        (s) => s.structureType === STRUCTURE_CONTAINER
      ) as StructureContainer[],
      extensions: myStructures.filter(
        (s) => s.structureType === STRUCTURE_EXTENSION
      ) as StructureExtension[],
      towers: myStructures.filter((s) => s.structureType === STRUCTURE_TOWER) as StructureTower[],
      links: myStructures.filter((s) => s.structureType === STRUCTURE_LINK) as StructureLink[],
      storage: room.storage ?? null,
      terminal: room.terminal ?? null,
      spawns: room.find(FIND_MY_SPAWNS),
      lastRefresh: Game.time,
    };
  }

  /**
   * Refresh energy status
   */
  private static refreshEnergy(room: Room, structures: StructureCache): EnergyStatus {
    const containersWithEnergy = structures.containers
      .filter((c) => c.store[RESOURCE_ENERGY] > 0)
      .map((c) => ({ id: c.id, amount: c.store[RESOURCE_ENERGY] }))
      .sort((a, b) => b.amount - a.amount);

    const spawnNeedsEnergy = room.energyAvailable < room.energyCapacityAvailable;
    const towersNeedEnergy = structures.towers.some(
      (t) => t.store[RESOURCE_ENERGY] < t.store.getCapacity(RESOURCE_ENERGY) * 0.8
    );

    return {
      available: room.energyAvailable,
      capacity: room.energyCapacityAvailable,
      storageAmount: structures.storage?.store[RESOURCE_ENERGY] ?? 0,
      spawnNeedsEnergy,
      towersNeedEnergy,
      containersWithEnergy,
      droppedResources: room.find(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 50,
      }),
    };
  }

  /**
   * Refresh threat assessment
   */
  private static refreshThreat(room: Room, structures: StructureCache): ThreatStatus {
    const hostiles = room.find(FIND_HOSTILE_CREEPS);

    const healers = hostiles.filter((h) => h.getActiveBodyparts(HEAL) > 0);
    const ranged = hostiles.filter((h) => h.getActiveBodyparts(RANGED_ATTACK) > 0);
    const melee = hostiles.filter((h) => h.getActiveBodyparts(ATTACK) > 0);

    // Check if spawn is under attack
    const spawnUnderAttack = structures.spawns.some((spawn) => {
      return hostiles.some((h) => h.pos.inRangeTo(spawn.pos, 3));
    });

    // Calculate threat level
    let level = ThreatLevel.NONE;
    if (hostiles.length > 0) {
      const totalCombatParts =
        healers.reduce((sum, h) => sum + h.getActiveBodyparts(HEAL), 0) +
        ranged.reduce((sum, h) => sum + h.getActiveBodyparts(RANGED_ATTACK), 0) +
        melee.reduce((sum, h) => sum + h.getActiveBodyparts(ATTACK), 0);

      if (spawnUnderAttack) {
        level = ThreatLevel.CRITICAL;
      } else if (totalCombatParts > 20) {
        level = ThreatLevel.HIGH;
      } else if (totalCombatParts > 5 || hostiles.length > 3) {
        level = ThreatLevel.MEDIUM;
      } else {
        level = ThreatLevel.LOW;
      }
    }

    // NOTE: Hostile tracking is now done centrally in Memory.intel via gatherRoomIntel()
    // No need to duplicate here

    return { hostiles, level, spawnUnderAttack, healers, ranged, melee };
  }

  /**
   * Refresh creep tracking
   */
  private static refreshCreeps(roomName: string): CreepStatus {
    const all = Object.values(Game.creeps).filter((c) => c.memory.room === roomName);
    const byRole: Record<string, Creep[]> = {};
    const dying: Creep[] = [];

    for (const creep of all) {
      const role = creep.memory.role;
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(creep);

      if (creep.ticksToLive && creep.ticksToLive < 100) {
        dying.push(creep);
      }
    }

    return { all, byRole, dying };
  }

  /**
   * Refresh source assignments
   */
  private static refreshSourceAssignments(
    room: Room,
    sources: Source[],
    structures: StructureCache
  ): SourceAssignment[] {
    const assignments: SourceAssignment[] = [];

    for (const source of sources) {
      // Find container near source
      const nearbyContainer = structures.containers.find((c) => c.pos.inRangeTo(source.pos, 2));

      // Find assigned harvester
      const harvester = Object.values(Game.creeps).find(
        (c) =>
          c.memory.role === "HARVESTER" &&
          c.memory.room === room.name &&
          c.memory.sourceId === source.id
      );

      assignments.push({
        sourceId: source.id,
        creepName: harvester?.name ?? null,
        hasContainer: !!nearbyContainer,
        containerId: nearbyContainer?.id ?? null,
      });
    }

    return assignments;
  }

  /**
   * Check emergency state
   */
  private static checkEmergency(state: CachedColonyState): EmergencyState {
    const harvesters = state.creeps.byRole["HARVESTER"] ?? [];
    const noHarvesters = harvesters.length === 0;

    const spawn = state.structures.spawns[0];
    const spawnDying = spawn ? spawn.hits < spawn.hitsMax * 0.3 : false;

    const lowEnergy =
      state.energy.available < 200 &&
      state.energy.storageAmount < 1000 &&
      state.energy.containersWithEnergy.length === 0;

    const isEmergency = noHarvesters || spawnDying || (lowEnergy && noHarvesters);

    if (isEmergency) {
      logger.warn(
        "ColonyState",
        `Emergency in ${state.room.name}: noHarvesters=${noHarvesters}, spawnDying=${spawnDying}, lowEnergy=${lowEnergy}`
      );
    }

    return { noHarvesters, spawnDying, lowEnergy, isEmergency };
  }

  /**
   * Get unassigned source for a new harvester
   */
  static getUnassignedSource(state: CachedColonyState): Source | null {
    for (const assignment of state.sourceAssignments) {
      if (!assignment.creepName) {
        return Game.getObjectById(assignment.sourceId);
      }
    }
    return null;
  }

  /**
   * Clear state for a room (call when room is lost)
   */
  static clearState(roomName: string): void {
    this.ensureGlobalInit();
    global.colonyStates!.delete(roomName);
  }

  /**
   * Force refresh all state (for debugging)
   */
  static forceRefresh(roomName: string): CachedColonyState | null {
    this.ensureGlobalInit();
    global.colonyStates!.delete(roomName);
    return this.getState(roomName);
  }
}
