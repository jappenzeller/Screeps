/**
 * CombatHealer - Healing support role for duo combat
 *
 * Works with a RangedAttacker partner to form a coordinated combat duo.
 * Focuses on keeping the attacker alive while staying safe from hostiles.
 *
 * Decision Tree (priority order):
 *   1. EMERGENCY: Partner HP < 50% → heal partner, move adjacent
 *   2. SELF: Own HP < 80% AND not adjacent to partner → heal self
 *   3. FOLLOW: Partner in range → heal partner, mirror movement
 *   4. CATCHUP: Partner out of range → move toward partner
 *   5. IDLE: No partner → patrol
 */

import { COMBAT } from "../CombatConstants";
import {
  scoreHealerPosition,
  getOpenPositions,
  calcIncomingDamage,
  getFleeGoals,
} from "../CombatUtils";
import { smartMoveTo, moveToRoom } from "../../utils/movement";

// ============================================
// Types
// ============================================

export type CombatHealerState =
  | "EMERGENCY"
  | "SELF"
  | "FOLLOW"
  | "CATCHUP"
  | "IDLE";

export interface CombatHealerMemory extends CreepMemory {
  role: "COMBAT_HEALER";
  duoId?: string;
  partnerId?: Id<Creep>;
  targetRoom?: string;
  lastState?: CombatHealerState;
  lastPartnerPos?: string; // "x,y,room" for movement mirroring
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get the attacker partner for this healer.
 */
function getPartner(creep: Creep): Creep | null {
  var memory = creep.memory as CombatHealerMemory;
  if (!memory.partnerId) return null;

  var partner = Game.getObjectById(memory.partnerId);
  return partner;
}

/**
 * Check if partner needs emergency healing.
 */
function partnerNeedsEmergency(partner: Creep | null): boolean {
  if (!partner) return false;
  return partner.hits < partner.hitsMax * 0.5;
}

/**
 * Check if self needs healing.
 */
function selfNeedsHealing(creep: Creep): boolean {
  return creep.hits < creep.hitsMax * 0.8;
}

/**
 * Find hostiles in the current room.
 */
function findHostiles(creep: Creep): Creep[] {
  return creep.room.find(FIND_HOSTILE_CREEPS);
}

/**
 * Find hostiles with melee parts (ATTACK).
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

/**
 * Parse last partner position from memory.
 */
function parseLastPartnerPos(memory: CombatHealerMemory): RoomPosition | null {
  if (!memory.lastPartnerPos) return null;

  var parts = memory.lastPartnerPos.split(",");
  if (parts.length !== 3) return null;

  return new RoomPosition(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10),
    parts[2]
  );
}

/**
 * Save partner position to memory.
 */
function savePartnerPos(memory: CombatHealerMemory, pos: RoomPosition): void {
  memory.lastPartnerPos = pos.x + "," + pos.y + "," + pos.roomName;
}

/**
 * Get the direction the partner moved.
 */
function getPartnerMoveDirection(
  currentPos: RoomPosition,
  lastPos: RoomPosition | null
): DirectionConstant | null {
  if (!lastPos) return null;
  if (currentPos.roomName !== lastPos.roomName) return null;
  if (currentPos.isEqualTo(lastPos)) return null;

  return lastPos.getDirectionTo(currentPos);
}

// ============================================
// State Decision Logic
// ============================================

/**
 * Determine the current state based on decision tree.
 */
function determineState(
  creep: Creep,
  partner: Creep | null,
  hostiles: Creep[]
): CombatHealerState {
  // 1. EMERGENCY: Partner critically wounded
  if (partnerNeedsEmergency(partner)) {
    return "EMERGENCY";
  }

  // 2. SELF: Own HP low and not adjacent to partner
  if (selfNeedsHealing(creep)) {
    if (!partner || creep.pos.getRangeTo(partner) > 1) {
      return "SELF";
    }
  }

  // No partner - idle
  if (!partner) {
    return "IDLE";
  }

  var partnerRange = creep.pos.getRangeTo(partner);

  // 3. FOLLOW: Partner in heal range
  if (partnerRange <= 3) {
    return "FOLLOW";
  }

  // 4. CATCHUP: Partner out of range
  return "CATCHUP";
}

