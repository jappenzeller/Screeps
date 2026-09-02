/**
 * WorldState - Immutable snapshot of the game world
 *
 * Captured once per tick, all evaluators read from this snapshot.
 * No evaluator calls room.find() directly - all queries go through WorldState.
 *
 * OPTIMIZATIONS (v2):
 * 1. Creep cache - single Object.values(Game.creeps) per tick, indexed by room+role
 * 2. Tiered capture - structures every 10 ticks, traffic every 50 ticks
 * 3. No full arrays - just counts for structures/creeps (evaluators only use counts)
 * 4. Shared structure cache - pass allStructures to helpers instead of re-finding
 * 5. Removed unused room.find(FIND_MY_STRUCTURES) call
 */

import {
  WorldState,
  ColonySnapshot,
  ColonyMilestones,
  ThreatLevel,
  CreepSnapshot,
  StructureSnapshot,
  SiteSnapshot,
  RemoteSnapshot,
  RoomIntelSnapshot,
  EmpireSnapshot,
  TrafficHotspot,
} from "./types";
import { WeightTableManager } from "./WeightTable";
import { EconomyTracker } from "../core/EconomyTracker";
import { logger } from "../utils/Logger";
import { getCreepTargets } from "../core/ColonyTargets";

// ============================================================================
// GLOBAL STATE & CACHES
// ============================================================================

declare const global: {
  worldState?: WorldState;
  worldStateLastTick?: number;
  // Tiered cache for slow-changing data
  _structureCache?: Map<string, CachedStructureData>;
  _structureCacheTick?: number;
  _trafficCache?: Map<string, TrafficHotspot[]>;
  _trafficCacheTick?: number;
  // Economy cache
  _economyCache?: Map<string, CachedEconomyData>;
  _economyCacheTick?: number;
};

interface CachedStructureData {
  allStructures: Structure[];
  structureCounts: Record<string, number>;
  siteCounts: Record<string, number>;
  siteCount: number;
  links: StructureLink[];
  containers: StructureContainer[];
  spawns: StructureSpawn[];
  sources: Source[];
}

interface CachedEconomyData {
  stored: number;
  harvestIncome: number;
  remoteIncome: number;
  totalBurn: number;
  netFlow: number;
}

// ============================================================================
// CREEP INDEX - Single iteration of Game.creeps per tick
// ============================================================================

interface CreepIndex {
  byRoom: Map<string, Creep[]>;
  byRoomAndRole: Map<string, Map<string, Creep[]>>;
  byRoomAndTargetRoom: Map<string, Map<string, Creep[]>>;
  all: Creep[];
}

let _creepIndex: CreepIndex | null = null;
let _creepIndexTick = -1;

function getCreepIndex(): CreepIndex {
  if (_creepIndex && _creepIndexTick === Game.time) {
    return _creepIndex;
  }

  // Single iteration of all creeps
  const all = Object.values(Game.creeps);
  const byRoom = new Map<string, Creep[]>();
  const byRoomAndRole = new Map<string, Map<string, Creep[]>>();
  const byRoomAndTargetRoom = new Map<string, Map<string, Creep[]>>();

  for (const creep of all) {
    const homeRoom = creep.memory.room;
    const role = creep.memory.role;
    const targetRoom = creep.memory.targetRoom;

    // Index by home room
    if (homeRoom) {
      if (!byRoom.has(homeRoom)) {
        byRoom.set(homeRoom, []);
      }
      byRoom.get(homeRoom)!.push(creep);

      // Index by home room + role
      if (!byRoomAndRole.has(homeRoom)) {
        byRoomAndRole.set(homeRoom, new Map());
      }
      const roleMap = byRoomAndRole.get(homeRoom)!;
      if (!roleMap.has(role)) {
        roleMap.set(role, []);
      }
      roleMap.get(role)!.push(creep);

      // Index by home room + target room (for remote roles)
      if (targetRoom) {
        if (!byRoomAndTargetRoom.has(homeRoom)) {
          byRoomAndTargetRoom.set(homeRoom, new Map());
        }
        const targetMap = byRoomAndTargetRoom.get(homeRoom)!;
        if (!targetMap.has(targetRoom)) {
          targetMap.set(targetRoom, []);
        }
        targetMap.get(targetRoom)!.push(creep);
      }
    }
  }

  _creepIndex = { byRoom, byRoomAndRole, byRoomAndTargetRoom, all };
  _creepIndexTick = Game.time;
  return _creepIndex;
}

