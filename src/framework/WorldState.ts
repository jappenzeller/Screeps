/**
 * WorldState - Immutable snapshot of the game world
 *
 * Captured once per tick, all evaluators read from this snapshot.
 * No evaluator calls room.find() directly - all queries go through WorldState.
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
import { EconomyTracker, ColonyEconomyMetrics } from "../core/EconomyTracker";
import { getMilestones, Milestones } from "../core/ColonyMilestones";
import { logger } from "../utils/Logger";

// ============================================================================
// GLOBAL STATE
// ============================================================================

declare const global: {
  worldState?: WorldState;
  worldStateLastTick?: number;
};

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

  const colonies = new Map<string, ColonySnapshot>();
  const intel = new Map<string, RoomIntelSnapshot>();

  // Capture all owned rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      colonies.set(roomName, captureColony(room));
    }
  }

  // Capture intel for all scouted rooms
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
  if (cpuUsed > 5) {
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

// ============================================================================
// COLONY CAPTURE
// ============================================================================

function captureColony(room: Room): ColonySnapshot {
  const controller = room.controller!;
  const rcl = controller.level;

  // Get structures
  const allStructures = room.find(FIND_STRUCTURES);
  const myStructures = room.find(FIND_MY_STRUCTURES);

  // Count structures by type
  const structureCounts: Record<string, number> = {};
  const structures: StructureSnapshot[] = [];

  for (const s of allStructures) {
    structureCounts[s.structureType] = (structureCounts[s.structureType] || 0) + 1;

    structures.push({
      id: s.id,
      type: s.structureType,
      pos: { x: s.pos.x, y: s.pos.y },
      hits: s.hits,
      hitsMax: s.hitsMax,
      energy: (s as AnyStoreStructure).store?.[RESOURCE_ENERGY],
      energyCapacity: (s as AnyStoreStructure).store?.getCapacity?.(RESOURCE_ENERGY),
    });
  }

  // Get construction sites
  const sites = room.find(FIND_CONSTRUCTION_SITES);
  const siteCounts: Record<string, number> = {};
  const constructionSites: SiteSnapshot[] = [];

  for (const site of sites) {
    siteCounts[site.structureType] = (siteCounts[site.structureType] || 0) + 1;
    constructionSites.push({
      id: site.id,
      type: site.structureType,
      pos: { x: site.pos.x, y: site.pos.y },
      progress: site.progress,
      progressTotal: site.progressTotal,
    });
  }

  // Get creeps
  const allCreeps = Object.values(Game.creeps).filter((c) => c.memory.room === room.name);
  const counts: Record<string, number> = {};
  const dyingSoon: Record<string, number> = {};
  const creeps: CreepSnapshot[] = [];

  for (const creep of allCreeps) {
    const role = creep.memory.role;
    counts[role] = (counts[role] || 0) + 1;

    if (creep.ticksToLive && creep.ticksToLive < 100) {
      dyingSoon[role] = (dyingSoon[role] || 0) + 1;
    }

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

  // Get hostiles
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  let hostileDPS = 0;
  for (const h of hostiles) {
    hostileDPS +=
      h.getActiveBodyparts(ATTACK) * 30 +
      h.getActiveBodyparts(RANGED_ATTACK) * 10;
  }

  // Threat level
  const spawns = room.find(FIND_MY_SPAWNS);
  const spawnUnderAttack = spawns.some((spawn) =>
    hostiles.some((h) => h.pos.inRangeTo(spawn.pos, 3))
  );

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

  // Economy metrics
  const economyTracker = new EconomyTracker(room);
  const economy = economyTracker.getMetrics();

  // Milestones
  const rawMilestones = getMilestones(room);
  const milestones = convertMilestones(room, rawMilestones, structureCounts);

  // Sources
  const sources = room.find(FIND_SOURCES);

  // Containers near sources
  const containers = allStructures.filter(
    (s) => s.structureType === STRUCTURE_CONTAINER
  ) as StructureContainer[];
  const sourceContainerCount = sources.filter((source) =>
    containers.some((c) => c.pos.inRangeTo(source.pos, 2))
  ).length;

  // Remote mining
  const remotes = captureRemotes(room.name);

  // Traffic hotspots
  const trafficHotspots = captureTrafficHotspots(room.name);

  // Structure limits for current RCL
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl] || 0;
  const maxTowers = CONTROLLER_STRUCTURES[STRUCTURE_TOWER][rcl] || 0;
  const maxLinks = CONTROLLER_STRUCTURES[STRUCTURE_LINK][rcl] || 0;

  return {
    roomName: room.name,
    rcl,
    rclProgress: controller.progress,
    rclProgressTotal: controller.progressTotal,

    // Economy
    energyAvailable: room.energyAvailable,
    energyCapacity: room.energyCapacityAvailable,
    energyStored: economy.stored,
    harvestIncome: economy.harvestIncome + economy.remoteIncome,
    maxHarvestIncome: sources.length * 10 + remotes.reduce((sum, r) => sum + r.sources * 10, 0),
    totalBurn: economy.totalBurn,
    netFlow: economy.netFlow,

    // Population
    creeps,
    counts,
    dyingSoon,

    // Infrastructure
    structures,
    structureCounts,
    constructionSites,
    siteCounts,
    milestones,

    // Threats
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

function convertMilestones(
  room: Room,
  raw: Milestones,
  structureCounts: Record<string, number>
): ColonyMilestones {
  const rcl = room.controller?.level || 0;
  const linkCount = structureCounts[STRUCTURE_LINK] || 0;

  // Check for controller link
  const controller = room.controller;
  const links = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_LINK,
  }) as StructureLink[];
  const hasControllerLink = controller
    ? links.some((l) => l.pos.inRangeTo(controller.pos, 4))
    : false;

  // Check for storage link
  const storage = room.storage;
  const hasStorageLink = storage ? links.some((l) => l.pos.inRangeTo(storage.pos, 2)) : false;

  return {
    hasSourceContainers: raw.allSourceContainers,
    hasControllerContainer: raw.hasControllerContainer,
    hasControllerLink,
    hasStorageLink,
    hasFullExtensions: raw.allExtensions,
    hasAllTowers:
      (structureCounts[STRUCTURE_TOWER] || 0) >=
      (CONTROLLER_STRUCTURES[STRUCTURE_TOWER][rcl] || 0),
    hasLabs: (structureCounts[STRUCTURE_LAB] || 0) > 0,
    hasFactory: (structureCounts[STRUCTURE_FACTORY] || 0) > 0,
  };
}

// ============================================================================
// REMOTE MINING CAPTURE
// ============================================================================

function captureRemotes(colonyName: string): RemoteSnapshot[] {
  const remotes: RemoteSnapshot[] = [];

  const colonyMemory = Memory.colonies?.[colonyName];
  if (!colonyMemory?.remotes) {
    return remotes;
  }

  for (const roomName in colonyMemory.remotes) {
    const config = colonyMemory.remotes[roomName];

    // Count assigned creeps
    const minerCount = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_MINER" &&
        c.memory.room === colonyName &&
        c.memory.targetRoom === roomName
    ).length;

    const haulerCount = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_HAULER" &&
        c.memory.room === colonyName &&
        c.memory.targetRoom === roomName
    ).length;

    const reserverCount = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "RESERVER" &&
        c.memory.room === colonyName &&
        c.memory.targetRoom === roomName
    ).length;

    // Check for hostiles in intel
    const intel = Memory.intel?.[roomName];
    const hostilePresent = intel ? intel.hostiles > 0 : false;

    // Check for containers in the remote room (if we have vision)
    let hasContainers = false;
    const remoteRoom = Game.rooms[roomName];
    if (remoteRoom) {
      const containers = remoteRoom.find(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });
      hasContainers = containers.length >= config.sources;
    }

    remotes.push({
      roomName,
      distance: config.distance,
      via: config.via,
      sources: config.sources,
      active: config.active,
      paused: !!config.pausedUntil && Game.time < config.pausedUntil,
      pauseReason: config.pauseReason,
      minerCount,
      haulerCount,
      hasContainers,
      hasReserver: reserverCount > 0,
      hostilePresent,
      estimatedIncome: config.active ? config.sources * 10 * 0.8 : 0, // 80% efficiency estimate
    });
  }

  return remotes;
}

// ============================================================================
// INTEL CAPTURE
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
// TRAFFIC CAPTURE
// ============================================================================

function captureTrafficHotspots(roomName: string): TrafficHotspot[] {
  const hotspots: TrafficHotspot[] = [];

  const trafficMemory = Memory.traffic?.[roomName];
  if (!trafficMemory?.heatmap) {
    return hotspots;
  }

  const room = Game.rooms[roomName];
  if (!room) return hotspots;

  // Get road positions
  const roads = new Set<string>();
  const roadStructures = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_ROAD,
  });
  for (const road of roadStructures) {
    roads.add(`${road.pos.x}:${road.pos.y}`);
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
