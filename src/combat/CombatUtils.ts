/**
 * Combat Utilities
 *
 * Pure functions for combat calculations.
 * No state, no side effects - just math.
 *
 * Extracted from RemoteDefender.ts and enhanced for duo coordination.
 */

import { COMBAT, allHostilesAreNPC } from "./CombatConstants";

// ============================================
// Types
// ============================================

export interface ScoredTarget {
  target: Creep;
  score: number;
  reason: string;
}

export interface DamageAssessment {
  melee: number;      // DPS from ATTACK parts
  ranged: number;     // DPS from RANGED_ATTACK parts
  total: number;      // Combined DPS
}

export interface HealAssessment {
  selfHeal: number;   // HPS from own HEAL parts
  allyHeal: number;   // HPS from nearby ally HEAL parts
  total: number;      // Combined HPS
}

export interface PositionScore {
  pos: RoomPosition;
  score: number;
  factors: {
    rangeToTarget: number;
    distanceFromMelee: number;
    distanceFromHealer: number;
    edgePenalty: number;
    swampPenalty: number;
  };
}

// ============================================
// Target Selection
// ============================================

/**
 * Calculate priority score for a hostile creep.
 * Higher score = shoot first.
 *
 * Priority: Healers > Ranged > Melee > Workers > Other
 */
export function getTargetPriority(hostile: Creep): number {
  var priority = 0;
  priority += hostile.getActiveBodyparts(HEAL) * COMBAT.PRIORITY_HEALER;
  priority += hostile.getActiveBodyparts(RANGED_ATTACK) * COMBAT.PRIORITY_RANGED;
  priority += hostile.getActiveBodyparts(ATTACK) * COMBAT.PRIORITY_ATTACK;
  priority += hostile.getActiveBodyparts(WORK) * COMBAT.PRIORITY_WORK;
  priority += hostile.getActiveBodyparts(CLAIM) * COMBAT.PRIORITY_CLAIM;
  return priority;
}

/**
 * Score all hostile creeps for target priority.
 * Returns sorted array with highest priority first.
 *
 * Factors:
 *   - Body composition (healers first)
 *   - HP ratio (finish wounded targets)
 *   - Proximity (closer = more reliable damage)
 */
export function scoreTargets(
  hostiles: Creep[],
  myPos: RoomPosition,
  opts?: { preferHealers?: boolean; focusTarget?: Id<Creep> }
): ScoredTarget[] {
  var results: ScoredTarget[] = [];

  for (var i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];

    // Base score from body composition
    var score = getTargetPriority(hostile);

    // HP ratio bonus - prioritize wounded targets
    var hpRatio = hostile.hits / hostile.hitsMax;
    var woundedBonus = (1 - hpRatio) * 50; // Up to +50 for nearly dead
    score += woundedBonus;

    // Proximity bonus - closer targets easier to finish
    var range = myPos.getRangeTo(hostile);
    var proximityBonus = Math.max(0, (4 - range) * 10); // +30 at range 1, 0 at range 4+
    score += proximityBonus;

    // Focus target bonus - stick to assigned target
    if (opts && opts.focusTarget && hostile.id === opts.focusTarget) {
      score += 100;
    }

    var reason = "P:" + getTargetPriority(hostile) +
      " HP:" + Math.round(hpRatio * 100) + "%" +
      " R:" + range;

    results.push({ target: hostile, score: score, reason: reason });
  }

  // Sort by score descending
  results.sort(function(a, b) {
    return b.score - a.score;
  });

  return results;
}

/**
 * Find the best target to attack.
 * Convenience wrapper around scoreTargets.
 */
export function findBestTarget(
  hostiles: Creep[],
  myPos: RoomPosition,
  focusTarget?: Id<Creep>
): Creep | null {
  if (hostiles.length === 0) return null;

  var scored = scoreTargets(hostiles, myPos, { focusTarget: focusTarget });
  return scored.length > 0 ? scored[0].target : null;
}

/**
 * Check if a target is worth attacking.
 * Returns false for targets we can't damage effectively.
 */
export function isViableTarget(hostile: Creep, myCreep: Creep): boolean {
  // Dead or gone
  if (!hostile || hostile.hits === 0) return false;

  // Can we even reach them?
  var range = myCreep.pos.getRangeTo(hostile);
  var hasRanged = myCreep.getActiveBodyparts(RANGED_ATTACK) > 0;
  var hasMelee = myCreep.getActiveBodyparts(ATTACK) > 0;

  if (!hasRanged && !hasMelee) return false;
  if (!hasRanged && range > 1) return false;
  if (!hasMelee && range > 3) return false;

  return true;
}

// ============================================
// Damage Calculations
// ============================================

/**
 * Calculate damage output of a creep at a given range.
 */
