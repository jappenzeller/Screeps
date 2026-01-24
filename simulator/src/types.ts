/**
 * Simulator Types
 */

export interface SimCreep {
  id: string;
  role: string;
  ttl: number;
  body: string[];
  spawnTick: number;
  // For movement simulation
  position: 'home' | 'remote' | 'traveling_out' | 'traveling_back';
  travelProgress?: number;
  targetRoom?: string;
  carryUsed: number;
  carryCapacity: number;
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
    maxPerTick: number;  // 10 per source
  };
  
  // Containers (for harvester mode switching)
  containers: {
    atSources: boolean;
    energy: number;
  };
  
  // Creeps
  creeps: SimCreep[];
  
  // Spawning
  spawning: {
    role: string;
    body: string[];
    ticksRemaining: number;
    cost: number;
  } | null;
  
  // Derived (recalculated each tick)
  counts: Record<string, number>;
  
  // RCL
  rcl: number;
  
  // Remote rooms
  remoteRooms: {
    name: string;
    sources: number;
    distance: number;  // One-way ticks
    hasContainer: boolean;
    threatLevel: number;
  }[];
  
  // Threats
  homeThreats: number;
  
  // Construction
  constructionSites: number;
}

export interface SimConfig {
  rcl: number;
  energyCapacity: number;
  sources: number;
  hasSourceContainers: boolean;
  remoteRooms: {
    name: string;
    sources: number;
    distance: number;
  }[];
  initialCreeps: Partial<SimCreep>[];
  initialEnergy: number;
  initialStored: number;
  constructionSites: number;
}

export interface SimSnapshot {
  tick: number;
  creepCount: number;
  counts: Record<string, number>;
  energyAvailable: number;
  energyStored: number;
  energyIncome: number;
}

export interface SimEvent {
  tick: number;
  type: 'SPAWN_START' | 'SPAWN_COMPLETE' | 'DEATH' | 'WIPE' | 'RECOVERY' | 'RENEW' | 'INJECT';
  role?: string;
  details?: string;
}

export interface SimResult {
  survived: boolean;
  finalTick: number;
  deathTick: number | null;
  recoveryTick: number | null;
  peakCreeps: number;
  minCreeps: number;
  totalSpawned: number;
  totalDeaths: number;
  totalRenewals: number;
  averageEnergy: number;
  history: SimSnapshot[];
  events: SimEvent[];
}

export interface SpawnCandidate {
  role: string;
  utility: number;
  body: string[];
  cost: number;
  targetRoom?: string;
}

// Scenario injection - modify state at specific tick
export type ScenarioInjection = (state: SimState, tick: number) => SimState;

export interface TestScenario {
  name: string;
  description: string;
  config: SimConfig;
  injections?: { tick: number; action: ScenarioInjection }[];
  maxTicks: number;
  expectedSurvival: boolean;
  validate?: (result: SimResult) => { passed: boolean; reason?: string };
}
