/**
 * Utility-Based Spawning System
 *
 * Replaces static priorities with dynamic utility scoring.
 * Each role's spawn utility is a continuous function of colony state.
 * The spawner always picks the highest utility role.
 *
 * Uses modular utility modules from ./utilities/ for calculations.
 */

import { getHostileCount } from "../utils/remoteIntel";
import { RemoteSquadManager } from "../defense/RemoteSquadManager";
import { LinkManager } from "../structures/LinkManager";
import { buildBody as buildBodyFromConfig, ROLE_MIN_COST } from "./bodyBuilder";
import { CONFIG } from "../config";
import { combineUtilities } from "../utils/smoothing";
import {
  getEnergyState,
  storageUtility,
  sustainabilityUtility,
  rateUtility,
} from "./utilities/energyUtility";
import { roleCountUtility, getEffectiveCount } from "./utilities/populationUtility";

// TTL thresholds for proactive replacement spawning
const DYING_SOON_LOCAL = CONFIG.SPAWNING.REPLACEMENT_TTL;
const DYING_SOON_REMOTE = CONFIG.SPAWNING.REMOTE_REPLACEMENT_TTL;

// All roles that can be spawned
type SpawnRole =
  | "HARVESTER"
  | "HAULER"
  | "UPGRADER"
  | "BUILDER"
  | "DEFENDER"
  | "REMOTE_MINER"
  | "REMOTE_HAULER"
  | "REMOTE_DEFENDER"
  | "RESERVER"
  | "SCOUT"
  | "LINK_FILLER"
  | "UPGRADE_HAULER"
  | "MINERAL_HARVESTER";

const ALL_ROLES: SpawnRole[] = [
  "HARVESTER",
  "HAULER",
  "UPGRADER",
  "BUILDER",
  "DEFENDER",
  "REMOTE_MINER",
  "REMOTE_HAULER",
  "REMOTE_DEFENDER",
  "RESERVER",
  "SCOUT",
  "LINK_FILLER",
  "UPGRADE_HAULER",
  "MINERAL_HARVESTER",
];

export interface SpawnCandidate {
  role: SpawnRole;
  utility: number;
  body: BodyPartConstant[];
  memory: Partial<CreepMemory>;
  cost: number;
}

interface ColonyState {
  room: Room;
  rcl: number;

  // Energy flow
  energyAvailable: number;
  energyCapacity: number;
  energyStored: number;
  energyIncome: number; // energy/tick from harvesters
  energyIncomeMax: number; // theoretical max (sources * 10)

  // Creep counts by role
  counts: Record<string, number>;

  // Creep targets by role (what we want)
  targets: Record<string, number>;

  // Threats
  homeThreats: number;
  remoteThreatsByRoom: Record<string, number>;

  // Work to do
  constructionSites: number;
  remoteRooms: string[];

  // Creeps near death (TTL < 100)
  dyingSoon: Record<string, number>;
}

/**
 * Get the best spawn candidate based on utility scoring
 *
 * Key behavior: If economy has income, we WAIT for the highest utility role
 * even if we can't afford it yet. This prevents spawning low-priority roles
 * (like remote hauler #6) when a high-priority role (like builder) is needed
 * but temporarily unaffordable.
 */
