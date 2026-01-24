/**
 * Spawner Logic
 * 
 * This replicates the utility-based spawning system from the main codebase.
 * Replace this with imports from your actual code or keep in sync manually.
 */

import { SimState, SpawnCandidate } from './types';
import { 
  BODYPART_COST, 
  calculateBodyCost, 
  countParts,
  WORK_HARVEST_RATE,
  SOURCE_ENERGY_RATE,
} from './constants';

const ALL_ROLES = [
  'HARVESTER',
  'HAULER',
  'UPGRADER',
  'BUILDER',
  'DEFENDER',
  'REMOTE_MINER',
  'REMOTE_HAULER',
  'REMOTE_DEFENDER',
  'RESERVER',
  'SCOUT',
];

interface ColonyState {
  rcl: number;
  energyAvailable: number;
  energyCapacity: number;
  energyStored: number;
  energyIncome: number;
  energyIncomeMax: number;
  counts: Record<string, number>;
  targets: Record<string, number>;
  homeThreats: number;
  remoteThreatsByRoom: Record<string, number>;
  constructionSites: number;
  remoteRooms: string[];
  dyingSoon: Record<string, number>;
  hasSourceContainers: boolean;
}

/**
 * Convert SimState to ColonyState for spawner logic
 */
function simToColonyState(sim: SimState): ColonyState {
  // Calculate energy income from harvesters
  let energyIncome = 0;
  for (const creep of sim.creeps) {
    if (creep.role === 'HARVESTER' && creep.position === 'home') {
      const workParts = countParts(creep.body, 'work');
      energyIncome += workParts * WORK_HARVEST_RATE;
    }
  }
  
  const energyIncomeMax = sim.sources.count * SOURCE_ENERGY_RATE;
  
  // Count dying soon
  const dyingSoon: Record<string, number> = {};
  for (const creep of sim.creeps) {
    if (creep.ttl < 100) {
      dyingSoon[creep.role] = (dyingSoon[creep.role] || 0) + 1;
    }
  }
  
  // Calculate targets
  const targets = getCreepTargets(sim);
  
  // Remote threats
  const remoteThreatsByRoom: Record<string, number> = {};
  for (const room of sim.remoteRooms) {
    if (room.threatLevel > 0) {
      remoteThreatsByRoom[room.name] = room.threatLevel;
    }
  }
  
  return {
    rcl: sim.rcl,
    energyAvailable: sim.energyAvailable,
    energyCapacity: sim.energyCapacity,
    energyStored: sim.energyStored,
    energyIncome,
    energyIncomeMax,
    counts: { ...sim.counts },
    targets,
    homeThreats: sim.homeThreats,
    remoteThreatsByRoom,
    constructionSites: sim.constructionSites,
    remoteRooms: sim.remoteRooms.map(r => r.name),
    dyingSoon,
    hasSourceContainers: sim.containers.atSources,
  };
}

function getCreepTargets(sim: SimState): Record<string, number> {
  const rcl = sim.rcl;
  const sources = sim.sources.count;
  const hasStorage = sim.energyStored > 0 || rcl >= 4;
  
  const targets: Record<string, number> = {
    HARVESTER: sources,
    HAULER: hasStorage ? Math.max(2, sources) : sources,
    UPGRADER: rcl < 8 ? Math.min(rcl, 3) : 1,
    BUILDER: sim.constructionSites > 0 ? Math.min(2, rcl) : 0,
    DEFENDER: 0,
    REMOTE_MINER: 0,
    REMOTE_HAULER: 0,
    REMOTE_DEFENDER: 0,
    RESERVER: 0,
    SCOUT: 0,
  };
  
  // Remote operations at RCL 4+
  if (rcl >= 4) {
    let remoteSources = 0;
    for (const room of sim.remoteRooms) {
      remoteSources += room.sources;
    }
    
    targets.REMOTE_MINER = remoteSources;
    targets.REMOTE_HAULER = Math.ceil(remoteSources * 1.5);
    targets.RESERVER = sim.remoteRooms.length;
    targets.SCOUT = 1;  // Simplified
  }
  
  return targets;
}

/**
 * Main spawner function - returns best candidate or null
 */
export function getSpawnCandidate(sim: SimState): SpawnCandidate | null {
  const state = simToColonyState(sim);
  const candidates: SpawnCandidate[] = [];
  
  for (const role of ALL_ROLES) {
    const utility = calculateUtility(role, state);
    if (utility <= 0) continue;
    
    const body = buildBody(role, state);
    if (body.length === 0) continue;
    
    const cost = calculateBodyCost(body);
    if (cost > sim.energyAvailable) continue;
    
    // Skip remote roles without valid target
    const requiresTarget = ['REMOTE_MINER', 'REMOTE_HAULER', 'REMOTE_DEFENDER', 'RESERVER'];
    if (requiresTarget.includes(role)) {
      const hasTarget = findRemoteTarget(role, sim) !== null;
      if (!hasTarget) continue;
    }
    
    candidates.push({
      role,
      utility,
      body,
      cost,
      targetRoom: findRemoteTarget(role, sim) || undefined,
    });
  }
  
  if (candidates.length === 0) return null;
  
  candidates.sort((a, b) => b.utility - a.utility);
  return candidates[0];
}

