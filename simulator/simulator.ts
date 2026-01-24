/**
 * Economic Loop Simulator
 * 
 * Simulates colony evolution over time to test spawner decisions.
 */

import { 
  SimState, 
  SimConfig, 
  SimResult, 
  SimSnapshot, 
  SimEvent, 
  SimCreep,
  ScenarioInjection,
} from './types';
import { getSpawnCandidate } from './spawner';
import {
  CREEP_LIFE_TIME,
  SPAWN_TICKS_PER_PART,
  WORK_HARVEST_RATE,
  SOURCE_ENERGY_RATE,
  RENEW_TTL_THRESHOLD,
  countParts,
  getCarryCapacity,
  calculateBodyCost,
} from './constants';

/**
 * Initialize simulation state from config
 */
export function initializeState(config: SimConfig): SimState {
  const creeps: SimCreep[] = config.initialCreeps.map((c, i) => ({
    id: c.id || `${c.role}_init_${i}`,
    role: c.role || 'HARVESTER',
    ttl: c.ttl || CREEP_LIFE_TIME,
    body: c.body || ['work', 'carry', 'move'],
    spawnTick: c.spawnTick || 0,
    position: c.position || 'home',
    targetRoom: c.targetRoom,
    carryUsed: c.carryUsed || 0,
    carryCapacity: c.carryCapacity || getCarryCapacity(c.body || ['work', 'carry', 'move']),
  }));
  
  // Count initial creeps
  const counts: Record<string, number> = {};
  for (const creep of creeps) {
    counts[creep.role] = (counts[creep.role] || 0) + 1;
  }
  
  return {
    tick: 0,
    energyAvailable: config.initialEnergy,
    energyCapacity: config.energyCapacity,
    energyStored: config.initialStored,
    sources: {
      count: config.sources,
      maxPerTick: config.sources * SOURCE_ENERGY_RATE,
    },
    containers: {
      atSources: config.hasSourceContainers,
      energy: 0,
    },
    creeps,
    spawning: null,
    counts,
    rcl: config.rcl,
    remoteRooms: config.remoteRooms.map(r => ({
      ...r,
      hasContainer: true,
      threatLevel: 0,
    })),
    homeThreats: 0,
    constructionSites: config.constructionSites,
  };
}

/**
 * Simulate one tick
 */