export function getSpawnCandidate(room: Room): SpawnCandidate | null {
  const candidates: SpawnCandidate[] = [];
  const state = getColonyState(room);

  for (const role of ALL_ROLES) {
    const utility = calculateUtility(role, state);
    if (utility <= 0) continue;

    const body = buildBody(role, state);
    if (body.length === 0) continue;

    const cost = body.reduce((sum, part) => sum + BODYPART_COST[part], 0);

    const memory = buildMemory(role, state);

    // Skip remote roles that couldn't get a target room assigned
    const requiresTargetRoom: SpawnRole[] = [
      "REMOTE_MINER",
      "REMOTE_HAULER",
      "REMOTE_DEFENDER",
      "RESERVER",
    ];
    if (requiresTargetRoom.includes(role) && !memory.targetRoom) {
      continue;
    }

    // DON'T filter by affordability here - collect all valid candidates
    candidates.push({ role, utility, body, memory, cost });
  }

  if (candidates.length === 0) return null;

  // Sort by utility descending
  candidates.sort((a, b) => b.utility - a.utility);

  const best = candidates[0];

  // Can we afford the highest utility role?
  if (best.cost <= room.energyAvailable) {
    return best;
  }

  // Can't afford best. Check if economy is functional.
  const hasIncome = state.energyIncome > 0;

  if (hasIncome) {
    // Economy is working. Wait for energy to accumulate.
    return null;
  }

  // Economy is dead (no harvesters producing). Bootstrap with whatever we can afford.
  const affordable = candidates.filter((c) => c.cost <= room.energyAvailable);
  return affordable.length > 0 ? affordable[0] : null;
}

/**
 * Gather all metrics needed for utility calculations
 */
function getColonyState(room: Room): ColonyState {
  const sources = room.find(FIND_SOURCES);
  const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === room.name);

  // Calculate actual energy income from active harvesters
  let energyIncome = 0;
  for (const c of creeps) {
    if (c.memory.role === "HARVESTER") {
      const workParts = c.getActiveBodyparts(WORK);
      energyIncome += workParts * 2;
    }
  }

  const energyIncomeMax = sources.length * 10; // 5 WORK per source max

  // Count creeps by role
  const counts: Record<string, number> = {};
  const dyingSoon: Record<string, number> = {};

  for (const c of creeps) {
    const role = c.memory.role;
    counts[role] = (counts[role] || 0) + 1;

    // Use higher threshold for remote roles (need travel time buffer)
    const isRemoteRole =
      role === "REMOTE_MINER" ||
      role === "REMOTE_HAULER" ||
      role === "RESERVER" ||
      role === "REMOTE_DEFENDER" ||
      role === "SCOUT";
    const dyingThreshold = isRemoteRole ? DYING_SOON_REMOTE : DYING_SOON_LOCAL;

    if (c.ticksToLive && c.ticksToLive < dyingThreshold) {
      dyingSoon[role] = (dyingSoon[role] || 0) + 1;
    }
  }

  // Get targets (desired counts)
  const targets = getCreepTargets(room);

  // Get remote threats
  const remoteThreatsByRoom = getRemoteThreats(room.name);

  // Get remote mining targets
  const remoteRooms = getRemoteMiningTargets(room.name);

  return {
    room,
    rcl: room.controller?.level || 0,
    energyAvailable: room.energyAvailable,
    energyCapacity: room.energyCapacityAvailable,
    energyStored: room.storage?.store.energy || 0,
    energyIncome,
    energyIncomeMax,
    counts,
    targets,
    homeThreats: room.find(FIND_HOSTILE_CREEPS).length,
    remoteThreatsByRoom,
    constructionSites: room.find(FIND_CONSTRUCTION_SITES).length,
    remoteRooms,
    dyingSoon,
  };
}

/**
 * Calculate desired creep counts for each role
 */
