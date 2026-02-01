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
import { BootstrapManager } from "../expansion/BootstrapManager";
import { getBootstrapBuilderBody } from "../creeps/BootstrapBuilder";
import { getBootstrapHaulerBody } from "../creeps/BootstrapHauler";
import { ExpansionManager } from "../empire";

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
  | "MINERAL_HARVESTER"
  | "CLAIMER"
  | "BOOTSTRAP_BUILDER"
  | "BOOTSTRAP_HAULER";

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
  "MINERAL_HARVESTER",
  "CLAIMER",
  "BOOTSTRAP_BUILDER",
  "BOOTSTRAP_HAULER",
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
  constructionSites: number; // Total including remote + assumed sites
  hasRemoteContainerSite: boolean; // Critical infrastructure flag
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

  // Debug: show state at RCL 1-2
  const debugSpawn = state.rcl <= 2 && Game.time % 20 === 0;
  if (debugSpawn) {
    console.log(`[${room.name}] SpawnDebug: rcl=${state.rcl} income=${state.energyIncome} avail=${state.energyAvailable} cap=${state.energyCapacity}`);
    console.log(`[${room.name}] SpawnDebug: counts=${JSON.stringify(state.counts)} targets=${JSON.stringify(state.targets)}`);
  }

  for (const role of ALL_ROLES) {
    const utility = calculateUtility(role, state);
    if (utility <= 0) continue;

    const body = buildBody(role, state);
    if (body.length === 0) {
      if (debugSpawn) console.log(`[${room.name}] SpawnDebug: ${role} utility=${utility.toFixed(1)} but empty body`);
      continue;
    }

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

    if (debugSpawn) console.log(`[${room.name}] SpawnDebug: ${role} utility=${utility.toFixed(1)} cost=${cost}`);

    // DON'T filter by affordability here - collect all valid candidates
    candidates.push({ role, utility, body, memory, cost });
  }

  if (candidates.length === 0) {
    if (debugSpawn) console.log(`[${room.name}] SpawnDebug: NO CANDIDATES`);
    return null;
  }

  // Sort by utility descending
  candidates.sort((a, b) => b.utility - a.utility);

  const best = candidates[0];

  // Can we afford the highest utility role?
  if (best.cost <= room.energyAvailable) {
    return best;
  }

  // Can't afford best. Check if economy is functional.
  const hasIncome = state.energyIncome > 0;

  if (debugSpawn) {
    console.log(`[${room.name}] SpawnDebug: best=${best.role} cost=${best.cost} avail=${room.energyAvailable} hasIncome=${hasIncome}`);
  }

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

  // Get remote threats
  const remoteThreatsByRoom = getRemoteThreats(room.name);

  // Get remote mining targets
  const remoteRooms = getRemoteMiningTargets(room.name);

  // Count construction sites (home + remote + assumed for non-visible remotes)
  let constructionSites = room.find(FIND_CONSTRUCTION_SITES).length;
  let hasRemoteContainerSite = false;
  for (const remoteName of remoteRooms) {
    const remoteRoom = Game.rooms[remoteName];
    if (remoteRoom) {
      const remoteSites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
      constructionSites += remoteSites.length;
      if (remoteSites.some((s) => s.structureType === STRUCTURE_CONTAINER)) {
        hasRemoteContainerSite = true;
      }
    } else {
      // Can't see room, but assume some sites if we're mining there
      const intel = Memory.rooms?.[remoteName];
      if (intel?.lastScan && Game.time - intel.lastScan < 1000) {
        constructionSites += 2; // Assume container + roads needed
      }
    }
  }

  // Get targets (desired counts) - pass site count to avoid recalculation
  const targets = getCreepTargets(room, constructionSites);

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
    constructionSites,
    hasRemoteContainerSite,
    remoteRooms,
    dyingSoon,
  };
}

/**
 * Calculate desired creep counts for each role
 */
