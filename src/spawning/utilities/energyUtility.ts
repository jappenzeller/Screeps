/**
 * Energy Utility Module
 *
 * Utility calculations based on energy state.
 * Provides smooth scaling instead of hard thresholds.
 */

import { scale, smoothStep } from "../../utils/smoothing";
import {
  getEnergyRate,
  calculateHarvestIncome,
  calculateUpgradeConsumption,
  calculateBuilderConsumption,
} from "../../utils/metrics";

export interface EnergyState {
  stored: number;
  rate: number; // Smoothed energy delta/tick
  harvestIncome: number; // Theoretical max from harvesters
  upgradeConsumption: number;
  builderConsumption: number;
  available: number; // Spawn energy available
  capacity: number; // Spawn energy capacity
}

export interface StorageThresholds {
  low: number;
  target: number;
  high: number;
}

// Default thresholds
const DEFAULT_THRESHOLDS: StorageThresholds = {
  low: 50000,
  target: 200000,
  high: 400000,
};

/**
 * Get current energy state for a room
 */
export function getEnergyState(room: Room): EnergyState {
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  }) as StructureContainer[];

  const containerEnergy = containers.reduce(
    (sum, c) => sum + c.store[RESOURCE_ENERGY],
    0
  );

  const stored = (room.storage?.store[RESOURCE_ENERGY] || 0) + containerEnergy;

  return {
    stored,
    rate: getEnergyRate(room.name),
    harvestIncome: calculateHarvestIncome(room),
    upgradeConsumption: calculateUpgradeConsumption(room),
    builderConsumption: calculateBuilderConsumption(room),
    available: room.energyAvailable,
    capacity: room.energyCapacityAvailable,
  };
}

/**
 * Storage-based utility multiplier
 * Smoothly scales from 0 at empty to 1.5 at abundant
 *
 * @param stored Current storage amount
 * @param thresholds Thresholds for scaling
 */
export function storageUtility(
  stored: number,
  thresholds: StorageThresholds = DEFAULT_THRESHOLDS
): number {
  if (stored <= thresholds.low) {
    // Below low threshold: scale from 0 to 0.5
    return scale(stored, 0, thresholds.low, 0, 0.5);
  } else if (stored <= thresholds.target) {
    // Between low and target: scale from 0.5 to 1.0
    return scale(stored, thresholds.low, thresholds.target, 0.5, 1.0);
  } else {
    // Above target: scale from 1.0 to 1.5 (burn excess)
    return scale(stored, thresholds.target, thresholds.high, 1.0, 1.5);
  }
}

/**
 * Income sustainability check
 * Returns multiplier based on whether we can sustain additional consumption
 *
 * @param currentConsumption Current energy/tick being consumed
 * @param additionalConsumption How much the new creep would add
 * @param income Current energy income/tick
 */
export function sustainabilityUtility(
  currentConsumption: number,
  additionalConsumption: number,
  income: number
): number {
  // If no income data yet (new room, tracker hasn't warmed up),
  // return moderate sustainability to avoid blocking spawns
  // Young colonies need to spawn creeps even without income tracking
  if (income <= 0) {
    return 0.5; // Assume moderate sustainability until tracking warms up
  }

  const projectedConsumption = currentConsumption + additionalConsumption;

  // Ratio of projected consumption to income
  // < 1 means sustainable, > 1 means unsustainable
  const ratio = projectedConsumption / income;

  // Return high utility when ratio < 0.8, low when > 1.2
  return 1 - smoothStep(0.8, 1.2, ratio);
}

/**
 * Energy rate trend utility
 * Positive rate = gaining energy = can afford more consumers
 * Negative rate = losing energy = reduce consumers
 *
 * @param rate Smoothed energy delta per tick
 * @param sensitivity How sensitive to rate changes (default 0.1)
 */
export function rateUtility(rate: number, sensitivity: number = 0.1): number {
  // Sigmoid centered at 0
  // Positive rate -> utility > 0.5
  // Negative rate -> utility < 0.5
  return 1 / (1 + Math.exp(-sensitivity * rate));
}

/**
 * Income ratio utility
 * Compares current income to maximum possible income
 * Higher ratio = more established economy
 */
export function incomeRatioUtility(room: Room): number {
  const sources = room.find(FIND_SOURCES).length;
  const maxIncome = sources * 10; // 5 WORK parts * 2 energy/tick per source
  const currentIncome = calculateHarvestIncome(room);

  if (maxIncome === 0) return 0;
  return Math.min(currentIncome / maxIncome, 1);
}

/**
 * Spawn energy availability utility
 * Higher when spawn energy is topped up
 */
export function spawnEnergyUtility(available: number, capacity: number): number {
  if (capacity === 0) return 0;
  return available / capacity;
}