function findRemoteTarget(role: string, sim: SimState): string | null {
  if (sim.remoteRooms.length === 0) return null;
  
  // Simplified: return first room that needs this role
  for (const room of sim.remoteRooms) {
    const minersInRoom = sim.creeps.filter(
      c => c.role === 'REMOTE_MINER' && c.targetRoom === room.name
    ).length;
    const haulersInRoom = sim.creeps.filter(
      c => c.role === 'REMOTE_HAULER' && c.targetRoom === room.name
    ).length;
    const reserversInRoom = sim.creeps.filter(
      c => c.role === 'RESERVER' && c.targetRoom === room.name
    ).length;
    
    if (role === 'REMOTE_MINER' && minersInRoom < room.sources) {
      return room.name;
    }
    if (role === 'REMOTE_HAULER' && haulersInRoom < Math.ceil(room.sources * 1.5)) {
      return room.name;
    }
    if (role === 'RESERVER' && reserversInRoom < 1) {
      return room.name;
    }
    if (role === 'REMOTE_DEFENDER' && room.threatLevel > 0) {
      const defendersInRoom = sim.creeps.filter(
        c => c.role === 'REMOTE_DEFENDER' && c.targetRoom === room.name
      ).length;
      if (defendersInRoom === 0) return room.name;
    }
  }
  
  return null;
}

function calculateUtility(role: string, state: ColonyState): number {
  const current = state.counts[role] || 0;
  const target = state.targets[role] || 0;
  const deficit = target - current;
  // NOTE: Removed dyingSoon from deficit per discussion
  
  switch (role) {
    case 'HARVESTER':
      return harvesterUtility(deficit, state);
    case 'HAULER':
      return haulerUtility(deficit, state);
    case 'UPGRADER':
      return upgraderUtility(deficit, state);
    case 'BUILDER':
      return builderUtility(deficit, state);
    case 'DEFENDER':
      return defenderUtility(state);
    case 'REMOTE_MINER':
      return remoteMinerUtility(deficit, state);
    case 'REMOTE_HAULER':
      return remoteHaulerUtility(deficit, state);
    case 'REMOTE_DEFENDER':
      return remoteDefenderUtility(state);
    case 'RESERVER':
      return reserverUtility(deficit, state);
    case 'SCOUT':
      return scoutUtility(deficit, state);
    default:
      return 0;
  }
}

function harvesterUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;
  
  let utility = deficit * 100;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  const scarcityMultiplier = 1 / Math.max(incomeRatio, 0.01);
  
  utility *= scarcityMultiplier;
  
  return utility;
}

function haulerUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;
  if ((state.counts.HARVESTER || 0) === 0) return 0;
  
  let utility = deficit * 90;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  
  if ((state.counts.HAULER || 0) === 0 && state.energyIncome > 0) {
    utility *= 10;
  } else {
    utility *= 1 + incomeRatio;
  }
  
  return utility;
}

function upgraderUtility(deficit: number, state: ColonyState): number {
  if (deficit <= 0) return 0;
  
  let utility = deficit * 20;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  if (state.energyStored > 100000) {
    utility *= 1.5;
  }
  
  return utility;
}

function builderUtility(deficit: number, state: ColonyState): number {
  if (state.constructionSites === 0) return 0;
  if (deficit <= 0) return 0;
  
  let utility = deficit * 25;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  utility *= Math.min(state.constructionSites / 5, 2);
  
  return utility;
}

function defenderUtility(state: ColonyState): number {
  if (state.homeThreats === 0) return 0;
  
  const current = state.counts.DEFENDER || 0;
  let utility = state.homeThreats * 50;
  utility *= 1 / (current + 1);
  
  return utility;
}

function remoteMinerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;
  if (state.remoteRooms.length === 0) return 0;
  
  if ((state.counts.HARVESTER || 0) < 2 || (state.counts.HAULER || 0) < 1) {
    return 0;
  }
  
  let utility = deficit * 40;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  return utility;
}

function remoteHaulerUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;
  if ((state.counts.REMOTE_MINER || 0) === 0) return 0;
  
  let utility = deficit * 35;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  return utility;
}

function remoteDefenderUtility(state: ColonyState): number {
  if (state.rcl < 4) return 0;
  
  let maxThreat = 0;
  for (const [_, threatCount] of Object.entries(state.remoteThreatsByRoom)) {
    if (threatCount > maxThreat) {
      maxThreat = threatCount;
    }
  }
  
  if (maxThreat === 0) return 0;
  
  let utility = maxThreat * 30;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  return utility;
}

function reserverUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 4) return 0;
  if (deficit <= 0) return 0;
  if (state.remoteRooms.length === 0) return 0;
  if ((state.counts.REMOTE_MINER || 0) === 0) return 0;
  
  let utility = deficit * 25;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  return utility;
}