/**
 * Get creeps for a room (uses cached index)
 */
export function getCreepsForRoom(roomName: string): Creep[] {
  return getCreepIndex().byRoom.get(roomName) || [];
}

/**
 * Get creeps for a room with a specific role (uses cached index)
 */
export function getCreepsForRoomAndRole(roomName: string, role: string): Creep[] {
  const roleMap = getCreepIndex().byRoomAndRole.get(roomName);
  return roleMap?.get(role) || [];
}

/**
 * Get creeps for a room targeting a specific remote (uses cached index)
 */
export function getCreepsForRoomAndTarget(roomName: string, targetRoom: string): Creep[] {
  const targetMap = getCreepIndex().byRoomAndTargetRoom.get(roomName);
  return targetMap?.get(targetRoom) || [];
}

// ============================================================================
// TIERED STRUCTURE CACHE
// ============================================================================

const STRUCTURE_CACHE_TTL = 10; // Refresh every 10 ticks
const TRAFFIC_CACHE_TTL = 50; // Refresh every 50 ticks
const ECONOMY_CACHE_TTL = 5; // Refresh every 5 ticks

function getCachedStructures(room: Room): CachedStructureData {
  // Check if cache is fresh
  if (
    global._structureCache &&
    global._structureCacheTick &&
    Game.time - global._structureCacheTick < STRUCTURE_CACHE_TTL
  ) {
    const cached = global._structureCache.get(room.name);
    if (cached) return cached;
  }

  // Initialize cache if needed
  if (!global._structureCache || global._structureCacheTick !== Game.time) {
    if (Game.time % STRUCTURE_CACHE_TTL === 0) {
      global._structureCache = new Map();
    } else if (!global._structureCache) {
      global._structureCache = new Map();
    }
    global._structureCacheTick = Game.time;
  }

  // Capture structure data
  const allStructures = room.find(FIND_STRUCTURES);
  const structureCounts: Record<string, number> = {};

  const links: StructureLink[] = [];
  const containers: StructureContainer[] = [];
  const spawns: StructureSpawn[] = [];

  for (const s of allStructures) {
    structureCounts[s.structureType] = (structureCounts[s.structureType] || 0) + 1;

    if (s.structureType === STRUCTURE_LINK) {
      links.push(s as StructureLink);
    } else if (s.structureType === STRUCTURE_CONTAINER) {
      containers.push(s as StructureContainer);
    } else if (s.structureType === STRUCTURE_SPAWN) {
      spawns.push(s as StructureSpawn);
    }
  }

  // Construction sites
  const sites = room.find(FIND_CONSTRUCTION_SITES);
  const siteCounts: Record<string, number> = {};
  for (const site of sites) {
    siteCounts[site.structureType] = (siteCounts[site.structureType] || 0) + 1;
  }

  // Sources (static, can cache longer)
  const sources = room.find(FIND_SOURCES);

  const data: CachedStructureData = {
    allStructures,
    structureCounts,
    siteCounts,
    siteCount: sites.length,
    links,
    containers,
    spawns,
    sources,
  };

  global._structureCache.set(room.name, data);
  return data;
}

function getCachedEconomy(room: Room): CachedEconomyData {
  // Check if cache is fresh
  if (
    global._economyCache &&
    global._economyCacheTick &&
    Game.time - global._economyCacheTick < ECONOMY_CACHE_TTL
  ) {
    const cached = global._economyCache.get(room.name);
    if (cached) return cached;
  }

  // Initialize cache
  if (!global._economyCache) {
    global._economyCache = new Map();
  }
  global._economyCacheTick = Game.time;

  // Calculate economy
  const economyTracker = new EconomyTracker(room);
  const metrics = economyTracker.getMetrics();

  const data: CachedEconomyData = {
    stored: metrics.stored,
    harvestIncome: metrics.harvestIncome + metrics.remoteIncome,
    remoteIncome: metrics.remoteIncome,
    totalBurn: metrics.totalBurn,
    netFlow: metrics.netFlow,
  };

  global._economyCache.set(room.name, data);
  return data;
}

// ============================================================================
// MAIN CAPTURE FUNCTION
// ============================================================================

/**
 * Capture the world state for the current tick.
 * Call this once at the start of the main loop.
 */
