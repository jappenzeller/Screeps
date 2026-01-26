import { LogLevel } from "./utils/Logger";

export const CONFIG = {
  // Logging
  LOG_LEVEL: LogLevel.INFO,

  // Spawning priorities (lower = higher priority)
  SPAWN_PRIORITY: {
    HARVESTER: 1,
    HAULER: 2,
    UPGRADER: 3,
    BUILDER: 4,
    DEFENDER: 5,
    REMOTE_DEFENDER: 6,
    RESERVER: 7,
    REMOTE_MINER: 8,
    REMOTE_HAULER: 9,
    SCOUT: 10,
    CLAIMER: 11,
    LINK_FILLER: 12,
    UPGRADE_HAULER: 13,
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
