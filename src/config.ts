import { LogLevel } from "./utils/Logger";

export const CONFIG = {
  // Logging
  LOG_LEVEL: LogLevel.INFO,


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
    // BASE_UTILITY lived here and is gone. It was one of three tables of the same
    // constants; the hardcoded literals inside each utility function shadowed it, so
    // tuning it did nothing for six roles, and it had drifted out of agreement with live
    // behaviour on four more. The single table is WeightTable.spawning.basePriority,
    // read via basePriority() - it is the one the AI advisor can actually write to.


    // OPTIMAL_COUNTS was here and had no readers at all - target counts are computed
    // per-role in utilitySpawning and declared in WeightTable.spawning.roles. Dead
    // configuration is worse than none: it reads as the knob to turn.

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

// NOTE: SPAWN_PRIORITY and the Role type derived from it were removed. Spawning has been
// utility-scored since src/spawning/utilitySpawning.ts replaced static priorities; the
// table was referenced nowhere and described a design that no longer exists. SpawnRole in
// utilitySpawning.ts is the live role union.