export function captureWorldState(): WorldState {
  // Return cached if already captured this tick
  if (global.worldState && global.worldStateLastTick === Game.time) {
    return global.worldState;
  }

  const startCpu = Game.cpu.getUsed();

  // Pre-build creep index (single iteration of Game.creeps)
  getCreepIndex();

  const colonies = new Map<string, ColonySnapshot>();
  const intel = new Map<string, RoomIntelSnapshot>();

  // Capture all owned rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      colonies.set(roomName, captureColony(room));
    }
  }

  // Capture intel for all scouted rooms (cheap - memory reads only)
  if (Memory.intel) {
    for (const roomName in Memory.intel) {
      intel.set(roomName, captureIntel(roomName, Memory.intel[roomName]));
    }
  }

  const state: WorldState = {
    tick: Game.time,
    colonies,
    intel,
    empire: captureEmpire(colonies),
    weights: WeightTableManager.getWeights(),
  };

  // Cache it
  global.worldState = state;
  global.worldStateLastTick = Game.time;

  const cpuUsed = Game.cpu.getUsed() - startCpu;
  if (cpuUsed > 8) {
    logger.warn("WorldState", `Capture took ${cpuUsed.toFixed(2)} CPU`);
  }

  return state;
}

/**
 * Get the current world state (must call captureWorldState first)
 */
export function getWorldState(): WorldState {
  if (!global.worldState || global.worldStateLastTick !== Game.time) {
    return captureWorldState();
  }
  return global.worldState;
}

/**
 * Get colony snapshot by name
 */
export function getColonySnapshot(roomName: string): ColonySnapshot | null {
  const state = getWorldState();
  return state.colonies.get(roomName) || null;
}

/**
 * Get cached structure data for a room (exported for AWSExporter)
 */
export function getStructureCache(room: Room): CachedStructureData {
  return getCachedStructures(room);
}

// Re-export the interface for consumers
export type { CachedStructureData };

// ============================================================================
// COLONY CAPTURE (Optimized)
// ============================================================================