export function simulateTick(state: SimState): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  let next = { ...state, tick: state.tick + 1 };
  
  // Deep copy creeps array
  next.creeps = state.creeps.map(c => ({ ...c }));
  next.counts = { ...state.counts };
  next.remoteRooms = state.remoteRooms.map(r => ({ ...r }));
  
  // 1. ENERGY GENERATION from harvesters
  next = simulateHarvesting(next);
  
  // 2. REMOTE OPERATIONS - haulers bring energy back
  const remoteEvents = simulateRemoteOperations(next);
  events.push(...remoteEvents.events);
  next = remoteEvents.state;
  
  // 3. SPAWNING PROGRESS
  if (next.spawning) {
    next.spawning = { ...next.spawning };
    next.spawning.ticksRemaining--;
    
    if (next.spawning.ticksRemaining <= 0) {
      // Spawn complete
      const newCreep: SimCreep = {
        id: `${next.spawning.role}_${next.tick}`,
        role: next.spawning.role,
        ttl: CREEP_LIFE_TIME,
        body: next.spawning.body,
        spawnTick: next.tick,
        position: 'home',
        carryUsed: 0,
        carryCapacity: getCarryCapacity(next.spawning.body),
      };
      
      // Assign target room for remote roles
      if (['REMOTE_MINER', 'REMOTE_HAULER', 'RESERVER', 'REMOTE_DEFENDER'].includes(newCreep.role)) {
        // Find first room that needs this role
        for (const room of next.remoteRooms) {
          const existingCount = next.creeps.filter(
            c => c.role === newCreep.role && c.targetRoom === room.name
          ).length;
          
          let needed = 0;
          if (newCreep.role === 'REMOTE_MINER') needed = room.sources;
          if (newCreep.role === 'REMOTE_HAULER') needed = Math.ceil(room.sources * 1.5);
          if (newCreep.role === 'RESERVER') needed = 1;
          if (newCreep.role === 'REMOTE_DEFENDER') needed = room.threatLevel > 0 ? 1 : 0;
          
          if (existingCount < needed) {
            newCreep.targetRoom = room.name;
            break;
          }
        }
      }
      
      next.creeps.push(newCreep);
      next.counts[newCreep.role] = (next.counts[newCreep.role] || 0) + 1;
      
      events.push({
        tick: next.tick,
        type: 'SPAWN_COMPLETE',
        role: newCreep.role,
        details: `body=${newCreep.body.length} parts`,
      });
      
      next.spawning = null;
    }
  }
  
  // 4. RENEWAL - creeps at spawn with low TTL
  const renewalEvents = simulateRenewal(next);
  events.push(...renewalEvents.events);
  next = renewalEvents.state;
  
  // 5. SPAWNER DECISION (if not spawning and not renewing)
  if (!next.spawning) {
    const candidate = getSpawnCandidate(next);
    
    if (candidate && candidate.cost <= next.energyAvailable) {
      next.energyAvailable -= candidate.cost;
      next.spawning = {
        role: candidate.role,
        body: candidate.body,
        ticksRemaining: candidate.body.length * SPAWN_TICKS_PER_PART,
        cost: candidate.cost,
      };
      
      events.push({
        tick: next.tick,
        type: 'SPAWN_START',
        role: candidate.role,
        details: `utility=${candidate.utility.toFixed(1)}, cost=${candidate.cost}`,
      });
    }
  }
  
  // 6. AGE CREEPS
  for (const creep of next.creeps) {
    creep.ttl--;
  }
  
  // 7. REMOVE DEAD CREEPS
  const deadCreeps = next.creeps.filter(c => c.ttl <= 0);
  for (const dead of deadCreeps) {
    events.push({
      tick: next.tick,
      type: 'DEATH',
      role: dead.role,
      details: `id=${dead.id}`,
    });
    next.counts[dead.role] = Math.max(0, (next.counts[dead.role] || 0) - 1);
  }
  next.creeps = next.creeps.filter(c => c.ttl > 0);
  
  return { state: next, events };
}

/**
 * Simulate harvesting - harvesters generate energy
 */
function simulateHarvesting(state: SimState): SimState {
  const next = { ...state };
  
  // Count WORK parts on home harvesters
  let totalWorkParts = 0;
  for (const creep of next.creeps) {
    if (creep.role === 'HARVESTER' && creep.position === 'home') {
      totalWorkParts += countParts(creep.body, 'work');
    }
  }
  
  // Cap harvest at source max
  const harvestRate = Math.min(totalWorkParts * WORK_HARVEST_RATE, next.sources.maxPerTick);
  
  if (next.containers.atSources) {
    // Static mining: energy goes to containers, then haulers move it
    next.containers.energy += harvestRate;
    
    // Haulers move from containers to spawn/storage
    const haulers = next.creeps.filter(c => c.role === 'HAULER' && c.position === 'home');
    let haulerCapacity = 0;
    for (const h of haulers) {
      haulerCapacity += getCarryCapacity(h.body);
    }
    
    const moved = Math.min(next.containers.energy, haulerCapacity);
    next.containers.energy -= moved;
    next.energyAvailable = Math.min(next.energyAvailable + moved, next.energyCapacity);
  } else {
    // Mobile harvesting: harvesters deliver directly (less efficient)
    // Assume 50% efficiency due to travel
    const delivered = harvestRate * 0.5;
    next.energyAvailable = Math.min(next.energyAvailable + delivered, next.energyCapacity);
  }
  
  return next;
}

/**
 * Simulate remote mining operations
 */
