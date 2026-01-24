/**
 * Economic Loop Simulator
 *
 * Tests spawning logic by simulating colony evolution over time.
 * Runs the actual spawner across hundreds of ticks to answer:
 * "Does the colony survive?"
 */

import { createMockRoom, setupMockGameCreeps } from "./mockRoom";

// ============================================
// Types
// ============================================

export interface SimCreep {
  id: string;
  role: string;
  ttl: number; // Ticks to live (starts at 1500)
  body: BodyPartConstant[];
  spawnTick: number;
  memory?: Record<string, any>;
}

export interface SimState {
  tick: number;

  // Energy
  energyAvailable: number;
  energyCapacity: number;
  energyStored: number;

  // Sources
  sources: {
    count: number;
    maxPerTick: number; // 10 per source
  };

  // Creeps
  creeps: SimCreep[];

  // Spawning
  spawning: {
    role: string;
    body: BodyPartConstant[];
    ticksRemaining: number;
    cost: number;
    memory?: Record<string, any>;
  } | null;

  // Derived (recalculated each tick)
  counts: Record<string, number>;

  // Config
  rcl: number;
  remoteRooms: string[];
  homeThreats: number;
  constructionSites: number;
}

export interface SimConfig {
  rcl: number;
  energyCapacity: number;
  sources: number;
  remoteRooms: string[];
  initialCreeps: SimCreep[];
  initialEnergy: number;
  initialStored: number;
  homeThreats?: number;
  constructionSites?: number;
}

export interface SimSnapshot {
  tick: number;
  creepCount: number;
  counts: Record<string, number>;
  energy: number;
  spawning: string | null;
}

export interface SimEvent {
  tick: number;
  type: "SPAWN" | "DEATH" | "SPAWN_START" | "RECOVERY" | "WIPE" | "INJECTION";
  role?: string;
  details?: string;
}

export interface SimResult {
  survived: boolean;
  finalTick: number;
  deathTick: number | null;
  peakCreeps: number;
  minCreeps: number;
  history: SimSnapshot[];
  events: SimEvent[];
  finalState: SimState;
}

// ============================================
// Constants
// ============================================

export const SIM_CONSTANTS = {
  CREEP_TTL: 1500,
  SPAWN_TICKS_PER_PART: 3,
  WORK_HARVEST_RATE: 2,
  SOURCE_MAX_RATE: 10, // Per source (5 WORK saturates)

  BODYPART_COST: {
    move: 50,
    work: 100,
    carry: 50,
    attack: 80,
    ranged_attack: 150,
    heal: 250,
    claim: 600,
    tough: 10,
  } as Record<string, number>,
};

// ============================================
// Utility Functions
// ============================================

export function countParts(body: BodyPartConstant[], type: string): number {
  return body.filter((p) => p === type).length;
}

export function bodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + (SIM_CONSTANTS.BODYPART_COST[part] || 0), 0);
}

// ============================================
// State Initialization
// ============================================

export function initState(config: SimConfig): SimState {
  const state: SimState = {
    tick: 0,
    energyAvailable: config.initialEnergy,
    energyCapacity: config.energyCapacity,
    energyStored: config.initialStored,
    sources: {
      count: config.sources,
      maxPerTick: config.sources * SIM_CONSTANTS.SOURCE_MAX_RATE,
    },
    creeps: config.initialCreeps.map((c) => ({ ...c })),
    spawning: null,
    counts: {},
    rcl: config.rcl,
    remoteRooms: config.remoteRooms,
    homeThreats: config.homeThreats || 0,
    constructionSites: config.constructionSites || 0,
  };

  // Calculate initial counts
  for (const c of state.creeps) {
    state.counts[c.role] = (state.counts[c.role] || 0) + 1;
  }

  return state;
}

// ============================================
// Mock Setup for Spawner Integration
// ============================================

function setupSimMocks(state: SimState): void {
  // Convert SimCreep[] to the format expected by setupMockGameCreeps
  const testState = {
    rcl: state.rcl,
    energyAvailable: state.energyAvailable,
    energyCapacity: state.energyCapacity,
    energyStored: state.energyStored,
    energyIncome: calculateEnergyIncome(state),
    energyIncomeMax: state.sources.maxPerTick,
    counts: { ...state.counts },
    targets: {},
    homeThreats: state.homeThreats,
    remoteThreatsByRoom: {},
    constructionSites: state.constructionSites,
    remoteRooms: state.remoteRooms,
    dyingSoon: {},
  };

  // Setup basic mocks
  setupMockGameCreeps(testState);

  // Override Game.creeps with our simulation creeps
  const creeps: Record<string, any> = {};
  for (const c of state.creeps) {
    creeps[c.id] = {
      name: c.id,
      memory: {
        role: c.role,
        room: "sim",
        ...c.memory,
      },
      ticksToLive: c.ttl,
      body: c.body.map((p) => ({ type: p, hits: 100 })),
      getActiveBodyparts: (type: string) => countParts(c.body, type),
    };
  }

  // @ts-ignore
  global.Game.creeps = creeps;
  // @ts-ignore
  global.Game.time = state.tick;
  // @ts-ignore
  global.Game.rooms = {
    sim: createSimMockRoom(state),
  };
}

