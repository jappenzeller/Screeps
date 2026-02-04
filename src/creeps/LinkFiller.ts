import { smartMoveTo } from "../utils/movement";
import { LinkManager } from "../structures/LinkManager";

/**
 * LinkFiller - Parks between storage and storage link, keeping the link filled.
 * Tiny creep that withdraws from storage and transfers to storage link.
 * The LinkManager then transfers energy from storage link to controller link.
 * Persists via renewal (short round trip since spawn is nearby).
 */

// ============================================
// Renewal Logic for Link Filler
// ============================================

function getSpawnDistance(creep: Creep): number {
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  return spawn ? creep.pos.getRangeTo(spawn) : 999;
}

function shouldGoRenew(creep: Creep): boolean {
  if (!creep.ticksToLive) return false;

  // Don't renew undersized creeps - let them die and spawn bigger replacements
  const bodyCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
  const capacity = creep.room.energyCapacityAvailable;
  if (bodyCost < capacity * 0.5) {
    return false;
  }

  const distance = getSpawnDistance(creep);
  const roundTrip = distance * 2;
  const buffer = 20;

  return creep.ticksToLive < roundTrip + buffer;
}

function getRenewalTarget(creep: Creep): number {
  const distance = getSpawnDistance(creep);
  const roundTrip = distance * 2;
  const workPeriod = 500;
  const buffer = 20;

  return roundTrip + workPeriod + buffer;
}

function runRenewal(creep: Creep): boolean {
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return false;

  const range = creep.pos.getRangeTo(spawn);

  if (range > 1) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#00ff00" }, reusePath: 5 });
    creep.say("RENEW");
    return true;
  }

  // At spawn
  if (spawn.spawning) {
    if (creep.ticksToLive && creep.ticksToLive < 15) {
      return true; // critical, wait
    }
    return false; // give up
  }

  const target = getRenewalTarget(creep);
  if (creep.ticksToLive && creep.ticksToLive >= target) {
    return false; // done
  }

  spawn.renewCreep(creep);
  return true;
}

// ============================================
// Main Link Filler Logic
// ============================================

export function runLinkFiller(creep: Creep): void {
  // Check for renewal
  if (shouldGoRenew(creep) || creep.memory.renewing) {
    creep.memory.renewing = true;
    if (runRenewal(creep)) return;
    creep.memory.renewing = false;
  }

  // === EMERGENCY: Shuttle storage → spawn when economy is dead ===
  const homeCreeps = Object.values(Game.creeps).filter(
    (c) => c.memory.room === creep.room.name
  );
  const hasHarvesters = homeCreeps.some((c) => c.memory.role === "HARVESTER");
  const hasHaulers = homeCreeps.some((c) => c.memory.role === "HAULER");

  if (!hasHarvesters || !hasHaulers) {
    const storage = creep.room.storage;
    if (storage && storage.store[RESOURCE_ENERGY] > 0) {
      // Find spawn/extension that needs energy
      const target = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      });

      if (target) {
        if (creep.store[RESOURCE_ENERGY] === 0) {
          // Withdraw from storage
          if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            smartMoveTo(creep, storage, { reusePath: 5 });
          }
        } else {
          // Deliver to spawn/extension
          if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            smartMoveTo(creep, target, { reusePath: 5 });
          }
        }
        creep.say("SOS");
        return; // Skip normal link-filling
      }
    }
  }
  // === END EMERGENCY ===

  const storage = creep.room.storage;
  if (!storage) {
    creep.say("no stor");
    return;
  }

  const linkManager = new LinkManager(creep.room);
  const storageLink = linkManager.getStorageLink();

  if (!storageLink) {
    creep.say("no link");
    return;
  }

  // Find or move to parking spot (adjacent to both storage and link)
  const parkingSpot = findParkingSpot(storage, storageLink);
  if (!parkingSpot) {
    creep.say("no spot");
    return;
  }

  if (!creep.pos.isEqualTo(parkingSpot)) {
    smartMoveTo(creep, parkingSpot, { reusePath: 20 });
    creep.say("park");
    return;
  }

  // Parked - alternate withdraw/transfer
  if (creep.store[RESOURCE_ENERGY] === 0) {
    creep.withdraw(storage, RESOURCE_ENERGY);
  } else if (storageLink.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    creep.transfer(storageLink, RESOURCE_ENERGY);
  }
  // If link is full, just wait (LinkManager will transfer to controller link)
}

/**
 * Find tile adjacent to storage and storage link, optimizing for multiple links.
 * At RCL 6+ there may be a source link near storage too - prefer a tile
 * that is adjacent to ALL nearby links for maximum efficiency.
 */
function findParkingSpot(storage: StructureStorage, storageLink: StructureLink): RoomPosition | null {
  var room = storage.room;
  var terrain = room.getTerrain();

  // Find all links near storage (source links placed nearby, etc.)
  var nearbyLinks = room.find(FIND_MY_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_LINK &&
        s.pos.inRangeTo(storage, 3);
    },
  }) as StructureLink[];

  var candidates: Array<{ x: number; y: number; score: number }> = [];

  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;

      var x = storage.pos.x + dx;
      var y = storage.pos.y + dy;

      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      var pos = new RoomPosition(x, y, room.name);

      // Hard requirement: must be adjacent to storage link
      if (!pos.isNearTo(storageLink)) continue;

      // Check for blocking structures (roads/ramparts/containers are OK)
      var blocking = pos.lookFor(LOOK_STRUCTURES).some(
        function(s) {
          return s.structureType !== STRUCTURE_ROAD &&
            s.structureType !== STRUCTURE_RAMPART &&
            s.structureType !== STRUCTURE_CONTAINER;
        }
      );
      if (blocking) continue;

      // Score: count how many links this tile is adjacent to
      var score = 0;
      for (var i = 0; i < nearbyLinks.length; i++) {
        if (pos.isNearTo(nearbyLinks[i])) {
          score += 10;
        }
      }

      // Tiebreak: prefer plain terrain over swamp
      if (terrain.get(x, y) === 0) {
        score += 1;
      }

      candidates.push({ x: x, y: y, score: score });
    }
  }

  if (candidates.length === 0) return null;

  // Pick highest score
  candidates.sort(function(a, b) { return b.score - a.score; });
  return new RoomPosition(candidates[0].x, candidates[0].y, room.name);
}
