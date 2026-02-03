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
import { getMilestones } from "../core/ColonyMilestones";
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
import { getBootstrapBuilderBody } from "../creeps/BootstrapBuilder";
import { getBootstrapHaulerBody } from "../creeps/BootstrapHauler";
import { getBootstrapWorkerBody } from "../creeps/BootstrapWorker";
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
  | "BOOTSTRAP_HAULER"
  | "BOOTSTRAP_WORKER";

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
  "BOOTSTRAP_WORKER",
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
    // Check for storage deadlock: harvesters exist but no haulers,
    // and spawn can't fill because energy goes to containers/storage.
    const noHaulers = (state.counts.HAULER || 0) === 0;
    const spawnStarved = room.energyAvailable < 200;
    const hasStoredEnergy = state.energyStored > 1000;

    if (noHaulers && spawnStarved && hasStoredEnergy) {
      // Deadlock: energy exists but can't reach spawn.
      // Bootstrap a hauler with available energy.
      const haulerCandidates = candidates.filter(
        (c) => c.role === "HAULER" && c.cost <= room.energyAvailable
      );
      if (haulerCandidates.length > 0) {
        return haulerCandidates[0];
      }
    }

    // Economy is working. Wait for energy to accumulate.
    return null;
  }

  // Economy is dead (no harvesters producing). Bootstrap with ECONOMY roles only.
  // Never waste energy on scouts/reservers/remote roles during bootstrap.
  const ECONOMY_ROLES: SpawnRole[] = ["HARVESTER", "HAULER", "BUILDER", "UPGRADER", "DEFENDER"];
  const economyCandidates = candidates.filter(
    (c) => c.cost <= room.energyAvailable && ECONOMY_ROLES.includes(c.role)
  );

  if (economyCandidates.length > 0) {
    return economyCandidates[0]; // Already sorted by utility desc
  }

  // No economy roles affordable. Don't waste energy on non-economy roles.
  // Wait for remote haulers to deliver more energy to spawn.
  return null;
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
      const intel = Memory.intel && Memory.intel[remoteName];
      if (intel && intel.lastScanned && Game.time - intel.lastScanned < 1000) {
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
 * Uses milestone-based logic for early colonies (RCL 1-3 without storage)
 */
function getCreepTargets(room: Room, totalSites: number): Record<string, number> {
  const rcl = room.controller?.level || 0;
  const sources = room.find(FIND_SOURCES).length;
  const remoteRooms = getRemoteMiningTargets(room.name);
  const m = getMilestones(room);

  // Early colony (RCL 1-3 without storage): milestone-driven targets
  const isEarlyColony = rcl <= 3 && !m.hasStorage;

  // Builder target calculation
  let builderTarget = 0;
  if (totalSites > 0) {
    if (isEarlyColony) {
      // Early game: always target 2 builders when sites exist
      builderTarget = 2;
    } else if (rcl <= 3) {
      builderTarget = Math.min(2, Math.max(2, Math.min(rcl, 4)));
    } else {
      // RCL 4+: scale by site count
      const maxBuildersByEconomy = Math.min(rcl, 4);
      builderTarget = Math.min(Math.ceil(totalSites / 10), maxBuildersByEconomy);
    }
  }

  // Hauler target: throughput-aware calculation
  // Early colony gate: no containers = haulers have nothing to pick up
  let haulerTarget = sources; // default fallback
  if (isEarlyColony && !m.hasSourceContainers) {
    haulerTarget = 0;
  } else {
    // Throughput-aware hauler target
    // Estimate hauler carry capacity from energy cap
    // Hauler body pattern: CARRY, CARRY, MOVE (150 per unit)
    const haulerUnitCost = BODYPART_COST[CARRY] * 2 + BODYPART_COST[MOVE]; // 150
    const haulerUnits = Math.floor(room.energyCapacityAvailable / haulerUnitCost);
    const estimatedCarry = Math.min(haulerUnits * 2, 32) * 50; // cap at 32 CARRY (50 body part limit with MOVE)

    if (estimatedCarry > 0) {
      // Estimate average haul distance from source containers to spawn
      const spawn = room.find(FIND_MY_SPAWNS)[0];
      const sourceContainers = room.find(FIND_STRUCTURES, {
        filter: function(s: AnyStructure) {
          return s.structureType === STRUCTURE_CONTAINER &&
            s.pos.findInRange(FIND_SOURCES, 1).length > 0;
        },
      }) as StructureContainer[];

      let avgDistance = 20; // conservative default
      if (spawn && sourceContainers.length > 0) {
        let totalDist = 0;
        for (const container of sourceContainers) {
          // Use linear distance as cheap estimate (actual path is longer)
          // Multiply by 1.3 to approximate pathing overhead
          const linear = spawn.pos.getRangeTo(container);
          totalDist += Math.ceil(linear * 1.3);
        }
        avgDistance = Math.ceil(totalDist / sourceContainers.length);
      }

      // Round trip + load/unload overhead
      const roundTrip = avgDistance * 2 + 4;
      // Throughput per hauler in energy/tick
      const haulerThroughput = estimatedCarry / roundTrip;
      // Total source output
      const totalSourceOutput = sources * 10;
      // Haulers needed to keep up
      haulerTarget = Math.max(sources, Math.ceil(totalSourceOutput / haulerThroughput));
    }
  }

  // Upgrader target: milestone-gated
  let upgraderTarget = 0;
  if (isEarlyColony) {
    if (!m.hasControllerContainer) {
      upgraderTarget = 0; // No controller container = upgraders ZZZ
    } else if (m.allExtensions) {
      upgraderTarget = Math.min(rcl, 3); // Infrastructure done, push RCL
    } else {
      upgraderTarget = 1; // Building extensions, limit upgraders
    }
  } else {
    // RCL 4+ or has storage: normal scaling
    upgraderTarget = rcl < 8 ? Math.min(rcl, 3) : 1;
  }

  const targets: Record<string, number> = {
    HARVESTER: sources,
    HAULER: haulerTarget,
    UPGRADER: upgraderTarget,
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
      const intel = Memory.intel && Memory.intel[roomName];
      remoteSources += (intel && intel.sources) ? intel.sources.length : 0;
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
    case "BOOTSTRAP_WORKER":
      return bootstrapWorkerUtility(state);
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
 *
 * RCL 1-3 override: Upgraders are suppressed until economy is stable
 */
function upgraderUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  const controller = state.room.controller;

  // === RCL 1-3 YOUNG COLONY GATE ===
  // Upgraders are a luxury - only spawn if economy is truly stable
  if (state.rcl <= 3) {
    // Emergency upgrade: controller about to downgrade
    if (controller && controller.ticksToDowngrade && controller.ticksToDowngrade < 5000) {
      // Allow emergency upgrader with utility 80
      return 80;
    }

    // Gate: need at least 1 harvester per source
    var harvesters = state.counts.HARVESTER || 0;
    var sources = state.room.find(FIND_SOURCES).length;
    if (harvesters < sources) {
      return 0; // Economy not running - no upgraders
    }

    // Gate: need at least 1 hauler
    if ((state.counts.HAULER || 0) === 0) {
      return 0; // Can't move energy - no upgraders
    }

    // Gate: economy must be positive (more income than consumption)
    // At young colonies, income should exceed current creep consumption
    if (state.energyIncome < 4) {
      return 0; // Not enough income to sustain upgrading
    }

    // Gate: must have energy at controller OR spawn energy is consistently available
    var hasContainer = false;
    if (controller) {
      var nearby = controller.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; }
      });
      hasContainer = nearby.length > 0 && (nearby[0] as StructureContainer).store[RESOURCE_ENERGY] > 100;
    }
    var spawnHealthy = state.energyAvailable >= state.energyCapacity * 0.8;

    if (!hasContainer && !spawnHealthy) {
      return 0; // No energy delivery system to controller
    }

    // Young colony upgrader: low utility, max 1
    return (state.counts.UPGRADER || 0) === 0 ? 30 : 0;
  }

  // Gate: Don't spawn upgraders if no energy is reachable at controller
  if (controller) {
    const controllerContainer = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    })[0] as StructureContainer | undefined;

    const controllerLink = controller.pos.findInRange(FIND_MY_STRUCTURES, 3, {
      filter: (s) => s.structureType === STRUCTURE_LINK,
    })[0] as StructureLink | undefined;

    const storage = state.room.storage;

    const hasEnergyAtController =
      (controllerContainer && controllerContainer.store[RESOURCE_ENERGY] > 0) ||
      (controllerLink && controllerLink.store[RESOURCE_ENERGY] > 0) ||
      (storage && storage.store[RESOURCE_ENERGY] > 1000);

    if (!hasEnergyAtController) {
      return 0; // No point spawning upgrader with no energy to use
    }
  }

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
 *
 * RCL 1-3 override: Builders only spawn when economy can support them
 */
function builderUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;

  // Use pre-calculated site count from state (includes home + remote + assumed)
  const totalSites = state.constructionSites;
  if (totalSites === 0) return 0;

  // === RCL 1-3 YOUNG COLONY GATE ===
  if (state.rcl <= 3) {
    // Gate: need at least 1 harvester
    if ((state.counts.HARVESTER || 0) === 0) {
      return 0; // No income - no building
    }

    // Gate: need at least 1 hauler
    if ((state.counts.HAULER || 0) === 0) {
      return 0; // Can't move energy - no building
    }

    // Gate: must have some energy income
    if (state.energyIncome < 4) {
      return 0; // Not enough income
    }

    // Young colony builder: moderate utility, max 1-2
    var currentBuilders = state.counts.BUILDER || 0;
    if (currentBuilders >= 2) return 0;

    // First builder gets utility 50, second gets 25
    return currentBuilders === 0 ? 50 : 25;
  }

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
 *
 * RCL 1-3: max 1 defender
 * RCL 4-5: max 2 defenders
 * RCL 6+: no cap (towers handle most threats)
 */
function defenderUtility(_deficit: number, state: ColonyState): number {
  // No threat = no utility, regardless of deficit
  if (state.homeThreats === 0) return 0;

  const current = state.counts.DEFENDER || 0;

  // Cap defenders based on RCL
  if (state.rcl <= 3 && current >= 1) return 0;
  if (state.rcl <= 5 && current >= 2) return 0;

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
    const intel = Memory.intel && Memory.intel[roomName];

    // Skip rooms with hostiles - haulers would just flee
    if (intel && intel.hostiles && intel.hostiles > 0) continue;

    // Count active miners in this room (including spawning)
    const roomMiners = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_MINER" &&
        c.memory.targetRoom === roomName &&
        (!c.ticksToLive || c.ticksToLive > 50)
    ).length;

    if (roomMiners === 0) continue;
    totalActiveMiners += roomMiners;

    // Count haulers assigned to this room (including spawning)
    const roomHaulers = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "REMOTE_HAULER" &&
        c.memory.targetRoom === roomName &&
        (!c.ticksToLive || c.ticksToLive > 100)
    ).length;

    if (roomHaulers === 0) {
      roomsWithMinersNoHaulers++;
    }
  }

  if (totalActiveMiners === 0) return 0;

  // Count all existing remote haulers for this colony (including spawning)
  const existingHaulers = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "REMOTE_HAULER" &&
      c.memory.room === state.room.name &&
      (!c.ticksToLive || c.ticksToLive > 100)
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
 * based on Memory.intel[roomName].hostiles. Utility 65 ensures defenders
 * spawn before reservers (25) but after critical economy roles.
 */
