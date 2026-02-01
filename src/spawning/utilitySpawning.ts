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
  | "REMOTE_DEFENDER_RANGED"
  | "RESERVER"
  | "SCOUT"
  | "LINK_FILLER"
  | "MINERAL_HARVESTER"
  | "CLAIMER";

const ALL_ROLES: SpawnRole[] = [
  "HARVESTER",
  "HAULER",
  "UPGRADER",
  "BUILDER",
  "DEFENDER",
  "REMOTE_MINER",
  "REMOTE_HAULER",
  "REMOTE_DEFENDER",
  "REMOTE_DEFENDER_RANGED",
  "RESERVER",
  "SCOUT",
  "LINK_FILLER",
  "MINERAL_HARVESTER",
  "CLAIMER",
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
      "REMOTE_DEFENDER_RANGED",
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

  // Roles that autonomously renew - never count as dying soon
  const selfRenewingRoles = new Set([
    "HARVESTER",
    "LINK_FILLER",
    "REMOTE_DEFENDER",
    "REMOTE_DEFENDER_RANGED",
  ]);

  for (const c of creeps) {
    const role = c.memory.role;
    counts[role] = (counts[role] || 0) + 1;

    // Skip self-renewing roles - they manage their own lifecycle
    if (selfRenewingRoles.has(role)) continue;

    // Skip creeps actively renewing
    if (c.memory.renewing) continue;

    // Use higher threshold for remote roles (need travel time buffer)
    const isRemoteRole =
      role === "REMOTE_MINER" ||
      role === "REMOTE_HAULER" ||
      role === "RESERVER" ||
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
    MINERAL_HARVESTER: 0,
  };

  // Link filler at RCL 5+ with storage and links
  if (rcl >= 5 && room.storage && room.storage.store[RESOURCE_ENERGY] > 10000) {
    const linkManager = new LinkManager(room);
    if (linkManager.getStorageLink()) {
      targets.LINK_FILLER = 1;
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
    case "REMOTE_DEFENDER_RANGED":
      return remoteDefenderRangedUtility(state);
    case "RESERVER":
      return reserverUtility(effectiveDeficit, state);
    case "SCOUT":
      return scoutUtility(effectiveDeficit, state);
    case "LINK_FILLER":
      return linkFillerUtility(effectiveDeficit, state);
    case "MINERAL_HARVESTER":
      return mineralHarvesterUtility(effectiveDeficit, state);
    case "CLAIMER":
      return claimerUtility(state);
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

  // Factor 4: First-creep bonus - first builder spawns before second upgrader
  // count=0: 2.0x, count=1: 0.67x, count=2: 0.4x
  const firstCreepBonus = 1 / (currentCount + 0.5);

  // Factor 5: Site urgency (more sites = higher utility)
  const siteFactor = Math.min(totalSites / 5, 2);

  // Factor 6: Remote container boost (critical infrastructure)
  const containerBoost = hasRemoteContainer ? 1.5 : 1;

  // Combine factors
  const multiplier =
    combineUtilities(storageFactor, sustainFactor, countFactor) * siteFactor * containerBoost * firstCreepBonus;

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
 * Remote hauler utility - context-aware
 * Returns 0 if:
 * - Room has hostiles (miners can't work)
 * - No active miners (TTL > 50)
 * - No containers in remote rooms
 */
function remoteHaulerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;

  // Check all remote rooms for viability
  let totalActiveMiners = 0;
  let totalContainers = 0;
  let anyRoomHasHostiles = false;

  for (const roomName of state.remoteRooms) {
    const roomMem = Memory.rooms?.[roomName];

    // Check for hostiles - haulers useless if miners can't work
    if (roomMem?.hostiles && roomMem.hostiles > 0) {
      anyRoomHasHostiles = true;
      continue; // Skip this room for hauler calculation
    }

    // Count active miners (TTL > 50) for this remote room
    const activeMiners = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_MINER" &&
        c.memory.targetRoom === roomName &&
        c.ticksToLive &&
        c.ticksToLive > 50
    ).length;

    totalActiveMiners += activeMiners;

    // Check for containers in remote room
    const remoteRoom = Game.rooms[roomName];
    if (remoteRoom) {
      // Have vision - check directly
      const containers = remoteRoom.find(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });
      totalContainers += containers.length;
    }
    // Note: Without vision, we can't verify containers exist
    // Only spawn haulers if we have room vision or active miners already working
  }

  // If all remote rooms have hostiles, no utility
  if (anyRoomHasHostiles && totalActiveMiners === 0) {
    return 0;
  }

  // No active miners = no energy production = no hauler needed
  if (totalActiveMiners === 0) {
    return 0;
  }

  // Count existing haulers for deficit calculation
  const existingHaulers = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "REMOTE_HAULER" &&
      c.memory.room === state.room.name &&
      c.ticksToLive &&
      c.ticksToLive > 100
  ).length;

  // Need ~1.5 haulers per active miner
  const haulersNeeded = Math.ceil(totalActiveMiners * 1.5);
  const actualDeficit = haulersNeeded - existingHaulers;

  if (actualDeficit <= 0) {
    return 0;
  }

  // Scale utility by deficit ratio (not fixed thresholds)
  const baseUtility = 35;
  let utility = baseUtility * (actualDeficit / Math.max(haulersNeeded, 1));

  // Scale by home economy
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

/**
 * Remote defender utility - checks memory for threats and creates squads as needed
 * Uses squad-based spawning to coordinate attacks against healer-supported invaders
 *
 * Both melee and ranged defenders spawn independently when threats detected.
 * Utility is 60 (higher than RESERVER at 50) to ensure defenders spawn first.
 *
 * IMPORTANT: Must check Memory.rooms[roomName].hostiles directly because:
 * - Creeps flee when they see hostiles and update memory
 * - Without vision, we rely on memory for threat info
 * - Squads need to be created when threats are detected
 */
function remoteDefenderUtility(state: ColonyState): number {
  if (state.rcl < 4) return 0;

  const squadManager = new RemoteSquadManager(state.room);
  const SCAN_AGE_THRESHOLD = 200; // Consider scans stale after 200 ticks

  // Debug logging
  const DEBUG = Game.time % 20 === 0; // Log every 20 ticks
  if (DEBUG) console.log(`[DEFENDER] Checking ${state.remoteRooms.length} remote rooms`);

  // First check Memory.rooms for hostiles in remote rooms
  // This catches threats even when we don't have vision
  for (const remoteName of state.remoteRooms) {
    const roomMem = Memory.rooms?.[remoteName];
    if (!roomMem) {
      if (DEBUG) console.log(`[DEFENDER] ${remoteName}: SKIP - no memory`);
      continue;
    }

    // Check scan age - don't spawn defenders for stale intel
    const scanAge = Game.time - (roomMem.lastScan || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) {
      if (DEBUG) console.log(`[DEFENDER] ${remoteName}: SKIP - stale scan (${scanAge} ticks old)`);
      continue;
    }

    // Check for hostiles (from memory or live)
    const hostileCount = roomMem.hostiles || 0;
    if (hostileCount === 0) {
      if (DEBUG) console.log(`[DEFENDER] ${remoteName}: SKIP - no hostiles`);
      continue;
    }

    // Check for dangerous hostiles (with attack parts)
    const hostileDetails = (roomMem as any).hostileDetails;
    let hasDangerous = false;
    if (hostileDetails && Array.isArray(hostileDetails)) {
      hasDangerous = hostileDetails.some((h: any) => h.hasCombat);
    } else {
      // No details, assume any hostiles are dangerous
      hasDangerous = hostileCount > 0;
    }

    if (!hasDangerous) {
      if (DEBUG) console.log(`[DEFENDER] ${remoteName}: SKIP - hostiles not dangerous`);
      continue;
    }

    if (DEBUG) console.log(`[DEFENDER] ${remoteName}: THREAT DETECTED - ${hostileCount} hostiles`);

    // Request a squad if one doesn't exist
    const existingSquad = squadManager.getSquad(remoteName);
    if (!existingSquad || existingSquad.status === "DISBANDED") {
      // Analyze threat to determine squad size
      const analysis = squadManager.analyzeThreat(remoteName);
      if (analysis.recommendedSquadSize > 0) {
        squadManager.requestSquad(remoteName, analysis.recommendedSquadSize);
        if (DEBUG) console.log(`[DEFENDER] ${remoteName}: Requested squad size ${analysis.recommendedSquadSize}`);
      } else {
        // Default to 1 defender if we can't analyze
        squadManager.requestSquad(remoteName, 1);
        if (DEBUG) console.log(`[DEFENDER] ${remoteName}: Requested squad size 1 (default)`);
      }
    } else {
      if (DEBUG) console.log(`[DEFENDER] ${remoteName}: Squad exists, status=${existingSquad.status}`);
    }
  }

  // Now check squad needs (includes newly created squads)
  const needs = squadManager.getDefendersNeeded();

  if (DEBUG) console.log(`[DEFENDER] Squad needs: ${JSON.stringify(needs)}`);

  // No squad needs = no utility
  if (needs.length === 0) {
    if (DEBUG) console.log(`[DEFENDER] No squad needs, returning utility=0`);
    return 0;
  }

  // Find the most urgent need (most defenders needed)
  let totalNeeded = 0;
  for (const need of needs) {
    totalNeeded += need.count;
  }

  if (totalNeeded === 0) {
    if (DEBUG) console.log(`[DEFENDER] totalNeeded=0, returning utility=0`);
    return 0;
  }

  // Base utility for melee defender - MUST BE HIGHER THAN RESERVER (50)
  // 60 for first defender, +10 for each additional needed
  const BASE_UTILITY = 60;

  // Scale with number of defenders needed
  const utility = BASE_UTILITY + (totalNeeded - 1) * 10;

  if (DEBUG) console.log(`[DEFENDER] Returning utility=${utility} (need ${totalNeeded} defenders)`);

  return utility;
}

/**
 * Remote defender ranged utility - spawns independently when threats exist
 * Provides ranged support and healing for melee defenders
 *
 * Both defenders spawn when threat detected - ranged doesn't wait for melee.
 * Slightly lower utility (28) than melee (30) so melee spawns first.
 */
function remoteDefenderRangedUtility(state: ColonyState): number {
  if (state.rcl < 6) return 0; // Need RCL 6 for the energy cost

  // Use squad manager - melee defender utility creates squads when threats detected
  const squadManager = new RemoteSquadManager(state.room);
  const needs = squadManager.getDefendersNeeded();

  // No squad needs = no utility
  if (needs.length === 0) return 0;

  // Check if we already have ranged support
  const existingRanged = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "REMOTE_DEFENDER_RANGED" &&
      c.memory.room === state.room.name &&
      c.ticksToLive &&
      c.ticksToLive > 100
  ).length;

  // Only need 1 ranged defender total
  if (existingRanged >= 1) return 0;

  // Base utility for ranged defender
  // Slightly lower than melee (30) so melee spawns first
  return 28;
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
 * Scout utility - spawns multiple scouts for faster exploration
 * Up to 4 scouts can scan simultaneously in different directions
 */
function scoutUtility(_deficit: number, state: ColonyState): number {
  if (state.rcl < 3) return 0;

  // Count rooms needing scan
  const roomsNeedingScan = countRoomsNeedingScan(state.room.name);
  if (roomsNeedingScan === 0) return 0;

  // Count existing scouts
  const existingScouts = Object.values(Game.creeps).filter(
    (c) => c.memory.role === "SCOUT" && c.memory.room === state.room.name
  ).length;

  // Cap at 4 scouts or rooms needing scan, whichever is lower
  const maxScouts = Math.min(4, roomsNeedingScan);
  if (existingScouts >= maxScouts) return 0;

  // Higher utility when more rooms need scanning
  // Base utility scales with urgency, decreases with existing scouts
  const baseUtility = 25;
  const urgency = Math.min(roomsNeedingScan / 20, 2); // scales up to 2x

  return (baseUtility * urgency) / (existingScouts + 1);
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

/**
 * Claimer utility - spawns when expansion target is set and GCL allows
 * Trigger expansion via: Memory.expansion = { targetRoom: 'E47N38' }
 */
function claimerUtility(_state: ColonyState): number {
  // Check if expansion target is set
  const expansionTarget = Memory.expansion?.targetRoom;
  if (!expansionTarget) return 0;

  // Check GCL - can we claim another room?
  const currentRooms = Object.keys(Game.rooms).filter(
    (r) => Game.rooms[r].controller?.my
  ).length;
  if (currentRooms >= Game.gcl.level) return 0;

  // Check if target room is already claimed by us
  const targetRoom = Game.rooms[expansionTarget];
  if (targetRoom?.controller?.my) {
    // Already claimed - update status and return 0
    if (Memory.expansion) {
      Memory.expansion.status = "building_spawn";
    }
    return 0;
  }

  // Check if already have a claimer for this target
  const existingClaimers = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "CLAIMER" && c.memory.targetRoom === expansionTarget
  ).length;
  if (existingClaimers > 0) return 0;

  // High priority when expansion target is set
  return 40;
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

    case "REMOTE_DEFENDER_RANGED": {
      // Ranged defender follows melee defender, doesn't need its own target
      // Just assign home room - it will find the melee defender dynamically
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
