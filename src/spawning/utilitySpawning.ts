/**
 * Utility-Based Spawning System
 *
 * Replaces static priorities with dynamic utility scoring.
 * Each role's spawn utility is a continuous function of colony state.
 * The spawner always picks the highest utility role.
 */

import { getHostileCount } from "../utils/remoteIntel";
import { RemoteSquadManager } from "../defense/RemoteSquadManager";
import { LinkManager } from "../structures/LinkManager";

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
  | "LINK_FILLER";

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

    if (c.ticksToLive && c.ticksToLive < 100) {
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
  };

  // Link filler at RCL 5+ with storage and storage link
  if (rcl >= 5 && room.storage && room.storage.store[RESOURCE_ENERGY] > 10000) {
    const linkManager = new LinkManager(room);
    if (linkManager.getStorageLink()) {
      targets.LINK_FILLER = 1;
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
 * Upgrader utility - scales down when economy is struggling
 */
function upgraderUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  // Base utility
  let utility = deficit * 20;

  // Scale DOWN when economy is struggling
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  // Boost if we have lots of stored energy
  if (state.energyStored > 100000) {
    utility *= 1.5;
  }

  return utility;
}

/**
 * Builder utility - 0 if no construction sites, scales with economy
 * Accounts for remote room construction sites
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

  // Base utility
  let utility = deficit * 25;

  // Scale by economy health
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  // More sites = more urgency
  utility *= Math.min(totalSites / 5, 2);

  // Extra boost for remote containers (critical for remote mining)
  if (hasRemoteContainer) {
    utility *= 1.5;
  }

  return utility;
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

  // Base utility scales with number of defenders needed
  let utility = totalNeeded * 45;

  // Reduce if economy is struggling
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

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
 * Scout utility - luxury role, very low priority
 */
function scoutUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 3) return 0;
  if (deficit <= 0) return 0;

  // Very low base utility
  let utility = deficit * 5;

  // Only when economy is healthy
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;

  return utility;
}

// ============================================
// Body Building Functions
// ============================================

/**
 * Minimum energy cost for each role's smallest viable body
 */
const ROLE_MIN_COST: Record<SpawnRole, number> = {
  HARVESTER: 200, // WORK + CARRY + MOVE
  HAULER: 100, // CARRY + MOVE
  UPGRADER: 200, // WORK + CARRY + MOVE
  BUILDER: 200, // WORK + CARRY + MOVE
  DEFENDER: 130, // ATTACK + MOVE + MOVE
  REMOTE_MINER: 300, // WORK + WORK + CARRY + MOVE
  REMOTE_HAULER: 200, // CARRY + CARRY + MOVE + MOVE
  REMOTE_DEFENDER: 230, // TOUGH + ATTACK + ATTACK + MOVE + MOVE + MOVE
  RESERVER: 650, // CLAIM + MOVE
  SCOUT: 50, // MOVE
  LINK_FILLER: 150, // CARRY + CARRY + MOVE
};

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

  switch (role) {
    case "HARVESTER":
      return buildHarvesterBody(energy);
    case "HAULER":
      return buildHaulerBody(energy);
    case "UPGRADER":
      return buildUpgraderBody(energy);
    case "BUILDER":
      return buildBuilderBody(energy);
    case "DEFENDER":
      return buildDefenderBody(energy);
    case "REMOTE_MINER":
      return buildRemoteMinerBody(energy);
    case "REMOTE_HAULER":
      return buildRemoteHaulerBody(energy);
    case "REMOTE_DEFENDER":
      return buildRemoteDefenderBody(energy);
    case "RESERVER":
      return buildReserverBody(energy);
    case "SCOUT":
      return [MOVE];
    case "LINK_FILLER":
      return buildLinkFillerBody(energy);
    default:
      return [];
  }
}

function buildHarvesterBody(energy: number): BodyPartConstant[] {
  // Minimum viable harvester for low energy situations
  if (energy < 300) {
    return [WORK, CARRY, MOVE]; // 200 energy cost
  }

  // Static harvester (sits on container)
  // Optimal: 5 WORK, 1 CARRY, 3 MOVE = 700 energy
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  // Add WORK parts (max 5 for single source)
  while (remaining >= 100 && parts.filter((p) => p === WORK).length < 5) {
    parts.push(WORK);
    remaining -= 100;
  }

  // Add 1 CARRY for container transfer
  if (remaining >= 50) {
    parts.push(CARRY);
    remaining -= 50;
  }

  // Add MOVE parts (1 per 2 other parts for road efficiency)
  const otherParts = parts.length;
  const movesNeeded = Math.ceil(otherParts / 2);
  while (remaining >= 50 && parts.filter((p) => p === MOVE).length < movesNeeded) {
    parts.push(MOVE);
    remaining -= 50;
  }

  return parts.length >= 3 ? parts : [WORK, CARRY, MOVE];
}

function buildHaulerBody(energy: number): BodyPartConstant[] {
  // All CARRY and MOVE, balanced
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  while (remaining >= 100 && parts.length < 32) {
    parts.push(CARRY);
    parts.push(MOVE);
    remaining -= 100;
  }

  return parts.length >= 2 ? parts : [CARRY, MOVE];
}