function getCreepTargets(room: Room, totalSites: number): Record<string, number> {
  const rcl = room.controller?.level || 0;
  const sources = room.find(FIND_SOURCES).length;
  const remoteRooms = getRemoteMiningTargets(room.name);

  // Scale builders: 1 per 10 sites, floor of 2 if any sites exist (RCL 1 needs 2 builders)
  const maxBuildersByEconomy = Math.max(2, Math.min(rcl, 4));
  const builderTarget = totalSites > 0 ? Math.min(Math.ceil(totalSites / 10), maxBuildersByEconomy) : 0;

  const targets: Record<string, number> = {
    HARVESTER: sources,
    HAULER: sources, // 1 hauler per source - scales correctly for 1-source rooms
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
    case "BOOTSTRAP_BUILDER":
      return bootstrapBuilderUtility(state);
    case "BOOTSTRAP_HAULER":
      return bootstrapHaulerUtility(state);
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
    utility *= 10; // No haulers at all - critical
  } else if ((state.counts.HAULER || 0) < state.targets.HAULER) {
    // Below target — scale boost by how far below
    // 1 hauler when target is 2: multiplier = 3
    // This ensures the second hauler spawns before remote/scout roles
    const understaffRatio =
      1 - (state.counts.HAULER || 0) / Math.max(state.targets.HAULER, 1);
    utility *= 1 + understaffRatio * 2;
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

  // Factor 1: Storage level
  // Young colonies (no storage) get a fixed baseline — they MUST upgrade to progress
  const hasStorage = !!state.room.storage;
  const storageFactor = hasStorage
    ? storageUtility(energy.stored, CONFIG.ENERGY.STORAGE_THRESHOLDS)
    : 0.6; // Fixed baseline for young colonies

  // Factor 2: Can we sustain another upgrader?
  // Scale down expected work parts for young colonies (they get tiny bodies)
  const expectedWorkParts = hasStorage ? 15 : 1;
  const sustainFactor = sustainabilityUtility(
    energy.upgradeConsumption,
    expectedWorkParts,
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

  // Use pre-calculated site count from state (includes home + remote + assumed)
  const totalSites = state.constructionSites;
  if (totalSites === 0) return 0;

  const base = CONFIG.SPAWNING.BASE_UTILITY.BUILDER;
  const energy = getEnergyState(state.room);

  // Factor 1: Storage level
  // Young colonies (no storage) get a fixed baseline — they MUST build to progress
  const hasStorage = !!state.room.storage;
  const storageFactor = hasStorage
    ? storageUtility(energy.stored, CONFIG.ENERGY.STORAGE_THRESHOLDS)
    : 0.6; // Fixed baseline for young colonies

  // Factor 2: Can we sustain another builder?
  const expectedWorkParts = hasStorage ? 5 : 1;
  const sustainFactor = sustainabilityUtility(
    energy.builderConsumption,
    expectedWorkParts * 0.5, // 50% uptime estimate
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
  const containerBoost = state.hasRemoteContainerSite ? 1.5 : 1;

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
/**
 * Remote hauler utility - critical for capturing remote income
 *
 * Key insight: the FIRST hauler for a room with active miners is extremely
 * valuable because without it, all mined energy is wasted. Subsequent
 * haulers have diminishing returns.
 *
 * Utility range: 0-55 (above reserver at 30, below remote defender at 65)
 */
function remoteHaulerUtility(_deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;

  let totalActiveMiners = 0;
  let roomsWithMinersNoHaulers = 0;

  for (const roomName of state.remoteRooms) {
    const roomMem = Memory.rooms?.[roomName];

    // Skip rooms with hostiles - haulers would just flee
    if (roomMem?.hostiles && roomMem.hostiles > 0) continue;

    // Count active miners in this room
    const roomMiners = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_MINER" &&
        c.memory.targetRoom === roomName &&
        c.ticksToLive &&
        c.ticksToLive > 50
    ).length;

    if (roomMiners === 0) continue;
    totalActiveMiners += roomMiners;

    // Count haulers assigned to this room
    const roomHaulers = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_HAULER" &&
        c.memory.targetRoom === roomName &&
        c.ticksToLive &&
        c.ticksToLive > 100
    ).length;

    if (roomHaulers === 0) {
      roomsWithMinersNoHaulers++;
    }
  }

  if (totalActiveMiners === 0) return 0;

  // Count all existing remote haulers for this colony
  const existingHaulers = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "REMOTE_HAULER" &&
      c.memory.room === state.room.name &&
      c.ticksToLive &&
      c.ticksToLive > 100
  ).length;

  const haulersNeeded = Math.ceil(totalActiveMiners * 1.5);
  const actualDeficit = haulersNeeded - existingHaulers;

  if (actualDeficit <= 0) return 0;

  // Base utility 40
  let utility = 40;

  // First-hauler bonus: rooms with miners but NO haulers get +15
  // This ensures the first hauler for an unserviced room spawns quickly
  if (roomsWithMinersNoHaulers > 0) {
    utility += 15; // Total: 55 — beats reserver(30), scout(15), builder(25)
  }

  // Scale down slightly as we approach full coverage
  // But never below 30 when there's still a deficit
  const coverageRatio = existingHaulers / Math.max(haulersNeeded, 1);
  utility *= Math.max(0.75, 1 - coverageRatio * 0.5);

  return utility;
}

/**
 * Remote defender utility - hybrid ranged/heal defender for remote rooms
 *
 * Spawns when threats detected in remote rooms. Uses simple threat detection
 * based on Memory.rooms[roomName].hostiles. Utility 65 ensures defenders
 * spawn before reservers (25) but after critical economy roles.
 */
function remoteDefenderUtility(state: ColonyState): number {
  if (state.rcl < 4) return 0;

  const SCAN_AGE_THRESHOLD = 200; // Consider scans stale after 200 ticks

  // Check for threats in remote rooms
  let threatenedRooms = 0;
  for (const remoteName of state.remoteRooms) {
    const roomMem = Memory.rooms?.[remoteName];
    if (!roomMem) continue;

    // Check scan age - don't spawn defenders for stale intel
    const scanAge = Game.time - (roomMem.lastScan || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) continue;

    // Check for hostiles
    const hostileCount = roomMem.hostiles || 0;
    if (hostileCount === 0) continue;

    // Check for dangerous hostiles (with attack parts)
    const hostileDetails = (roomMem as any).hostileDetails;
    let hasDangerous = false;
    if (hostileDetails && Array.isArray(hostileDetails)) {
      hasDangerous = hostileDetails.some((h: any) => h.hasCombat);
    } else {
      // No details, assume any hostiles are dangerous
      hasDangerous = hostileCount > 0;
    }

    if (hasDangerous) {
      threatenedRooms++;
    }
  }

  if (threatenedRooms === 0) return 0;

  // Count existing defenders
  const existingDefenders = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "REMOTE_DEFENDER" &&
      c.memory.room === state.room.name &&
      c.ticksToLive &&
      c.ticksToLive > 100
  ).length;

  // Need 1 defender per threatened room
  if (existingDefenders >= threatenedRooms) return 0;

  // Utility 65 - higher than reserver (25), lower than economy roles
  return 65;
}