function createSimMockRoom(state: SimState): any {
  return {
    name: "sim",
    controller: {
      level: state.rcl,
      my: true,
    },
    energyAvailable: state.energyAvailable,
    energyCapacityAvailable: state.energyCapacity,
    storage:
      state.energyStored > 0
        ? {
            store: {
              energy: state.energyStored,
              getUsedCapacity: (type: string) => (type === "energy" ? state.energyStored : 0),
            },
          }
        : undefined,
    find: (type: number, _opts?: any) => {
      switch (type) {
        case 105: // FIND_SOURCES
          return Array(state.sources.count)
            .fill(null)
            .map((_, i) => ({ id: `source${i}` }));
        case 111: // FIND_CONSTRUCTION_SITES
          return Array(state.constructionSites).fill({ id: "site", structureType: "road" });
        case 103: // FIND_HOSTILE_CREEPS
          return Array(state.homeThreats).fill({
            id: "hostile",
            owner: { username: "Invader" },
            getActiveBodyparts: () => 1,
          });
        case 110: // FIND_MY_SPAWNS
          return [
            {
              id: "spawn1",
              spawning: state.spawning ? { name: state.spawning.role } : null,
              owner: { username: "SimUser" },
            },
          ];
        case 109: // FIND_MY_STRUCTURES
          return [];
        case 108: // FIND_STRUCTURES
          return [];
        default:
          return [];
      }
    },
  };
}

function calculateEnergyIncome(state: SimState): number {
  let income = 0;
  for (const c of state.creeps) {
    if (c.role === "HARVESTER") {
      income += countParts(c.body, "work") * SIM_CONSTANTS.WORK_HARVEST_RATE;
    }
  }
  return Math.min(income, state.sources.maxPerTick);
}

// ============================================
// Tick Simulation
// ============================================

let getSpawnCandidate: any = null;

export async function loadSpawner(): Promise<void> {
  if (getSpawnCandidate) return;

  // Initialize mocks first
  const dummyState: SimState = {
    tick: 0,
    energyAvailable: 300,
    energyCapacity: 300,
    energyStored: 0,
    sources: { count: 2, maxPerTick: 20 },
    creeps: [],
    spawning: null,
    counts: {},
    rcl: 1,
    remoteRooms: [],
    homeThreats: 0,
    constructionSites: 0,
  };
  setupSimMocks(dummyState);

  const utilitySpawning = await import("../../src/spawning/utilitySpawning");
  getSpawnCandidate = utilitySpawning.getSpawnCandidate;
}

export function simulateTick(state: SimState, events: SimEvent[]): SimState {
  const next: SimState = {
    ...state,
    tick: state.tick + 1,
    creeps: state.creeps.map((c) => ({ ...c })),
    counts: { ...state.counts },
    spawning: state.spawning ? { ...state.spawning } : null,
  };

  // 1. ENERGY GENERATION
  const harvesterWorkParts = next.creeps
    .filter((c) => c.role === "HARVESTER")
    .reduce((sum, c) => sum + countParts(c.body, "work"), 0);

  const maxHarvest = next.sources.maxPerTick;
  const actualHarvest = Math.min(
    harvesterWorkParts * SIM_CONSTANTS.WORK_HARVEST_RATE,
    maxHarvest
  );

  // Add to available energy (cap at capacity)
  next.energyAvailable = Math.min(next.energyAvailable + actualHarvest, next.energyCapacity);

  // 2. SPAWNING PROGRESS
  if (next.spawning) {
    next.spawning.ticksRemaining--;

    if (next.spawning.ticksRemaining <= 0) {
      // Spawn complete - add creep
      const newCreep: SimCreep = {
        id: `${next.spawning.role}_${next.tick}`,
        role: next.spawning.role,
        ttl: SIM_CONSTANTS.CREEP_TTL,
        body: [...next.spawning.body],
        spawnTick: next.tick,
        memory: next.spawning.memory,
      };
      next.creeps.push(newCreep);
      next.counts[newCreep.role] = (next.counts[newCreep.role] || 0) + 1;
      events.push({ tick: next.tick, type: "SPAWN", role: newCreep.role });
      next.spawning = null;
    }
  }

  // 3. SPAWNER DECISION (if not spawning)
  if (!next.spawning && getSpawnCandidate) {
    setupSimMocks(next);
    const mockRoom = createSimMockRoom(next);

    try {
      const candidate = getSpawnCandidate(mockRoom);

      if (candidate) {
        const cost = bodyCost(candidate.body);
        if (cost <= next.energyAvailable) {
          // Start spawning
          next.energyAvailable -= cost;
          next.spawning = {
            role: candidate.role,
            body: [...candidate.body],
            ticksRemaining: candidate.body.length * SIM_CONSTANTS.SPAWN_TICKS_PER_PART,
            cost,
            memory: candidate.memory,
          };
          events.push({ tick: next.tick, type: "SPAWN_START", role: candidate.role });
        }
      }
    } catch (error) {
      // Spawner error - log but continue
      events.push({
        tick: next.tick,
        type: "INJECTION",
        details: `Spawner error: ${error}`,
      });
    }
  }

  // 4. AGE CREEPS
  next.creeps = next.creeps.map((c) => ({ ...c, ttl: c.ttl - 1 }));

  // 5. REMOVE DEAD CREEPS
  const deadCreeps = next.creeps.filter((c) => c.ttl <= 0);
  for (const dead of deadCreeps) {
    events.push({ tick: next.tick, type: "DEATH", role: dead.role });
    next.counts[dead.role] = Math.max(0, (next.counts[dead.role] || 1) - 1);
  }
  next.creeps = next.creeps.filter((c) => c.ttl > 0);

  return next;
}