function captureColony(room: Room): ColonySnapshot {
  const controller = room.controller!;
  const rcl = controller.level;

  // Use cached structure data (refreshes every 10 ticks)
  const structureData = getCachedStructures(room);
  const { structureCounts, siteCounts, links, containers, sources } = structureData;

  // Get creeps from index (no Object.values iteration)
  const roomCreeps = getCreepsForRoom(room.name);
  const counts: Record<string, number> = {};
  const dyingSoon: Record<string, number> = {};

  // Build creep counts and snapshots
  const creeps: CreepSnapshot[] = [];
  for (const creep of roomCreeps) {
    const role = creep.memory.role;
    counts[role] = (counts[role] || 0) + 1;

    if (creep.ticksToLive && creep.ticksToLive < 100) {
      dyingSoon[role] = (dyingSoon[role] || 0) + 1;
    }

    // Only build full snapshot if needed (for telemetry - most consumers just use counts)
    const bodyParts: Record<string, number> = {};
    for (const part of creep.body) {
      bodyParts[part.type] = (bodyParts[part.type] || 0) + 1;
    }

    creeps.push({
      id: creep.id,
      name: creep.name,
      role,
      roomName: creep.room?.name || room.name,
      ticksToLive: creep.ticksToLive || 1500,
      bodyParts,
      carrying: creep.store.getUsedCapacity(RESOURCE_ENERGY),
      carryCapacity: creep.store.getCapacity(RESOURCE_ENERGY),
      fatigue: creep.fatigue,
      spawning: creep.spawning,
      pos: { x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName },
    });
  }

  // Get hostiles (must be fresh every tick for combat)
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  let hostileDPS = 0;
  for (const h of hostiles) {
    hostileDPS +=
      h.getActiveBodyparts(ATTACK) * 30 + h.getActiveBodyparts(RANGED_ATTACK) * 10;
  }

  // Check spawn under attack using cached spawns
  const spawns = structureData.spawns.filter((s) => s.my);
  const spawnUnderAttack = spawns.some((spawn) =>
    hostiles.some((h) => h.pos.inRangeTo(spawn.pos, 3))
  );

  // Threat level
  let threatLevel = ThreatLevel.NONE;
  if (hostiles.length > 0) {
    if (spawnUnderAttack) {
      threatLevel = ThreatLevel.CRITICAL;
    } else if (hostileDPS > 200) {
      threatLevel = ThreatLevel.HIGH;
    } else if (hostileDPS > 50 || hostiles.length > 3) {
      threatLevel = ThreatLevel.MEDIUM;
    } else {
      threatLevel = ThreatLevel.LOW;
    }
  }

  // Economy metrics (cached, refreshes every 5 ticks)
  const economy = getCachedEconomy(room);

  // Milestones - pass cached structures to avoid re-finding
  const milestones = computeMilestones(room, structureData, counts);

  // Source container count
  const sourceContainerCount = sources.filter((source) =>
    containers.some((c) => c.pos.inRangeTo(source.pos, 2))
  ).length;

  // Remote mining (uses creep index)
  const remotes = captureRemotes(room.name);

  // Traffic hotspots (cached, refreshes every 50 ticks)
  const trafficHotspots = getCachedTrafficHotspots(room.name, structureData);

  // Structure limits for current RCL
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl] || 0;
  const maxTowers = CONTROLLER_STRUCTURES[STRUCTURE_TOWER][rcl] || 0;
  const maxLinks = CONTROLLER_STRUCTURES[STRUCTURE_LINK][rcl] || 0;

  // Build minimal structure snapshots only for evaluators that need positions
  // Most evaluators just use counts, so we keep this lean
  const structures: StructureSnapshot[] = [];

  return {
    roomName: room.name,
    rcl,
    rclProgress: controller.progress,
    rclProgressTotal: controller.progressTotal,

    // Economy
    energyAvailable: room.energyAvailable,
    energyCapacity: room.energyCapacityAvailable,
    energyStored: economy.stored,
    harvestIncome: economy.harvestIncome,
    maxHarvestIncome: sources.length * 10 + remotes.reduce((sum, r) => sum + r.sources * 10, 0),
    totalBurn: economy.totalBurn,
    netFlow: economy.netFlow,

    // Population
    creeps,
    counts,
    dyingSoon,
    // Targets come from the shared module so both spawners answer "how many of this role
    // do we want" the same way. Site count is summed from the cached siteCounts rather
    // than re-running find(), which is why this is cheap enough to do every tick.
    targets: getCreepTargets(
      room,
      Object.keys(siteCounts).reduce((n, k) => n + siteCounts[k], 0)
    ),

    // Infrastructure (minimal - evaluators use counts)
    structures,
    structureCounts,
    constructionSites: [], // Evaluators use siteCounts, not full array
    siteCounts,
    milestones,

    // Threats (fresh every tick)
    hostileCount: hostiles.length,
    hostileDPS,
    threatLevel,
    spawnUnderAttack,

    // Remote mining
    remotes,
    activeRemoteCount: remotes.filter((r) => r.active).length,

    // Derived
    sourceCount: sources.length,
    containerCount: structureCounts[STRUCTURE_CONTAINER] || 0,
    sourceContainerCount,
    extensionCount: structureCounts[STRUCTURE_EXTENSION] || 0,
    maxExtensions,
    towerCount: structureCounts[STRUCTURE_TOWER] || 0,
    maxTowers,
    linkCount: structureCounts[STRUCTURE_LINK] || 0,
    maxLinks,
    hasStorage: !!room.storage,
    hasTerminal: !!room.terminal,

    // Traffic
    trafficHotspots,
  };
}

// ============================================================================
// MILESTONES (Optimized - uses cached structures)
// ============================================================================

function computeMilestones(
  room: Room,
  structureData: CachedStructureData,
  creepCounts: Record<string, number>
): ColonyMilestones {
  const rcl = room.controller?.level || 0;
  const { structureCounts, links, containers, sources, spawns } = structureData;

  // Source containers
  const sourceContainerCount = sources.filter((source) =>
    containers.some((c) => c.pos.inRangeTo(source.pos, 1))
  ).length;

  // Controller containers
  const controller = room.controller;
  const controllerContainerCount = controller
    ? containers.filter((c) => c.pos.inRangeTo(controller.pos, 3)).length
    : 0;

  // Extensions
  const extensionCount = structureCounts[STRUCTURE_EXTENSION] || 0;
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl] || 0;

  // Link positions (using cached links)
  const myLinks = links.filter((l) => l.my);
  const hasControllerLink = controller
    ? myLinks.some((l) => l.pos.inRangeTo(controller.pos, 4))
    : false;
  const storage = room.storage;
  const hasStorageLink = storage ? myLinks.some((l) => l.pos.inRangeTo(storage.pos, 2)) : false;

  return {
    hasSourceContainers: sourceContainerCount > 0,
    hasControllerContainer: controllerContainerCount > 0,
    hasControllerLink,
    hasStorageLink,
    hasFullExtensions: maxExtensions > 0 ? extensionCount >= maxExtensions : true,
    hasAllTowers:
      (structureCounts[STRUCTURE_TOWER] || 0) >=
      (CONTROLLER_STRUCTURES[STRUCTURE_TOWER][rcl] || 0),
    hasLabs: (structureCounts[STRUCTURE_LAB] || 0) > 0,
    hasFactory: (structureCounts[STRUCTURE_FACTORY] || 0) > 0,
  };
}

