/**
 * Combat Constants
 *
 * Centralized values for combat calculations.
 * Based on Screeps game mechanics.
 */

export const COMBAT = {
  // === Damage Output ===
  ATTACK_DAMAGE: 30,           // Per ATTACK part per tick (melee)
  RANGED_DAMAGE: 10,           // Per RANGED_ATTACK part per tick (single target)
  RANGED_MASS_DAMAGE: [10, 4, 1], // rangedMassAttack damage at range [0, 1, 2]

  // === Healing ===
  HEAL_ADJACENT: 12,           // Per HEAL part per tick (range 1)
  HEAL_RANGED: 4,              // Per HEAL part per tick (range 2-3)

  // === TOUGH Damage Reduction (with boosts) ===
  // Unboosted TOUGH: no reduction (just HP soak)
  // T1 (GO): 30% reduction
  // T2 (GHO2): 50% reduction
  // T3 (XGHO2): 70% reduction
  TOUGH_REDUCTION_T0: 1.0,     // No boost - full damage
  TOUGH_REDUCTION_T1: 0.7,     // GO boost
  TOUGH_REDUCTION_T2: 0.5,     // GHO2 boost
  TOUGH_REDUCTION_T3: 0.3,     // XGHO2 boost

  // === Tactical Ranges ===
  MELEE_RANGE: 1,              // ATTACK parts work at this range
  RANGED_RANGE: 3,             // RANGED_ATTACK parts work up to this range
  HEAL_ADJACENT_RANGE: 1,      // Full heal power
  HEAL_RANGED_RANGE: 3,        // Reduced heal power

  // === Kiting Thresholds ===
  KITE_RANGE: 3,               // Ideal range for ranged attackers
  FLEE_TRIGGER_RANGE: 2,       // If melee hostile this close, kite away
  FLEE_TARGET_RANGE: 4,        // Flee until this range from hostiles

  // === Retreat Thresholds ===
  RETREAT_HP_CRITICAL: 0.2,    // 20% HP - critical for NPCs
  RETREAT_HP_PLAYER: 0.4,      // 40% HP - more conservative vs players
  RETREAT_NET_DAMAGE_THRESHOLD: 10, // Min net DPS to trigger retreat

  // === Target Priority Weights ===
  // Higher = shoot first
  PRIORITY_HEALER: 100,        // Kill healers first!
  PRIORITY_RANGED: 50,         // Ranged attackers second
  PRIORITY_ATTACK: 30,         // Melee attackers third
  PRIORITY_WORK: 10,           // Workers/dismantlers last
  PRIORITY_CLAIM: 5,           // Claimers very low priority
  PRIORITY_BASE: 1,            // Any other parts

  // === Body Part Costs (for calculations) ===
  COST_TOUGH: 10,
  COST_MOVE: 50,
  COST_CARRY: 50,
  COST_ATTACK: 80,
  COST_RANGED_ATTACK: 150,
  COST_HEAL: 250,
  COST_CLAIM: 600,
  COST_WORK: 100,

  // === HP Values ===
  HP_PER_PART: 100,            // Each body part has 100 HP

  // === Timing ===
  TARGET_STALE_TICKS: 100,     // Clear target tracking after this many ticks
  THREAT_CACHE_TTL: 10,        // Refresh threat cache every N ticks
  INTEL_STALE_TICKS: 200,      // Consider room intel stale after this

  // === Squad/Duo ===
  DUO_RALLY_RANGE: 5,          // Max distance between duo members when rallying
  SQUAD_TIMEOUT_TICKS: 2000,   // Disband squad after this many ticks
};

// NPC owners that use predictable AI
export const NPC_OWNERS = ["Invader", "Source Keeper"];

/**
 * Check if a creep owner is an NPC (predictable behavior)
 */
export function isNPC(owner: string): boolean {
  return NPC_OWNERS.includes(owner);
}

/**
 * Check if all hostiles are NPCs
 */
export function allHostilesAreNPC(hostiles: Creep[]): boolean {
  for (var i = 0; i < hostiles.length; i++) {
    if (!isNPC(hostiles[i].owner.username)) {
      return false;
    }
  }
  return true;
}
