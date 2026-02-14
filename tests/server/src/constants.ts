/**
 * Screeps Constants for Node.js Test Environment
 *
 * These mirror the Screeps game constants for use in scenario definitions
 * without requiring @types/screeps (which assumes browser/Screeps runtime).
 */

// ============================================
// Body Part Types
// ============================================

export const WORK = "work";
export const CARRY = "carry";
export const MOVE = "move";
export const ATTACK = "attack";
export const RANGED_ATTACK = "ranged_attack";
export const HEAL = "heal";
export const CLAIM = "claim";
export const TOUGH = "tough";

export type BodyPartType =
  | typeof WORK
  | typeof CARRY
  | typeof MOVE
  | typeof ATTACK
  | typeof RANGED_ATTACK
  | typeof HEAL
  | typeof CLAIM
  | typeof TOUGH;

// ============================================
// Body Part Costs
// ============================================

export const BODYPART_COST: Record<BodyPartType, number> = {
  [MOVE]: 50,
  [WORK]: 100,
  [CARRY]: 50,
  [ATTACK]: 80,
  [RANGED_ATTACK]: 150,
  [HEAL]: 250,
  [CLAIM]: 600,
  [TOUGH]: 10,
};

// ============================================
// Structure Types
// ============================================

export const STRUCTURE_SPAWN = "spawn";
export const STRUCTURE_EXTENSION = "extension";
export const STRUCTURE_ROAD = "road";
export const STRUCTURE_WALL = "constructedWall";
export const STRUCTURE_RAMPART = "rampart";
export const STRUCTURE_KEEPER_LAIR = "keeperLair";
export const STRUCTURE_PORTAL = "portal";
export const STRUCTURE_CONTROLLER = "controller";
export const STRUCTURE_LINK = "link";
export const STRUCTURE_STORAGE = "storage";
export const STRUCTURE_TOWER = "tower";
export const STRUCTURE_OBSERVER = "observer";
export const STRUCTURE_POWER_BANK = "powerBank";
export const STRUCTURE_POWER_SPAWN = "powerSpawn";
export const STRUCTURE_EXTRACTOR = "extractor";
export const STRUCTURE_LAB = "lab";
export const STRUCTURE_TERMINAL = "terminal";
export const STRUCTURE_CONTAINER = "container";
export const STRUCTURE_NUKER = "nuker";
export const STRUCTURE_FACTORY = "factory";
export const STRUCTURE_INVADER_CORE = "invaderCore";

export type StructureType =
  | typeof STRUCTURE_SPAWN
  | typeof STRUCTURE_EXTENSION
  | typeof STRUCTURE_ROAD
  | typeof STRUCTURE_WALL
  | typeof STRUCTURE_RAMPART
  | typeof STRUCTURE_KEEPER_LAIR
  | typeof STRUCTURE_PORTAL
  | typeof STRUCTURE_CONTROLLER
  | typeof STRUCTURE_LINK
  | typeof STRUCTURE_STORAGE
  | typeof STRUCTURE_TOWER
  | typeof STRUCTURE_OBSERVER
  | typeof STRUCTURE_POWER_BANK
  | typeof STRUCTURE_POWER_SPAWN
  | typeof STRUCTURE_EXTRACTOR
  | typeof STRUCTURE_LAB
  | typeof STRUCTURE_TERMINAL
  | typeof STRUCTURE_CONTAINER
  | typeof STRUCTURE_NUKER
  | typeof STRUCTURE_FACTORY
  | typeof STRUCTURE_INVADER_CORE;

// ============================================
// Find Constants
// ============================================

export const FIND_EXIT_TOP = 1;
export const FIND_EXIT_RIGHT = 3;
export const FIND_EXIT_BOTTOM = 5;
export const FIND_EXIT_LEFT = 7;
export const FIND_EXIT = 10;
export const FIND_CREEPS = 101;
export const FIND_MY_CREEPS = 102;
export const FIND_HOSTILE_CREEPS = 103;
export const FIND_SOURCES_ACTIVE = 104;
export const FIND_SOURCES = 105;
export const FIND_DROPPED_RESOURCES = 106;
export const FIND_STRUCTURES = 107;
export const FIND_MY_STRUCTURES = 108;
export const FIND_HOSTILE_STRUCTURES = 109;
export const FIND_FLAGS = 110;
export const FIND_CONSTRUCTION_SITES = 111;
export const FIND_MY_SPAWNS = 112;
export const FIND_HOSTILE_SPAWNS = 113;
export const FIND_MY_CONSTRUCTION_SITES = 114;
export const FIND_HOSTILE_CONSTRUCTION_SITES = 115;
export const FIND_MINERALS = 116;
export const FIND_NUKES = 117;
export const FIND_TOMBSTONES = 118;
export const FIND_POWER_CREEPS = 119;
export const FIND_MY_POWER_CREEPS = 120;
export const FIND_HOSTILE_POWER_CREEPS = 121;
export const FIND_DEPOSITS = 122;
export const FIND_RUINS = 123;

// ============================================
// Resource Types
// ============================================