// ============================================
// Main Simulation
// ============================================

export interface SimulationOptions {
  maxTicks?: number;
  snapshotInterval?: number;
  injections?: ((state: SimState, tick: number, events: SimEvent[]) => SimState)[];
}

export async function simulate(
  config: SimConfig,
  options: SimulationOptions = {}
): Promise<SimResult> {
  const maxTicks = options.maxTicks || 2000;
  const snapshotInterval = options.snapshotInterval || 50;
  const injections = options.injections || [];

  // Load spawner
  await loadSpawner();

  // Initialize state
  let state = initState(config);

  const history: SimSnapshot[] = [];
  const events: SimEvent[] = [];
  let deathTick: number | null = null;
  let peakCreeps = state.creeps.length;
  let minCreeps = state.creeps.length;
  let wasWiped = false;

  // Take initial snapshot
  history.push({
    tick: 0,
    creepCount: state.creeps.length,
    counts: { ...state.counts },
    energy: state.energyAvailable,
    spawning: null,
  });

  // Run simulation
  for (let t = 0; t < maxTicks; t++) {
    // Apply injections
    for (const injection of injections) {
      const newState = injection(state, t, events);
      if (newState !== state) {
        state = newState;
      }
    }

    // Simulate tick
    state = simulateTick(state, events);

    // Track stats
    peakCreeps = Math.max(peakCreeps, state.creeps.length);
    minCreeps = Math.min(minCreeps, state.creeps.length);

    // Sample history
    if (t % snapshotInterval === 0) {
      history.push({
        tick: state.tick,
        creepCount: state.creeps.length,
        counts: { ...state.counts },
        energy: state.energyAvailable,
        spawning: state.spawning?.role || null,
      });
    }

    // Check for death
    const isAlive = state.creeps.length > 0 || state.spawning !== null;
    if (!isAlive && !wasWiped) {
      deathTick = state.tick;
      wasWiped = true;
      events.push({ tick: state.tick, type: "WIPE" });
    }

    // Check for recovery
    if (wasWiped && state.creeps.length > 0) {
      events.push({ tick: state.tick, type: "RECOVERY" });
      wasWiped = false;
      deathTick = null;
    }
  }

  const survived = state.creeps.length > 0 || state.spawning !== null;

  return {
    survived,
    finalTick: state.tick,
    deathTick,
    peakCreeps,
    minCreeps,
    history,
    events,
    finalState: state,
  };
}

// ============================================
// Helpers for Creating Test Creeps
// ============================================

export function createCreep(
  role: string,
  body: BodyPartConstant[],
  ttl: number = SIM_CONSTANTS.CREEP_TTL
): SimCreep {
  return {
    id: `${role}_init_${Math.random().toString(36).substr(2, 5)}`,
    role,
    ttl,
    body,
    spawnTick: 0,
  };
}

export const STANDARD_BODIES = {
  HARVESTER_SMALL: ["work", "carry", "move"] as BodyPartConstant[],
  HARVESTER_MEDIUM: ["work", "work", "work", "carry", "move", "move"] as BodyPartConstant[],
  HARVESTER_FULL: [
    "work",
    "work",
    "work",
    "work",
    "work",
    "carry",
    "move",
    "move",
    "move",
  ] as BodyPartConstant[],
  HAULER_SMALL: ["carry", "move"] as BodyPartConstant[],
  HAULER_MEDIUM: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"] as BodyPartConstant[],
  UPGRADER_SMALL: ["work", "carry", "move"] as BodyPartConstant[],
};