function simulateRemoteOperations(state: SimState): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  let next = { ...state };
  next.creeps = state.creeps.map(c => ({ ...c }));
  
  for (const creep of next.creeps) {
    // Remote miners
    if (creep.role === 'REMOTE_MINER') {
      if (!creep.targetRoom) continue;
      
      const room = next.remoteRooms.find(r => r.name === creep.targetRoom);
      if (!room) continue;
      
      if (creep.position === 'home') {
        // Start traveling to remote
        creep.position = 'traveling_out';
        creep.travelProgress = 0;
      } else if (creep.position === 'traveling_out') {
        creep.travelProgress = (creep.travelProgress || 0) + 1;
        if (creep.travelProgress >= room.distance) {
          creep.position = 'remote';
        }
      }
      // Remote miners stay in remote room, don't return
    }
    
    // Remote haulers
    if (creep.role === 'REMOTE_HAULER') {
      if (!creep.targetRoom) continue;
      
      const room = next.remoteRooms.find(r => r.name === creep.targetRoom);
      if (!room) continue;
      
      if (creep.position === 'home') {
        // At spawn - check for renewal opportunity
        // (handled in renewal section)
        
        // Start traveling to remote (empty)
        creep.position = 'traveling_out';
        creep.travelProgress = 0;
        creep.carryUsed = 0;
      } else if (creep.position === 'traveling_out') {
        creep.travelProgress = (creep.travelProgress || 0) + 1;
        if (creep.travelProgress >= room.distance) {
          creep.position = 'remote';
        }
      } else if (creep.position === 'remote') {
        // Pick up energy from remote miners
        const remoteMiners = next.creeps.filter(
          c => c.role === 'REMOTE_MINER' && c.targetRoom === room.name && c.position === 'remote'
        );
        
        // Each remote miner generates ~10 energy/tick
        const available = remoteMiners.length * 10;
        const pickup = Math.min(available, creep.carryCapacity - creep.carryUsed);
        creep.carryUsed += pickup;
        
        // If full, head back
        if (creep.carryUsed >= creep.carryCapacity * 0.8) {
          creep.position = 'traveling_back';
          creep.travelProgress = 0;
        }
      } else if (creep.position === 'traveling_back') {
        creep.travelProgress = (creep.travelProgress || 0) + 1;
        if (creep.travelProgress >= room.distance) {
          creep.position = 'home';
          // Deliver energy
          next.energyAvailable = Math.min(
            next.energyAvailable + creep.carryUsed,
            next.energyCapacity
          );
          creep.carryUsed = 0;
        }
      }
    }
    
    // Reservers, Remote defenders - simplified, just travel
    if (creep.role === 'RESERVER' || creep.role === 'REMOTE_DEFENDER') {
      if (!creep.targetRoom) continue;
      
      const room = next.remoteRooms.find(r => r.name === creep.targetRoom);
      if (!room) continue;
      
      if (creep.position === 'home') {
        creep.position = 'traveling_out';
        creep.travelProgress = 0;
      } else if (creep.position === 'traveling_out') {
        creep.travelProgress = (creep.travelProgress || 0) + 1;
        if (creep.travelProgress >= room.distance) {
          creep.position = 'remote';
        }
      }
      // Stay in remote
    }
  }
  
  return { state: next, events };
}

/**
 * Simulate renewal - creeps at spawn with low TTL get renewed
 */
function simulateRenewal(state: SimState): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  let next = { ...state };
  next.creeps = state.creeps.map(c => ({ ...c }));
  
  // Only renew if spawn is free
  if (next.spawning) {
    return { state: next, events };
  }
  
  // Find creeps at home with low TTL
  // Prioritize by body cost (expensive creeps first)
  const candidates = next.creeps
    .filter(c => c.position === 'home' && c.ttl < RENEW_TTL_THRESHOLD)
    .sort((a, b) => calculateBodyCost(b.body) - calculateBodyCost(a.body));
  
  if (candidates.length === 0) {
    return { state: next, events };
  }
  
  const toRenew = candidates[0];
  
  // Renewal cost: ceil(creepCost / 2.5 / bodyParts) per tick
  // Renewal gain: floor(600 / bodyParts) TTL per tick
  const bodyCost = calculateBodyCost(toRenew.body);
  const bodyParts = toRenew.body.length;
  const renewCost = Math.ceil(bodyCost / 2.5 / bodyParts);
  const renewGain = Math.floor(600 / bodyParts);
  
  // Only renew if we can afford it and it's worth it
  if (next.energyAvailable >= renewCost && toRenew.ttl + renewGain <= CREEP_LIFE_TIME) {
    next.energyAvailable -= renewCost;
    toRenew.ttl = Math.min(toRenew.ttl + renewGain, CREEP_LIFE_TIME);
    
    events.push({
      tick: next.tick,
      type: 'RENEW',
      role: toRenew.role,
      details: `ttl=${toRenew.ttl}, cost=${renewCost}`,
    });
  }
  
  return { state: next, events };
}

