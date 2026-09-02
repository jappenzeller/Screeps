/**
 * ColonyTargets - how many creeps of each role a colony wants.
 *
 * There were two answers to this question. utilitySpawning computed `targets` with
 * getCreepTargets(); the framework's SpawnEvaluator computed the same thing again in its
 * own computeTarget() switch. They disagreed, and the disagreement was measurable: over
 * 20,265 ticks of shadow comparison the framework proposed NOTHING on 870 of the ticks
 * where utilitySpawning actually spawned - 62% of them - because its target for a role
 * came back 0 where the live system wanted one. E46N37's SCOUT is the clearest case.
 *
 * A target is a fact about the colony, not a policy of whichever module asks. Two answers
 * meant the shadow comparison was measuring schema drift rather than judgement, which is
 * the thing that has to go before there can be one spawn implementation.
 *
 * This is utilitySpawning's version - the one that has been running the colony - moved
 * verbatim so the merge changes no behaviour. Both spawners now read it.
 */

import { ColonyManager } from "./ColonyManager";
import { getMilestones } from "./ColonyMilestones";
import { scoutingViable } from "./ColonyPopulation";
import { LinkManager } from "../structures/LinkManager";
import { CONFIG } from "../config";

/**
 * Extra upgraders a storage-rich room may add beyond its base target, so a full store can
 * spend its way out instead of dropping energy on the ground.
 */
const MAX_SURPLUS_UPGRADERS = 4;

export function getCreepTargets(room: Room, totalSites: number): Record<string, number> {
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

  // Upgrader target: always need upgraders to progress RCL
  // Early colonies: at least 1 upgrader (can use source containers or dropped energy)
  // Mature colonies: scale with RCL
  let upgraderTarget = 0;
  if (isEarlyColony) {
    // Early colony (RCL 1-3, no storage): always have at least 1 upgrader
    // Upgraders can pick up energy from source containers or dropped resources
    if (m.allExtensions) {
      upgraderTarget = Math.min(rcl, 3); // Infrastructure done, push RCL
    } else {
      upgraderTarget = 1; // Building extensions or early RCL, have 1 upgrader
    }
  } else {
    // RCL 4+ or has storage: normal scaling
    upgraderTarget = rcl < 8 ? Math.min(rcl, 3) : 1;
  }

  // Surplus burn: a storage sitting above the high-water mark is dead capital, and
  // once it caps out the room starts dropping energy on the ground. The base target
  // is capped at 3, so without this a full room can never spend its way out.
  // Upgrading is the sink that always exists — convert the surplus into RCL.
  if (room.storage && rcl < 8) {
    const stored = room.storage.store[RESOURCE_ENERGY];
    const high = CONFIG.ENERGY.STORAGE_THRESHOLDS.high;

    if (stored > high) {
      const step = high / 2;
      const surplusUpgraders = Math.min(Math.floor((stored - high) / step), MAX_SURPLUS_UPGRADERS);
      upgraderTarget += surplusUpgraders;
    }
  }

  // FLOOR: RCL 1-3 without storage MUST have upgrader target >= 1
  // This is non-negotiable — without upgrading, colony can never progress.
  // Safety net in case any conditional logic above failed.
  if (isEarlyColony && upgraderTarget < 1) {
    upgraderTarget = 1;
  }

  // Pioneer target: only during pioneer phase
  var pioneerTarget = 0;
  if (isPioneerPhase(room)) {
    pioneerTarget = sources + 1; // 1 per source + 1 extra for overlap
  }

  // Defenders scale with the threat, capped by what the RCL can sustain.
  const hostileCount = room.find(FIND_HOSTILE_CREEPS).length;
  const maxDefenders = rcl <= 3 ? 1 : rcl <= 5 ? 2 : 3;
  const defenderTarget = hostileCount === 0 ? 0 : Math.min(hostileCount, maxDefenders);

  const targets: Record<string, number> = {
    PIONEER: pioneerTarget,
    HARVESTER: sources,
    HAULER: haulerTarget,
    UPGRADER: upgraderTarget,
    BUILDER: builderTarget,
    // Computed, not left at 0. A role whose target is permanently zero has escaped the
    // target map, and anything reading the map then has to special-case it - which is how
    // two spawners drift apart again. This is the framework's old computeTarget logic,
    // which was the only place it existed.
    DEFENDER: defenderTarget,
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

  // Filler at RCL 5+ with storage containing energy
  // Filler owns spawn/extension filling, freeing haulers for long-haul
  if (rcl >= 5 && room.storage && room.storage.store[RESOURCE_ENERGY] > 5000) {
    targets.FILLER = 1;
    // At RCL 7+ with 50+ extensions, may need 2
    if (rcl >= 7) {
      var extensionCount = room.find(FIND_MY_STRUCTURES, {
        filter: function(s) { return s.structureType === STRUCTURE_EXTENSION; }
      }).length;
      if (extensionCount >= 50) {
        targets.FILLER = 2;
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

  // Road builder: 1 if road construction sites exist and colony has storage
  if (room.storage) {
    var roadSites = room.find(FIND_CONSTRUCTION_SITES, {
      filter: function(s) { return s.structureType === STRUCTURE_ROAD; },
    });
    targets.ROAD_BUILDER = roadSites.length > 0 ? 1 : 0;
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
    // Same count the live scout utility enforces (cap 2), not a 1/0 flag. It was binary
    // here while scoutUtility allowed two, so the target map disagreed with the system
    // that was actually spawning - the map has to state the real number to be authority.
    // Scouts that never come home deliver no intel, so demand alone does not justify
    // spawning them - see scoutingViable().
    targets.SCOUT = scoutingViable(room.name)
      ? Math.min(2, countRoomsNeedingScan(room.name))
      : 0;

    // Remote builder target: only spawn when remote rooms have construction sites
    targets.REMOTE_BUILDER = getRemoteBuilderTarget(room, remoteConfigs);
  }

  return targets;
}

export function isPioneerPhase(room: Room): boolean {
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

export function countRoomsNeedingScan(homeRoom: string): number {
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

export function needsScout(homeRoom: string): boolean {
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