// ============================================
// State Handlers
// ============================================

/**
 * EMERGENCY state - rush to heal critically wounded partner.
 */
function runEmergency(creep: Creep, partner: Creep, hostiles: Creep[]): void {
  creep.say("EMRG!");

  var partnerRange = creep.pos.getRangeTo(partner);

  // Heal partner (adjacent = full heal, ranged = reduced)
  if (partnerRange <= 1) {
    creep.heal(partner);
  } else if (partnerRange <= 3) {
    creep.rangedHeal(partner);
  }

  // Move adjacent to partner if not already
  if (partnerRange > 1) {
    // Find best adjacent position considering hostiles
    var positions = getOpenPositions(partner.pos, 1, { excludeCreeps: true });
    var bestPos: RoomPosition | null = null;
    var bestScore = -Infinity;

    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      var score = scoreHealerPosition(pos, partner, hostiles);

      // Bonus for being closer to current position
      score -= creep.pos.getRangeTo(pos) * 5;

      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }

    if (bestPos) {
      creep.moveTo(bestPos, { reusePath: 0 });
    } else {
      // Fallback - just move toward partner
      smartMoveTo(creep, partner, { range: 1, reusePath: 0 });
    }
  }
}

/**
 * SELF state - heal self when not adjacent to partner.
 */
function runSelf(creep: Creep, partner: Creep | null, hostiles: Creep[]): void {
  creep.say("SELF");

  // Self-heal
  creep.heal(creep);

  // Move toward partner if exists
  if (partner && creep.room.name === partner.room.name) {
    var partnerRange = creep.pos.getRangeTo(partner);
    if (partnerRange > 1) {
      smartMoveTo(creep, partner, { range: 1, reusePath: 3 });
    }
  } else if (partner) {
    // Partner in different room
    moveToRoom(creep, partner.room.name);
  }

  // Kite away from melee hostiles if needed
  var meleeHostiles = findMeleeHostiles(hostiles);
  for (var i = 0; i < meleeHostiles.length; i++) {
    if (creep.pos.getRangeTo(meleeHostiles[i]) <= 2) {
      // Flee from melee
      var fleeGoals = getFleeGoals(meleeHostiles);
      var path = PathFinder.search(creep.pos, fleeGoals, {
        flee: true,
        maxRooms: 1,
      });
      if (path.path.length > 0) {
        creep.moveByPath(path.path);
      }
      break;
    }
  }
}

/**
 * FOLLOW state - heal partner and mirror their movement.
 */
function runFollow(
  creep: Creep,
  partner: Creep,
  hostiles: Creep[],
  memory: CombatHealerMemory
): void {
  creep.say("FOLLOW");

  var partnerRange = creep.pos.getRangeTo(partner);

  // Heal partner
  if (partnerRange <= 1) {
    creep.heal(partner);
  } else if (partnerRange <= 3) {
    creep.rangedHeal(partner);
  }

  // Movement mirroring - follow partner's movement pattern
  var lastPartnerPos = parseLastPartnerPos(memory);
  var partnerDir = getPartnerMoveDirection(partner.pos, lastPartnerPos);

  if (partnerDir !== null) {
    // Partner moved - mirror the movement to maintain formation
    var newX = creep.pos.x;
    var newY = creep.pos.y;

    // Calculate offset based on direction
    switch (partnerDir) {
      case TOP: newY--; break;
      case TOP_RIGHT: newX++; newY--; break;
      case RIGHT: newX++; break;
      case BOTTOM_RIGHT: newX++; newY++; break;
      case BOTTOM: newY++; break;
      case BOTTOM_LEFT: newX--; newY++; break;
      case LEFT: newX--; break;
      case TOP_LEFT: newX--; newY--; break;
    }

    // Validate new position
    if (newX >= 1 && newX <= 48 && newY >= 1 && newY <= 48) {
      var terrain = Game.map.getRoomTerrain(creep.room.name);
      if (terrain.get(newX, newY) !== TERRAIN_MASK_WALL) {
        var targetPos = new RoomPosition(newX, newY, creep.room.name);
        creep.moveTo(targetPos, { reusePath: 0 });
      }
    }
  } else if (partnerRange > 1) {
    // Partner didn't move or we couldn't track - stay adjacent
    var positions = getOpenPositions(partner.pos, 1, { excludeCreeps: true });
    var bestPos: RoomPosition | null = null;
    var bestScore = -Infinity;

    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      var score = scoreHealerPosition(pos, partner, hostiles);

      // Prefer staying close to current position
      score -= creep.pos.getRangeTo(pos) * 3;

      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }

    if (bestPos && !creep.pos.isEqualTo(bestPos)) {
      creep.moveTo(bestPos, { reusePath: 0 });
    }
  }

  // Save partner position for next tick
  savePartnerPos(memory, partner.pos);
}