/**
 * Reserver utility - lower priority than miners/haulers
 */
/**
 * Reserver utility - protects remote income by maintaining reservation
 *
 * Reservers directly protect remote income by preventing source capacity decay.
 * Their utility shouldn't be suppressed by home incomeRatio (which is based on
 * HOME income, not remote).
 *
 * Fixed utility 30 when needed — above scout(15), below remote hauler first(55)
 */
function reserverUtility(_deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (state.remoteRooms.length === 0) return 0;

  // Check if any remote room needs reservation
  let needsReservation = false;
  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

  for (const roomName of state.remoteRooms) {
    // Need reserver if: no reservation, or reservation < 1000 ticks
    const remoteRoom = Game.rooms[roomName];
    const reservation = remoteRoom?.controller?.reservation;
    if (!reservation || reservation.ticksToEnd < 1000 || reservation.username !== myUsername) {
      // Only if we have miners there (worth protecting)
      const hasMiners = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "REMOTE_MINER" &&
          c.memory.targetRoom === roomName &&
          c.ticksToLive &&
          c.ticksToLive > 100
      );
      if (hasMiners) {
        // Check if we already have a reserver assigned
        const hasReserver = Object.values(Game.creeps).some(
          (c) =>
            c.memory.role === "RESERVER" &&
            c.memory.targetRoom === roomName &&
            c.ticksToLive &&
            c.ticksToLive > 150
        );
        if (!hasReserver) {
          needsReservation = true;
          break;
        }
      }
    }
  }

  if (!needsReservation) return 0;

  // Fixed utility 30 — above scout(15), below remote hauler first(55)
  // No incomeRatio suppression — reservation protects remote income directly
  return 30;
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
/**
 * Scout utility - capped low to never outbid economy/infrastructure roles
 *
 * Scouts are nice-to-have, not critical. Max utility 15.
 * Economy roles (hauler, remote hauler, reserver) must always win.
 */