export const RESOURCE_ENERGY = "energy";
export const RESOURCE_POWER = "power";

// ============================================
// Room Terrain
// ============================================

export const TERRAIN_MASK_WALL = 1;
export const TERRAIN_MASK_SWAMP = 2;
export const TERRAIN_MASK_LAVA = 4;

// ============================================
// Direction Constants
// ============================================

export const TOP = 1;
export const TOP_RIGHT = 2;
export const RIGHT = 3;
export const BOTTOM_RIGHT = 4;
export const BOTTOM = 5;
export const BOTTOM_LEFT = 6;
export const LEFT = 7;
export const TOP_LEFT = 8;

// ============================================
// Return Codes
// ============================================

export const OK = 0;
export const ERR_NOT_OWNER = -1;
export const ERR_NO_PATH = -2;
export const ERR_NAME_EXISTS = -3;
export const ERR_BUSY = -4;
export const ERR_NOT_FOUND = -5;
export const ERR_NOT_ENOUGH_RESOURCES = -6;
export const ERR_NOT_ENOUGH_ENERGY = -6;
export const ERR_INVALID_TARGET = -7;
export const ERR_FULL = -8;
export const ERR_NOT_IN_RANGE = -9;
export const ERR_INVALID_ARGS = -10;
export const ERR_TIRED = -11;
export const ERR_NO_BODYPART = -12;
export const ERR_NOT_ENOUGH_EXTENSIONS = -6;
export const ERR_RCL_NOT_ENOUGH = -14;
export const ERR_GCL_NOT_ENOUGH = -15;

// ============================================
// Game Constants
// ============================================

export const CREEP_LIFE_TIME = 1500;
export const CREEP_SPAWN_TIME = 3; // Ticks per body part

export const SOURCE_ENERGY_CAPACITY = 3000;
export const SOURCE_ENERGY_NEUTRAL_CAPACITY = 1500;
export const SOURCE_ENERGY_KEEPER_CAPACITY = 4000;

export const CONTROLLER_LEVELS: Record<number, number> = {
  1: 200,
  2: 45000,
  3: 135000,
  4: 405000,
  5: 1215000,
  6: 3645000,
  7: 10935000,
  8: Infinity,
};

export const CONTROLLER_STRUCTURES: Record<string, Record<number, number>> = {
  spawn: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
  extension: { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
  link: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 },
  road: { 0: 2500, 1: 2500, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
  constructedWall: { 0: 0, 1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
  rampart: { 0: 0, 1: 0, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
  storage: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
  tower: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
  observer: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
  powerSpawn: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
  extractor: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 },
  terminal: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 },
  lab: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3, 7: 6, 8: 10 },
  container: { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5 },
  nuker: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
  factory: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 1, 8: 1 },
};

// Extension energy capacity by RCL
export const EXTENSION_ENERGY_CAPACITY: Record<number, number> = {
  0: 50,
  1: 50,
  2: 50,
  3: 50,
  4: 50,
  5: 50,
  6: 50,
  7: 100,
  8: 200,
};

// Spawn energy capacity
export const SPAWN_ENERGY_CAPACITY = 300;

// Storage capacity
export const STORAGE_CAPACITY = 1000000;

// Container capacity
export const CONTAINER_CAPACITY = 2000;

// ============================================
// Standard Body Templates
// ============================================

export const STANDARD_BODIES = {
  HARVESTER_SMALL: [WORK, CARRY, MOVE] as BodyPartType[],
  HARVESTER_MEDIUM: [WORK, WORK, WORK, CARRY, MOVE, MOVE] as BodyPartType[],
  HARVESTER_FULL: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE] as BodyPartType[],
  HAULER_SMALL: [CARRY, MOVE] as BodyPartType[],
  HAULER_MEDIUM: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  UPGRADER_SMALL: [WORK, CARRY, MOVE] as BodyPartType[],
  DEFENDER_SMALL: [TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE] as BodyPartType[],
  DEFENDER_MEDIUM: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  INVADER_MELEE: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  INVADER_HEALER: [TOUGH, TOUGH, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
};

// ============================================
// Utility Functions
// ============================================

/**
 * Calculate the energy cost of a body
 */
export function bodyCost(body: BodyPartType[]): number {
  return body.reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
}

/**
 * Count parts of a specific type in a body
 */
export function countParts(body: BodyPartType[], type: BodyPartType): number {
  return body.filter((p) => p === type).length;
}

/**
 * Calculate spawn time for a body (3 ticks per part)
 */
export function spawnTime(body: BodyPartType[]): number {
  return body.length * CREEP_SPAWN_TIME;
}

/**
 * Calculate energy capacity at a given RCL
 */
export function energyCapacityAtRCL(rcl: number): number {
  const spawns = CONTROLLER_STRUCTURES.spawn[rcl] || 0;
  const extensions = CONTROLLER_STRUCTURES.extension[rcl] || 0;
  const extensionCapacity = EXTENSION_ENERGY_CAPACITY[rcl] || 50;
  return spawns * SPAWN_ENERGY_CAPACITY + extensions * extensionCapacity;
}