function getCreepTargets(room: Room): Record<string, number> {
  const rcl = room.controller?.level || 0;
  const sources = room.find(FIND_SOURCES).length;
  const hasStorage = !!room.storage;
  const remoteRooms = getRemoteMiningTargets(room.name);

  // Count construction sites in home AND remote rooms
  let totalSites = room.find(FIND_CONSTRUCTION_SITES).length;
  for (const remoteName of remoteRooms) {
    const remoteRoom = Game.rooms[remoteName];
    if (remoteRoom) {
      totalSites += remoteRoom.find(FIND_CONSTRUCTION_SITES).length;
    } else {
      // Can't see room, but assume some sites if we're mining there
      const intel = Memory.rooms?.[remoteName];
      if (intel?.lastScan && Game.time - intel.lastScan < 1000) {
        totalSites += 2; // Assume container + roads needed
      }
    }
  }

  // Scale builders: 1 per 5 sites, minimum 1 if any sites, max based on RCL
  const maxBuilders = Math.min(rcl, 4);
  const builderTarget = totalSites > 0 ? Math.min(Math.ceil(totalSites / 5), maxBuilders) : 0;

  const targets: Record<string, number> = {
    HARVESTER: sources,
    HAULER: hasStorage ? Math.max(2, sources) : sources,
    UPGRADER: rcl < 8 ? Math.min(rcl, 3) : 1,
    BUILDER: builderTarget,
    DEFENDER: 0, // Dynamic based on threats
    REMOTE_MINER: 0,
    REMOTE_HAULER: 0,
    REMOTE_DEFENDER: 0,
    RESERVER: 0,
    SCOUT: 0,
    LINK_FILLER: 0,
    UPGRADE_HAULER: 0,
    MINERAL_HARVESTER: 0,
  };

  // Link filler and upgrade hauler at RCL 5+ with storage and links
  if (rcl >= 5 && room.storage && room.storage.store[RESOURCE_ENERGY] > 10000) {
    const linkManager = new LinkManager(room);
    if (linkManager.getStorageLink()) {
      targets.LINK_FILLER = 1;
    }

    // Upgrade hauler: supplement link transfers when upgraders exceed link throughput
    const controllerLink = linkManager.getControllerLink();
    if (controllerLink) {
      const upgraderWorkParts = Object.values(Game.creeps)
        .filter((c) => c.memory.role === "UPGRADER" && c.memory.room === room.name)
        .reduce((sum, c) => sum + c.getActiveBodyparts(WORK), 0);
      // Link delivers ~35 energy/tick; each WORK part consumes 1/tick
      if (upgraderWorkParts > 35) {
        targets.UPGRADE_HAULER = 1;
      }
    }
  }

  // Mineral harvester at RCL 6+ with extractor
  if (rcl >= 6) {
    const mineral = room.find(FIND_MINERALS)[0];
    if (mineral && mineral.mineralAmount > 0) {
      const extractor = mineral.pos
        .lookFor(LOOK_STRUCTURES)
        .find((s) => s.structureType === STRUCTURE_EXTRACTOR);
      if (extractor) {
        targets.MINERAL_HARVESTER = 1;
      }
    }
  }

  // Remote operations at RCL 4+
  if (rcl >= 4) {
    // Count remote sources
    let remoteSources = 0;
    for (const roomName of remoteRooms) {
      const intel = Memory.rooms?.[roomName];
      remoteSources += intel?.sources?.length || 0;
    }

    targets.REMOTE_MINER = remoteSources;
    targets.REMOTE_HAULER = Math.ceil(remoteSources * 1.5); // 1.5 haulers per miner
    targets.RESERVER = remoteRooms.length;
    targets.SCOUT = needsScout(room.name) ? 1 : 0;
  }

  return targets;
}

/**
 * Calculate utility for a role based on colony state
 */
function calculateUtility(role: SpawnRole, state: ColonyState): number {
  const current = state.counts[role] || 0;
  const target = state.targets[role] || 0;
  const deficit = target - current;
  const dying = state.dyingSoon[role] || 0;

  // Effective deficit includes creeps about to die
  const effectiveDeficit = deficit + dying;

  switch (role) {
    case "HARVESTER":
      return harvesterUtility(effectiveDeficit, state);
    case "HAULER":
      return haulerUtility(effectiveDeficit, state);
    case "UPGRADER":
      return upgraderUtility(effectiveDeficit, state);
    case "BUILDER":
      return builderUtility(effectiveDeficit, state);
    case "DEFENDER":
      return defenderUtility(effectiveDeficit, state);
    case "REMOTE_MINER":
      return remoteMinerUtility(effectiveDeficit, state);
    case "REMOTE_HAULER":
      return remoteHaulerUtility(effectiveDeficit, state);
    case "REMOTE_DEFENDER":
      return remoteDefenderUtility(state);
    case "RESERVER":
      return reserverUtility(effectiveDeficit, state);
    case "SCOUT":
      return scoutUtility(effectiveDeficit, state);
    case "LINK_FILLER":
      return linkFillerUtility(effectiveDeficit, state);
    case "UPGRADE_HAULER":
      return upgradeHaulerUtility(effectiveDeficit, state);
    case "MINERAL_HARVESTER":
      return mineralHarvesterUtility(effectiveDeficit, state);
    default:
      return 0;
  }
}

