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
import { ColonyManager } from "../core/ColonyManager";
import { buildBody as buildBodyFromConfig, ROLE_MIN_COST } from "./bodyBuilder";
import { CONFIG } from "../config";
import { combineUtilities } from "../utils/smoothing";
import {
  getEnergyState,
  storageUtility,
  sustainabilityUtility,
  rateUtility,
} from "./utilities/energyUtility";
import { roleCountUtility, getEffectiveCount, getCreepEffectiveness } from "./utilities/populationUtility";
import { getPioneerBody } from "../creeps/Pioneer";
import { ExpansionManager } from "../empire";

// TTL thresholds for proactive replacement spawning
const DYING_SOON_LOCAL = CONFIG.SPAWNING.REPLACEMENT_TTL;
const DYING_SOON_REMOTE = CONFIG.SPAWNING.REMOTE_REPLACEMENT_TTL;

/**
 * Detect if a colony is in "pioneer phase"
 * Pioneer phase = RCL 1, no source containers, no storage
 *
 * Exit pioneer phase when:
 * - Has storage (mature colony)
 * - Has source containers (infrastructure built)
 * - RCL >= 2 (prevents deadlock where pioneers max out before containers)
 */
function isPioneerPhase(room: Room): boolean {
  // Has storage = not pioneer phase
  if (room.storage) return false;

  // Not pioneer phase if no spawn (pre-expansion)
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) return false;

  // Exit pioneer phase at RCL 2+ regardless of containers
  // This prevents deadlock where 4 pioneers exist but can't build containers fast enough
  var rcl = room.controller ? room.controller.level : 0;
  if (rcl >= 2) return false;

  // Check for source containers
  var sourceContainers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        s.pos.findInRange(FIND_SOURCES, 1).length > 0;
    }
  });

  // Pioneer phase only at RCL 1 with no source containers
  return sourceContainers.length === 0;
}

/**
 * Energy budget for young colonies (RCL 1-3 without storage)
 *
 * These colonies have no buffer - they can only sustain creeps if
 * income >= burn. Spawning more consumers than income supports = death spiral.
 *
 * Returns income, existing burn, and a function to check if additional burn is sustainable.
 */
interface EnergyBudget {
  income: number;           // energy/tick from harvesters
  existingBurn: number;     // energy/tick consumed by existing builders+upgraders
  availableBudget: number;  // income - existingBurn
  canSustain: (additionalBurn: number) => boolean;
}

function getEnergyBudget(state: ColonyState): EnergyBudget {
  // Income is already calculated in state
  var income = state.energyIncome;

  // Count existing consumers (builders + upgraders) and estimate their burn rate
  var creeps = Object.values(Game.creeps).filter(function(c) {
    return c.memory.room === state.room.name;
  });

  var existingBurn = 0;
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    var role = c.memory.role;
    var workParts = c.getActiveBodyparts(WORK);

    if (role === "BUILDER") {
      // Builders burn 5 energy per WORK per tick when building
      // Estimate 50% uptime (walking, waiting for energy)
      existingBurn += workParts * 5 * 0.5;
    } else if (role === "UPGRADER") {
      // Upgraders burn 1 energy per WORK per tick
      // Estimate 80% uptime (mostly stationary at controller)
      existingBurn += workParts * 1 * 0.8;
    } else if (role === "PIONEER") {
      // Pioneers split time between tasks. Estimate:
      // 40% harvesting (0 burn), 30% building (5/work), 30% upgrading (1/work)
      existingBurn += workParts * (0.3 * 5 + 0.3 * 1);
    }
  }

  var availableBudget = income - existingBurn;

  return {
    income: income,
    existingBurn: existingBurn,
    availableBudget: availableBudget,
    canSustain: function(additionalBurn: number): boolean {
      // Allow some slack (10%) because estimates are imprecise
      return (existingBurn + additionalBurn) <= income * 1.1;
    }
  };
}

