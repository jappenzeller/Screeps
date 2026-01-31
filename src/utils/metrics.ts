/**
 * Metrics Tracking
 *
 * Exponential moving average (EMA) trackers for energy flow metrics.
 * Smooths values over time without storing full history.
 */

interface EMATracker {
  value: number;
  alpha: number; // Smoothing factor (0-1, lower = more smoothing)
  lastTick: number;
  lastValue?: number; // For delta calculations
}

declare global {
  interface Memory {
    metrics?: Record<string, EMATracker>;
  }
}

/**
 * Initialize or get existing tracker from Memory
 */
export function getTracker(key: string, alpha: number = 0.1): EMATracker {
  Memory.metrics = Memory.metrics || {};
  if (!Memory.metrics[key]) {
    Memory.metrics[key] = { value: 0, alpha, lastTick: Game.time };
  }
  return Memory.metrics[key];
}

/**
 * Update tracker with new sample
 */
export function updateTracker(key: string, sample: number): number {
  const tracker = getTracker(key);

  // EMA formula: new = alpha * sample + (1 - alpha) * old
  tracker.value = tracker.alpha * sample + (1 - tracker.alpha) * tracker.value;
  tracker.lastTick = Game.time;

  return tracker.value;
}

/**
 * Get current smoothed value
 */
export function getMetric(key: string): number {
  return getTracker(key).value;
}

// === Energy Flow Metrics ===

/**
 * Call once per tick in main loop to track energy delta
 */
export function trackEnergyFlow(room: Room): void {
  const storage = room.storage?.store[RESOURCE_ENERGY] || 0;
  const containers = room
    .find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    })
    .reduce((sum, c) => sum + (c as StructureContainer).store[RESOURCE_ENERGY], 0);

  const currentTotal = storage + containers + room.energyAvailable;

  // Get previous total
  const prevKey = `${room.name}:energyTotal`;
  Memory.metrics = Memory.metrics || {};
  const prevTracker = Memory.metrics[prevKey];
  const prev = prevTracker?.lastValue ?? currentTotal;

  // Calculate delta this tick
  const delta = currentTotal - prev;

  // Update smoothed metrics
  updateTracker(`${room.name}:energyDelta`, delta);

  // Store current for next tick
  Memory.metrics[prevKey] = {
    value: 0,
    alpha: 0.1,
    lastTick: Game.time,
    lastValue: currentTotal,
  };
}

/**
 * Get smoothed energy income rate (positive = gaining, negative = losing)
 */
export function getEnergyRate(roomName: string): number {
  return getMetric(`${roomName}:energyDelta`);
}

// === Creep-based Income Tracking ===

/**
 * Calculate theoretical max income from harvesters
 */
export function calculateHarvestIncome(room: Room): number {
  const harvesters = Object.values(Game.creeps).filter(
    (c) =>
      c.memory.room === room.name &&
      (c.memory.role === "HARVESTER" || c.memory.role === "REMOTE_MINER")
  );

  let totalWorkParts = 0;
  for (const creep of harvesters) {
    totalWorkParts += creep.body.filter((p) => p.type === WORK && p.hits > 0).length;
  }

  // Each WORK part harvests 2 energy/tick
  return totalWorkParts * 2;
}

/**
 * Calculate current upgrader consumption
 */
export function calculateUpgradeConsumption(room: Room): number {
  const upgraders = Object.values(Game.creeps).filter(
    (c) => c.memory.room === room.name && c.memory.role === "UPGRADER"
  );

  let totalWorkParts = 0;
  for (const creep of upgraders) {
    totalWorkParts += creep.body.filter((p) => p.type === WORK && p.hits > 0).length;
  }

  // Each WORK part upgrades 1 energy/tick
  return totalWorkParts;
}

/**
 * Calculate current builder consumption
 */
export function calculateBuilderConsumption(room: Room): number {
  const builders = Object.values(Game.creeps).filter(
    (c) => c.memory.room === room.name && c.memory.role === "BUILDER"
  );

  let totalWorkParts = 0;
  for (const creep of builders) {
    totalWorkParts += creep.body.filter((p) => p.type === WORK && p.hits > 0).length;
  }

  // Each WORK part builds 5 energy/tick (but only when actively building)
  // Use a conservative estimate of 50% uptime
  return totalWorkParts * 2.5;
}
