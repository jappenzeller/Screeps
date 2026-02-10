// Response from GET /military
export interface MilitaryStatus {
  posture: 'PEACEFUL' | 'ALERT' | 'OFFENSIVE';
  campaigns: CampaignSummary[];
  campaignCount: number;
}

export interface CampaignSummary {
  id: string;
  type: 'CONTROLLER_ATTACK' | 'ROOM_ASSAULT' | 'TOWER_DRAIN';
  targetRoom: string;
  targetOwner: string;
  state: CampaignPhase;
  stateChangedAt: number;
  createdAt: number;
  // Attack summary
  currentRCL: number | null;
  ticksToDowngrade: number | null;
  attackCount: number;
  safeModeActive: boolean;
  safeModeEndsAt: number | null;
  defendersSeen: boolean;
  towerDrainNeeded: boolean;
  // Stats summary
  stats: CampaignStats | null;
  // Conquest phase
  conquestPhase: ConquestPhase | null;
}

export type CampaignPhase =
  | 'PLANNING'
  | 'SCOUTING'
  | 'ATTACKING'
  | 'WAITING_SAFE_MODE'
  | 'WAITING_COOLDOWN'
  | 'TOWER_DRAINING'
  | 'CLAIMING'
  | 'SECURING'
  | 'COMPLETE'
  | 'ABORTED'
  | 'PAUSED';

export type ConquestPhase =
  | 'DEMOLISHING'
  | 'BLOCKING'
  | 'READY_TO_CLAIM'
  | 'CLAIMING'
  | 'BOOTSTRAPPING'
  | 'DONE';

export interface CampaignStats {
  totalSpawned: number;
  totalLost: number;
  totalEnergySpent: number;
  rclDowngrades: number[];
  safeModeActivations: number;
  campaignStartTimer: number;
  campaignStartRCL: number;
}

// Response from GET /military/{campaignId}
export interface CampaignDetail {
  id: string;
  type: 'CONTROLLER_ATTACK' | 'ROOM_ASSAULT' | 'TOWER_DRAIN';
  targetRoom: string;
  targetOwner: string;
  state: CampaignPhase;
  stateChangedAt: number;
  createdAt: number;
  controllerAttack: ControllerAttackState;
  conquest: ConquestState | null;
  eventLog: CampaignEvent[];
  counterIntel: CounterIntelState | null;
}

export interface ControllerAttackState {
  controllerPos: { x: number; y: number };
  approachDirection: 'south' | 'west' | 'east' | 'north';
  lastAttackTick: number;
  attackCount: number;
  currentTargetRCL: number;
  currentTicksToDowngrade: number;
  estimatedTicksRemaining: number;
  estimatedCyclesRemaining: number;
  towerPositions: TowerPosition[];
  safeModeActive: boolean;
  safeModeEndsAt: number;
  upgradeBlockedUntil: number;
  defendersSeen: boolean;
  defendersLastSeen: number;
  towerDrainNeeded: boolean;
  stats: CampaignStats;
}

export interface TowerPosition {
  x: number;
  y: number;
  lastEnergy: number;
}

export interface ConquestState {
  phase: ConquestPhase;
  structuresRemaining: number;
  demolishersActive: number;
  blockersActive: number;
  claimersActive: number;
  spawnsCleared: boolean;
  towersCleared: boolean;
  enemyClaimersDetected: boolean;
}

export interface CampaignEvent {
  tick: number;
  type: EventType;
  detail: string;
  data?: Record<string, unknown>;
}

export type EventType =
  | 'CAMPAIGN_CREATED'
  | 'STATE_CHANGE'
  | 'ATTACK_LANDED'
  | 'CREEP_LOST'
  | 'RCL_DOWNGRADE'
  | 'SAFE_MODE'
  | 'TOWER_DRAIN_START'
  | 'TOWER_DRAIN_END'
  | 'ESCORT_REQUESTED'
  | 'DEFENDER_DETECTED'
  | 'COUNTER_INTEL_ALERT'
  | 'CONQUEST_PHASE'
  | 'EXPANSION_TRIGGERED'
  | 'CAMPAIGN_COMPLETE'
  | 'CAMPAIGN_ABORTED';

export interface CounterIntelState {
  alerts: CounterIntelAlert[];
  lastSnapshot: number;
}

export interface CounterIntelAlert {
  tick: number;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  detail: string;
}