// All roles that can be spawned
type SpawnRole =
  | "HARVESTER"
  | "HAULER"
  | "UPGRADER"
  | "BUILDER"
  | "DEFENDER"
  | "REMOTE_MINER"
  | "REMOTE_HAULER"
  | "REMOTE_BUILDER"
  | "REMOTE_DEFENDER"
  | "RESERVER"
  | "SCOUT"
  | "LINK_FILLER"
  | "MINERAL_HARVESTER"
  | "CLAIMER"
  | "PIONEER";

const ALL_ROLES: SpawnRole[] = [
  "PIONEER",
  "HARVESTER",
  "HAULER",
  "UPGRADER",
  "BUILDER",
  "DEFENDER",
  "REMOTE_MINER",
  "REMOTE_HAULER",
  "REMOTE_BUILDER",
  "REMOTE_DEFENDER",
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
      "REMOTE_BUILDER",
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

  // ENERGY RESERVATION: Prevent spending energy that would make harvester replacement impossible.
  // If we're about to spawn a non-harvester/non-pioneer role and it would leave us unable to
  // afford a minimum harvester, skip it — UNLESS we already have 2+ healthy harvesters.
  var harvesterCount = state.counts.HARVESTER || 0;
  var pioneerCount = state.counts.PIONEER || 0;
  var hasSpawningHarvester = room.find(FIND_MY_SPAWNS).some(function(s) {
    if (!s.spawning) return false;
    var spawningCreep = Game.creeps[s.spawning.name];
    return spawningCreep && (spawningCreep.memory.role === 'HARVESTER' || spawningCreep.memory.role === 'PIONEER');
  });

  if (best.role !== 'HARVESTER' && best.role !== 'PIONEER') {
    var minHarvesterCost = ROLE_MIN_COST['HARVESTER'] || 200;
    var energyAfterSpawn = room.energyAvailable - best.cost;
    var harvestersSafe = harvesterCount >= 2 || pioneerCount >= 2 || hasSpawningHarvester;

    if (!harvestersSafe && energyAfterSpawn < minHarvesterCost && harvesterCount <= 1) {
      // Spending this energy would make harvester replacement impossible.
      // Check if there's a cheaper economy role we can afford while preserving the reserve.
      var safeCandidate: SpawnCandidate | null = null;
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (c.role === 'HARVESTER' || c.role === 'PIONEER') continue; // handled by normal flow
        if (c.cost <= room.energyAvailable && (room.energyAvailable - c.cost) >= minHarvesterCost) {
          safeCandidate = c;
          break;
        }
      }
      if (safeCandidate) {
        // Found a role we can spawn while keeping reserve
        if (safeCandidate.cost <= room.energyAvailable) {
          return safeCandidate;
        }
      }
      // No safe candidate — don't spend the reserve. Wait.
      // Exception: if best IS affordable and is an economy role, allow it
      // (better to have a hauler than sit with idle energy when harvester exists)
      if (harvesterCount >= 1 && best.cost <= room.energyAvailable) {
        var SAFE_ECONOMY: SpawnRole[] = ['HAULER', 'BUILDER', 'UPGRADER', 'DEFENDER'];
        if (SAFE_ECONOMY.indexOf(best.role) === -1) {
          return null; // Don't spend on non-economy roles
        }
        // Allow economy roles if at least 1 harvester exists
        // (the reserve is mainly to prevent 0-harvester deadlock)
      } else if (harvesterCount === 0) {
        // 0 harvesters — absolutely do not spend energy on anything else
        return null;
      }
    }
  }

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
  const ECONOMY_ROLES: SpawnRole[] = ["PIONEER", "HARVESTER", "HAULER", "BUILDER", "UPGRADER", "DEFENDER"];
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
 * Count creeps that can actually perform their role.
 * Uses fractional counting based on damage - a hauler with 8/16 CARRY counts as 0.5.
 * This prevents the spawner from thinking "we have 1 hauler" when that hauler is damaged.
 */