function remoteDefenderUtility(state: ColonyState): number {
  if (state.rcl < 4) return 0;

  const SCAN_AGE_THRESHOLD = 200; // Consider scans stale after 200 ticks

  // Check for threats in remote rooms
  let threatenedRooms = 0;
  for (const remoteName of state.remoteRooms) {
    const intel = Memory.intel && Memory.intel[remoteName];
    if (!intel) continue;

    // Check scan age - don't spawn defenders for stale intel
    const scanAge = Game.time - (intel.lastScanned || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) continue;

    // Check for hostiles
    const hostileCount = intel.hostiles || 0;
    if (hostileCount === 0) continue;

    // Check for dangerous hostiles (with attack parts)
    const hostileDetails = (intel as any).hostileDetails;
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

  // Count existing defenders (including spawning)
  // !c.ticksToLive catches spawning creeps (TTL undefined = still building)
  const existingDefenders = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === "REMOTE_DEFENDER" &&
      c.memory.room === state.room.name &&
      (!c.ticksToLive || c.ticksToLive > 100)
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
 * A lapsed reservation halves source output (3000→1500 per cycle).
 * Their utility shouldn't be suppressed by home incomeRatio (which is based on
 * HOME income, not remote).
 *
 * Fixed utility 45 when needed — above remote miners (40), below remote haulers first (55)
 */
function reserverUtility(_deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (state.remoteRooms.length === 0) return 0;

  // Check if any remote room needs reservation
  let needsReservation = false;
  const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

  for (const roomName of state.remoteRooms) {
    // Need reserver if: no reservation, or reservation < 2000 ticks
    // 2000 tick buffer allows for spawn time + travel time
    const remoteRoom = Game.rooms[roomName];
    const reservation = remoteRoom?.controller?.reservation;
    if (!reservation || reservation.ticksToEnd < 2000 || reservation.username !== myUsername) {
      // Only if we have miners there (worth protecting) - including spawning
      const hasMiners = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "REMOTE_MINER" &&
          c.memory.targetRoom === roomName &&
          (!c.ticksToLive || c.ticksToLive > 100)
      );
      if (hasMiners) {
        // Check if we already have a reserver assigned (including spawning)
        // !c.ticksToLive catches spawning creeps (TTL undefined = still building = healthy)
        // c.ticksToLive > 200 catches live creeps with enough life left
        const hasReserver = Object.values(Game.creeps).some(
          (c) =>
            c.memory.role === "RESERVER" &&
            c.memory.targetRoom === roomName &&
            (!c.ticksToLive || c.ticksToLive > 200)
        );
        if (!hasReserver) {
          needsReservation = true;
          break;
        }
      }
    }
  }

  if (!needsReservation) return 0;

  // Utility 45 — above remote miners (40), below remote haulers first (55)
  // Reservation protects remote income directly
  return 45;
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
 * Claimer utility - spawns when ExpansionManager needs a claimer
 */
function claimerUtility(state: ColonyState): number {
  // Check GCL - can we claim another room?
  var currentRooms = Object.keys(Game.rooms).filter(function(r) {
    var room = Game.rooms[r];
    return room.controller && room.controller.my;
  }).length;
  if (currentRooms >= Game.gcl.level) return 0;

  // Check ExpansionManager for claiming needs
  var empExpansion = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
  if (!empExpansion) return 0;

  var empActive = empExpansion.active || {};
  var claimingExpansion = null;
  var keys = Object.keys(empActive);
  for (var i = 0; i < keys.length; i++) {
    var e = empActive[keys[i]];
    if (e.parentRoom === state.room.name && e.state === "CLAIMING" && !e.claimer) {
      claimingExpansion = e;
      break;
    }
  }

  if (!claimingExpansion) return 0;

  // Check if already have a claimer for this target
  var existingClaimers = Object.values(Game.creeps).filter(function(c) {
    return c.memory.role === "CLAIMER" && c.memory.targetRoom === claimingExpansion!.roomName;
  }).length;
  if (existingClaimers > 0) return 0;

  return 40;
}

/**
 * Bootstrap builder utility - spawns when ExpansionManager needs builders
 * Only spawns from the parent room of an active bootstrap operation
 */
function bootstrapBuilderUtility(state: ColonyState): number {
  var expansionManager = new ExpansionManager();
  var needs = expansionManager.getSpawnRequests(state.room.name);
  var builderNeeds = needs.filter(function(n) { return n.role === "BOOTSTRAP_BUILDER"; });

  if (builderNeeds.length === 0) return 0;

  // High priority - getting spawn built is critical
  return 80;
}

/**
 * Bootstrap hauler utility - spawns when ExpansionManager needs haulers
 * Only spawns from the parent room of an active bootstrap operation
 */
function bootstrapHaulerUtility(state: ColonyState): number {
  var expansionManager = new ExpansionManager();
  var needs = expansionManager.getSpawnRequests(state.room.name);
  var haulerNeeds = needs.filter(function(n) { return n.role === "BOOTSTRAP_HAULER"; });

  if (haulerNeeds.length === 0) return 0;

  // High priority - energy delivery is critical for spawn construction
  return 75;
}

/**
 * Bootstrap worker utility - spawns when a colony needs emergency help
 * Triggers when:
 * - Colony has spawn but < 3 creeps with WORK parts
 * - Colony has no energy income (no miners/harvesters active)
 * - Controller ticksToDowngrade < 10000
 */
function bootstrapWorkerUtility(state: ColonyState): number {
  // Check for colonies needing help
  var empExpansion = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
  if (!empExpansion) return 0;

  var empActive = empExpansion.active || {};
  var activeKeys = Object.keys(empActive);

  for (var i = 0; i < activeKeys.length; i++) {
    var expansion = empActive[activeKeys[i]];
    if (expansion.parentRoom !== state.room.name) continue;

    // Check if this expansion needs bootstrap workers
    var targetRoom = Game.rooms[expansion.roomName];
    if (!targetRoom) continue;

    var spawns = targetRoom.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue; // No spawn yet, use builder/hauler

    // Count WORK parts in target room
    var workParts = 0;
    var targetCreeps = targetRoom.find(FIND_MY_CREEPS);
    for (var j = 0; j < targetCreeps.length; j++) {
      workParts += targetCreeps[j].getActiveBodyparts(WORK);
    }

    // Count existing bootstrap workers heading to this room
    var existingWorkers = Object.values(Game.creeps).filter(function(c) {
      return c.memory.role === "BOOTSTRAP_WORKER" &&
        (c.memory as any).targetRoom === expansion.roomName;
    }).length;

    // Need workers if: < 3 WORK parts and < 4 workers assigned
    var needsWorkers = workParts < 3 && existingWorkers < 4;

    // Also check controller emergency
    var controller = targetRoom.controller;
    if (controller && controller.my && controller.ticksToDowngrade && controller.ticksToDowngrade < 10000) {
      needsWorkers = true;
    }

    if (needsWorkers) {
      // High priority - colony survival
      return 60;
    }
  }

  return 0;
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
  if (role === "BOOTSTRAP_WORKER") {
    return getBootstrapWorkerBody(energy);
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
      // Use spawn request memory from ExpansionManager to get selfHarvest flag
      var expansionManager = new ExpansionManager();
      var builderRequests = expansionManager
        .getSpawnRequests(state.room.name)
        .filter(function(r) { return r.role === "BOOTSTRAP_BUILDER"; });
      if (builderRequests.length > 0) {
        // Use memory from first request - includes selfHarvest flag
        var req = builderRequests[0];
        return {
          ...base,
          ...req.memory,
          bootstrapState: "TRAVELING_TO_TARGET",
        } as unknown as Partial<CreepMemory>;
      }
      return base;
    }

    case "BOOTSTRAP_HAULER": {
      // Find expansion from this parent room
      var empExpansion = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
      var empActive = empExpansion ? empExpansion.active : {};
      var expansion = null;
      var activeKeys = Object.keys(empActive);
      for (var i = 0; i < activeKeys.length; i++) {
        var e = empActive[activeKeys[i]];
        if (e.parentRoom === state.room.name) {
          expansion = e;
          break;
        }
      }
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
      // Find claiming-state expansion from this room
      var empExpansion2 = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
      var empActive2 = empExpansion2 ? empExpansion2.active : {};
      var claimTarget = null;
      var activeKeys2 = Object.keys(empActive2);
      for (var j = 0; j < activeKeys2.length; j++) {
        var exp = empActive2[activeKeys2[j]];
        if (exp.parentRoom === state.room.name && exp.state === "CLAIMING") {
          claimTarget = exp;
          break;
        }
      }
      if (claimTarget) {
        return {
          ...base,
          targetRoom: claimTarget.roomName,
        };
      }
      return base;
    }

    case "BOOTSTRAP_WORKER": {
      // Find expansion needing bootstrap workers
      var empExpansion3 = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
      var empActive3 = empExpansion3 ? empExpansion3.active : {};
      var workerTarget = null;
      var activeKeys3 = Object.keys(empActive3);
      for (var k = 0; k < activeKeys3.length; k++) {
        var exp3 = empActive3[activeKeys3[k]];
        if (exp3.parentRoom === state.room.name) {
          // Check if this expansion needs workers
          var targetRoom = Game.rooms[exp3.roomName];
          if (targetRoom) {
            var spawns = targetRoom.find(FIND_MY_SPAWNS);
            if (spawns.length > 0) {
              workerTarget = exp3;
              break;
            }
          }
        }
      }
      if (workerTarget) {
        return {
          ...base,
          role: "BOOTSTRAP_WORKER",
          parentRoom: workerTarget.parentRoom,
          targetRoom: workerTarget.roomName,
          state: "MOVING",
        } as unknown as Partial<CreepMemory>;
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
  // Read from colony registry — single source of truth
  if (Memory.colonies && Memory.colonies[homeRoom]) {
    return Memory.colonies[homeRoom].remoteRooms;
  }

  // Fallback: derive from exits + intel (pre-initialization or missing colony)
  const exits = Game.map.describeExits(homeRoom);
  if (!exits) return [];

  const intel = Memory.intel || {};
  const firstSpawn = Object.values(Game.spawns)[0];
  const myUsername = firstSpawn && firstSpawn.owner
    ? firstSpawn.owner.username
    : "";
  const targets: string[] = [];

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const ri = intel[roomName];
    if (!ri || !ri.lastScanned) continue;

    if (!ri.sources || ri.sources.length === 0) continue;
    if (ri.roomType === "sourceKeeper") continue;
    if (ri.owner && ri.owner !== myUsername) continue;
    if (ri.reservation && ri.reservation.username !== myUsername) continue;

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
    const intel = Memory.intel && Memory.intel[roomName];
    if (intel && intel.roomType === "sourceKeeper") continue;

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
    const intel = Memory.intel && Memory.intel[roomName];
    if (!intel || !intel.sources) continue;

    // Memory.intel sources are {id, pos} objects
    for (const source of intel.sources) {
      const sourceId = source.id;
      // Check if this source has a miner
      const hasMiner = Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === "REMOTE_MINER" &&
          c.memory.room === state.room.name &&
          c.memory.sourceId === sourceId
      );

      if (!hasMiner) {
        return { roomName, sourceId: sourceId };
      }
    }
  }

  return null;
}

function findUnminedSource(state: ColonyState, roomName: string): string | null {
  const intel = Memory.intel && Memory.intel[roomName];
  if (!intel || !intel.sources) return null;

  // Memory.intel sources are {id, pos} objects
  for (const source of intel.sources) {
    const sourceId = source.id;
    const hasMiner = Object.values(Game.creeps).some(
      (c) =>
        c.memory.role === "REMOTE_MINER" &&
        c.memory.room === state.room.name &&
        c.memory.sourceId === sourceId
    );

    if (!hasMiner) {
      return sourceId;
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
    const intel = Memory.intel && Memory.intel[need.roomName];

    // Validate room still has active threats (not stale intel)
    if (!intel) continue;
    const scanAge = Game.time - (intel.lastScanned || 0);
    if (scanAge > SCAN_AGE_THRESHOLD) continue;
    if ((intel.hostiles || 0) === 0) {
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
  const firstSpawn = Object.values(Game.spawns)[0];
  const myUsername = firstSpawn && firstSpawn.owner ? firstSpawn.owner.username : null;

  for (const roomName of state.remoteRooms) {
    const intel = Memory.intel && Memory.intel[roomName];
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

    // Has reserver - check if we need a replacement (TTL < 200 for spawn + travel time)
    const reserverDying = existingReserver.ticksToLive && existingReserver.ticksToLive < 200;
    if (!reserverDying) continue;

    // Reserver dying soon - check if reservation needs maintenance
    const reservation = intel.reservation;
    const elapsed = Game.time - (intel.lastScanned || 0);
    const actualTicksToEnd = reservation ? reservation.ticksToEnd - elapsed : 0;
    const needsReservation =
      !reservation || actualTicksToEnd < 2000 || reservation.username !== myUsername;

    if (needsReservation) {
      return roomName;
    }
  }

  return null;
}
