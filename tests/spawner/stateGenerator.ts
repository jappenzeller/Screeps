import { TestColonyState } from "./invariants";

/**
 * Generate a random colony state for testing
 */
export function generateRandomState(): TestColonyState {
  const rcl = randomInt(1, 8);
  const energyCapacity = getCapacityForRCL(rcl);

  // Bias towards interesting states (low economy, edge cases)
  const stateBias = Math.random();

  let state: TestColonyState;

  if (stateBias < 0.2) {
    // 20%: Emergency state (0 harvesters)
    state = generateEmergencyState(rcl, energyCapacity);
  } else if (stateBias < 0.4) {
    // 20%: Recovery state (few creeps, low energy)
    state = generateRecoveryState(rcl, energyCapacity);
  } else if (stateBias < 0.6) {
    // 20%: Combat state (threats present)
    state = generateCombatState(rcl, energyCapacity);
  } else {
    // 40%: Normal operation
    state = generateNormalState(rcl, energyCapacity);
  }

  return state;
}

function generateEmergencyState(rcl: number, energyCapacity: number): TestColonyState {
  return {
    rcl,
    energyAvailable: randomInt(50, 500),
    energyCapacity,
    energyStored: randomInt(0, 10000),
    energyIncome: 0,
    energyIncomeMax: 20,
    counts: {
      HARVESTER: 0,
      HAULER: randomInt(0, 1),
      UPGRADER: randomInt(0, 1),
      BUILDER: 0,
      DEFENDER: 0,
      REMOTE_MINER: 0,
      REMOTE_HAULER: 0,
      RESERVER: 0,
      SCOUT: 0,
    },
    targets: generateTargets(rcl),
    homeThreats: 0,
    remoteThreatsByRoom: {},
    constructionSites: randomInt(0, 5),
    remoteRooms: rcl >= 4 ? ["W1N2"] : [],
    dyingSoon: {},
  };
}

function generateRecoveryState(rcl: number, energyCapacity: number): TestColonyState {
  return {
    rcl,
    energyAvailable: randomInt(100, 400),
    energyCapacity,
    energyStored: randomInt(0, 50000),
    energyIncome: randomInt(0, 5),
    energyIncomeMax: 20,
    counts: {
      HARVESTER: randomInt(0, 2),
      HAULER: randomInt(0, 2),
      UPGRADER: randomInt(0, 1),
      BUILDER: 0,
      DEFENDER: 0,
      REMOTE_MINER: 0,
      REMOTE_HAULER: 0,
      RESERVER: 0,
      SCOUT: 0,
    },
    targets: generateTargets(rcl),
    homeThreats: 0,
    remoteThreatsByRoom: {},
    constructionSites: randomInt(0, 10),
    remoteRooms: rcl >= 4 ? ["W1N2"] : [],
    dyingSoon: {},
  };
}

function generateCombatState(rcl: number, energyCapacity: number): TestColonyState {
  return {
    rcl,
    energyAvailable: randomInt(200, energyCapacity),
    energyCapacity,
    energyStored: randomInt(10000, 200000),
    energyIncome: randomInt(10, 20),
    energyIncomeMax: 20,
    counts: {
      HARVESTER: 2,
      HAULER: 2,
      UPGRADER: randomInt(1, 3),
      BUILDER: randomInt(0, 2),
      DEFENDER: randomInt(0, 2),
      REMOTE_MINER: rcl >= 4 ? randomInt(0, 4) : 0,
      REMOTE_HAULER: rcl >= 4 ? randomInt(0, 4) : 0,
      RESERVER: rcl >= 4 ? randomInt(0, 2) : 0,
      SCOUT: randomInt(0, 1),
    },
    targets: generateTargets(rcl),
    homeThreats: randomInt(1, 5),
    remoteThreatsByRoom: rcl >= 4 ? { W1N2: randomInt(0, 3) } : {},
    constructionSites: randomInt(0, 20),
    remoteRooms: rcl >= 4 ? ["W1N2"] : [],
    dyingSoon: {},
  };
}

function generateNormalState(rcl: number, energyCapacity: number): TestColonyState {
  return {
    rcl,
    energyAvailable: randomInt(300, energyCapacity),
    energyCapacity,
    energyStored: randomInt(50000, 500000),
    energyIncome: randomInt(15, 20),
    energyIncomeMax: 20,
    counts: {
      HARVESTER: 2,
      HAULER: randomInt(2, 4),
      UPGRADER: randomInt(2, 4),
      BUILDER: randomInt(0, 2),
      DEFENDER: 0,
      REMOTE_MINER: rcl >= 4 ? randomInt(2, 4) : 0,
      REMOTE_HAULER: rcl >= 4 ? randomInt(3, 6) : 0,
      RESERVER: rcl >= 4 ? randomInt(1, 2) : 0,
      SCOUT: randomInt(0, 1),
    },
    targets: generateTargets(rcl),
    homeThreats: 0,
    remoteThreatsByRoom: {},
    constructionSites: randomInt(0, 30),
    remoteRooms: rcl >= 4 ? ["W1N2", "W2N1"] : [],
    dyingSoon: {},
  };
}

