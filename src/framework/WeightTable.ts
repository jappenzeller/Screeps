/**
 * WeightTable - AI-tunable parameters for bot behavior
 *
 * The entire bot's behavior is parameterized through this weight table.
 * The AI advisor tunes weights; game code reads them.
 *
 * Weights are loaded from Memory.empire.weights if present,
 * otherwise defaults are used.
 */

import { WeightTable, WeightPatch, RoleConfig, StructureTypeConfig } from "./types";
import { logger } from "../utils/Logger";

// ============================================================================
// DEFAULT WEIGHT TABLE
// ============================================================================

/**
 * Default weights - sensible starting values.
 * These can be overridden by AI advisor or manual console commands.
 */
export const DEFAULT_WEIGHTS: WeightTable = {
  version: 1,
  updatedAt: 0,
  updatedBy: "default",

  // ========== SPAWNING WEIGHTS ==========
  spawning: {
    basePriority: {
      HARVESTER: 95,
      HAULER: 85,
      PIONEER: 90, // Bootstrap role
      FILLER: 75,
      UPGRADER: 60,
      BUILDER: 55,
      DEFENDER: 90, // High when needed
      REMOTE_MINER: 50,
      REMOTE_HAULER: 45,
      REMOTE_DEFENDER: 70,
      RESERVER: 30,
      SCOUT: 25,
      LINK_FILLER: 65,
      CLAIMER: 40,
      MINERAL_HARVESTER: 20,
    },

    factors: {
      deficit: 1.0, // How much deficit matters
      economy: 0.8, // How much economy health matters
      rcl: 0.3, // How much RCL progression matters
      threat: 1.5, // How much threat level matters
      saturation: 0.6, // Diminishing returns on count
    },

    roles: {
      HARVESTER: {
        minCount: 1,
        maxCount: 4,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      PIONEER: {
        minCount: 0,
        maxCount: 4,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      HAULER: {
        minCount: 0,
        maxCount: 6,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      FILLER: {
        minCount: 0,
        maxCount: 2,
        minRcl: 4,
        rclPenalty: 0.1,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      UPGRADER: {
        minCount: 1, // Always at least 1 upgrader
        maxCount: 5,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      BUILDER: {
        minCount: 0,
        maxCount: 3,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      DEFENDER: {
        minCount: 0,
        maxCount: 3,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 50,
      },
      REMOTE_MINER: {
        minCount: 0,
        maxCount: 8,
        minRcl: 3,
        rclPenalty: 0.1,
        economyThreshold: 30,
        replacementTTL: 200,
      },
      REMOTE_HAULER: {
        minCount: 0,
        maxCount: 8,
        minRcl: 3,
        rclPenalty: 0.1,
        economyThreshold: 30,
        replacementTTL: 200,
      },
      REMOTE_DEFENDER: {
        minCount: 0,
        maxCount: 4,
        minRcl: 3,
        rclPenalty: 0.1,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      RESERVER: {
        minCount: 0,
        maxCount: 4,
        minRcl: 4,
        rclPenalty: 0.0,
        economyThreshold: 50,
        replacementTTL: 200,
      },
      SCOUT: {
        minCount: 0,
        maxCount: 1,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 50,
      },
      LINK_FILLER: {
        minCount: 0,
        maxCount: 1,
        minRcl: 5,
        rclPenalty: 0.0,
        economyThreshold: 0,
        replacementTTL: 100,
      },
      CLAIMER: {
        minCount: 0,
        maxCount: 1,
        minRcl: 4,
        rclPenalty: 0.0,
        economyThreshold: 50,
        replacementTTL: 100,
      },
      MINERAL_HARVESTER: {
        minCount: 0,
        maxCount: 1,
        minRcl: 6,
        rclPenalty: 0.0,
        economyThreshold: 80,
        replacementTTL: 100,
      },
    },
  },

  // ========== CONSTRUCTION WEIGHTS ==========
  construction: {
    basePriority: {
      container: 90,
      extension: 85,
      tower: 80,
      storage: 75,
      link: 65,
      terminal: 60,
      road: 40,
      lab: 50,
      extractor: 45,
      factory: 40,
      spawn: 95, // Highest priority when available
      observer: 30,
      powerSpawn: 25,
      nuker: 20,
      rampart: 35,
      constructedWall: 30,
    },

    factors: {
      rclProgress: 1.0,
      economyImpact: 1.2,
      defensiveValue: 0.8,
      trafficBenefit: 0.6,
      completionGap: 1.0,
    },

    types: {
      container: {
        minRcl: 1,
        rclPenalty: 1.0,
        maxConcurrentSites: 3,
        requiresStorage: false,
        noStoragePenalty: 1.0,
      },
      extension: {
        minRcl: 2,
        rclPenalty: 0.0,
        maxConcurrentSites: 5,
        requiresStorage: false,
        noStoragePenalty: 1.0,
      },
      tower: {
        minRcl: 3,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: false,
        noStoragePenalty: 1.0,
      },
      storage: {
        minRcl: 4,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: false,
        noStoragePenalty: 1.0,
      },
      link: {
        minRcl: 5,
        rclPenalty: 0.0,
        maxConcurrentSites: 2,
        requiresStorage: true,
        noStoragePenalty: 0.1,
      },
      terminal: {
        minRcl: 6,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: true,
        noStoragePenalty: 0.0,
      },
      lab: {
        minRcl: 6,
        rclPenalty: 0.0,
        maxConcurrentSites: 2,
        requiresStorage: true,
        noStoragePenalty: 0.1,
      },
      extractor: {
        minRcl: 6,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: true,
        noStoragePenalty: 0.1,
      },
      factory: {
        minRcl: 7,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: true,
        noStoragePenalty: 0.0,
      },
      spawn: {
        minRcl: 7,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: false,
        noStoragePenalty: 1.0,
      },
      observer: {
        minRcl: 8,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: true,
        noStoragePenalty: 0.0,
      },
      powerSpawn: {
        minRcl: 8,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: true,
        noStoragePenalty: 0.0,
      },
      nuker: {
        minRcl: 8,
        rclPenalty: 0.0,
        maxConcurrentSites: 1,
        requiresStorage: true,
        noStoragePenalty: 0.0,
      },
      road: {
        minRcl: 1,
        rclPenalty: 1.0,
        maxConcurrentSites: 5,
        requiresStorage: false,
        noStoragePenalty: 0.5,
      },
      rampart: {
        minRcl: 2,
        rclPenalty: 0.5,
        maxConcurrentSites: 3,
        requiresStorage: false,
        noStoragePenalty: 0.3,
      },
      constructedWall: {
        minRcl: 2,
        rclPenalty: 0.5,
        maxConcurrentSites: 3,
        requiresStorage: false,
        noStoragePenalty: 0.3,
      },
    },
  },

  // ========== REMOTE MINING WEIGHTS ==========
  remotes: {
    factors: {
      sourceCount: 1.5,
      distance: -0.8, // Negative = penalty per distance
      safety: 1.0,
      pathQuality: 0.5,
      profitability: 1.0,
    },

    // Minimum sources required by distance
    minSources: {
      1: 1, // Distance 1: any source count OK
      2: 2, // Distance 2: need 2+ sources to be worthwhile
    },

    maxActive: 4,
  },

  // ========== MILITARY WEIGHTS ==========
  military: {
    factors: {
      threatLevel: 1.5,
      strategicValue: 1.0,
      economicLoss: 0.8,
      winProbability: 1.2,
    },
  },

  // ========== ECONOMY WEIGHTS ==========
  economy: {
    targetSurplusRatio: 1.3, // Aim for 30% more income than burn
    storageTargets: {
      1: 0,
      2: 0,
      3: 0,
      4: 5000,
      5: 20000,
      6: 50000,
      7: 100000,
      8: 200000,
    },
    emergencyThreshold: 500,
  },
};

// ============================================================================
// WEIGHT TABLE MANAGER
// ============================================================================

/**
 * Manages loading, saving, and patching of weights
 */
export class WeightTableManager {
  private static cached: WeightTable | null = null;
  private static cacheTime: number = 0;

  /**
   * Get the current weight table.
   * Loads from memory if available, otherwise uses defaults.
   */
  static getWeights(): WeightTable {
    // Cache for the current tick
    if (this.cached && this.cacheTime === Game.time) {
      return this.cached;
    }

    // Try to load from memory
    const memWeights = this.loadFromMemory();
    if (memWeights) {
      this.cached = memWeights;
    } else {
      this.cached = { ...DEFAULT_WEIGHTS };
    }

    this.cacheTime = Game.time;
    return this.cached;
  }

  /**
   * Load weights from Memory.empire.weights
   */
  private static loadFromMemory(): WeightTable | null {
    const empire = Memory.empire as { weights?: WeightTable } | undefined;
    if (!empire?.weights) {
      return null;
    }

    const stored = empire.weights;

    // Validate version compatibility
    if (stored.version !== DEFAULT_WEIGHTS.version) {
      logger.warn(
        "WeightTable",
        `Stored weights version ${stored.version} != default ${DEFAULT_WEIGHTS.version}, using defaults`
      );
      return null;
    }

    // Merge with defaults to ensure all keys exist
    return this.mergeWithDefaults(stored);
  }

  /**
   * Merge stored weights with defaults to fill any missing keys
   */
  private static mergeWithDefaults(stored: Partial<WeightTable>): WeightTable {
    return {
      ...DEFAULT_WEIGHTS,
      ...stored,
      spawning: {
        ...DEFAULT_WEIGHTS.spawning,
        ...stored.spawning,
        factors: {
          ...DEFAULT_WEIGHTS.spawning.factors,
          ...stored.spawning?.factors,
        },
        basePriority: {
          ...DEFAULT_WEIGHTS.spawning.basePriority,
          ...stored.spawning?.basePriority,
        },
        roles: {
          ...DEFAULT_WEIGHTS.spawning.roles,
          ...stored.spawning?.roles,
        },
      },
      construction: {
        ...DEFAULT_WEIGHTS.construction,
        ...stored.construction,
        factors: {
          ...DEFAULT_WEIGHTS.construction.factors,
          ...stored.construction?.factors,
        },
        basePriority: {
          ...DEFAULT_WEIGHTS.construction.basePriority,
          ...stored.construction?.basePriority,
        },
        types: {
          ...DEFAULT_WEIGHTS.construction.types,
          ...stored.construction?.types,
        },
      },
      remotes: {
        ...DEFAULT_WEIGHTS.remotes,
        ...stored.remotes,
        factors: {
          ...DEFAULT_WEIGHTS.remotes.factors,
          ...stored.remotes?.factors,
        },
        minSources: {
          ...DEFAULT_WEIGHTS.remotes.minSources,
          ...stored.remotes?.minSources,
        },
      },
      military: {
        ...DEFAULT_WEIGHTS.military,
        ...stored.military,
        factors: {
          ...DEFAULT_WEIGHTS.military.factors,
          ...stored.military?.factors,
        },
      },
      economy: {
        ...DEFAULT_WEIGHTS.economy,
        ...stored.economy,
        storageTargets: {
          ...DEFAULT_WEIGHTS.economy.storageTargets,
          ...stored.economy?.storageTargets,
        },
      },
    };
  }

  /**
   * Save weights to memory
   */
  static saveToMemory(weights: WeightTable): void {
    if (!Memory.empire) {
      (Memory as { empire?: unknown }).empire = {};
    }
    (Memory.empire as { weights?: WeightTable }).weights = weights;
    this.cached = weights;
    this.cacheTime = Game.time;

    logger.info("WeightTable", `Saved weights v${weights.version} (${weights.updatedBy})`);
  }

  /**
   * Apply a weight patch
   */
  static applyPatch(patch: WeightPatch): boolean {
    const weights = this.getWeights();
    const parts = patch.path.split(".");

    // Navigate to the parent object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = weights;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined) {
        logger.warn("WeightTable", `Invalid patch path: ${patch.path}`);
        return false;
      }
      current = current[parts[i]];
    }

    const key = parts[parts.length - 1];
    const oldValue = current[key];

    // Validate old value matches expected
    if (JSON.stringify(oldValue) !== JSON.stringify(patch.oldValue)) {
      logger.warn(
        "WeightTable",
        `Patch conflict at ${patch.path}: expected ${JSON.stringify(patch.oldValue)}, got ${JSON.stringify(oldValue)}`
      );
      return false;
    }

    // Apply the patch
    current[key] = patch.newValue;
    weights.updatedAt = Game.time;
    weights.updatedBy = "ai_advisor";

    this.saveToMemory(weights);

    logger.info(
      "WeightTable",
      `Applied patch: ${patch.path} = ${JSON.stringify(patch.newValue)} (${patch.reason})`
    );

    return true;
  }

  /**
   * Set a weight value directly (for console commands)
   */
  static setWeight(path: string, value: unknown): boolean {
    const weights = this.getWeights();
    const parts = path.split(".");

    // Navigate to the parent object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = weights;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined) {
        logger.warn("WeightTable", `Invalid path: ${path}`);
        return false;
      }
      current = current[parts[i]];
    }

    const key = parts[parts.length - 1];
    current[key] = value;
    weights.updatedAt = Game.time;
    weights.updatedBy = "manual";

    this.saveToMemory(weights);

    logger.info("WeightTable", `Set ${path} = ${JSON.stringify(value)}`);
    return true;
  }

  /**
   * Reset weights to defaults
   */
  static resetToDefaults(): void {
    const defaults = { ...DEFAULT_WEIGHTS };
    defaults.updatedAt = Game.time;
    defaults.updatedBy = "manual";
    this.saveToMemory(defaults);

    logger.info("WeightTable", "Reset to defaults");
  }

  /**
   * Get role config with defaults
   */
  static getRoleConfig(role: string): RoleConfig {
    const weights = this.getWeights();
    return (
      weights.spawning.roles[role] || {
        minCount: 0,
        maxCount: 10,
        minRcl: 0,
        rclPenalty: 1.0,
        economyThreshold: 0,
        replacementTTL: 100,
      }
    );
  }

  /**
   * Get structure type config with defaults
   */
  static getStructureConfig(type: string): StructureTypeConfig {
    const weights = this.getWeights();
    return (
      weights.construction.types[type] || {
        minRcl: 1,
        rclPenalty: 1.0,
        maxConcurrentSites: 3,
        requiresStorage: false,
        noStoragePenalty: 1.0,
      }
    );
  }

  /**
   * Clear cache (for testing)
   */
  static clearCache(): void {
    this.cached = null;
    this.cacheTime = 0;
  }
}

// ============================================================================
// CONSOLE COMMANDS
// ============================================================================

/**
 * Console command: Show current weights
 */
export function showWeights(path?: string): string {
  const weights = WeightTableManager.getWeights();

  if (!path) {
    return JSON.stringify(
      {
        version: weights.version,
        updatedAt: weights.updatedAt,
        updatedBy: weights.updatedBy,
        sections: ["spawning", "construction", "remotes", "military", "economy"],
      },
      null,
      2
    );
  }

  const parts = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = weights;
  for (const part of parts) {
    if (current[part] === undefined) {
      return `Invalid path: ${path}`;
    }
    current = current[part];
  }

  return JSON.stringify(current, null, 2);
}

/**
 * Console command: Set a weight
 */
export function setWeight(path: string, value: unknown): string {
  const success = WeightTableManager.setWeight(path, value);
  return success ? `Set ${path} = ${JSON.stringify(value)}` : `Failed to set ${path}`;
}

/**
 * Console command: Reset weights to defaults
 */
export function resetWeights(): string {
  WeightTableManager.resetToDefaults();
  return "Weights reset to defaults";
}