export function calcDamageAtRange(creep: Creep, range: number): number {
  var damage = 0;

  // Melee damage (range 1 only)
  if (range <= 1) {
    damage += creep.getActiveBodyparts(ATTACK) * COMBAT.ATTACK_DAMAGE;
  }

  // Ranged damage (range 1-3)
  if (range <= 3) {
    damage += creep.getActiveBodyparts(RANGED_ATTACK) * COMBAT.RANGED_DAMAGE;
  }

  return damage;
}

/**
 * Calculate total incoming damage to a position from all hostiles.
 */
export function calcIncomingDamage(
  pos: RoomPosition,
  hostiles: Creep[]
): DamageAssessment {
  var melee = 0;
  var ranged = 0;

  for (var i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];
    var range = pos.getRangeTo(hostile);

    // Melee damage
    if (range <= 1) {
      melee += hostile.getActiveBodyparts(ATTACK) * COMBAT.ATTACK_DAMAGE;
    }

    // Ranged damage
    if (range <= 3) {
      ranged += hostile.getActiveBodyparts(RANGED_ATTACK) * COMBAT.RANGED_DAMAGE;
    }
  }

  return {
    melee: melee,
    ranged: ranged,
    total: melee + ranged,
  };
}

/**
 * Calculate effective HP accounting for TOUGH boosts.
 * Boosted TOUGH parts absorb damage at reduced rate.
 *
 * Note: Without boost info from body, assumes unboosted.
 * For accurate boosted calculations, check body[].boost.
 */
export function calcEffectiveHP(creep: Creep): number {
  var baseHP = creep.hits;

  // Count boosted TOUGH parts (rough estimation)
  // In practice, TOUGH parts are at the front of the body
  var toughParts = creep.getActiveBodyparts(TOUGH);

  // Assume unboosted for now - TOUGH just provides HP soak
  // Boosted TOUGH would multiply effective HP significantly
  return baseHP;
}

/**
 * Calculate net damage (incoming - healing).
 * Positive = taking damage, Negative = outhealing
 */
export function calcNetDamage(incomingDPS: number, healingHPS: number): number {
  return incomingDPS - healingHPS;
}

// ============================================
// Healing Calculations
// ============================================

/**
 * Calculate self-heal capability.
 */
export function calcSelfHeal(creep: Creep): number {
  return creep.getActiveBodyparts(HEAL) * COMBAT.HEAL_ADJACENT;
}

/**
 * Calculate total heal available to a position from allies.
 *
 * @param pos - Position to calculate heal for
 * @param allies - Array of allied creeps with HEAL parts
 */
export function calcAvailableHeal(
  pos: RoomPosition,
  allies: Creep[]
): HealAssessment {
  var allyHeal = 0;

  for (var i = 0; i < allies.length; i++) {
    var ally = allies[i];
    var range = pos.getRangeTo(ally);
    var healParts = ally.getActiveBodyparts(HEAL);

    if (healParts === 0) continue;

    if (range <= 1) {
      allyHeal += healParts * COMBAT.HEAL_ADJACENT;
    } else if (range <= 3) {
      allyHeal += healParts * COMBAT.HEAL_RANGED;
    }
  }

  return {
    selfHeal: 0, // Caller should add self-heal separately
    allyHeal: allyHeal,
    total: allyHeal,
  };
}

// ============================================
// Retreat Logic
// ============================================

/**
 * Smart retreat decision - ONLY retreat when truly unable to fight.
 *
 * For NPC invaders: Only retreat when critically wounded AND
 * taking unsustainable damage.
 *
 * For player creeps: More conservative logic since they may pursue.
 *
 * Extracted from RemoteDefender.shouldRetreat()
 */
export function shouldRetreat(
  creep: Creep,
  hostiles: Creep[],
  allyHealPerTick?: number
): boolean {
  // Lost all ranged attack parts - can't fight, must retreat
  if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) return true;

  if (hostiles.length === 0) return false;

  // Calculate our self-heal capability
  var selfHealPerTick = calcSelfHeal(creep);
  var totalHealPerTick = selfHealPerTick + (allyHealPerTick || 0);

  // Calculate incoming DPS
  var incoming = calcIncomingDamage(creep.pos, hostiles);

  if (allHostilesAreNPC(hostiles)) {
    // Against NPCs: Only retreat if critically wounded AND taking massive damage
    var isCritical = creep.hits < creep.hitsMax * COMBAT.RETREAT_HP_CRITICAL;
    var unsustainableDamage = incoming.total > totalHealPerTick * 2;
    return isCritical && unsustainableDamage;
  }

  // Against players: More conservative
  var netDamage = calcNetDamage(incoming.total, totalHealPerTick);
  if (netDamage <= 0) return false;

  // Retreat if HP is below threshold and taking net damage
  return creep.hits < creep.hitsMax * COMBAT.RETREAT_HP_PLAYER &&
    netDamage > COMBAT.RETREAT_NET_DAMAGE_THRESHOLD;
}