// ============================================================================
// REMOTE MINING CAPTURE (Optimized - uses creep index)
// ============================================================================

function captureRemotes(colonyName: string): RemoteSnapshot[] {
  const remotes: RemoteSnapshot[] = [];

  const colonyMemory = Memory.colonies?.[colonyName];
  if (!colonyMemory?.remotes) {
    return remotes;
  }

  // Get creeps targeting each remote from index (no iteration)
  const targetMap = getCreepIndex().byRoomAndTargetRoom.get(colonyName);

  for (const roomName in colonyMemory.remotes) {
    const config = colonyMemory.remotes[roomName];

    // Get creeps for this remote from pre-built index
    const remoteCreeps = targetMap?.get(roomName) || [];

    // Count by role (single pass over small array)
    let minerCount = 0;
    let haulerCount = 0;
    let reserverCount = 0;

    for (const creep of remoteCreeps) {
      switch (creep.memory.role) {
        case "REMOTE_MINER":
          minerCount++;
          break;
        case "REMOTE_HAULER":
          haulerCount++;
          break;
        case "RESERVER":
          reserverCount++;
          break;
      }
    }

    // Check for hostiles in intel (memory read - cheap).
    //
    // Only creeps that can actually hurt a miner count. Treating any hostile as a threat
    // shut down remote mining across the whole empire: a single enemy scout passing
    // through pauses a remote for 5,000 ticks, and in a neighbourhood with 33 hostile
    // rooms something is always passing through. All nine remotes sat paused with the
    // reason "Hostile detected" while the two RCL 7 rooms had no external income at all.
    //
    // When intel carries body detail, require a combat part. Without detail we cannot
    // tell, so fall back to the conservative reading and treat presence as threat.
    const intel = Memory.intel?.[roomName];
    let hostilePresent = false;
    if (intel && intel.hostiles > 0) {
      const details = intel.hostileDetails;
      hostilePresent =
        details && details.length > 0 ? details.some((h) => h.hasCombat) : true;
    }

    // Check for containers in the remote room (if we have vision)
    let hasContainers = false;
    const remoteRoom = Game.rooms[roomName];
    if (remoteRoom) {
      // Use cached structure data if available
      const remoteStructures = getCachedStructures(remoteRoom);
      hasContainers = remoteStructures.containers.length >= (config.sources ?? 2);
    }

    const sources = config.sources ?? 2;
    remotes.push({
      roomName,
      distance: config.distance ?? 1,
      via: config.via,
      sources,
      active: config.active,
      paused: !!config.pausedUntil && Game.time < config.pausedUntil,
      pauseReason: config.pauseReason,
      minerCount,
      haulerCount,
      hasContainers,
      hasReserver: reserverCount > 0,
      hostilePresent,
      estimatedIncome: config.active ? sources * 10 * 0.8 : 0,
    });
  }

  return remotes;
}

// ============================================================================
// INTEL CAPTURE (Already optimized - memory reads only)
// ============================================================================

function captureIntel(roomName: string, intel: RoomIntel): RoomIntelSnapshot {
  return {
    roomName,
    lastScanned: intel.lastScanned,
    roomType: intel.roomType,
    owner: intel.owner,
    ownerRcl: intel.ownerRcl,
    sources: intel.sources?.length || 0,
    hostile: intel.hostiles > 0 || !!intel.owner,
    hostileCount: intel.hostiles,
    invaderCore: intel.invaderCore,
    distanceFromHome: intel.distanceFromHome,
  };
}

// ============================================================================
// EMPIRE CAPTURE
// ============================================================================

function captureEmpire(colonies: Map<string, ColonySnapshot>): EmpireSnapshot {
  const ownedRooms: string[] = [];
  let totalCreeps = 0;
  let totalEnergy = 0;

  for (const [roomName, colony] of colonies) {
    ownedRooms.push(roomName);
    totalCreeps += colony.creeps.length;
    totalEnergy += colony.energyStored;
  }

  // Get expansion target
  let expansionTarget: string | null = null;
  const empireMemory = Memory.empire as { expansion?: { targetRoom?: string } } | undefined;
  if (empireMemory?.expansion?.targetRoom) {
    expansionTarget = empireMemory.expansion.targetRoom;
  }

  return {
    ownedRooms,
    totalCreeps,
    totalEnergy,
    gcl: Game.gcl.level,
    gclProgress: Game.gcl.progress / Game.gcl.progressTotal,
    cpuUsed: Game.cpu.getUsed(),
    cpuLimit: Game.cpu.limit,
    bucket: Game.cpu.bucket,
    expansionTarget,
  };
}

