/**
 * Raider Role - Economic Disruption
 *
 * Raiders target the enemy economy to accelerate controller downgrade:
 * - Kill haulers to stop energy delivery
 * - Destroy containers to deny storage
 * - Attack harvesters if opportunity presents
 *
 * Raiders operate independently, using hit-and-run tactics.
 * They have ATTACK + MOVE for melee combat with good mobility.
 *
 * Priority targets:
 * 1. Haulers (weakest, highest impact)
 * 2. Harvesters (stops energy income)
 * 3. Containers (denies storage/hauler pickup)
 */

import { moveToRoom } from "../../utils/movement";

export interface RaiderMemory extends CreepMemory {
  role: "RAIDER";
  room: string;
  targetRoom: string;
  campaignId: string;
  raiderState: "TRAVELING" | "RAIDING" | "RETREATING" | "RECYCLING";
  currentTarget?: Id<Creep | StructureContainer>;
  lastDamage?: number;
  healthLastTick?: number;
  killCount: number;
  containersDamaged: number;
}

// ============================================
// Constants
// ============================================

var RETREAT_HEALTH_PCT = 0.3;      // Retreat when below 30% health
var TOWER_AVOID_RANGE = 15;        // Stay this far from towers when possible
var RECYCLE_TICKS_THRESHOLD = 100; // Recycle if TTL below this

// ============================================
// Main Run Function
// ============================================

export function runRaider(creep: Creep): void {
  var mem = creep.memory as RaiderMemory;

  // Track damage taken
  if (mem.healthLastTick !== undefined) {
    var currentHealth = creep.hits;
    if (currentHealth < mem.healthLastTick) {
      mem.lastDamage = Game.time;
    }
  }
  mem.healthLastTick = creep.hits;

  // State transitions
  if (mem.raiderState !== "RECYCLING") {
    // Check for retreat condition
    if (creep.hits / creep.hitsMax < RETREAT_HEALTH_PCT) {
      mem.raiderState = "RETREATING";
      creep.say("RETREAT!");
    }

    // Check for recycle condition
    if (creep.ticksToLive && creep.ticksToLive < RECYCLE_TICKS_THRESHOLD) {
      mem.raiderState = "RECYCLING";
      creep.say("RECYCLE");
    }
  }

  // Run state
  switch (mem.raiderState) {
    case "TRAVELING":
      runTraveling(creep, mem);
      break;
    case "RAIDING":
      runRaiding(creep, mem);
      break;
    case "RETREATING":
      runRetreating(creep, mem);
      break;
    case "RECYCLING":
      runRecycling(creep, mem);
      break;
    default:
      mem.raiderState = "TRAVELING";
  }
}

// ============================================
// State Handlers
// ============================================

function runTraveling(creep: Creep, mem: RaiderMemory): void {
  if (creep.room.name === mem.targetRoom) {
    mem.raiderState = "RAIDING";
    creep.say("RAID!");
    return;
  }

  // Move to target room, avoiding danger when possible
  moveToRoom(creep, mem.targetRoom, "#ff4400", { avoidDanger: false });
  creep.say("→" + mem.targetRoom.substring(0, 4));
}

function runRaiding(creep: Creep, mem: RaiderMemory): void {
  // Get tower positions for avoidance
  var towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];

  // Find targets
  var target = findRaidTarget(creep, towers);

  if (!target) {
    // No targets - move to patrol position away from towers
    patrolRoom(creep, towers);
    creep.say("PATROL");
    return;
  }

  // Attack target
  if (target instanceof Creep) {
    var attackResult = creep.attack(target);
    if (attackResult === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target, towers);
      creep.say("→" + (target.memory.role || "CREEP").substring(0, 4));
    } else if (attackResult === OK) {
      creep.say("HIT!");
      // Check for kill
      if (target.hits <= getAttackDamage(creep)) {
        mem.killCount = (mem.killCount || 0) + 1;
        console.log("[Raider] " + creep.name + " killed " +
          (target.memory.role || "creep") + " in " + mem.targetRoom +
          " (total kills: " + mem.killCount + ")");
      }
    }
  } else {
    // Container
    var dismantleResult = creep.dismantle(target);
    if (dismantleResult === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target, towers);
      creep.say("→CONT");
    } else if (dismantleResult === OK) {
      creep.say("SMASH");
      mem.containersDamaged = (mem.containersDamaged || 0) + 1;
    } else if (dismantleResult === ERR_NO_BODYPART) {
      // No WORK parts - try to attack
      creep.attack(target as any);
    }
  }
}