// ============================================
// Position Scoring
// ============================================

/**
 * Score a position for a ranged attacker.
 *
 * Wants:
 *   - Range 3 from primary target (ideal attack range)
 *   - Range 3+ from melee hostiles (avoid getting hit)
 *   - Adjacent to healer partner (get healed)
 *   - Not on swamp (slow)
 *   - Not at room edge (dangerous)
 */
export function scoreRangedPosition(
  pos: RoomPosition,
  hostiles: Creep[],
  partner: Creep | null,
  target: Creep | null
): number {
  var score = 100; // Start with base score

  // Factor 1: Range to target (want exactly 3)
  if (target) {
    var targetRange = pos.getRangeTo(target);
    if (targetRange === 3) {
      score += 30; // Perfect range
    } else if (targetRange === 2) {
      score += 20; // Acceptable
    } else if (targetRange > 3) {
      score -= (targetRange - 3) * 10; // Too far, penalty
    } else {
      score -= 20; // Too close
    }
  }

  // Factor 2: Distance from melee hostiles (want 3+)
  for (var i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];
    if (hostile.getActiveBodyparts(ATTACK) === 0) continue;

    var meleeRange = pos.getRangeTo(hostile);
    if (meleeRange <= 1) {
      score -= 50; // Very bad, in melee range
    } else if (meleeRange === 2) {
      score -= 20; // Dangerous
    } else if (meleeRange >= 3) {
      score += 10; // Safe from melee
    }
  }

  // Factor 3: Distance from healer partner (want adjacent)
  if (partner) {
    var partnerRange = pos.getRangeTo(partner);
    if (partnerRange === 1) {
      score += 25; // Adjacent = full heal
    } else if (partnerRange <= 3) {
      score += 10; // Can get ranged heal
    } else {
      score -= 15; // Too far from healer
    }
  }

  // Factor 4: Edge penalty
  if (isEdgePosition(pos)) {
    score -= 30; // Avoid room edges
  }

  // Factor 5: Terrain penalty
  var terrain = Game.map.getRoomTerrain(pos.roomName);
  if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
    score -= 10; // Swamp slows movement
  }

  return score;
}

/**
 * Score a position for a healer.
 *
 * Wants:
 *   - Adjacent to heal target (full heal power)
 *   - Range 3+ from melee hostiles (stay safe)
 *   - Escape route available (2+ open adjacent tiles)
 */
export function scoreHealerPosition(
  pos: RoomPosition,
  healTarget: Creep,
  hostiles: Creep[]
): number {
  var score = 100;

  // Factor 1: Distance from heal target (want adjacent)
  var targetRange = pos.getRangeTo(healTarget);
  if (targetRange === 1) {
    score += 40; // Adjacent = full heal
  } else if (targetRange <= 3) {
    score += 10; // Can ranged heal
  } else {
    score -= 30; // Too far to heal
  }

  // Factor 2: Distance from melee hostiles
  for (var i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];
    if (hostile.getActiveBodyparts(ATTACK) === 0) continue;

    var meleeRange = pos.getRangeTo(hostile);
    if (meleeRange <= 1) {
      score -= 60; // Very dangerous
    } else if (meleeRange === 2) {
      score -= 30; // Risky
    } else if (meleeRange >= 4) {
      score += 10; // Safe
    }
  }

  // Factor 3: Edge penalty
  if (isEdgePosition(pos)) {
    score -= 20;
  }

  // Factor 4: Escape routes (open adjacent tiles)
  var openAdjacent = getOpenPositions(pos, 1).length;
  if (openAdjacent >= 4) {
    score += 15; // Good escape options
  } else if (openAdjacent <= 2) {
    score -= 15; // Cornered
  }

  return score;
}

// ============================================
// Position Utilities
// ============================================

/**
 * Get all walkable positions within range of a center point.
 */
export function getOpenPositions(
  center: RoomPosition,
  range: number,
  opts?: { excludeCreeps?: boolean; excludeSwamp?: boolean }
): RoomPosition[] {
  var positions: RoomPosition[] = [];
  var terrain = Game.map.getRoomTerrain(center.roomName);
  var room = Game.rooms[center.roomName];

  var minX = Math.max(1, center.x - range);
  var maxX = Math.min(48, center.x + range);
  var minY = Math.max(1, center.y - range);
  var maxY = Math.min(48, center.y + range);

  for (var x = minX; x <= maxX; x++) {
    for (var y = minY; y <= maxY; y++) {
      // Skip walls
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      // Skip swamps if requested
      if (opts && opts.excludeSwamp && terrain.get(x, y) === TERRAIN_MASK_SWAMP) {
        continue;
      }

      var pos = new RoomPosition(x, y, center.roomName);

      // Skip positions with creeps if requested
      if (opts && opts.excludeCreeps && room) {
        var atPos = room.lookForAt(LOOK_CREEPS, x, y);
        if (atPos.length > 0) continue;
      }

      positions.push(pos);
    }
  }

  return positions;
}

