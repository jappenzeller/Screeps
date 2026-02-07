/**
 * CombatBodyBuilder - Specialized body generation for combat roles
 *
 * Provides utility functions for building combat-optimized bodies.
 * Handles part ordering (TOUGH first, primary parts, MOVE last) and
 * scaling based on available energy.
 */

import { BODY_CONFIGS, BodyConfig } from "../spawning/bodyConfig";

// ============================================
// Types
// ============================================

export interface CombatBodyInfo {
  body: BodyPartConstant[];
  cost: number;
  stats: {
    rangedDPS: number;
    meleeDPS: number;
    healHPS: number;
    rangedHealHPS: number;
    toughHP: number;
    moveRatio: number; // Ratio of MOVE to other parts
  };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Calculate the cost of a body.
 */
export function getBodyCost(body: BodyPartConstant[]): number {
  var cost = 0;
  for (var i = 0; i < body.length; i++) {
    cost += BODYPART_COST[body[i]];
  }
  return cost;
}

/**
 * Calculate combat stats for a body.
 */
export function getBodyStats(body: BodyPartConstant[]): CombatBodyInfo["stats"] {
  var rangedParts = 0;
  var attackParts = 0;
  var healParts = 0;
  var toughParts = 0;
  var moveParts = 0;
  var otherParts = 0;

  for (var i = 0; i < body.length; i++) {
    switch (body[i]) {
      case RANGED_ATTACK: rangedParts++; break;
      case ATTACK: attackParts++; break;
      case HEAL: healParts++; break;
      case TOUGH: toughParts++; break;
      case MOVE: moveParts++; break;
      default: otherParts++; break;
    }
  }

  var nonMoveParts = body.length - moveParts;

  return {
    rangedDPS: rangedParts * 10,
    meleeDPS: attackParts * 30,
    healHPS: healParts * 12,
    rangedHealHPS: healParts * 4,
    toughHP: toughParts * 100,
    moveRatio: nonMoveParts > 0 ? moveParts / nonMoveParts : 0,
  };
}

/**
 * Sort body parts for combat optimization.
 * Order: TOUGH > ATTACK > RANGED_ATTACK > WORK > CARRY > CLAIM > HEAL > MOVE
 * This puts damage-absorbing parts first and MOVE/HEAL last (they survive longest).
 */
export function sortBodyForCombat(body: BodyPartConstant[]): BodyPartConstant[] {
  var partOrder: Record<string, number> = {
    [TOUGH]: 1,
    [ATTACK]: 2,
    [RANGED_ATTACK]: 3,
    [WORK]: 4,
    [CARRY]: 5,
    [CLAIM]: 6,
    [HEAL]: 7,
    [MOVE]: 8,
  };

  return body.slice().sort(function(a, b) {
    return (partOrder[a] || 99) - (partOrder[b] || 99);
  });
}

// ============================================
// Body Building
// ============================================

/**
 * Build a body from config, scaled to available energy.
 * Combat-optimized: sorts parts if configured.
 */
export function buildCombatBody(
  role: "RANGED_ATTACKER" | "COMBAT_HEALER",
  energy: number
): CombatBodyInfo | null {
  var config = BODY_CONFIGS[role];
  if (!config) return null;

  // Check minimum energy
  if (config.minEnergy && energy < config.minEnergy) {
    return null;
  }

  // Start with prefix
  var body: BodyPartConstant[] = [];
  var cost = 0;

  if (config.prefix) {
    for (var i = 0; i < config.prefix.length; i++) {
      body.push(config.prefix[i]);
      cost += BODYPART_COST[config.prefix[i]];
    }
  }

  // Add suffix parts (reserve energy for them)
  var suffixCost = 0;
  if (config.suffix) {
    for (var j = 0; j < config.suffix.length; j++) {
      suffixCost += BODYPART_COST[config.suffix[j]];
    }
  }

  // Calculate pattern cost
  var patternCost = 0;
  for (var k = 0; k < config.pattern.length; k++) {
    patternCost += BODYPART_COST[config.pattern[k]];
  }

  // Add as many pattern repeats as we can afford
  var maxRepeats = config.maxRepeats || 25;
  var repeats = 0;
  var remainingEnergy = energy - cost - suffixCost;

  while (
    repeats < maxRepeats &&
    remainingEnergy >= patternCost &&
    body.length + config.pattern.length + (config.suffix?.length || 0) <= 50
  ) {
    for (var m = 0; m < config.pattern.length; m++) {
      body.push(config.pattern[m]);
      cost += BODYPART_COST[config.pattern[m]];
    }
    remainingEnergy -= patternCost;
    repeats++;
  }

  // Add suffix
  if (config.suffix) {
    for (var n = 0; n < config.suffix.length; n++) {
      if (body.length < 50) {
        body.push(config.suffix[n]);
        cost += BODYPART_COST[config.suffix[n]];
      }
    }
  }

  // If no pattern repeats were possible but energy >= minEnergy, use fallback
  if (repeats === 0 && config.fallback) {
    body = config.fallback.slice();
    cost = getBodyCost(body);
  }

  // Sort for combat if configured
  if (config.sortForCombat) {
    body = sortBodyForCombat(body);
  }

  return {
    body: body,
    cost: cost,
    stats: getBodyStats(body),
  };
}

/**
 * Get ranged attacker body for available energy.
 */
export function getRangedAttackerBody(energy: number): CombatBodyInfo | null {
  return buildCombatBody("RANGED_ATTACKER", energy);
}

/**
 * Get combat healer body for available energy.
 */
export function getCombatHealerBody(energy: number): CombatBodyInfo | null {
  return buildCombatBody("COMBAT_HEALER", energy);
}

/**
 * Estimate combat effectiveness for a duo.
 * Returns a score based on combined stats.
 */
export function estimateDuoEffectiveness(energy: number): {
  attackerBody: CombatBodyInfo | null;
  healerBody: CombatBodyInfo | null;
  combinedDPS: number;
  combinedHPS: number;
  canDefeatInvaderPair: boolean;
  canSurvivePlayerRaid: boolean;
} {
  var attacker = getRangedAttackerBody(energy);
  var healer = getCombatHealerBody(energy);

  var combinedDPS = 0;
  var combinedHPS = 0;

  if (attacker) {
    combinedDPS += attacker.stats.rangedDPS;
    combinedHPS += attacker.stats.healHPS; // If attacker has HEAL parts
  }

  if (healer) {
    combinedHPS += healer.stats.healHPS;
  }

  // Standard invader pair: ~40 DPS, requires ~40 HPS to sustain
  // Need to outdamage their ~200 HP faster than they can hurt us
  var canDefeatInvaderPair = combinedDPS >= 60 && combinedHPS >= 40;

  // Player raid: Varies wildly, but 100 HPS can sustain most attacks
  // Need enough DPS to threaten them back
  var canSurvivePlayerRaid = combinedHPS >= 100 && combinedDPS >= 80;

  return {
    attackerBody: attacker,
    healerBody: healer,
    combinedDPS: combinedDPS,
    combinedHPS: combinedHPS,
    canDefeatInvaderPair: canDefeatInvaderPair,
    canSurvivePlayerRaid: canSurvivePlayerRaid,
  };
}

/**
 * Get minimum energy needed for effective combat duo.
 * Returns the energy threshold where duo can handle invaders.
 */
export function getMinEffectiveEnergy(): number {
  // Test energy levels to find minimum effective threshold
  for (var energy = 500; energy <= 3000; energy += 100) {
    var estimate = estimateDuoEffectiveness(energy);
    if (estimate.canDefeatInvaderPair) {
      return energy;
    }
  }
  return 1500; // Fallback estimate
}