function scoutUtility(_deficit: number, state: ColonyState): number {
  if (state.rcl < 3) return 0;

  const roomsNeedingScan = countRoomsNeedingScan(state.room.name);
  if (roomsNeedingScan === 0) return 0;

  const existingScouts = Object.values(Game.creeps).filter(
    (c) => c.memory.role === "SCOUT" && c.memory.room === state.room.name
  ).length;

  // Cap at 2 scouts max (down from 4 — diminishing returns on exploration)
  const maxScouts = Math.min(2, roomsNeedingScan);
  if (existingScouts >= maxScouts) return 0;

  // Base 10, urgency scales up to 1.5x, cap at 15
  const urgency = Math.min(roomsNeedingScan / 20, 1.5);
  const utility = (10 * urgency) / (existingScouts + 1);

  return Math.min(utility, 15);
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
function claimerUtility(state: ColonyState): number {
  // Check GCL - can we claim another room?
  const currentRooms = Object.keys(Game.rooms).filter(
    (r) => Game.rooms[r].controller?.my
  ).length;
  if (currentRooms >= Game.gcl.level) return 0;

  // Check old expansion system first
  const expansionTarget = Memory.expansion?.targetRoom;
  if (expansionTarget) {
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

  // Check new ExpansionManager system
  const empActive = Memory.empireExpansion?.active || {};
  const claimingExpansion = Object.values(empActive).find(
    (e) => e.parentRoom === state.room.name && e.state === "CLAIMING" && !e.claimer
  );

  if (claimingExpansion) {
    // Check if already have a claimer for this target
    const existingClaimers = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "CLAIMER" && c.memory.targetRoom === claimingExpansion.roomName
    ).length;
    if (existingClaimers > 0) return 0;

    return 40;
  }

  return 0;
}

/**
 * Bootstrap builder utility - spawns when BootstrapManager or ExpansionManager needs builders
 * Only spawns from the parent room of an active bootstrap operation
 */
function bootstrapBuilderUtility(state: ColonyState): number {
  // Check old BootstrapManager system
  const bootstrapManager = new BootstrapManager();
  const oldNeeds = bootstrapManager.getCreepNeeds();
  const oldBuilderNeeds = oldNeeds.filter(
    (n) => n.role === "BOOTSTRAP_BUILDER" && n.parentRoom === state.room.name
  );

  // Check new ExpansionManager system
  const expansionManager = new ExpansionManager();
  const newNeeds = expansionManager.getSpawnRequests(state.room.name);
  const newBuilderNeeds = newNeeds.filter((n) => n.role === "BOOTSTRAP_BUILDER");

  if (oldBuilderNeeds.length === 0 && newBuilderNeeds.length === 0) return 0;

  // High priority - getting spawn built is critical
  return 80;
}

/**
 * Bootstrap hauler utility - spawns when BootstrapManager or ExpansionManager needs haulers
 * Only spawns from the parent room of an active bootstrap operation
 */
function bootstrapHaulerUtility(state: ColonyState): number {
  // Check old BootstrapManager system
  const bootstrapManager = new BootstrapManager();
  const oldNeeds = bootstrapManager.getCreepNeeds();
  const oldHaulerNeeds = oldNeeds.filter(
    (n) => n.role === "BOOTSTRAP_HAULER" && n.parentRoom === state.room.name
  );

  // Check new ExpansionManager system
  const expansionManager = new ExpansionManager();
  const newNeeds = expansionManager.getSpawnRequests(state.room.name);
  const newHaulerNeeds = newNeeds.filter((n) => n.role === "BOOTSTRAP_HAULER");

  if (oldHaulerNeeds.length === 0 && newHaulerNeeds.length === 0) return 0;

  // High priority - energy delivery is critical for spawn construction
  return 75;
}

// ============================================
// Body Building Functions
// ============================================

// ROLE_MIN_COST is now imported from bodyBuilder.ts

/**
 * Build appropriate body for a role given available energy
 */
/**
 * Build appropriate body for a role given available energy
 *
 * Emergency mode (build with available energy) ONLY triggers when
 * both harvesters AND haulers are missing — true economy death.
 * A missing hauler alone is not an emergency if harvesters + storage exist.
 *
 * Special case: First hauler bootstrap. If harvesters are stationary at
 * containers but no hauler exists, energy won't reach spawn naturally.
 * Build first hauler with available energy to break the deadlock.
 */
function buildBody(role: SpawnRole, state: ColonyState): BodyPartConstant[] {
  const noHarvesters = (state.counts.HARVESTER || 0) === 0;
  const noHaulers = (state.counts.HAULER || 0) === 0;

  // True emergency: economy is completely dead
  // Both harvesters AND haulers must be gone, OR we have no harvesters and low storage
  const isEmergency =
    (noHarvesters && noHaulers) || (noHarvesters && state.energyStored < 1000);

  // Special case: First hauler bootstrap
  // If harvesters exist but no haulers, harvesters may be stationary at containers
  // Energy won't reach spawn naturally - build first hauler with available energy
  const isHaulerBootstrap = role === "HAULER" && noHaulers;

  // In emergency OR hauler bootstrap, build what we can afford NOW
  // Otherwise, build for full capacity (wait for energy)
  const energy = (isEmergency || isHaulerBootstrap) ? state.energyAvailable : state.energyCapacity;

  // Bootstrap roles use their own body builders
  if (role === "BOOTSTRAP_BUILDER") {
    return getBootstrapBuilderBody(energy);
  }
  if (role === "BOOTSTRAP_HAULER") {
    return getBootstrapHaulerBody(energy);
  }

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

    case "BOOTSTRAP_BUILDER": {
      // Check old BootstrapManager first
      const bootstrapManager = new BootstrapManager();
      const oldStatus = bootstrapManager.getStatus();
      if (oldStatus) {
        return {
          ...base,
          role: "BOOTSTRAP_BUILDER",
          parentRoom: oldStatus.parentRoom,
          targetRoom: oldStatus.targetRoom,
          bootstrapState: "TRAVELING_TO_TARGET",
        } as unknown as Partial<CreepMemory>;
      }
      // Check new ExpansionManager
      const empActive = Memory.empireExpansion?.active || {};
      const expansion = Object.values(empActive).find(
        (e) => e.parentRoom === state.room.name
      );
      if (expansion) {
        return {
          ...base,
          role: "BOOTSTRAP_BUILDER",
          parentRoom: expansion.parentRoom,
          targetRoom: expansion.roomName,
          bootstrapState: "TRAVELING_TO_TARGET",
        } as unknown as Partial<CreepMemory>;
      }
      return base;
    }

    case "BOOTSTRAP_HAULER": {
      // Check old BootstrapManager first
      const bootstrapManager = new BootstrapManager();
      const oldStatus = bootstrapManager.getStatus();
      if (oldStatus) {
        return {
          ...base,
          role: "BOOTSTRAP_HAULER",
          parentRoom: oldStatus.parentRoom,
          targetRoom: oldStatus.targetRoom,
          bootstrapState: "LOADING",
        } as unknown as Partial<CreepMemory>;
      }
      // Check new ExpansionManager
      const empActive = Memory.empireExpansion?.active || {};
      const expansion = Object.values(empActive).find(
        (e) => e.parentRoom === state.room.name
      );
      if (expansion) {
        return {
          ...base,
          role: "BOOTSTRAP_HAULER",
          parentRoom: expansion.parentRoom,
          targetRoom: expansion.roomName,
          bootstrapState: "LOADING",
        } as unknown as Partial<CreepMemory>;
      }
      return base;
    }

    case "CLAIMER": {
      // Check old expansion system first
      const expansionTarget = Memory.expansion?.targetRoom;
      if (expansionTarget) {
        return {
          ...base,
          targetRoom: expansionTarget,
        };
      }
      // Check new ExpansionManager - find claiming state expansion from this room
      const empActive = Memory.empireExpansion?.active || {};
      const claimingExpansion = Object.values(empActive).find(
        (e) => e.parentRoom === state.room.name && e.state === "CLAIMING"
      );
      if (claimingExpansion) {
        return {
          ...base,
          targetRoom: claimingExpansion.roomName,
        };
      }
      return base;
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
  const SCAN_AGE_THRESHOLD = 200;

  // Use squad manager to find rooms that need defenders
  const squadManager = new RemoteSquadManager(state.room);
  const needs = squadManager.getDefendersNeeded();

  if (needs.length === 0) return null;

  // Return the room with the highest need that still has active threats
  let bestRoom: string | null = null;
  let maxNeeded = 0;

  for (const need of needs) {
    const roomMem = Memory.rooms?.[need.roomName];

    // Validate room still has active threats (not stale intel)
    if (!roomMem) continue;
    const scanAge = Game.time - (roomMem.lastScan || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) continue;
    if ((roomMem.hostiles || 0) === 0) {
      // No threats - disband the stale squad
      squadManager.disbandSquad(need.roomName);
      continue;
    }

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
