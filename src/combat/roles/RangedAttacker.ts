/**
 * RangedAttacker - Ranged DPS role for duo combat
 *
 * Works with a CombatHealer partner to form a coordinated combat duo.
 * Uses kiting tactics to stay at optimal range while dealing damage.
 *
 * Decision Tree (priority order):
 *   1. FLEE: HP < 30% OR partner dead with hostiles nearby
 *   2. KITE: Any hostile at range ≤ 2 with ATTACK parts
 *   3. ENGAGE: Target at range ≤ 3 → rangedAttack or rangedMassAttack
 *   4. ADVANCE: Target at range > 3 → move toward target
 *   5. HOLD: No targets → rally with healer
 */

import { COMBAT } from "../CombatConstants";
import {
  shouldRetreat,
  shouldKite,
  findBestTarget,
  getBestRangedAttack,
  scoreRangedPosition,
  getOpenPositions,
  getFleeGoals,
  calcIncomingDamage,
} from "../CombatUtils";
import { smartMoveTo, moveToRoom } from "../../utils/movement";

// ============================================
// Types
// ============================================

export type RangedAttackerState =
  | "FLEE"
  | "KITE"
  | "ENGAGE"
  | "ADVANCE"
  | "HOLD";

export interface RangedAttackerMemory extends CreepMemory {
  role: "RANGED_ATTACKER";
  duoId?: string;
  partnerId?: Id<Creep>;
  targetRoom?: string;
  hostileTargetId?: Id<Creep>;  // Current hostile target
  lastState?: RangedAttackerState;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get the healer partner for this attacker.
 */
function getPartner(creep: Creep): Creep | null {
  var memory = creep.memory as RangedAttackerMemory;
  if (!memory.partnerId) return null;

  var partner = Game.getObjectById(memory.partnerId);
  return partner;
}

/**
 * Check if partner is alive and nearby.
 */
function isPartnerAlive(creep: Creep): boolean {
  var partner = getPartner(creep);
  return partner !== null && partner.hits > 0;
}

/**
 * Check if partner is dead but was expected.
 */
function wasPartnerLost(creep: Creep): boolean {
  var memory = creep.memory as RangedAttackerMemory;
  if (!memory.partnerId) return false;
  return getPartner(creep) === null;
}

/**
 * Find hostiles in the current room.
 */
function findHostiles(creep: Creep): Creep[] {
  return creep.room.find(FIND_HOSTILE_CREEPS);
}

/**
 * Get hostiles with melee parts (ATTACK).
 */
function findMeleeHostiles(hostiles: Creep[]): Creep[] {
  var melee: Creep[] = [];
  for (var i = 0; i < hostiles.length; i++) {
    if (hostiles[i].getActiveBodyparts(ATTACK) > 0) {
      melee.push(hostiles[i]);
    }
  }
  return melee;
}

// ============================================
// State Decision Logic
// ============================================

/**
 * Determine the current state based on decision tree.
 */
function determineState(
  creep: Creep,
  hostiles: Creep[],
  partner: Creep | null
): RangedAttackerState {
  var memory = creep.memory as RangedAttackerMemory;

  // 1. FLEE: HP critical OR partner dead with hostiles
  var hpRatio = creep.hits / creep.hitsMax;
  if (hpRatio < 0.3) {
    return "FLEE";
  }

  // Partner dead with hostiles = flee to safety
  if (wasPartnerLost(creep) && hostiles.length > 0) {
    return "FLEE";
  }

  // Use CombatUtils for sophisticated retreat decision
  if (hostiles.length > 0) {
    var partnerHeal = partner ? partner.getActiveBodyparts(HEAL) * COMBAT.HEAL_ADJACENT : 0;
    if (shouldRetreat(creep, hostiles, partnerHeal)) {
      return "FLEE";
    }
  }

  // No hostiles - hold position
  if (hostiles.length === 0) {
    return "HOLD";
  }

  // 2. KITE: Melee hostile too close
  if (shouldKite(creep, hostiles)) {
    return "KITE";
  }

  // Get target
  var target = memory.hostileTargetId ? Game.getObjectById(memory.hostileTargetId) : null;
  if (!target || target.room !== creep.room) {
    target = findBestTarget(hostiles, creep.pos);
  }

  if (!target) {
    return "HOLD";
  }

  var targetRange = creep.pos.getRangeTo(target);

  // 3. ENGAGE: Target in range
  if (targetRange <= 3) {
    return "ENGAGE";
  }

  // 4. ADVANCE: Target out of range
  return "ADVANCE";
}

// ============================================
// State Handlers
// ============================================

/**
 * FLEE state - retreat to safety.
 * Move toward home room or away from hostiles.
 */
function runFlee(creep: Creep, hostiles: Creep[]): void {
  creep.say("FLEE");

  var memory = creep.memory as RangedAttackerMemory;

  // Self-heal if we have heal parts
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }

  // Ranged attack while fleeing (if targets in range)
  var attack = getBestRangedAttack(creep, hostiles, null);
  if (attack.action === "mass") {
    creep.rangedMassAttack();
  } else if (attack.action === "single" && attack.target) {
    creep.rangedAttack(attack.target);
  }

  // Flee using PathFinder
  if (hostiles.length > 0) {
    var fleeGoals = getFleeGoals(hostiles);
    var path = PathFinder.search(creep.pos, fleeGoals, {
      flee: true,
      maxRooms: 2,
      roomCallback: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return false;

        var costs = new PathFinder.CostMatrix();
        var structures = room.find(FIND_STRUCTURES);
        for (var i = 0; i < structures.length; i++) {
          var s = structures[i];
          if (s.structureType === STRUCTURE_ROAD) {
            costs.set(s.pos.x, s.pos.y, 1);
          } else if (
            s.structureType !== STRUCTURE_CONTAINER &&
            (s.structureType !== STRUCTURE_RAMPART || !(s as StructureRampart).my)
          ) {
            costs.set(s.pos.x, s.pos.y, 255);
          }
        }
        return costs;
      },
    });

    if (path.path.length > 0) {
      creep.moveByPath(path.path);
    }
  } else {
    // No hostiles visible, retreat to home room
    var homeRoom = memory.room || creep.memory.room;
    if (creep.room.name !== homeRoom) {
      moveToRoom(creep, homeRoom);
    }
  }
}

/**
 * KITE state - maintain distance from melee threats.
 * Stay at range 3 from melee hostiles while attacking.
 */