function generateTargets(rcl: number): Record<string, number> {
  return {
    HARVESTER: 2,
    HAULER: rcl >= 4 ? 3 : 2,
    UPGRADER: Math.min(rcl, 3),
    BUILDER: 2,
    DEFENDER: 0,
    REMOTE_MINER: rcl >= 4 ? 4 : 0,
    REMOTE_HAULER: rcl >= 4 ? 6 : 0,
    RESERVER: rcl >= 4 ? 2 : 0,
    SCOUT: 1,
  };
}

function getCapacityForRCL(rcl: number): number {
  const capacities: Record<number, number> = {
    1: 300,
    2: 550,
    3: 800,
    4: 1300,
    5: 1800,
    6: 2300,
    7: 5600,
    8: 12900,
  };
  return capacities[rcl] || 300;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate specific edge case states for targeted testing
 */
export function generateEdgeCaseStates(): TestColonyState[] {
  return [
    // Exact threshold: 200 energy, 0 harvesters
    {
      rcl: 5,
      energyAvailable: 200,
      energyCapacity: 1800,
      energyStored: 0,
      energyIncome: 0,
      energyIncomeMax: 20,
      counts: {
        HARVESTER: 0,
        HAULER: 0,
        UPGRADER: 0,
        BUILDER: 0,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 0,
      },
      targets: {
        HARVESTER: 2,
        HAULER: 2,
        UPGRADER: 3,
        BUILDER: 2,
        DEFENDER: 0,
        REMOTE_MINER: 4,
        REMOTE_HAULER: 6,
        RESERVER: 2,
        SCOUT: 1,
      },
      homeThreats: 0,
      remoteThreatsByRoom: {},
      constructionSites: 0,
      remoteRooms: ["W1N2"],
      dyingSoon: {},
    },
    // Just below threshold: 199 energy, 0 harvesters
    {
      rcl: 5,
      energyAvailable: 199,
      energyCapacity: 1800,
      energyStored: 0,
      energyIncome: 0,
      energyIncomeMax: 20,
      counts: {
        HARVESTER: 0,
        HAULER: 0,
        UPGRADER: 0,
        BUILDER: 0,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 0,
      },
      targets: {
        HARVESTER: 2,
        HAULER: 2,
        UPGRADER: 3,
        BUILDER: 2,
        DEFENDER: 0,
        REMOTE_MINER: 4,
        REMOTE_HAULER: 6,
        RESERVER: 2,
        SCOUT: 1,
      },
      homeThreats: 0,
      remoteThreatsByRoom: {},
      constructionSites: 0,
      remoteRooms: ["W1N2"],
      dyingSoon: {},
    },
    // Harvesters exist but no haulers
    {
      rcl: 5,
      energyAvailable: 500,
      energyCapacity: 1800,
      energyStored: 100000,
      energyIncome: 20,
      energyIncomeMax: 20,
      counts: {
        HARVESTER: 2,
        HAULER: 0,
        UPGRADER: 0,
        BUILDER: 0,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 0,
      },
      targets: {
        HARVESTER: 2,
        HAULER: 2,
        UPGRADER: 3,
        BUILDER: 2,
        DEFENDER: 0,
        REMOTE_MINER: 4,
        REMOTE_HAULER: 6,
        RESERVER: 2,
        SCOUT: 1,
      },
      homeThreats: 0,
      remoteThreatsByRoom: {},
      constructionSites: 5,
      remoteRooms: ["W1N2"],
      dyingSoon: {},
    },
    // 0 harvesters with hostiles present
    {
      rcl: 5,
      energyAvailable: 300,
      energyCapacity: 1800,
      energyStored: 0,
      energyIncome: 0,
      energyIncomeMax: 20,
      counts: {
        HARVESTER: 0,
        HAULER: 0,
        UPGRADER: 0,
        BUILDER: 0,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 0,
      },
      targets: {
        HARVESTER: 2,
        HAULER: 2,
        UPGRADER: 3,
        BUILDER: 2,
        DEFENDER: 0,
        REMOTE_MINER: 4,
        REMOTE_HAULER: 6,
        RESERVER: 2,
        SCOUT: 1,
      },
      homeThreats: 3,
      remoteThreatsByRoom: {},
      constructionSites: 5,
      remoteRooms: ["W1N2"],
      dyingSoon: {},
    },
    // RCL 3 trying to do remote mining
    {
      rcl: 3,
      energyAvailable: 800,
      energyCapacity: 800,
      energyStored: 50000,
      energyIncome: 20,
      energyIncomeMax: 20,
      counts: {
        HARVESTER: 2,
        HAULER: 2,
        UPGRADER: 2,
        BUILDER: 1,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 0,
      },
      targets: {
        HARVESTER: 2,
        HAULER: 2,
        UPGRADER: 3,
        BUILDER: 2,
        DEFENDER: 0,
        REMOTE_MINER: 0,
        REMOTE_HAULER: 0,
        RESERVER: 0,
        SCOUT: 1,
      },
      homeThreats: 0,
      remoteThreatsByRoom: {},
      constructionSites: 10,
      remoteRooms: [],
      dyingSoon: {},
    },
  ];
}