function runRetreating(creep: Creep, mem: RaiderMemory): void {
  // Move back to home room
  if (creep.room.name !== mem.room) {
    moveToRoom(creep, mem.room, "#00ff00", { avoidDanger: true });
    creep.say("HOME");
    return;
  }

  // In home room - check if healed
  if (creep.hits === creep.hitsMax) {
    mem.raiderState = "TRAVELING";
    creep.say("HEALED");
    return;
  }

  // Move to spawn for healing
  var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (spawn) {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: "#00ff00" } });
  }
}

function runRecycling(creep: Creep, mem: RaiderMemory): void {
  // Move to home room
  if (creep.room.name !== mem.room) {
    moveToRoom(creep, mem.room, "#888888", { avoidDanger: true });
    return;
  }

  // Find spawn to recycle at
  var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (spawn) {
    if (creep.pos.isNearTo(spawn)) {
      spawn.recycleCreep(creep);
    } else {
      creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
    }
  } else {
    // No spawn - suicide
    creep.suicide();
  }
}

// ============================================
// Target Selection
// ============================================

function findRaidTarget(creep: Creep, towers: StructureTower[]): Creep | StructureContainer | null {
  // Priority 1: Haulers (low health, high impact)
  var haulers = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: function(c: Creep) {
      // Look for hauler-like creeps (CARRY heavy, few offensive parts)
      var carryParts = c.getActiveBodyparts(CARRY);
      var offensiveParts = c.getActiveBodyparts(ATTACK) +
                           c.getActiveBodyparts(RANGED_ATTACK);
      return carryParts > 0 && offensiveParts === 0;
    }
  });

  if (haulers.length > 0) {
    // Pick closest hauler not too close to towers
    var safestHauler = pickSafestTarget(creep, haulers, towers);
    if (safestHauler) return safestHauler;
  }

  // Priority 2: Harvesters (stops income)
  var harvesters = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: function(c: Creep) {
      var workParts = c.getActiveBodyparts(WORK);
      var offensiveParts = c.getActiveBodyparts(ATTACK) +
                           c.getActiveBodyparts(RANGED_ATTACK);
      return workParts > 0 && offensiveParts === 0;
    }
  });

  if (harvesters.length > 0) {
    var safestHarvester = pickSafestTarget(creep, harvesters, towers);
    if (safestHarvester) return safestHarvester;
  }

  // Priority 3: Containers (denies storage)
  // Note: Containers are neutral structures, not hostile, so use FIND_STRUCTURES
  var containers = creep.room.find(FIND_STRUCTURES, {
    filter: function(s: Structure) {
      return s.structureType === STRUCTURE_CONTAINER;
    }
  }) as StructureContainer[];

  if (containers.length > 0) {
    var safestContainer = pickSafestTarget(creep, containers as any, towers);
    if (safestContainer) return safestContainer as unknown as StructureContainer;
  }

  // Priority 4: Any non-combat creep
  var nonCombat = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: function(c: Creep) {
      var offensiveParts = c.getActiveBodyparts(ATTACK) +
                           c.getActiveBodyparts(RANGED_ATTACK) +
                           c.getActiveBodyparts(HEAL);
      return offensiveParts === 0;
    }
  });

  if (nonCombat.length > 0) {
    var safestNonCombat = pickSafestTarget(creep, nonCombat, towers);
    if (safestNonCombat) return safestNonCombat;
  }

  return null;
}