// ============================================
// Utility Functions for Each Role
// ============================================

/**
 * Harvester utility - scales inversely with energy income
 * When income approaches 0, utility approaches infinity
 */
function harvesterUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  // Base utility from deficit
  let utility = deficit * 100;

  // Scale by income scarcity
  // As income approaches 0, multiplier approaches infinity
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  const scarcityMultiplier = 1 / Math.max(incomeRatio, 0.01);

  utility *= scarcityMultiplier;

  return utility;
}

/**
 * Hauler utility - useless without harvesters, high when income exists but no haulers
 */
function haulerUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  // Haulers are useless without harvesters
  if ((state.counts.HARVESTER || 0) === 0) return 0;

  // Base utility from deficit
  let utility = deficit * 90;

  // Scale by income - more income needs more hauling
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);

  // If we have income but no haulers, energy is piling up - high utility
  if ((state.counts.HAULER || 0) === 0 && state.energyIncome > 0) {
    utility *= 10;
  } else {
    utility *= 1 + incomeRatio;
  }

  return utility;
}

/**
 * Upgrader utility - uses modular utility system
 * Considers storage level, sustainability, energy rate, and population
 */
function upgraderUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  const base = CONFIG.SPAWNING.BASE_UTILITY.UPGRADER;
  const energy = getEnergyState(state.room);

  // Factor 1: Storage level (smooth scaling)
  const storageFactor = storageUtility(energy.stored, CONFIG.ENERGY.STORAGE_THRESHOLDS);

  // Factor 2: Can we sustain another upgrader?
  const avgWorkParts = 15; // Estimate for new upgrader
  const sustainFactor = sustainabilityUtility(
    energy.upgradeConsumption,
    avgWorkParts,
    energy.harvestIncome
  );

  // Factor 3: Energy trend (are we gaining or losing?)
  const rateFactor = rateUtility(energy.rate);

  // Factor 4: Diminishing returns on upgrader count
  const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === state.room.name);
  const currentCount = getEffectiveCount(creeps, "UPGRADER", DYING_SOON_LOCAL);
  const optimal = state.targets.UPGRADER || 2;
  const countFactor = roleCountUtility(currentCount, optimal);

  // Combine all factors using geometric mean
  const multiplier = combineUtilities(storageFactor, sustainFactor, rateFactor, countFactor);

  return base * multiplier * deficit;
}

/**
 * Builder utility - uses modular utility system
 * Accounts for remote room construction sites and storage levels
 */
function builderUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  // Count total sites including remote rooms
  let totalSites = state.constructionSites;
  let hasRemoteContainer = false;

  for (const remoteName of state.remoteRooms) {
    const room = Game.rooms[remoteName];
    if (room) {
      const remoteSites = room.find(FIND_CONSTRUCTION_SITES);
      totalSites += remoteSites.length;

      // Check for remote container sites (critical infrastructure)
      if (remoteSites.some((s) => s.structureType === STRUCTURE_CONTAINER)) {
        hasRemoteContainer = true;
      }
    }
  }

  if (totalSites === 0) return 0;

  const base = CONFIG.SPAWNING.BASE_UTILITY.BUILDER;
  const energy = getEnergyState(state.room);

  // Factor 1: Storage level (smooth scaling)
  const storageFactor = storageUtility(energy.stored, CONFIG.ENERGY.STORAGE_THRESHOLDS);

  // Factor 2: Can we sustain another builder?
  const avgWorkParts = 5; // Builders use ~2.5 energy/tick when active
  const sustainFactor = sustainabilityUtility(
    energy.builderConsumption,
    avgWorkParts * 0.5, // 50% uptime estimate
    energy.harvestIncome
  );

  // Factor 3: Population diminishing returns
  const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === state.room.name);
  const currentCount = getEffectiveCount(creeps, "BUILDER", DYING_SOON_LOCAL);
  const optimal = state.targets.BUILDER || 1;
  const countFactor = roleCountUtility(currentCount, optimal);

  // Factor 4: Site urgency (more sites = higher utility)
  const siteFactor = Math.min(totalSites / 5, 2);

  // Factor 5: Remote container boost (critical infrastructure)
  const containerBoost = hasRemoteContainer ? 1.5 : 1;

  // Combine factors
  const multiplier = combineUtilities(storageFactor, sustainFactor, countFactor) * siteFactor * containerBoost;

  return base * multiplier * deficit;
}

/**
 * Defender utility - 0 without threat, scales with threat level
 */
function defenderUtility(_deficit: number, state: ColonyState): number {
  // No threat = no utility, regardless of deficit
  if (state.homeThreats === 0) return 0;

  const current = state.counts.DEFENDER || 0;

  // Utility scales with threat count
  let utility = state.homeThreats * 50;

  // Reduce utility if we already have defenders
  utility *= 1 / (current + 1);

  return utility;
}

/**
 * Remote miner utility - only when home economy is stable
 */
function remoteMinerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;
  if (state.remoteRooms.length === 0) return 0;

  // Need minimum home economy before expanding
  if ((state.counts.HARVESTER || 0) < 2 || (state.counts.HAULER || 0) < 1) {
    return 0;
  }

  // Base utility
  let utility = deficit * 40;

  // Scale by home economy health
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

/**
 * Remote hauler utility - useless without remote miners
 */
function remoteHaulerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;

  // Useless without remote miners
  if ((state.counts.REMOTE_MINER || 0) === 0) return 0;

  // Base utility
  let utility = deficit * 35;

  // Scale by home economy
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

/**
 * Remote defender utility - based on squad needs from RemoteSquadManager
 * Uses squad-based spawning to coordinate attacks against healer-supported invaders
 *
 * CRITICAL: When threats exist, defenders MUST spawn before other remote roles.
 * Defense is not optional - losing miners/haulers to invaders is expensive.
 */
function remoteDefenderUtility(state: ColonyState): number {
  if (state.rcl < 4) return 0;

  // Use squad manager to determine defender needs
  const squadManager = new RemoteSquadManager(state.room);
  const needs = squadManager.getDefendersNeeded();

  // No squad needs = no utility
  if (needs.length === 0) return 0;

  // Find the most urgent need (most defenders needed)
  let totalNeeded = 0;
  for (const need of needs) {
    totalNeeded += need.count;
  }

  if (totalNeeded === 0) return 0;

  // CRITICAL: Defense utility must be VERY HIGH to override other roles
  // When threats exist, spawning defenders is more important than:
  // - Additional remote haulers (35 base)
  // - Remote miners (40 base)
  // - Reservers (25 base)
  // Only harvesters (100) and haulers (90) in emergency should beat this
  const DEFENSE_PRIORITY = 150;

  // Scale with number of defenders needed, but minimum is still very high
  const utility = DEFENSE_PRIORITY + (totalNeeded - 1) * 50;

  // DO NOT reduce based on economy - defense is critical regardless of income
  // Losing miners to invaders costs more than the defender spawn cost

  return utility;
}

/**
 * Reserver utility - lower priority than miners/haulers
 */
function reserverUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;
  if (state.remoteRooms.length === 0) return 0;

  // Need active remote mining before reserving
  if ((state.counts.REMOTE_MINER || 0) === 0) return 0;

  // Lower priority than miners/haulers
  let utility = deficit * 25;

  // Scale by economy
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