function buildUpgraderBody(energy: number): BodyPartConstant[] {
  // WORK heavy with some CARRY and MOVE
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  // Start with minimum
  if (remaining < 200) return [WORK, CARRY, MOVE];

  // Add WORK parts
  while (remaining >= 150 && parts.filter((p) => p === WORK).length < 15) {
    parts.push(WORK);
    remaining -= 100;

    // Add CARRY every 3 WORK
    if (parts.filter((p) => p === WORK).length % 3 === 0 && remaining >= 50) {
      parts.push(CARRY);
      remaining -= 50;
    }
  }

  // Add MOVE (1 per 2 other parts)
  const otherParts = parts.length;
  const movesNeeded = Math.ceil(otherParts / 2);
  while (remaining >= 50 && parts.filter((p) => p === MOVE).length < movesNeeded) {
    parts.push(MOVE);
    remaining -= 50;
  }

  return parts.length >= 3 ? parts : [WORK, CARRY, MOVE];
}

function buildBuilderBody(energy: number): BodyPartConstant[] {
  // Similar to upgrader but more balanced
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  if (remaining < 200) return [WORK, CARRY, MOVE];

  // Balanced WORK/CARRY/MOVE
  while (remaining >= 200 && parts.length < 30) {
    parts.push(WORK);
    parts.push(CARRY);
    parts.push(MOVE);
    remaining -= 200;
  }

  return parts.length >= 3 ? parts : [WORK, CARRY, MOVE];
}

function buildDefenderBody(energy: number): BodyPartConstant[] {
  // ATTACK and MOVE
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  // Add TOUGH for buffer
  while (remaining >= 60 && parts.filter((p) => p === TOUGH).length < 3) {
    parts.push(TOUGH);
    remaining -= 10;
  }

  // Add ATTACK and MOVE balanced
  while (remaining >= 130 && parts.length < 25) {
    parts.push(ATTACK);
    parts.push(MOVE);
    remaining -= 130;
  }

  return parts.length >= 3 ? parts : [ATTACK, MOVE, MOVE];
}

function buildRemoteMinerBody(energy: number): BodyPartConstant[] {
  // 5 WORK, 1 CARRY, 3 MOVE = 700 energy
  if (energy >= 700) {
    return [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE];
  } else if (energy >= 550) {
    return [WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE];
  } else if (energy >= 400) {
    return [WORK, WORK, WORK, CARRY, MOVE, MOVE];
  }
  return [WORK, WORK, CARRY, MOVE];
}

function buildRemoteHaulerBody(energy: number): BodyPartConstant[] {
  // All CARRY and MOVE, balanced for road travel
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  while (remaining >= 100 && parts.length < 32) {
    parts.push(CARRY);
    parts.push(MOVE);
    remaining -= 100;
  }

  return parts.length >= 4 ? parts : [CARRY, CARRY, MOVE, MOVE];
}

function buildRemoteDefenderBody(energy: number): BodyPartConstant[] {
  // 650 energy standard body
  if (energy >= 650) {
    return [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE];
  }
  return [TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE];
}

function buildReserverBody(energy: number): BodyPartConstant[] {
  // 2 CLAIM, 2 MOVE = 1300 energy
  if (energy >= 1300) {
    return [CLAIM, CLAIM, MOVE, MOVE];
  }
  // 1 CLAIM, 1 MOVE = 650 energy
  return [CLAIM, MOVE];
}

function buildLinkFillerBody(energy: number): BodyPartConstant[] {
  // Stationary creep: mostly CARRY with minimal MOVE
  // Bigger carry = fewer ticks to fill link (800 capacity)
  const parts: BodyPartConstant[] = [];
  let remaining = energy;

  // Add CARRY parts (max 6 = 300 capacity)
  while (remaining >= 100 && parts.filter((p) => p === CARRY).length < 6) {
    parts.push(CARRY);
    remaining -= 50;

    // Add 1 MOVE per 2 CARRY (just enough to reach parking spot)
    if (parts.filter((p) => p === CARRY).length % 2 === 0 && remaining >= 50) {
      parts.push(MOVE);
      remaining -= 50;
    }
  }

  return parts.length >= 3 ? parts : [CARRY, CARRY, MOVE];
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
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return false;

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms?.[roomName];

    // Need scout if no intel or intel is stale (> 5000 ticks)
    if (!intel || !intel.lastScan || Game.time - intel.lastScan > 5000) {
      return true;
    }
  }

  return false;
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

    // Check if reservation is missing or expiring
    // Account for staleness: ticksToEnd in memory was recorded at lastScan
    const reservation = intel.controller?.reservation;
    const elapsed = Game.time - (intel.lastScan || 0);
    const actualTicksToEnd = reservation ? reservation.ticksToEnd - elapsed : 0;
    const needsReservation =
      !reservation || actualTicksToEnd < 1000 || reservation.username !== myUsername;

    if (!needsReservation) continue;

    // Check if we already have a reserver for this room
    const hasReserver = Object.values(Game.creeps).some(
      (c) =>
        c.memory.role === "RESERVER" &&
        c.memory.room === state.room.name &&
        c.memory.targetRoom === roomName
    );

    if (!hasReserver) {
      return roomName;
    }
  }

  return null;
}
