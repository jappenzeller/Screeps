import { LogLevel } from "./utils/Logger";

export const CONFIG = {
  // Logging
  LOG_LEVEL: LogLevel.INFO,

  // Spawning priorities (lower = higher priority)
  SPAWN_PRIORITY: {
    HARVESTER: 1,
    HAULER: 2,
    SCOUT: 3, // Intel gathering before extra upgraders
    UPGRADER: 4,
    BUILDER: 5,
    DEFENDER: 6,
    REMOTE_DEFENDER: 7,
    REMOTE_DEFENDER_RANGED: 8,
    RESERVER: 9,
    REMOTE_MINER: 10,
    REMOTE_HAULER: 11,
    CLAIMER: 12,
    LINK_FILLER: 13,
  } as const,

  // Minimum creep counts per room
  MIN_CREEPS: {
    HARVESTER: 2,
    HAULER: 2,
    UPGRADER: 2,
    BUILDER: 2,
    DEFENDER: 0, // Spawned on demand when hostiles detected
    SCOUT: 1,
    REMOTE_MINER: 0, // Spawned when remote mining enabled
  } as const,

  // Maximum creep counts per room
  MAX_CREEPS: {
    HARVESTER: 4,
    HAULER: 4,
    UPGRADER: 4,
    BUILDER: 3,
    DEFENDER: 3,
    SCOUT: 1,
    REMOTE_MINER: 4,
  } as const,

  // Energy thresholds
  ENERGY: {
    // Start spawning upgraders when energy > this
    UPGRADE_THRESHOLD: 500,
    // Start spawning builders when construction sites exist
    BUILD_THRESHOLD: 300,

    // Storage thresholds for utility scaling
    STORAGE_THRESHOLDS: {
      low: 50000, // Below this: conservation mode
      target: 200000, // Optimal operating level
      high: 400000, // Above this: burn excess
    },

    // Metrics smoothing
    RATE_SMOOTHING_ALPHA: 0.1, // Lower = more smoothing (slower response)
  } as const,

  // Spawning configuration
  SPAWNING: {
    // TTL threshold for replacement spawning
    REPLACEMENT_TTL: 100,

    // TTL threshold for remote roles (need travel time buffer)
    REMOTE_REPLACEMENT_TTL: 200,

    // Base utility scores (before modifiers)
    BASE_UTILITY: {
      HARVESTER: 100, // Critical - economy foundation
      HAULER: 90, // Critical - energy distribution
      UPGRADER: 20, // Important but deferrable
      BUILDER: 25, // Construction
      DEFENDER: 50, // Defense when needed
      REMOTE_MINER: 40, // Expansion
      REMOTE_HAULER: 35, // Support remote mining
      REMOTE_DEFENDER: 45, // Protect remotes
      REMOTE_DEFENDER_RANGED: 40, // Support melee defenders
      RESERVER: 25, // Maintain reservations
      LINK_FILLER: 70, // Infrastructure
      SCOUT: 25, // Intel gathering - spawn before second upgrader
      MINERAL_HARVESTER: 15, // Luxury - future value for labs
    },

    // Optimal counts by RCL (role -> [rcl1, rcl2, ..., rcl8])
    OPTIMAL_COUNTS: {
      HARVESTER: [2, 2, 2, 2, 2, 2, 2, 2],
      HAULER: [1, 2, 2, 2, 2, 2, 3, 3],
      UPGRADER: [1, 2, 2, 3, 3, 3, 4, 2], // Lower at RCL8 (15/tick cap)
    },
  } as const,

  // Visual debugging
  VISUALS: {
    ENABLED: true,
    SHOW_ROLES: true,
    SHOW_TARGETS: true,
  } as const,

  // Memory cleanup interval (ticks)
  MEMORY_CLEANUP_INTERVAL: 100,
} as const;

export type Role = keyof typeof CONFIG.SPAWN_PRIORITY;
