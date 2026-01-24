/**
 * Test Scenarios
 * 
 * Each scenario tests a specific failure mode or recovery capability.
 */

import { TestScenario, SimState, SimConfig, SimCreep } from './types';
import { CREEP_LIFE_TIME } from './constants';

/**
 * Helper to create a standard healthy colony config
 */
function healthyColony(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    rcl: 5,
    energyCapacity: 1800,
    sources: 2,
    hasSourceContainers: true,
    remoteRooms: [],
    initialEnergy: 1000,
    initialStored: 100000,
    constructionSites: 0,
    initialCreeps: [
      { role: 'HARVESTER', ttl: 1200, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
      { role: 'HARVESTER', ttl: 1000, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
      { role: 'HAULER', ttl: 800, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
      { role: 'HAULER', ttl: 900, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
      { role: 'UPGRADER', ttl: 600, body: ['work', 'work', 'work', 'carry', 'carry', 'move', 'move', 'move'], position: 'home' },
    ],
    ...overrides,
  };
}

/**
 * Injection: Kill all harvesters
 */
function killAllHarvesters(state: SimState): SimState {
  return {
    ...state,
    creeps: state.creeps.filter(c => c.role !== 'HARVESTER'),
    counts: {
      ...state.counts,
      HARVESTER: 0,
    },
  };
}

/**
 * Injection: Kill all creeps
 */
function killAllCreeps(state: SimState): SimState {
  return {
    ...state,
    creeps: [],
    counts: {},
  };
}

/**
 * Injection: Reduce energy to minimum
 */
function drainEnergy(state: SimState): SimState {
  return {
    ...state,
    energyAvailable: 200,
    energyStored: 0,
    containers: {
      ...state.containers,
      energy: 0,
    },
  };
}

/**
 * Injection: Set all creep TTL low
 */
function ageAllCreeps(state: SimState, targetTTL: number = 100): SimState {
  return {
    ...state,
    creeps: state.creeps.map(c => ({ ...c, ttl: targetTTL })),
  };
}

/**
 * All test scenarios
 */
export const SCENARIOS: TestScenario[] = [
  // ============================================
  // RECOVERY SCENARIOS
  // ============================================
  {
    name: 'Full wipe with 200 energy',
    description: 'Colony has 0 creeps and 200 energy. Should spawn minimal harvester and recover.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 200,
      initialStored: 0,
      constructionSites: 0,
      initialCreeps: [],
    },
    maxTicks: 1000,
    expectedSurvival: true,
    validate: (result) => {
      // Must spawn harvester first
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (!firstSpawn || firstSpawn.role !== 'HARVESTER') {
        return { passed: false, reason: `First spawn was ${firstSpawn?.role}, expected HARVESTER` };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Full wipe with 300 energy',
    description: 'Colony has 0 creeps and 300 energy. Should spawn harvester.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 0,
      constructionSites: 0,
      initialCreeps: [],
    },
    maxTicks: 1000,
    expectedSurvival: true,
    validate: (result) => {
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (!firstSpawn || firstSpawn.role !== 'HARVESTER') {
        return { passed: false, reason: `First spawn was ${firstSpawn?.role}, expected HARVESTER` };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Recovery from zero harvesters',
    description: 'Colony has haulers/upgraders but no harvesters. Should prioritize harvester.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 500,
      initialStored: 50000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HAULER', ttl: 500, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'UPGRADER', ttl: 800, body: ['work', 'work', 'carry', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 1000,
    expectedSurvival: true,
    validate: (result) => {
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (!firstSpawn || firstSpawn.role !== 'HARVESTER') {
        return { passed: false, reason: `First spawn was ${firstSpawn?.role}, expected HARVESTER` };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Recovery from zero haulers',
    description: 'Colony has harvesters but no haulers. Should spawn hauler second.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 500,
      initialStored: 50000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HARVESTER', ttl: 1000, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HARVESTER', ttl: 1200, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'UPGRADER', ttl: 800, body: ['work', 'work', 'carry', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 1000,
    expectedSurvival: true,
    validate: (result) => {
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (!firstSpawn || firstSpawn.role !== 'HAULER') {
        return { passed: false, reason: `First spawn was ${firstSpawn?.role}, expected HAULER` };
      }
      return { passed: true };
    },
  },
  
  // ============================================
  // CASCADING FAILURE SCENARIOS
  // ============================================
  {
    name: 'Harvesters about to die',
    description: 'Both harvesters have TTL < 100. Should spawn replacement before they die.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 800,
      initialStored: 50000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HARVESTER', ttl: 80, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HARVESTER', ttl: 120, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 500, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 500,
    expectedSurvival: true,
    validate: (result) => {
      // Check that we never hit 0 harvesters for more than spawn time
      let zeroHarvesterTicks = 0;
      for (const snapshot of result.history) {
        if ((snapshot.counts.HARVESTER || 0) === 0) {
          zeroHarvesterTicks++;
        }
      }
      // Some gap is acceptable (spawn time), but not prolonged
      if (zeroHarvesterTicks > 5) {
        return { passed: false, reason: `Had 0 harvesters for ${zeroHarvesterTicks} snapshots` };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Invader attack mid-game',
    description: 'Healthy colony loses all harvesters at tick 300. Should recover.',
    config: healthyColony(),
    injections: [
      { tick: 300, action: killAllHarvesters },
    ],
    maxTicks: 1000,
    expectedSurvival: true,
    validate: (result) => {
      // Should spawn harvester soon after injection
      const injectionTick = 300;
      const firstSpawnAfter = result.events.find(
        e => e.type === 'SPAWN_START' && e.tick > injectionTick
      );
      if (!firstSpawnAfter || firstSpawnAfter.role !== 'HARVESTER') {
        return { passed: false, reason: `First spawn after attack was ${firstSpawnAfter?.role}` };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Gradual death spiral',
    description: 'All creeps have low TTL and energy is draining. Tests replacement timing.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 500,
      initialStored: 10000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HARVESTER', ttl: 200, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HARVESTER', ttl: 250, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 180, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 220, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 1000,
    expectedSurvival: true,
  },
  
  // ============================================
  // PRIORITY SCENARIOS
  // ============================================
  {
    name: 'Builder needed but no harvesters',
    description: 'Colony needs builder (sites exist) but has no harvesters. Should spawn harvester first.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 500,
      initialStored: 50000,
      constructionSites: 10,
      initialCreeps: [
        { role: 'HAULER', ttl: 500, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'UPGRADER', ttl: 800, body: ['work', 'work', 'carry', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 500,
    expectedSurvival: true,
    validate: (result) => {
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (firstSpawn?.role === 'BUILDER') {
        return { passed: false, reason: 'Spawned BUILDER before HARVESTER' };
      }
      if (firstSpawn?.role !== 'HARVESTER') {
        return { passed: false, reason: `First spawn was ${firstSpawn?.role}, expected HARVESTER` };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Scout should not spawn before economy',
    description: 'Colony missing harvesters with scout target available. Should not spawn scout.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 0,
      constructionSites: 0,
      initialCreeps: [],
    },
    maxTicks: 500,
    expectedSurvival: true,
    validate: (result) => {
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (firstSpawn?.role === 'SCOUT') {
        return { passed: false, reason: 'Spawned SCOUT with 0 harvesters - this is the bug!' };
      }
      return { passed: true };
    },
  },
  
  // ============================================
  // REMOTE MINING SCENARIOS
  // ============================================
  {
    name: 'Remote mining with healthy economy',
    description: 'RCL 5 colony with remote rooms configured. Should spawn remote miners.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [
        { name: 'W1N2', sources: 2, distance: 50 },
      ],
      initialEnergy: 1000,
      initialStored: 100000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HARVESTER', ttl: 1200, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HARVESTER', ttl: 1000, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 800, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 900, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'UPGRADER', ttl: 600, body: ['work', 'work', 'carry', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 500,
    expectedSurvival: true,
    validate: (result) => {
      const remoteSpawns = result.events.filter(
        e => e.type === 'SPAWN_START' && e.role === 'REMOTE_MINER'
      );
      if (remoteSpawns.length === 0) {
        return { passed: false, reason: 'Never spawned any REMOTE_MINERs' };
      }
      return { passed: true };
    },
  },
  
  {
    name: 'Remote mining blocked by dead economy',
    description: 'Colony has remote config but no harvesters. Should fix economy first.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [
        { name: 'W1N2', sources: 2, distance: 50 },
      ],
      initialEnergy: 500,
      initialStored: 50000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HAULER', ttl: 500, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 500,
    expectedSurvival: true,
    validate: (result) => {
      const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
      if (firstSpawn?.role === 'REMOTE_MINER' || firstSpawn?.role === 'REMOTE_HAULER') {
        return { passed: false, reason: `Spawned remote role ${firstSpawn.role} before fixing home economy` };
      }
      return { passed: true };
    },
  },
  
  // ============================================
  // RENEWAL SCENARIOS
  // ============================================
  {
    name: 'Hauler renewal at spawn',
    description: 'Hauler at home with low TTL should be renewed.',
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      hasSourceContainers: true,
      remoteRooms: [],
      initialEnergy: 1000,
      initialStored: 100000,
      constructionSites: 0,
      initialCreeps: [
        { role: 'HARVESTER', ttl: 1200, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HARVESTER', ttl: 1000, body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 150, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'HAULER', ttl: 900, body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'], position: 'home' },
        { role: 'UPGRADER', ttl: 600, body: ['work', 'work', 'carry', 'move', 'move'], position: 'home' },
      ],
    },
    maxTicks: 300,
    expectedSurvival: true,
    validate: (result) => {
      const renewals = result.events.filter(e => e.type === 'RENEW');
      if (renewals.length === 0) {
        return { passed: false, reason: 'No renewals occurred' };
      }
      return { passed: true };
    },
  },
];

export default SCENARIOS;