function getEffectiveCounts(creeps: Creep[], room: Room): Record<string, number> {
  var counts: Record<string, number> = {};

  // Check if source containers exist (harvesters without CARRY are OK if containers catch energy)
  var sourceContainers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        s.pos.findInRange(FIND_SOURCES, 1).length > 0;
    }
  });
  var hasSourceContainers = sourceContainers.length > 0;

  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    var role = c.memory.role;
    var functional = true;

    // First check if creep is completely non-functional (0 key parts)
    switch (role) {
      case "HARVESTER":
        // Must have WORK parts to harvest
        if (c.getActiveBodyparts(WORK) === 0) { functional = false; break; }
        // Must have CARRY OR source containers must exist to catch dropped energy
        if (c.getActiveBodyparts(CARRY) === 0 && !hasSourceContainers) { functional = false; }
        break;

      case "HAULER":
      case "REMOTE_HAULER":
        // Must have CARRY to transport anything
        if (c.getActiveBodyparts(CARRY) === 0) functional = false;
        break;

      case "UPGRADER":
      case "BUILDER":
        // Must have WORK to do anything useful
        if (c.getActiveBodyparts(WORK) === 0) functional = false;
        break;

      case "PIONEER":
        // Must have WORK to harvest/build/upgrade AND CARRY to deliver
        if (c.getActiveBodyparts(WORK) === 0) { functional = false; break; }
        if (c.getActiveBodyparts(CARRY) === 0) functional = false;
        break;

      case "REMOTE_MINER":
        // Must have WORK to harvest
        if (c.getActiveBodyparts(WORK) === 0) functional = false;
        break;

      case "REMOTE_DEFENDER":
      case "DEFENDER":
        // Must have at least one attack-type part
        if (c.getActiveBodyparts(ATTACK) === 0 &&
            c.getActiveBodyparts(RANGED_ATTACK) === 0) functional = false;
        break;

      case "RESERVER":
      case "CLAIMER":
        // Must have CLAIM
        if (c.getActiveBodyparts(CLAIM) === 0) functional = false;
        break;

      // SCOUT, LINK_FILLER, MINERAL_HARVESTER: just needs to be alive
      default:
        break;
    }

    if (functional) {
      // Count as fractional based on damage to key body parts
      var effectiveness = getCreepEffectiveness(c);
      counts[role] = (counts[role] || 0) + effectiveness;
    }
  }

  return counts;
}

/**
 * Gather all metrics needed for utility calculations
 */