/**
 * Is this position at a room edge (x/y = 0 or 49)?
 */
export function isEdgePosition(pos: RoomPosition): boolean {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/**
 * Get threat direction vector.
 * Returns normalized direction pointing TOWARD hostiles.
 * Use negative for flee direction.
 */
export function getThreatVector(
  pos: RoomPosition,
  hostiles: Creep[]
): { x: number; y: number } {
  if (hostiles.length === 0) {
    return { x: 0, y: 0 };
  }

  var sumX = 0;
  var sumY = 0;

  for (var i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];
    sumX += hostile.pos.x - pos.x;
    sumY += hostile.pos.y - pos.y;
  }

  // Normalize
  var magnitude = Math.sqrt(sumX * sumX + sumY * sumY);
  if (magnitude === 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: sumX / magnitude,
    y: sumY / magnitude,
  };
}

/**
 * Get direction to flee from hostiles.
 * Returns the best direction constant to move away.
 */
export function getFleeDirection(
  pos: RoomPosition,
  hostiles: Creep[]
): DirectionConstant | null {
  if (hostiles.length === 0) return null;

  var threatVec = getThreatVector(pos, hostiles);

  // Flee in opposite direction
  var fleeX = -threatVec.x;
  var fleeY = -threatVec.y;

  // Convert to direction constant
  // Screeps directions: TOP=1, TOP_RIGHT=2, ... LEFT=8
  if (Math.abs(fleeX) < 0.3 && Math.abs(fleeY) < 0.3) {
    return null; // No clear direction
  }

  if (fleeY < -0.3) {
    // Moving up (north)
    if (fleeX > 0.3) return TOP_RIGHT;
    if (fleeX < -0.3) return TOP_LEFT;
    return TOP;
  } else if (fleeY > 0.3) {
    // Moving down (south)
    if (fleeX > 0.3) return BOTTOM_RIGHT;
    if (fleeX < -0.3) return BOTTOM_LEFT;
    return BOTTOM;
  } else {
    // Moving horizontally
    if (fleeX > 0) return RIGHT;
    return LEFT;
  }
}

// ============================================
// Combat Action Helpers
// ============================================

/**
 * Determine best attack action for a ranged creep.
 * Uses rangedMassAttack when multiple targets close, single target otherwise.
 */
export function getBestRangedAttack(
  creep: Creep,
  hostiles: Creep[],
  primaryTarget: Creep | null
): { action: "single" | "mass" | "none"; target: Creep | null } {
  if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) {
    return { action: "none", target: null };
  }

  // Count hostiles in mass attack range
  var inRange1 = 0;
  var inRange3 = 0;

  for (var i = 0; i < hostiles.length; i++) {
    var range = creep.pos.getRangeTo(hostiles[i]);
    if (range <= 1) inRange1++;
    if (range <= 3) inRange3++;
  }

  // No targets in range
  if (inRange3 === 0) {
    return { action: "none", target: null };
  }

  // Mass attack if multiple hostiles at range 1
  // (mass attack does 10 at range 0, 4 at range 1, 1 at range 2)
  if (inRange1 >= 2) {
    return { action: "mass", target: null };
  }

  // Single target attack
  var target = primaryTarget;
  if (!target || creep.pos.getRangeTo(target) > 3) {
    target = findBestTarget(hostiles, creep.pos);
  }

  return { action: "single", target: target };
}

/**
 * Check if creep should kite (move away from melee hostiles).
 */
export function shouldKite(creep: Creep, hostiles: Creep[]): boolean {
  for (var i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];
    if (hostile.getActiveBodyparts(ATTACK) === 0) continue;

    if (creep.pos.getRangeTo(hostile) <= COMBAT.FLEE_TRIGGER_RANGE) {
      return true;
    }
  }
  return false;
}

/**
 * Get PathFinder goals for fleeing from hostiles.
 */
export function getFleeGoals(
  hostiles: Creep[],
  fleeRange?: number
): { pos: RoomPosition; range: number }[] {
  var range = fleeRange || COMBAT.FLEE_TARGET_RANGE;
  var goals: { pos: RoomPosition; range: number }[] = [];

  for (var i = 0; i < hostiles.length; i++) {
    goals.push({ pos: hostiles[i].pos, range: range });
  }

  return goals;
}
