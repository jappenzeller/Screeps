/**
 * Screeps Game Constants
 */

export const BODYPART_COST: Record<string, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10,
};

export const CREEP_LIFE_TIME = 1500;
export const SPAWN_TICKS_PER_PART = 3;
export const WORK_HARVEST_RATE = 2;  // Energy per WORK part per tick
export const SOURCE_ENERGY_RATE = 10;  // Max energy per source per tick (5 WORK saturates)
export const CARRY_CAPACITY = 50;  // Per CARRY part

// Renewal
export const RENEW_TTL_THRESHOLD = 200;  // Consider renewal below this
export const RENEW_TICKS_PER_BODY_PART = 0.6;  // Approximate ticks per renewal action

// RCL to energy capacity mapping
export const RCL_ENERGY_CAPACITY: Record<number, number> = {
  1: 300,
  2: 550,
  3: 800,
  4: 1300,
  5: 1800,
  6: 2300,
  7: 5600,
  8: 12900,
};

// Body templates for reference
export const BODY_TEMPLATES = {
  HARVESTER_MIN: ['work', 'carry', 'move'],  // 200 energy
  HARVESTER_STATIC: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'],  // 700 energy
  HAULER_SMALL: ['carry', 'carry', 'move', 'move'],  // 200 energy
  HAULER_MEDIUM: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'],  // 400 energy
  UPGRADER_MIN: ['work', 'carry', 'move'],  // 200 energy
  BUILDER_MIN: ['work', 'carry', 'move'],  // 200 energy
  SCOUT: ['move'],  // 50 energy
  REMOTE_MINER: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'],  // 700 energy
  REMOTE_HAULER: ['carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move', 'move', 'move'],  // 600 energy
  RESERVER: ['claim', 'claim', 'move', 'move'],  // 1300 energy
};

export function calculateBodyCost(body: string[]): number {
  return body.reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
}

export function countParts(body: string[], type: string): number {
  return body.filter(p => p === type).length;
}

export function getCarryCapacity(body: string[]): number {
  return countParts(body, 'carry') * CARRY_CAPACITY;
}