/**
 * Link filler utility - keeps storage link filled for controller upgrading
 * Infrastructure role: without it, upgraders at controller link starve.
 * Priority above upgraders (20 base) but below haulers (90 base).
 */
function linkFillerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 5) return 0;
  if (deficit <= 0) return 0;

  // High priority - infrastructure that enables upgraders
  let utility = deficit * 70;

  // Scale by economy health
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

/**
 * Upgrade hauler utility - supplements link transfers to controller link
 * Spawns after link filler, before additional upgraders
 */
function upgradeHaulerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 5) return 0;
  if (deficit <= 0) return 0;

  // Infrastructure that enables upgrader throughput - between link filler and upgrader
  let utility = deficit * 55;

  // Scale by economy health
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

/**
 * Scout utility - luxury role, very low priority
 */
function scoutUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 3) return 0;
  if (deficit <= 0) return 0;

  // Count rooms needing scan for priority
  const roomsNeedingScan = countRoomsNeedingScan(state.room.name);

  // High utility if many rooms need scanning (initial scouting push)
  if (roomsNeedingScan > 40) return 12; // Over half of 81 rooms
  if (roomsNeedingScan > 20) return 8;
  if (roomsNeedingScan > 10) return 5;
  if (roomsNeedingScan > 0) return 2;

  return 0; // All rooms scanned
}

/**
 * Mineral harvester utility - low priority luxury role
 * Only spawns when extractor exists and mineral has resources
 */
function mineralHarvesterUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 6) return 0;
  if (deficit <= 0) return 0;

  // Low priority - economy roles come first
  let utility = deficit * 15;

  // Scale by economy health - only spawn when economy is healthy
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  // Require storage with decent reserves before mining minerals
  if (state.energyStored < 50000) {
    return 0;
  }

  return utility;
}

// ============================================
// Body Building Functions
// ============================================

// ROLE_MIN_COST is now imported from bodyBuilder.ts

/**
 * Build appropriate body for a role given available energy
 */
function buildBody(role: SpawnRole, state: ColonyState): BodyPartConstant[] {
  // Emergency detection: no harvesters OR no haulers
  const noHarvesters = (state.counts.HARVESTER || 0) === 0;
  const noHaulers = (state.counts.HAULER || 0) === 0;
  const isEmergency = noHarvesters || noHaulers;

  // In emergency, build what we can afford NOW
  // Otherwise, build for full capacity (wait for energy)
  const energy = isEmergency ? state.energyAvailable : state.energyCapacity;

  // Can't afford this role's minimum body
  const minCost = ROLE_MIN_COST[role] || 200;
  if (energy < minCost) return [];

  // Use the generic body builder
  return buildBodyFromConfig(role, energy);
}

// ============================================
// Memory Building Functions
// ============================================

/**
 * Build appropriate memory for a role
 */
function buildMemory(role: SpawnRole, state: ColonyState): Partial<CreepMemory> {
  const base: Partial<CreepMemory> = { role, room: state.room.name };

  switch (role) {
    case "REMOTE_MINER": {
      const target = findRemoteRoomNeedingMiner(state);
      const sourceId = target ? findUnminedSource(state, target.roomName) : null;
      return {
        ...base,
        targetRoom: target?.roomName,
        sourceId: sourceId as Id<Source> | undefined,
      };
    }

    case "REMOTE_HAULER": {
      const targetRoom = findRemoteRoomNeedingHauler(state);
      return {
        ...base,
        targetRoom: targetRoom || undefined,
      };
    }

    case "REMOTE_DEFENDER": {
      const targetRoom = findThreatenedRemoteRoom(state);
      return {
        ...base,
        targetRoom: targetRoom || undefined,
      };
    }

    case "RESERVER": {
      const targetRoom = findRemoteRoomNeedingReserver(state);
      return {
        ...base,
        targetRoom: targetRoom || undefined,
      };
    }

    default:
      return base;
  }
}