/**
 * Run full simulation
 */
export function simulate(
  config: SimConfig,
  maxTicks: number = 2000,
  injections: { tick: number; action: ScenarioInjection }[] = [],
  snapshotInterval: number = 50
): SimResult {
  let state = initializeState(config);
  
  const history: SimSnapshot[] = [];
  const allEvents: SimEvent[] = [];
  let deathTick: number | null = null;
  let recoveryTick: number | null = null;
  let peakCreeps = state.creeps.length;
  let minCreeps = state.creeps.length;
  let totalSpawned = 0;
  let totalDeaths = 0;
  let totalRenewals = 0;
  let totalEnergy = state.energyAvailable;
  let energySamples = 1;
  
  // Sort injections by tick
  const sortedInjections = [...injections].sort((a, b) => a.tick - b.tick);
  let injectionIndex = 0;
  
  for (let t = 0; t < maxTicks; t++) {
    // Apply injections
    while (injectionIndex < sortedInjections.length && sortedInjections[injectionIndex].tick <= t) {
      state = sortedInjections[injectionIndex].action(state, t);
      allEvents.push({
        tick: t,
        type: 'INJECT',
        details: `Injection ${injectionIndex + 1}`,
      });
      injectionIndex++;
    }
    
    // Simulate tick
    const { state: nextState, events } = simulateTick(state);
    state = nextState;
    allEvents.push(...events);
    
    // Track stats
    peakCreeps = Math.max(peakCreeps, state.creeps.length);
    minCreeps = Math.min(minCreeps, state.creeps.length);
    totalEnergy += state.energyAvailable;
    energySamples++;
    
    for (const event of events) {
      if (event.type === 'SPAWN_COMPLETE') totalSpawned++;
      if (event.type === 'DEATH') totalDeaths++;
      if (event.type === 'RENEW') totalRenewals++;
    }
    
    // Snapshot history
    if (t % snapshotInterval === 0) {
      // Calculate current energy income
      let energyIncome = 0;
      for (const c of state.creeps) {
        if (c.role === 'HARVESTER' && c.position === 'home') {
          energyIncome += countParts(c.body, 'work') * WORK_HARVEST_RATE;
        }
      }
      
      history.push({
        tick: state.tick,
        creepCount: state.creeps.length,
        counts: { ...state.counts },
        energyAvailable: state.energyAvailable,
        energyStored: state.energyStored,
        energyIncome: Math.min(energyIncome, state.sources.maxPerTick),
      });
    }
    
    // Check for death
    const isAlive = state.creeps.length > 0 || state.spawning !== null;
    if (!isAlive && deathTick === null) {
      deathTick = state.tick;
      allEvents.push({ tick: state.tick, type: 'WIPE' });
    }
    
    // Check for recovery
    if (deathTick !== null && recoveryTick === null && state.creeps.length > 0) {
      recoveryTick = state.tick;
      allEvents.push({ tick: state.tick, type: 'RECOVERY' });
    }
  }
  
  const survived = state.creeps.length > 0 || state.spawning !== null;
  
  return {
    survived,
    finalTick: state.tick,
    deathTick,
    recoveryTick,
    peakCreeps,
    minCreeps,
    totalSpawned,
    totalDeaths,
    totalRenewals,
    averageEnergy: totalEnergy / energySamples,
    history,
    events: allEvents,
  };
}