function runKite(creep: Creep, hostiles: Creep[], partner: Creep | null): void {
  creep.say("KITE");

  // Attack while kiting
  var target = findBestTarget(hostiles, creep.pos);
  var attack = getBestRangedAttack(creep, hostiles, target);

  if (attack.action === "mass") {
    creep.rangedMassAttack();
  } else if (attack.action === "single" && attack.target) {
    creep.rangedAttack(attack.target);
  }

  // Find best position to kite to
  var positions = getOpenPositions(creep.pos, 2, { excludeCreeps: true });
  var bestPos: RoomPosition | null = null;
  var bestScore = -Infinity;

  for (var i = 0; i < positions.length; i++) {
    var pos = positions[i];
    var score = scoreRangedPosition(pos, hostiles, partner, target);

    // Bonus for positions further from melee hostiles
    var meleeHostiles = findMeleeHostiles(hostiles);
    for (var j = 0; j < meleeHostiles.length; j++) {
      var meleeRange = pos.getRangeTo(meleeHostiles[j]);
      if (meleeRange >= 3) {
        score += 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }

  if (bestPos && !creep.pos.isEqualTo(bestPos)) {
    creep.moveTo(bestPos, { reusePath: 0 });
  }
}

/**
 * ENGAGE state - attack target at optimal range.
 */
function runEngage(
  creep: Creep,
  hostiles: Creep[],
  partner: Creep | null
): void {
  creep.say("ENGAGE");

  var memory = creep.memory as RangedAttackerMemory;

  // Get or find target
  var target = memory.hostileTargetId ? Game.getObjectById(memory.hostileTargetId) : null;
  if (!target || target.room !== creep.room) {
    target = findBestTarget(hostiles, creep.pos, memory.hostileTargetId || undefined);
    if (target) {
      memory.hostileTargetId = target.id;
    }
  }

  // Attack
  var attack = getBestRangedAttack(creep, hostiles, target);
  if (attack.action === "mass") {
    creep.rangedMassAttack();
  } else if (attack.action === "single" && attack.target) {
    creep.rangedAttack(attack.target);
  }

  // Micro-positioning for optimal range
  if (target) {
    var targetRange = creep.pos.getRangeTo(target);

    // Already at optimal range 3, consider if we need to reposition
    if (targetRange === 3) {
      // Check if any melee hostile is getting close
      var meleeHostiles = findMeleeHostiles(hostiles);
      var needsReposition = false;

      for (var i = 0; i < meleeHostiles.length; i++) {
        if (creep.pos.getRangeTo(meleeHostiles[i]) <= 2) {
          needsReposition = true;
          break;
        }
      }

      if (needsReposition) {
        // Find a better position that maintains range 3 to target but further from melee
        var positions = getOpenPositions(creep.pos, 2, { excludeCreeps: true });
        var bestPos: RoomPosition | null = null;
        var bestScore = -Infinity;

        for (var j = 0; j < positions.length; j++) {
          var pos = positions[j];
          var posRange = pos.getRangeTo(target);
          if (posRange > 3) continue; // Stay in attack range

          var score = scoreRangedPosition(pos, hostiles, partner, target);
          if (score > bestScore) {
            bestScore = score;
            bestPos = pos;
          }
        }

        if (bestPos && !creep.pos.isEqualTo(bestPos)) {
          creep.moveTo(bestPos, { reusePath: 0 });
        }
      }
    } else if (targetRange < 3) {
      // Too close - back off slightly
      var positions = getOpenPositions(creep.pos, 2, { excludeCreeps: true });
      for (var k = 0; k < positions.length; k++) {
        var pos = positions[k];
        if (pos.getRangeTo(target) === 3) {
          creep.moveTo(pos, { reusePath: 0 });
          break;
        }
      }
    }
  }
}

/**
 * ADVANCE state - move toward target.
 */
function runAdvance(creep: Creep, hostiles: Creep[]): void {
  creep.say("ADVANCE");

  var memory = creep.memory as RangedAttackerMemory;

  // Get target
  var target = memory.hostileTargetId ? Game.getObjectById(memory.hostileTargetId) : null;
  if (!target || target.room !== creep.room) {
    target = findBestTarget(hostiles, creep.pos);
    if (target) {
      memory.hostileTargetId = target.id;
    }
  }

  if (target) {
    // Move toward target, stopping at range 3
    var range = creep.pos.getRangeTo(target);
    if (range > 3) {
      smartMoveTo(creep, target, { range: 3, reusePath: 3 });
    }

    // Attack if we're now in range
    if (range <= 3) {
      creep.rangedAttack(target);
    }
  }
}

/**
 * HOLD state - rally with healer partner.
 */
function runHold(creep: Creep, partner: Creep | null): void {
  creep.say("HOLD");

  var memory = creep.memory as RangedAttackerMemory;

  // Self-heal if damaged
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }

  // If we have a target room assignment, move there
  if (memory.targetRoom && creep.room.name !== memory.targetRoom) {
    moveToRoom(creep, memory.targetRoom);
    return;
  }

  // Rally with partner if exists
  if (partner) {
    var partnerRange = creep.pos.getRangeTo(partner);
    if (partnerRange > COMBAT.DUO_RALLY_RANGE) {
      smartMoveTo(creep, partner, { range: 2, reusePath: 5 });
    } else if (partnerRange > 2) {
      // Stay close but not too close
      smartMoveTo(creep, partner, { range: 2, reusePath: 3 });
    }
    return;
  }

  // No partner and no targets - idle at room center
  var center = new RoomPosition(25, 25, creep.room.name);
  if (creep.pos.getRangeTo(center) > 5) {
    smartMoveTo(creep, center, { range: 5, reusePath: 10 });
  }
}

// ============================================
// Main Run Function
// ============================================

/**
 * Run the RangedAttacker role.
 */
export function runRangedAttacker(creep: Creep): void {
  var memory = creep.memory as RangedAttackerMemory;

  // Get situational data
  var hostiles = findHostiles(creep);
  var partner = getPartner(creep);

  // Determine state
  var state = determineState(creep, hostiles, partner);
  memory.lastState = state;

  // Execute state
  switch (state) {
    case "FLEE":
      runFlee(creep, hostiles);
      break;
    case "KITE":
      runKite(creep, hostiles, partner);
      break;
    case "ENGAGE":
      runEngage(creep, hostiles, partner);
      break;
    case "ADVANCE":
      runAdvance(creep, hostiles);
      break;
    case "HOLD":
      runHold(creep, partner);
      break;
  }

  // Clear stale target if out of room or dead
  if (memory.hostileTargetId) {
    var target = Game.getObjectById(memory.hostileTargetId);
    if (!target || target.room !== creep.room) {
      delete memory.hostileTargetId;
    }
  }
}