// ============================================
// Helper Functions
// ============================================

function getRemoteMiningTargets(homeRoom: string): string[] {
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return [];

  const targets: string[] = [];
  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms?.[roomName];
    if (!intel) continue;

    // Skip rooms without sources
    if (!intel.sources || intel.sources.length === 0) continue;

    // Skip source keeper rooms
    if (intel.hasKeepers) continue;

    // Skip owned rooms
    if (intel.controller?.owner && intel.controller.owner !== myUsername) continue;

    // Skip rooms reserved by others
    if (intel.controller?.reservation && intel.controller.reservation.username !== myUsername)
      continue;

    targets.push(roomName);
  }

  return targets;
}

function getRemoteThreats(homeRoom: string): Record<string, number> {
  const threats: Record<string, number> = {};
  const exits = Game.map.describeExits(homeRoom);

  if (!exits) return threats;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    // Skip Source Keeper rooms - those hostiles are permanent
    const intel = Memory.rooms?.[roomName];
    if (intel?.hasKeepers) continue;

    // Use live vision if available, fall back to memory
    const hostileCount = getHostileCount(roomName);
    if (hostileCount > 0) {
      threats[roomName] = hostileCount;
    }
  }

  return threats;
}

function needsScout(homeRoom: string): boolean {
  // Scout 4-room radius around home (81 rooms total)
  // Uses Memory.intel for comprehensive room data
  const SCOUT_RANGE = 4;
  const STALE_THRESHOLD = 10000;

  const intel = Memory.intel || {};

  // Parse home room coordinates
  const parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(homeRoom);
  if (!parsed) return false;

  const [, ew, xStr, ns, yStr] = parsed;
  const homeX = parseInt(xStr) * (ew === "E" ? 1 : -1);
  const homeY = parseInt(yStr) * (ns === "N" ? 1 : -1);

  // Check if any room in range needs scouting
  for (let dx = -SCOUT_RANGE; dx <= SCOUT_RANGE; dx++) {
    for (let dy = -SCOUT_RANGE; dy <= SCOUT_RANGE; dy++) {
      if (dx === 0 && dy === 0) continue; // Skip home room

      const x = homeX + dx;
      const y = homeY + dy;
      const ewDir = x >= 0 ? "E" : "W";
      const nsDir = y >= 0 ? "N" : "S";
      const roomName = `${ewDir}${Math.abs(x)}${nsDir}${Math.abs(y)}`;

      const roomIntel = intel[roomName];
      if (!roomIntel || Game.time - roomIntel.lastScanned > STALE_THRESHOLD) {
        return true;
      }
    }
  }

  return false;
}

function countRoomsNeedingScan(homeRoom: string): number {
  const SCOUT_RANGE = 4;
  const STALE_THRESHOLD = 10000;
  const intel = Memory.intel || {};

  const parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(homeRoom);
  if (!parsed) return 0;

  const [, ew, xStr, ns, yStr] = parsed;
  const homeX = parseInt(xStr) * (ew === "E" ? 1 : -1);
  const homeY = parseInt(yStr) * (ns === "N" ? 1 : -1);

  let count = 0;
  for (let dx = -SCOUT_RANGE; dx <= SCOUT_RANGE; dx++) {
    for (let dy = -SCOUT_RANGE; dy <= SCOUT_RANGE; dy++) {
      if (dx === 0 && dy === 0) continue;

      const x = homeX + dx;
      const y = homeY + dy;
      const ewDir = x >= 0 ? "E" : "W";
      const nsDir = y >= 0 ? "N" : "S";
      const roomName = `${ewDir}${Math.abs(x)}${nsDir}${Math.abs(y)}`;

      const roomIntel = intel[roomName];
      if (!roomIntel || Game.time - roomIntel.lastScanned > STALE_THRESHOLD) {
        count++;
      }
    }
  }

  return count;
}