function scoutUtility(deficit: number, state: ColonyState): number {
  if (state.rcl < 3) return 0;
  if (deficit <= 0) return 0;
  
  let utility = deficit * 5;
  
  const incomeRatio = state.energyIncome / Math.max(state.energyIncomeMax, 1);
  utility *= incomeRatio;
  
  return utility;
}

/**
 * Build body for role given energy state
 */
function buildBody(role: string, state: ColonyState): string[] {
  // Emergency detection
  const noHarvesters = (state.counts.HARVESTER || 0) === 0;
  const noHaulers = (state.counts.HAULER || 0) === 0;
  const isEmergency = noHarvesters || noHaulers;
  
  const energy = isEmergency ? state.energyAvailable : state.energyCapacity;
  
  if (energy < 200) return [];
  
  switch (role) {
    case 'HARVESTER':
      return buildHarvesterBody(energy, state);
    case 'HAULER':
      return buildHaulerBody(energy);
    case 'UPGRADER':
      return buildUpgraderBody(energy);
    case 'BUILDER':
      return buildBuilderBody(energy);
    case 'DEFENDER':
      return buildDefenderBody(energy);
    case 'REMOTE_MINER':
      return buildRemoteMinerBody(energy);
    case 'REMOTE_HAULER':
      return buildRemoteHaulerBody(energy);
    case 'REMOTE_DEFENDER':
      return buildRemoteDefenderBody(energy);
    case 'RESERVER':
      return buildReserverBody(energy);
    case 'SCOUT':
      return ['move'];
    default:
      return [];
  }
}

function buildHarvesterBody(energy: number, state: ColonyState): string[] {
  if (energy < 300) {
    return ['work', 'carry', 'move'];
  }
  
  const parts: string[] = [];
  let remaining = energy;
  
  // Add WORK parts (max 5)
  while (remaining >= 100 && parts.filter(p => p === 'work').length < 5) {
    parts.push('work');
    remaining -= 100;
  }
  
  // Add 1 CARRY
  if (remaining >= 50) {
    parts.push('carry');
    remaining -= 50;
  }
  
  // Add MOVE parts
  const otherParts = parts.length;
  const movesNeeded = Math.ceil(otherParts / 2);
  while (remaining >= 50 && parts.filter(p => p === 'move').length < movesNeeded) {
    parts.push('move');
    remaining -= 50;
  }
  
  return parts.length >= 3 ? parts : ['work', 'carry', 'move'];
}

function buildHaulerBody(energy: number): string[] {
  const parts: string[] = [];
  let remaining = energy;
  
  while (remaining >= 100 && parts.length < 32) {
    parts.push('carry');
    parts.push('move');
    remaining -= 100;
  }
  
  return parts.length >= 2 ? parts : ['carry', 'move'];
}

function buildUpgraderBody(energy: number): string[] {
  if (energy < 200) return ['work', 'carry', 'move'];
  
  const parts: string[] = [];
  let remaining = energy;
  
  while (remaining >= 200 && parts.length < 30) {
    parts.push('work');
    parts.push('carry');
    parts.push('move');
    remaining -= 200;
  }
  
  return parts.length >= 3 ? parts : ['work', 'carry', 'move'];
}

function buildBuilderBody(energy: number): string[] {
  return buildUpgraderBody(energy);  // Same pattern
}

function buildDefenderBody(energy: number): string[] {
  const parts: string[] = [];
  let remaining = energy;
  
  // Add TOUGH
  while (remaining >= 60 && parts.filter(p => p === 'tough').length < 3) {
    parts.push('tough');
    remaining -= 10;
  }
  
  // Add ATTACK and MOVE
  while (remaining >= 130 && parts.length < 25) {
    parts.push('attack');
    parts.push('move');
    remaining -= 130;
  }
  
  return parts.length >= 3 ? parts : ['attack', 'move', 'move'];
}

function buildRemoteMinerBody(energy: number): string[] {
  if (energy >= 700) {
    return ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'];
  } else if (energy >= 550) {
    return ['work', 'work', 'work', 'work', 'carry', 'move', 'move'];
  } else if (energy >= 400) {
    return ['work', 'work', 'work', 'carry', 'move', 'move'];
  }
  return ['work', 'work', 'carry', 'move'];
}

function buildRemoteHaulerBody(energy: number): string[] {
  const parts: string[] = [];
  let remaining = energy;
  
  while (remaining >= 100 && parts.length < 32) {
    parts.push('carry');
    parts.push('move');
    remaining -= 100;
  }
  
  return parts.length >= 4 ? parts : ['carry', 'carry', 'move', 'move'];
}

function buildRemoteDefenderBody(energy: number): string[] {
  if (energy >= 650) {
    return ['tough', 'tough', 'attack', 'attack', 'attack', 'move', 'move', 'move', 'move', 'move'];
  }
  return ['tough', 'attack', 'attack', 'move', 'move', 'move'];
}

function buildReserverBody(energy: number): string[] {
  if (energy >= 1300) {
    return ['claim', 'claim', 'move', 'move'];
  }
  return ['claim', 'move'];
}
