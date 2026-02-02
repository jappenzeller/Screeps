/**
 * EmpireConfig - Centralized configuration
 * Per empire-architecture.md: "Config-driven thresholds - Tune behavior without code changes"
 */

export interface ExpansionConfig {
  maxSimultaneous: number;
  minEconomyScore: number;
  minReserves: number;
  minParentRCL: number;
  maxAttempts: number;
  claimerTimeout: number;
  bootstrapTimeout: number;
  builderCount: number;
  haulerCount: number;
  autoExpand: boolean; // Enable automatic expansion
  weights: {
    economic: number;
    strategic: number;
    defensive: number;
    tech: number;
  };
}

export interface EmpireConfig {
  expansion: ExpansionConfig;
}

export const DEFAULT_CONFIG: EmpireConfig = {
  expansion: {
    maxSimultaneous: 1,
    minEconomyScore: 50,
    minReserves: 50000,
    minParentRCL: 4,
    maxAttempts: 3,
    claimerTimeout: 3000,
    bootstrapTimeout: 15000,
    builderCount: 2,
    haulerCount: 3,
    autoExpand: true,
    weights: {
      economic: 0.35,
      strategic: 0.3,
      defensive: 0.2,
      tech: 0.15,
    },
  },
};

/**
 * Get config, merging with any overrides in Memory
 */
export function getConfig(): EmpireConfig {
  const overrides = Memory.empire?.config || {};
  // Deep merge config with overrides
  return {
    expansion: {
      ...DEFAULT_CONFIG.expansion,
      ...overrides,
      weights: {
        ...DEFAULT_CONFIG.expansion.weights,
        ...(overrides.weights || {}),
      },
    },
  };
}