function pickSafestTarget<T extends RoomObject>(
  creep: Creep,
  targets: T[],
  towers: StructureTower[]
): T | null {
  var best: T | null = null;
  var bestScore = -Infinity;

  for (var i = 0; i < targets.length; i++) {
    var target = targets[i];
    var pos = target.pos;

    // Calculate tower danger at target position
    var towerDanger = 0;
    for (var j = 0; j < towers.length; j++) {
      var tower = towers[j];
      if (tower.store[RESOURCE_ENERGY] < 10) continue; // Drained tower

      var range = tower.pos.getRangeTo(pos);
      if (range <= 5) {
        towerDanger += 600; // Max damage
      } else if (range <= 20) {
        towerDanger += 600 - (range - 5) * 30; // Damage falloff
      }
    }

    // Distance to target
    var distance = creep.pos.getRangeTo(pos);

    // Score: prefer close targets with low tower danger
    var score = -distance - (towerDanger / 10);

    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }

  return best;
}

// ============================================
// Movement
// ============================================

function moveToTarget(
  creep: Creep,
  target: RoomObject,
  towers: StructureTower[]
): void {
  // Use PathFinder with tower avoidance
  var goal = { pos: target.pos, range: 1 };

  var ret = PathFinder.search(creep.pos, goal, {
    maxRooms: 1,
    roomCallback: function(roomName) {
      var room = Game.rooms[roomName];
      if (!room) return new PathFinder.CostMatrix();

      var costs = new PathFinder.CostMatrix();

      // Avoid hostile creeps with combat parts
      var hostiles = room.find(FIND_HOSTILE_CREEPS);
      for (var i = 0; i < hostiles.length; i++) {
        var h = hostiles[i];
        if (h.getActiveBodyparts(ATTACK) > 0 ||
            h.getActiveBodyparts(RANGED_ATTACK) > 0) {
          // Give wider berth to combat creeps
          for (var dx = -2; dx <= 2; dx++) {
            for (var dy = -2; dy <= 2; dy++) {
              var x = h.pos.x + dx;
              var y = h.pos.y + dy;
              if (x < 0 || x > 49 || y < 0 || y > 49) continue;
              var existing = costs.get(x, y);
              if (existing < 255) {
                costs.set(x, y, Math.min(existing + 30, 254));
              }
            }
          }
        }
      }

      // Add tower danger zones
      for (var j = 0; j < towers.length; j++) {
        var tower = towers[j];
        if (tower.store[RESOURCE_ENERGY] < 10) continue;

        // Add cost based on tower range
        for (var tx = -TOWER_AVOID_RANGE; tx <= TOWER_AVOID_RANGE; tx++) {
          for (var ty = -TOWER_AVOID_RANGE; ty <= TOWER_AVOID_RANGE; ty++) {
            var px = tower.pos.x + tx;
            var py = tower.pos.y + ty;
            if (px < 0 || px > 49 || py < 0 || py > 49) continue;

            var range = Math.max(Math.abs(tx), Math.abs(ty));
            if (range > TOWER_AVOID_RANGE) continue;

            var existingCost = costs.get(px, py);
            if (existingCost === 255) continue;

            var addedCost = 0;
            if (range <= 5) {
              addedCost = 50; // Max damage zone
            } else if (range <= 10) {
              addedCost = 30;
            } else {
              addedCost = 15;
            }

            costs.set(px, py, Math.min(existingCost + addedCost, 254));
          }
        }
      }

      return costs;
    }
  });

  if (ret.path.length > 0) {
    creep.moveByPath(ret.path);
  }
}

function patrolRoom(creep: Creep, towers: StructureTower[]): void {
  // Move to a position away from towers but within the room
  var targetX = 25;
  var targetY = 25;

  // Adjust position based on tower locations
  if (towers.length > 0) {
    var avgTowerX = 0;
    var avgTowerY = 0;
    for (var i = 0; i < towers.length; i++) {
      avgTowerX += towers[i].pos.x;
      avgTowerY += towers[i].pos.y;
    }
    avgTowerX = Math.floor(avgTowerX / towers.length);
    avgTowerY = Math.floor(avgTowerY / towers.length);

    // Move to opposite side of room from towers
    targetX = avgTowerX < 25 ? 40 : 10;
    targetY = avgTowerY < 25 ? 40 : 10;
  }

  creep.moveTo(targetX, targetY, {
    visualizePathStyle: { stroke: "#ff4400" },
    reusePath: 10,
  });
}

// ============================================
// Utilities
// ============================================

function getAttackDamage(creep: Creep): number {
  return creep.getActiveBodyparts(ATTACK) * 30;
}