// ============================================================================
// TRAFFIC CAPTURE (Cached - refreshes every 50 ticks)
// ============================================================================

function getCachedTrafficHotspots(
  roomName: string,
  structureData: CachedStructureData
): TrafficHotspot[] {
  // Check if cache is fresh
  if (
    global._trafficCache &&
    global._trafficCacheTick &&
    Game.time - global._trafficCacheTick < TRAFFIC_CACHE_TTL
  ) {
    const cached = global._trafficCache.get(roomName);
    if (cached) return cached;
  }

  // Initialize cache
  if (!global._trafficCache || Game.time % TRAFFIC_CACHE_TTL === 0) {
    global._trafficCache = new Map();
    global._trafficCacheTick = Game.time;
  }

  const hotspots = captureTrafficHotspots(roomName, structureData);
  global._trafficCache.set(roomName, hotspots);
  return hotspots;
}

function captureTrafficHotspots(
  roomName: string,
  structureData: CachedStructureData
): TrafficHotspot[] {
  const hotspots: TrafficHotspot[] = [];

  const trafficMemory = Memory.traffic?.[roomName];
  if (!trafficMemory?.heatmap) {
    return hotspots;
  }

  // Get road positions from cached structures
  const roads = new Set<string>();
  for (const s of structureData.allStructures) {
    if (s.structureType === STRUCTURE_ROAD) {
      roads.add(`${s.pos.x}:${s.pos.y}`);
    }
  }

  // Convert heatmap to hotspots (top 20 by visits)
  const entries = Object.entries(trafficMemory.heatmap)
    .map(([pos, visits]) => ({ pos, visits }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 20);

  for (const entry of entries) {
    const [x, y] = entry.pos.split(":").map(Number);
    hotspots.push({
      pos: { x, y },
      visits: entry.visits,
      hasRoad: roads.has(entry.pos),
    });
  }

  return hotspots;
}

// ============================================================================
// CONSOLE COMMANDS
// ============================================================================

/**
 * Console command: Show world state summary
 */
export function showWorldState(roomName?: string): string {
  const state = getWorldState();

  if (roomName) {
    const colony = state.colonies.get(roomName);
    if (!colony) {
      return `No colony found: ${roomName}`;
    }

    return JSON.stringify(
      {
        roomName: colony.roomName,
        rcl: colony.rcl,
        progress: `${colony.rclProgress}/${colony.rclProgressTotal}`,
        energy: {
          available: colony.energyAvailable,
          capacity: colony.energyCapacity,
          stored: colony.energyStored,
        },
        economy: {
          harvestIncome: colony.harvestIncome.toFixed(2),
          totalBurn: colony.totalBurn.toFixed(2),
          netFlow: colony.netFlow.toFixed(2),
        },
        population: {
          total: colony.creeps.length,
          counts: colony.counts,
          dyingSoon: colony.dyingSoon,
        },
        milestones: colony.milestones,
        threats: {
          hostileCount: colony.hostileCount,
          hostileDPS: colony.hostileDPS,
          threatLevel: ThreatLevel[colony.threatLevel],
        },
        remotes: colony.remotes.map((r) => ({
          room: r.roomName,
          active: r.active,
          miners: r.minerCount,
          haulers: r.haulerCount,
        })),
      },
      null,
      2
    );
  }

  // Summary of all colonies
  const summary: Record<string, unknown> = {
    tick: state.tick,
    colonies: [],
    empire: {
      gcl: state.empire.gcl,
      totalCreeps: state.empire.totalCreeps,
      totalEnergy: state.empire.totalEnergy,
      bucket: state.empire.bucket,
    },
  };

  for (const [name, colony] of state.colonies) {
    (summary.colonies as unknown[]).push({
      name,
      rcl: colony.rcl,
      creeps: colony.creeps.length,
      energy: colony.energyStored,
      netFlow: colony.netFlow.toFixed(2),
      threat: ThreatLevel[colony.threatLevel],
    });
  }

  return JSON.stringify(summary, null, 2);
}
