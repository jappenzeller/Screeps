/**
 * Opportunistic Creep Renewal Manager
 *
 * Renews creeps that happen to be near spawn when spawn is idle.
 * No forced travel - creeps continue normal work and get renewed as they pass by.
 *
 * Renewal mechanics:
 * - Cost per tick: ceil(creep_cost / 2.5 / body_parts)
 * - TTL gain per tick: floor(600 / body_parts)
 *
 * Example 46-part hauler (2300 energy):
 * - Cost: ceil(2300 / 2.5 / 46) = 20 energy/tick
 * - Gain: floor(600 / 46) = 13 TTL/tick
 */

export class RenewalManager {
  private room: Room;
  private spawn: StructureSpawn | null;

  constructor(room: Room) {
    this.room = room;
    const spawns = room.find(FIND_MY_SPAWNS);
    this.spawn = spawns.length > 0 ? spawns[0] : null;
  }

  /**
   * Run opportunistic renewal - call each tick BEFORE spawn decisions
   * Returns true if actively renewing (spawn is busy)
   */
  run(): boolean {
    if (!this.spawn) return false;

    // Can't renew while spawning
    if (this.spawn.spawning) return false;

    // Need energy to renew
    if (this.room.energyAvailable < 50) return false;

    // Find best candidate near spawn
    const candidate = this.findBestCandidateNearSpawn();
    if (!candidate) return false;

    // Attempt renewal
    const result = this.spawn.renewCreep(candidate);

    if (result === OK) {
      // Visual feedback
      this.spawn.room.visual.text(
        `♻️ ${candidate.name.substring(0, 8)}`,
        this.spawn.pos.x,
        this.spawn.pos.y - 1,
        { font: 0.4, color: "#00ff00" }
      );
      return true; // Renewed this tick, spawn is "busy"
    }

    return false;
  }

  /**
   * Find the best creep to renew that's already near spawn
   */
  private findBestCandidateNearSpawn(): Creep | null {
    if (!this.spawn) return null;

    const nearbyCreeps = this.spawn.pos.findInRange(FIND_MY_CREEPS, 1);

    if (nearbyCreeps.length === 0) return null;

    let bestCreep: Creep | null = null;
    let bestScore = 0;

    for (const creep of nearbyCreeps) {
      const score = this.getRenewalScore(creep);
      if (score > bestScore) {
        bestScore = score;
        bestCreep = creep;
      }
    }

    return bestCreep;
  }

  /**
   * Score how valuable it is to renew this creep
   * Returns 0 if shouldn't renew, higher = more valuable
   */
  private getRenewalScore(creep: Creep): number {
    const ttl = creep.ticksToLive;
    if (!ttl) return 0;

    // Don't renew if already near max (leave some buffer)
    if (ttl >= 1400) return 0;

    // Only skip cheap haulers - expensive ones are worth renewing
    if (creep.memory.role === "HAULER") {
      var haulerCost = this.getCreepCost(creep);
      if (haulerCost < 800) return 0; // Cheap hauler, not worth it
      // Expensive hauler — allow renewal but with a lower score multiplier
      // to deprioritize vs harvesters/upgraders (applied later)
    }

    const bodyParts = creep.body.length;
    const creepCost = this.getCreepCost(creep);
    const capacity = this.room.energyCapacityAvailable;

    // Skip cheap/small creeps - not worth spawn time
    // Also skip undersized creeps that should be replaced with bigger ones
    if (bodyParts < 10 || creepCost < 500 || creepCost < capacity * 0.5) return 0;

    // Calculate renewal metrics
    const ttlGain = Math.floor(600 / bodyParts);
    const renewCost = Math.ceil(creepCost / 2.5 / bodyParts);

    // Base score: how much TTL room we have
    const ttlRoom = 1500 - ttl;

    // Weight by creep value (expensive creeps more valuable to renew)
    const valueWeight = creepCost / 1000;

    // Weight by urgency (lower TTL = more urgent)
    const urgencyWeight = ttl < 300 ? 2 : ttl < 500 ? 1.5 : 1;

    // Weight by size (bigger creeps save more spawn time)
    const sizeWeight = bodyParts / 20;

    // Efficiency: TTL gained per energy spent
    const efficiency = ttlGain / renewCost;

    return ttlRoom * valueWeight * urgencyWeight * sizeWeight * efficiency;
  }

  /**
   * Get total cost of creep body
   */
  private getCreepCost(creep: Creep): number {
    return creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
  }
}

/**
 * Check if a creep should emergency-travel to spawn for renewal
 * Only for critical creeps with very low TTL that are the last of their kind
 */
export function shouldEmergencyRenew(creep: Creep): boolean {
  const ttl = creep.ticksToLive || 0;
  const bodyParts = creep.body.length;
  const role = creep.memory.role;

  // Only for large, stationary roles (not haulers - they're cheap and mobile)
  if (bodyParts < 30) return false;
  if (role !== "HARVESTER") return false;

  // Only if TTL is critically low
  if (ttl > 150) return false;

  // Only if we're the last one with healthy TTL
  const healthyCount = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.role === role &&
      c.memory.room === creep.memory.room &&
      c.name !== creep.name &&
      (c.ticksToLive || 0) > 200
  ).length;

  return healthyCount === 0; // We're the last healthy one
}