function getColonyState(room: Room): ColonyState {
  const sources = room.find(FIND_SOURCES);
  const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === room.name);

  // Check if source containers exist (affects harvester functionality)
  var sourceContainers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        s.pos.findInRange(FIND_SOURCES, 1).length > 0;
    }
  });
  var hasSourceContainers = sourceContainers.length > 0;

  // Calculate actual energy income from FUNCTIONAL harvesters only
  // A harvester with 0 CARRY and no source containers contributes 0 income
  let energyIncome = 0;
  for (const c of creeps) {
    if (c.memory.role === "HARVESTER") {
      const workParts = c.getActiveBodyparts(WORK);
      const carryParts = c.getActiveBodyparts(CARRY);
      // Only count income if energy can actually enter the economy
      if (workParts > 0 && (carryParts > 0 || hasSourceContainers)) {
        energyIncome += workParts * 2;
      }
    }
  }

  const energyIncomeMax = sources.length * 10; // 5 WORK per source max

  // Count FUNCTIONAL creeps by role (not just alive creeps)
  // A hauler with 0 CARRY doesn't count as a hauler
  const counts = getEffectiveCounts(creeps, room);

  // Track dying soon separately (still uses raw role, for replacement timing)
  const dyingSoon: Record<string, number> = {};

  // Roles that autonomously renew - never count as dying soon
  const selfRenewingRoles = new Set([
    "HARVESTER",
    "LINK_FILLER",
    "REMOTE_DEFENDER",
  ]);

  for (const c of creeps) {
    const role = c.memory.role;

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
  const m = getMilestones(room);

  // Early colony (RCL 1-3 without storage): milestone-driven targets
  const isEarlyColony = rcl <= 3 && !m.hasStorage;

  // Builder target calculation
  // For early colonies, scale target based on estimated income
  // A builder burns ~2.5 energy/tick (1 WORK at 50% uptime building)
  let builderTarget = 0;
  if (totalSites > 0) {
    if (isEarlyColony) {
      // Estimate income from harvesters (may not be in ColonyState here)
      // Use sources * 6 as rough estimate (3 WORK parts per source typical)
      const estimatedIncome = sources * 6;
      // Each builder burns ~2.5 energy/tick, leave 50% for haulers/upgraders
      const maxBuildersForIncome = Math.floor((estimatedIncome * 0.5) / 2.5);
      // Target 1-2 builders based on income
      builderTarget = Math.min(2, Math.max(1, maxBuildersForIncome));
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

      // Total source output: use ACTUAL income for early colonies, max for mature
      // Young colonies may not have full harvesters yet
      let totalSourceOutput = sources * 10; // theoretical max
      if (isEarlyColony) {
        // Estimate actual income from harvesters (sources * 6 = 3 WORK per source typical)
        // Cap at actual output, not theoretical
        const estimatedActualIncome = sources * 6;
        totalSourceOutput = Math.min(totalSourceOutput, estimatedActualIncome);
      }

      // Haulers needed to keep up
      haulerTarget = Math.max(1, Math.ceil(totalSourceOutput / haulerThroughput));
    }
  }

  // Minimum 2 haulers for colonies with infrastructure
  // Single hauler is SPOF — death or damage cascades into tower starvation
  var hasLinks = room.find(FIND_MY_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_LINK; }
  }).length > 0;
  if (m.hasStorage || hasLinks) {
    haulerTarget = Math.max(haulerTarget, 2);
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

  // Pioneer target: only during pioneer phase
  var pioneerTarget = 0;
  if (isPioneerPhase(room)) {
    pioneerTarget = sources + 1; // 1 per source + 1 extra for overlap
  }

  const targets: Record<string, number> = {
    PIONEER: pioneerTarget,
    HARVESTER: sources,
    HAULER: haulerTarget,
    UPGRADER: upgraderTarget,
    BUILDER: builderTarget,
    DEFENDER: 0, // Dynamic based on threats
    REMOTE_MINER: 0,
    REMOTE_HAULER: 0,
    REMOTE_BUILDER: 0,
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
    // Use new remote config format for distance-aware calculations
    var manager = ColonyManager.getInstance(room.name);
    var remoteConfigs = manager.getRemoteConfigs();
    var remoteSources = 0;
    var remoteHaulers = 0;
    var activeRemotes = 0;

    for (var remoteName in remoteConfigs) {
      var config = remoteConfigs[remoteName];
      if (!config.active) continue;

      activeRemotes++;
      remoteSources += config.sources || 2;

      // Distance-aware hauler calculation
      // Distance 1: ~50 tiles round trip, 2 haulers per remote
      // Distance 2: ~100 tiles round trip, 3 haulers per remote
      var haulersForRemote = config.distance >= 2 ? 3 : 2;
      remoteHaulers += haulersForRemote;
    }

    targets.REMOTE_MINER = remoteSources;
    targets.REMOTE_HAULER = remoteHaulers;
    targets.RESERVER = activeRemotes;
    targets.SCOUT = needsScout(room.name) ? 1 : 0;

    // Remote builder target: only spawn when remote rooms have construction sites
    targets.REMOTE_BUILDER = getRemoteBuilderTarget(room, remoteConfigs);
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
    case "PIONEER":
      return pioneerUtility(state);
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
    case "REMOTE_BUILDER":
      return remoteBuilderUtility(effectiveDeficit, state);
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
 *
 * GATED during pioneer phase - pioneers handle harvesting
 */
function harvesterUtility(deficit: number, state: ColonyState): number {
  // Pioneer phase: pioneers harvest, not specialists
  if (isPioneerPhase(state.room)) return 0;

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
 *
 * GATED during pioneer phase - pioneers handle hauling
 */
function haulerUtility(deficit: number, state: ColonyState): number {
  // Pioneer phase: pioneers haul, not specialists
  if (isPioneerPhase(state.room)) return 0;

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
 * GATED during pioneer phase - pioneers handle upgrading
 *
 * For young colonies (RCL 1-3 without storage):
 * - Budget-aware: won't spawn if income can't sustain additional burn
 * - Infrastructure (builders) takes priority over upgrading
 */
function upgraderUtility(deficit: number, state: ColonyState): number {
  // Pioneer phase: pioneers upgrade, not specialists
  if (isPioneerPhase(state.room)) return 0;

  if (deficit <= 0) return 0;

  const controller = state.room.controller;

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

  const hasStorage = !!state.room.storage;
  const energy = getEnergyState(state.room);

  // Young colony budget check (RCL 1-3 without storage)
  // Prevent spawning upgraders that income can't sustain
  if (!hasStorage && state.rcl <= 3) {
    const budget = getEnergyBudget(state);
    const existingUpgraders = state.counts.UPGRADER || 0;

    // REACTIVE: If economy is already in deficit, limit to 1 upgrader
    // (to prevent controller downgrade, but don't add to the problem)
    if (budget.availableBudget < 0 && energy.stored < 5000) {
      if (existingUpgraders >= 1) {
        return 0; // Already have 1 upgrader, don't spawn more during deficit
      }
      // Allow spawning 1 upgrader with low priority to prevent downgrade
      return 5;
    }

    // PROACTIVE: Check if a new upgrader would push us into deficit
    // Upgrader burns 1 energy/WORK/tick at 80% uptime = 0.8 energy/tick
    const estimatedBurn = 0.8;
    if (!budget.canSustain(estimatedBurn)) {
      return 0; // Can't afford another upgrader
    }
  }

  const base = CONFIG.SPAWNING.BASE_UTILITY.UPGRADER;

  // Factor 1: Storage level
  // Young colonies (no storage) get a fixed baseline — they MUST upgrade to progress
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
 * GATED during pioneer phase - pioneers handle building
 *
 * For young colonies (RCL 1-3 without storage):
 * - Budget-aware: won't spawn if income can't sustain additional burn
 * - Prioritizes infrastructure (containers, extensions) over general building
 */
function builderUtility(deficit: number, state: ColonyState): number {
  // Pioneer phase: pioneers build, not specialists
  if (isPioneerPhase(state.room)) return 0;

  if (deficit <= 0) return 0;

  // Use pre-calculated site count from state (includes home + remote + assumed)
  const totalSites = state.constructionSites;
  if (totalSites === 0) return 0;

  const base = CONFIG.SPAWNING.BASE_UTILITY.BUILDER;
  const energy = getEnergyState(state.room);
  const hasStorage = !!state.room.storage;

  // Young colony budget check (RCL 1-3 without storage)
  // Prevent spawning builders that income can't sustain
  if (!hasStorage && state.rcl <= 3) {
    const budget = getEnergyBudget(state);

    // REACTIVE: If economy is already in deficit, suppress builder spawning entirely
    // This catches cases where existing builders are burning more than income
    if (budget.availableBudget < 0 && energy.stored < 5000) {
      return 0; // Economy is hemorrhaging, don't spawn more consumers
    }

    // PROACTIVE: Check if a new builder would push us into deficit
    // Builder burns 5 energy/WORK/tick at 50% uptime = 2.5 energy/tick
    const estimatedBurn = 2.5;
    if (!budget.canSustain(estimatedBurn)) {
      return 0; // Can't afford another builder
    }
  }

  // Factor 1: Storage level
  // Young colonies (no storage) get a fixed baseline — they MUST build to progress
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

  // Don't start remote operations until home economy is stable
  var totalEnergy = state.energyStored + state.energyAvailable;
  if (totalEnergy < 2000 || state.energyIncome < state.energyIncomeMax * 0.5) {
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

  // Don't start remote operations until home economy is stable
  var totalEnergy = state.energyStored + state.energyAvailable;
  if (totalEnergy < 2000 || state.energyIncome < state.energyIncomeMax * 0.5) {
    return 0;
  }

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
 * Remote builder utility - builds infrastructure in remote mining rooms
 *
 * Only spawns when remote rooms have construction sites.
 * Lower priority than BUILDER, higher than UPGRADER.
 * Utility range: 0-35 (below builder at 25 base, above upgrader at 20 base)
 */
function remoteBuilderUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;

  // Don't spawn during economy crisis
  var totalEnergy = state.energyStored + state.energyAvailable;
  if (totalEnergy < 3000 || state.energyIncome < state.energyIncomeMax * 0.5) {
    return 0;
  }

  // Count construction sites in remote rooms
  var totalSites = 0;
  var manager = ColonyManager.getInstance(state.room.name);
  var remoteConfigs = manager.getRemoteConfigs();

  for (var remoteName in remoteConfigs) {
    var config = remoteConfigs[remoteName];
    if (!config.active) continue;

    var remoteRoom = Game.rooms[remoteName];
    if (!remoteRoom) {
      // No visibility - assume sites exist if recently activated
      if (config.activatedAt && Game.time - config.activatedAt < 5000) {
        totalSites += 5;
      }
      continue;
    }

    var sites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
    totalSites += sites.length;
  }

  if (totalSites === 0) return 0;

  // Base utility 25 - lower than home builder, higher than upgrader
  var utility = 25;

  // Urgency bonus for many sites
  if (totalSites > 10) utility += 5;
  if (totalSites > 20) utility += 5;

  // Scale by deficit
  utility *= Math.min(deficit, 2);

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

  // Don't reserve when home economy is struggling
  var totalEnergy = state.energyStored + state.energyAvailable;
  if (totalEnergy < 2000) {
    return 0;
  }

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

  // Don't scout when economy is struggling — every spawn tick matters
  var totalEnergy = state.energyStored + state.energyAvailable;
  if (totalEnergy < 1000 || state.energyIncome < state.energyIncomeMax * 0.5) {
    return 0;
  }

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
 * Pioneer utility - self-sufficient generalist for colonies without infrastructure
 *
 * High utility when colony is in "pioneer phase" (no source containers, no storage).
 * Returns 0 once source containers exist (specialists take over).
 *
 * Pioneers replace HARVESTER, HAULER, UPGRADER, BUILDER during early game.
 * They harvest, deliver to spawn, build, and upgrade - no interdependencies.
 */
function pioneerUtility(state: ColonyState): number {
  // Check for expansion pioneer needs first (higher priority)
  var expansionUtility = expansionPioneerUtility(state);
  if (expansionUtility > 0) return expansionUtility;

  // Only spawn local pioneers during pioneer phase
  if (!isPioneerPhase(state.room)) return 0;

  // Count existing LOCAL pioneers (not expansion pioneers)
  var currentPioneers = 0;
  var creeps = Object.values(Game.creeps);
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (c.memory.role === "PIONEER" && c.memory.room === state.room.name && !c.memory.targetRoom) {
      currentPioneers++;
    }
  }

  // Target: 1 pioneer per source, max 4
  var sources = state.room.find(FIND_SOURCES).length;
  var targetPioneers = Math.min(sources * 2, 4);

  if (currentPioneers >= targetPioneers) return 0;

  // High utility - pioneers are critical for survival
  // First pioneer: 150, second: 140, etc.
  return 150 - (currentPioneers * 10);
}

/**
 * Expansion pioneer utility - spawns when ExpansionManager needs pioneers
 * Only spawns from the parent room of an active bootstrap operation
 */
function expansionPioneerUtility(state: ColonyState): number {
  var expansionManager = new ExpansionManager();
  var needs = expansionManager.getSpawnRequests(state.room.name);
  var pioneerNeeds = needs.filter(function(n) { return n.role === "PIONEER"; });

  if (pioneerNeeds.length === 0) return 0;

  // High priority - getting spawn built is critical
  return 85;
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

  // Pioneer uses its own body builder
  // Expansion pioneers: use available energy to spawn quickly
  // Local pioneers: first uses available, subsequent use capacity
  if (role === "PIONEER") {
    // Check if this is an expansion pioneer
    var expansionManager = new ExpansionManager();
    var pioneerRequests = expansionManager.getSpawnRequests(state.room.name)
      .filter(function(r) { return r.role === "PIONEER"; });

    if (pioneerRequests.length > 0) {
      // Expansion pioneers use available energy (spawn quickly for bootstrap)
      return getPioneerBody(state.energyAvailable);
    }

    // Local pioneers: first uses available, subsequent use capacity
    var pioneerEnergy = state.energyCapacity;
    if ((state.counts.PIONEER || 0) === 0 && state.energyAvailable < state.energyCapacity) {
      pioneerEnergy = state.energyAvailable;
    }
    return getPioneerBody(pioneerEnergy);
  }

  // Can't afford this role's minimum body
  const minCost = ROLE_MIN_COST[role] || 200;
  if (energy < minCost) return [];

  // Use the generic body builder
  var body = buildBodyFromConfig(role, energy);

  // HARVESTER special case: ensure at least 1 CARRY when source containers don't exist
  // Without CARRY, harvesters can't self-deliver energy to spawn, causing deadlock
  if (role === "HARVESTER" && body.length > 0) {
    var hasCarry = body.some(function(p) { return p === CARRY; });
    if (!hasCarry) {
      // Check if source containers exist
      var sources = state.room.find(FIND_SOURCES);
      var sourceContainers = state.room.find(FIND_STRUCTURES, {
        filter: function(s) {
          return s.structureType === STRUCTURE_CONTAINER &&
            s.pos.findInRange(FIND_SOURCES, 1).length > 0;
        }
      });
      if (sourceContainers.length < sources.length) {
        // Not all sources have containers - use fallback body to ensure CARRY
        var fallback: BodyPartConstant[] = [WORK, CARRY, MOVE];
        var fallbackCost = fallback.reduce(function(sum, p) { return sum + BODYPART_COST[p]; }, 0);
        if (energy >= fallbackCost) {
          body = fallback;
        }
      }
    }
  }

  // BUILDER special case: cap WORK parts for early colonies to prevent economy overdraft
  // Single-source colonies (10 energy/tick income) can't sustain 4-WORK builders (20 energy/tick burn)
  if (role === "BUILDER" && body.length > 0) {
    var rcl = state.room.controller ? state.room.controller.level : 0;
    var hasStorage = !!state.room.storage;
    var isEarlyColony = rcl <= 3 && !hasStorage;

    if (isEarlyColony) {
      var sourceCount = state.room.find(FIND_SOURCES).length;
      // Cap WORK parts: 1 source = max 2 WORK, 2 sources = max 3 WORK
      // Builder burns 5 energy/WORK/tick at ~50% uptime = 2.5 energy/tick per WORK
      // 1 source = 10 income, 40% for building = 4 / 2.5 = 1.6 → round to 2
      // 2 sources = 20 income, 40% for building = 8 / 2.5 = 3.2 → round to 3
      var maxWorkParts = sourceCount === 1 ? 2 : 3;

      var currentWorkParts = 0;
      for (var i = 0; i < body.length; i++) {
        if (body[i] === WORK) currentWorkParts++;
      }

      if (currentWorkParts > maxWorkParts) {
        // Rebuild body with capped WORK parts
        // Builder pattern: [WORK, CARRY, MOVE] per unit
        var cappedBody: BodyPartConstant[] = [];
        for (var w = 0; w < maxWorkParts; w++) {
          cappedBody.push(WORK);
        }
        for (var c = 0; c < maxWorkParts; c++) {
          cappedBody.push(CARRY);
        }
        for (var m = 0; m < maxWorkParts; m++) {
          cappedBody.push(MOVE);
        }
        body = cappedBody;
      }
    }
  }

  return body;
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

    case "REMOTE_BUILDER": {
      const remoteRoom = findRemoteRoomNeedingBuilder(state);
      if (!remoteRoom) return base;
      return {
        ...base,
        targetRoom: remoteRoom,
        working: false,
      } as Partial<CreepMemory>;
    }

    case "RESERVER": {
      const targetRoom = findRemoteRoomNeedingReserver(state);
      return {
        ...base,
        targetRoom: targetRoom || undefined,
      };
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

    case "PIONEER": {
      // Check if this is an expansion pioneer
      var expansionManager = new ExpansionManager();
      var pioneerRequests = expansionManager
        .getSpawnRequests(state.room.name)
        .filter(function(r) { return r.role === "PIONEER"; });

      if (pioneerRequests.length > 0) {
        // Use memory from expansion manager request
        var req = pioneerRequests[0];
        return {
          ...base,
          ...req.memory,
          state: "TRAVELING",
        } as unknown as Partial<CreepMemory>;
      }

      // Local pioneer - basic memory
      return {
        ...base,
        state: "HARVESTING",
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
  // Use ColonyManager as single source of truth
  var manager = ColonyManager.getInstance(homeRoom);
  return manager.getRemoteMiningTargets();
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

/**
 * Calculate how many REMOTE_BUILDERs are needed.
 * Only spawn when remote rooms have construction sites.
 */
function getRemoteBuilderTarget(_room: Room, remoteConfigs: Record<string, RemoteRoomConfig>): number {
  // Count construction sites in active remotes
  var totalSites = 0;
  var remotesWithSites = 0;

  for (var remoteName in remoteConfigs) {
    var config = remoteConfigs[remoteName];
    if (!config.active) continue;

    // Check if we have visibility
    var remoteRoom = Game.rooms[remoteName];
    if (!remoteRoom) {
      // No visibility - assume sites exist if recently activated
      if (config.activatedAt && Game.time - config.activatedAt < 5000) {
        remotesWithSites++;
        totalSites += 5; // assume some sites
      }
      continue;
    }

    var sites = remoteRoom.find(FIND_CONSTRUCTION_SITES);
    if (sites.length > 0) {
      totalSites += sites.length;
      remotesWithSites++;
    }
  }

  if (totalSites === 0) return 0;

  // Scaling: 1 builder per 5 sites, max 2 total
  // More builders cause congestion and aren't efficient for remotes
  var target = Math.min(2, Math.ceil(totalSites / 5));

  // At least 1 if any remote has sites
  return Math.max(1, target);
}

/**
 * Find which remote room needs a builder most.
 */
function findRemoteRoomNeedingBuilder(state: ColonyState): string | null {
  var manager = ColonyManager.getInstance(state.room.name);
  var remoteConfigs = manager.getRemoteConfigs();

  var bestRemote: string | null = null;
  var mostSites = 0;

  for (var remoteName in remoteConfigs) {
    var config = remoteConfigs[remoteName];
    if (!config.active) continue;

    var remoteRoom = Game.rooms[remoteName];
    if (!remoteRoom) continue;

    var sites = remoteRoom.find(FIND_CONSTRUCTION_SITES).length;
    if (sites > mostSites) {
      mostSites = sites;
      bestRemote = remoteName;
    }
  }

  return bestRemote;
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