function findRemoteRoomNeedingMiner(
  state: ColonyState
): { roomName: string; sourceId: string } | null {
  for (const roomName of state.remoteRooms) {
    const intel = Memory.rooms?.[roomName];
    if (!intel?.sources) continue;

    // intel.sources is an array of source IDs (strings)
    for (const sourceId of intel.sources) {
      // Check if this source has a miner
      const hasMiner = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "REMOTE_MINER" &&
          c.memory.room === state.room.name &&
          c.memory.sourceId === sourceId
      );

      if (!hasMiner) {
        return { roomName, sourceId: sourceId as string };
      }
    }
  }

  return null;
}

function findUnminedSource(state: ColonyState, roomName: string): string | null {
  const intel = Memory.rooms?.[roomName];
  if (!intel?.sources) return null;

  // intel.sources is an array of source IDs (strings)
  for (const sourceId of intel.sources) {
    const hasMiner = Object.values(Game.creeps).some(
      (c) =>
        c.memory.role === "REMOTE_MINER" &&
        c.memory.room === state.room.name &&
        c.memory.sourceId === sourceId
    );

    if (!hasMiner) {
      return sourceId as string;
    }
  }

  return null;
}

function findRemoteRoomNeedingHauler(state: ColonyState): string | null {
  // Find room with miners but insufficient haulers
  const haulerCounts: Record<string, number> = {};
  const minerCounts: Record<string, number> = {};

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.room !== state.room.name) continue;

    if (creep.memory.role === "REMOTE_HAULER" && creep.memory.targetRoom) {
      haulerCounts[creep.memory.targetRoom] = (haulerCounts[creep.memory.targetRoom] || 0) + 1;
    }
    if (creep.memory.role === "REMOTE_MINER" && creep.memory.targetRoom) {
      minerCounts[creep.memory.targetRoom] = (minerCounts[creep.memory.targetRoom] || 0) + 1;
    }
  }

  for (const roomName of state.remoteRooms) {
    const miners = minerCounts[roomName] || 0;
    const haulers = haulerCounts[roomName] || 0;

    // Want ~1.5 haulers per miner
    if (miners > 0 && haulers < Math.ceil(miners * 1.5)) {
      return roomName;
    }
  }

  return null;
}

function findThreatenedRemoteRoom(state: ColonyState): string | null {
  // Use squad manager to find rooms that need defenders
  const squadManager = new RemoteSquadManager(state.room);
  const needs = squadManager.getDefendersNeeded();

  if (needs.length === 0) return null;

  // Return the room with the highest need
  let bestRoom: string | null = null;
  let maxNeeded = 0;

  for (const need of needs) {
    if (need.count > maxNeeded) {
      maxNeeded = need.count;
      bestRoom = need.roomName;
    }
  }

  return bestRoom;
}

function findRemoteRoomNeedingReserver(state: ColonyState): string | null {
  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

  for (const roomName of state.remoteRooms) {
    const intel = Memory.rooms?.[roomName];
    if (!intel) continue;

    // Check if we already have a reserver for this room
    const existingReserver = Object.values(Game.creeps).find(
      (c) =>
        c.memory.role === "RESERVER" &&
        c.memory.room === state.room.name &&
        c.memory.targetRoom === roomName
    );

    // No reserver assigned -> need one
    if (!existingReserver) {
      return roomName;
    }

    // Has reserver - check if we need a replacement (TTL < 150 for travel time)
    const reserverDying = existingReserver.ticksToLive && existingReserver.ticksToLive < 150;
    if (!reserverDying) continue;

    // Reserver dying soon - check if reservation needs maintenance
    const reservation = intel.controller?.reservation;
    const elapsed = Game.time - (intel.lastScan || 0);
    const actualTicksToEnd = reservation ? reservation.ticksToEnd - elapsed : 0;
    const needsReservation =
      !reservation || actualTicksToEnd < 2000 || reservation.username !== myUsername;

    if (needsReservation) {
      return roomName;
    }
  }

  return null;
}