/**
 * CATCHUP state - move toward partner who is out of range.
 */
function runCatchup(creep: Creep, partner: Creep, memory: CombatHealerMemory): void {
  creep.say("CATCH");

  // Self-heal while moving if damaged
  if (creep.hits < creep.hitsMax) {
    creep.heal(creep);
  }

  // Move toward partner
  if (creep.room.name !== partner.room.name) {
    moveToRoom(creep, partner.room.name);
  } else {
    smartMoveTo(creep, partner, { range: 1, reusePath: 3 });
  }

  // Update partner position
  savePartnerPos(memory, partner.pos);
}

/**
 * IDLE state - no partner, patrol or wait.
 */
function runIdle(creep: Creep, hostiles: Creep[]): void {
  creep.say("IDLE");

  var memory = creep.memory as CombatHealerMemory;

  // Self-heal if damaged
  if (creep.hits < creep.hitsMax) {
    creep.heal(creep);
  }

  // If we have a target room assignment, go there
  if (memory.targetRoom && creep.room.name !== memory.targetRoom) {
    moveToRoom(creep, memory.targetRoom);
    return;
  }

  // Flee from hostiles if any
  if (hostiles.length > 0) {
    var meleeHostiles = findMeleeHostiles(hostiles);
    var fleeFrom = meleeHostiles.length > 0 ? meleeHostiles : hostiles;

    var closestHostile = creep.pos.findClosestByRange(fleeFrom);
    if (closestHostile && creep.pos.getRangeTo(closestHostile) < 5) {
      var fleeGoals = getFleeGoals(fleeFrom);
      var path = PathFinder.search(creep.pos, fleeGoals, {
        flee: true,
        maxRooms: 1,
      });
      if (path.path.length > 0) {
        creep.moveByPath(path.path);
      }
      return;
    }
  }

  // Patrol around room center
  var center = new RoomPosition(25, 25, creep.room.name);
  if (creep.pos.getRangeTo(center) > 10) {
    smartMoveTo(creep, center, { range: 5, reusePath: 10 });
  }
}

// ============================================
// Main Run Function
// ============================================

/**
 * Run the CombatHealer role.
 */
export function runCombatHealer(creep: Creep): void {
  var memory = creep.memory as CombatHealerMemory;

  // Get situational data
  var hostiles = findHostiles(creep);
  var partner = getPartner(creep);

  // Determine state
  var state = determineState(creep, partner, hostiles);
  memory.lastState = state;

  // Execute state
  switch (state) {
    case "EMERGENCY":
      if (partner) runEmergency(creep, partner, hostiles);
      break;
    case "SELF":
      runSelf(creep, partner, hostiles);
      break;
    case "FOLLOW":
      if (partner) runFollow(creep, partner, hostiles, memory);
      break;
    case "CATCHUP":
      if (partner) runCatchup(creep, partner, memory);
      break;
    case "IDLE":
      runIdle(creep, hostiles);
      break;
  }
}
