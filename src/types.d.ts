// Extend Screeps memory types
// The @types/screeps package provides empty interfaces for us to extend

// Creep state machine states
type CreepState = "IDLE" | "COLLECTING" | "DELIVERING" | "BUILDING" | "UPGRADING" | "HARVESTING" | "TRAVELING" | "MOVING" | "WORKING";

// Container plan interface
interface ContainerPlan {
  sources: { [sourceId: string]: { x: number; y: number } };
  controller?: { x: number; y: number };
}

// Extend CreepMemory from @types/screeps
interface CreepMemory {
  role: string;
  room: string;
  sourceId?: Id<Source>;
  targetRoom?: string;
  parentRoom?: string;  // Parent colony for expansion pioneers

  // Task system
  taskId?: string;
  targetSiteId?: Id<ConstructionSite>;
  state?: CreepState;
  emergency?: boolean;

  // Energy acquisition coordination
  energyTarget?: Id<StructureContainer | StructureStorage | StructureLink | Resource | Tombstone | Ruin>;

  // Movement stuck detection
  _lastPos?: string;
  _stuckCount?: number;
  _safeWaypoint?: string; // Intermediate room for safe multi-hop routing

  // Hauler container targeting (dynamic per-trip selection)
  targetContainer?: Id<StructureContainer> | null;

  // Remote hauler renewal tracking
  _lastRenewTick?: number;
  _renewTicks?: number;
  _renewWaitStart?: number; // Tick when started waiting at spawn for renewal

  // Remote hauler delivery target cache (cleared on state change)
  deliverTarget?: Id<AnyStoreStructure>;

  // Harvester/defender renewal state
  renewing?: boolean;

  // Defender retreat state (damaged, needs tower healing)
  retreating?: boolean;

  // Combat duo system
  duoId?: string;
  partnerId?: Id<Creep>;

  // Legacy support
  working?: boolean;
}

// Task definition for RoomMemory
interface RoomTask {
  id: string;
  type: "HARVEST" | "SUPPLY_SPAWN" | "SUPPLY_TOWER" | "BUILD" | "UPGRADE" | "HAUL" | "DEFEND";
  targetId: Id<any>;
  priority: number;
  assignedCreep: string | null;
  createdAt: number;
}

// Extend RoomMemory from @types/screeps
// Note: Intel data (hostiles, lastScan, controller, hasKeepers) lives in Memory.intel[roomName]
interface RoomMemory {
  sources?: Id<Source>[];
  containerPlan?: ContainerPlan;
  tasks?: RoomTask[];

  // Assignment tracking
  assignments?: {
    harvesters: Record<string, string>; // sourceId -> creepName
    haulers: Record<string, string[]>; // containerId -> creepNames
  };

  // Lab placement plan (10 positions, ordered by placement priority)
  labPlan?: Array<{ x: number; y: number }>;
}

// AI Advisor recommendation
interface AdvisorRecommendation {
  priority: number;
  title: string;
  description: string;
  category?: string;
  status?: string;
}

// AI Advisor data stored in memory
interface AdvisorData {
  roomName: string;
  recommendations: AdvisorRecommendation[];
  snapshot?: unknown;
  recommendationCount?: number;
  fetchedAt?: number;
}

// Traffic tracking for intelligent road planning
interface TrafficMemory {
  heatmap: { [packedPos: string]: number }; // "x:y" → visit count
  lastReset: number; // Game.time of last reset
  windowSize: number; // Ticks per measurement window (default 1000)
  roadsSuggested: string[]; // Positions suggested but not built
  roadsBuilt: string[]; // Positions where we built roads
}

// Room intel for scouting and expansion planning
interface RoomIntel {
  roomName: string;
  lastScanned: number; // game tick

  // Room type
  roomType: "normal" | "sourceKeeper" | "center" | "highway";

  // Ownership
  owner: string | null;
  ownerRcl: number | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;

  // Resources
  sources: {
    id: string;
    pos: { x: number; y: number };
  }[];
  mineral: {
    type: MineralConstant;
    amount: number;
    id: string;
    pos: { x: number; y: number };
  } | null;

  // Terrain analysis
  terrain: {
    swampPercent: number;
    wallPercent: number;
    plainPercent: number;
  };

  // Exits
  exits: {
    top: string | null;
    right: string | null;
    bottom: string | null;
    left: string | null;
  };

  // Threats
  hostileStructures: {
    towers: number;
    spawns: number;
    hasTerminal: boolean;
  };
  invaderCore: boolean;
  hostiles: number; // Count of hostile creeps last seen
  lastHostileSeen: number; // Game.time when hostiles were last observed
  hostileDetails?: {
    id: string;
    owner: string;
    pos: { x: number; y: number };
    bodyParts: number;
    hasCombat: boolean;
  }[];

  // Distance from home
  distanceFromHome: number;

  // Calculated scores (for expansion planning)
  expansionScore?: number;
  remoteMiningScore?: number;
}

// Scout creep memory
interface ScoutMemory extends CreepMemory {
  targetRoom: string;
  scoutQueue: string[];
  homeRoom: string;
  scannedRooms?: string[]; // Rooms this scout has already scanned
}

// Debug flags
interface DebugFlags {
  showTraffic?: boolean;
  showEvaluations?: boolean; // Show framework evaluator logs per tick
}

// Visual settings
interface SettingsFlags {
  showVisuals?: boolean;
  logPositions?: boolean;
  lastExportTick?: number; // Last successful AWS export tick for delta tracking
  useDirectives?: boolean; // Enable AWS directive system (segment 95)
}

// Export metadata for AWS Lambda visibility
interface ExportMeta {
  lastExportTick: number;
  deltaIntelCount: number;
  totalIntelCount: number;
}

// Pioneer creep memory - self-sufficient generalist for young colonies and expansion
interface PioneerMemory extends CreepMemory {
  role: "PIONEER";
  room: string;
  state?: "TRAVELING" | "HARVESTING" | "DELIVERING" | "BUILDING" | "UPGRADING";
  sourceId?: Id<Source>;
  // Expansion fields (when targetRoom is set, this is an expansion pioneer)
  targetRoom?: string;
  parentRoom?: string;
  working?: boolean;
}

// Remote builder creep memory
interface RemoteBuilderMemory extends CreepMemory {
  role: "REMOTE_BUILDER";
  homeRoom: string;
  remoteRoom: string;          // Assigned remote room to build in
  working: boolean;            // true = building, false = collecting energy
  targetSiteId?: Id<ConstructionSite>;  // Current build target
}

// Remote defender creep memory
interface RemoteDefenderMemory extends CreepMemory {
  role: "REMOTE_DEFENDER";
  room: string;                    // Home room
  targetId?: Id<Creep>;            // Current hostile target (may be null if no vision)
  targetRoom?: string;             // Room with hostiles (persists even without vision)
  lastTargetSeen?: number;         // Game.time when target was last visible
  patrolRoom?: string;             // Assigned patrol room (optional)
  renewing?: boolean;              // Currently renewing at spawn
  retreating?: boolean;            // Currently retreating (legacy, cleared)
}

/**
 * Performance metrics for a remote room.
 * Updated periodically by EconomyTracker.
 */
interface RemoteRoomMetrics {
  lastUpdated: number;             // Game.time of last update

  // Energy flow
  estimatedIncome: number;         // Energy/tick this remote provides
  actualIncome: number;            // Measured income
  efficiency: number;              // actualIncome / estimatedIncome (0-1)

  // Hauler performance
  avgHaulDistance: number;         // Measured average path length
  haulerUtilization: number;       // % of time haulers are carrying vs empty
  energyDecay: number;             // Energy lost to decay in containers

  // Threats
  hostilesSeen: number;            // Count in last 1000 ticks
  lastHostileTick: number;         // Game.time of last hostile
  creepLosses: number;             // Creeps killed in this room (lifetime)
}

/**
 * Scoring data for remote room evaluation.
 * Used for automated remote selection (future feature).
 */
interface RemoteRoomScore {
  lastCalculated: number;          // Game.time of score calculation

  // Component scores (0-100 each)
  profitability: number;           // Net energy gain after hauler costs
  safety: number;                  // Inverse of threat frequency
  accessibility: number;           // Path quality, chokepoints

  // Derived
  totalScore: number;              // Weighted combination
  rank: number;                    // Rank among all candidates for this colony

  // Recommendation
  recommended: boolean;            // Should this room be mined?
  reason: string;                  // Why or why not
}

/**
 * Configuration for a remote mining room.
 * Designed for future extension with scoring/automation.
 */
interface RemoteRoomConfig {
  // === Core Identity ===
  room: string;                    // Room name (e.g., "E47N38")
  homeColony: string;              // Parent colony (e.g., "E46N37")

  // === Pathing ===
  distance: number;                // Tile distance: 1 = adjacent, 2 = one room away
  via?: string;                    // For distance 2+: intermediate room to path through

  // === Source Data (populated on first scout) ===
  sources: number;                 // Number of sources (1 or 2)
  sourceIds?: Id<Source>[];        // Actual source IDs once scouted

  // === Operational State ===
  active: boolean;                 // Currently being mined
  activatedAt?: number;            // Game.time when activated
  pausedUntil?: number;            // Temporarily paused (e.g., hostile activity)
  pauseReason?: string;            // Why paused

  // === Assigned Creeps (for tracking) ===
  miners: string[];                // Names of assigned REMOTE_MINERs
  haulers: string[];               // Names of assigned REMOTE_HAULERs

  // === Performance Metrics (updated periodically) ===
  metrics?: RemoteRoomMetrics;

  // === Future: Scoring (populated by evaluator) ===
  score?: RemoteRoomScore;
}

/**
 * Remote mining settings for a colony.
 */
interface RemoteSettings {
  maxDistance: number;             // Max distance to consider (default: 2)
  maxRemotes: number;              // Max simultaneous remotes (default: 4)
  minScoreThreshold: number;       // Minimum score to activate (future)
  autoExpand: boolean;             // Automatically add profitable remotes (future)
}

// Colony configuration (explicit registry for per-colony settings)
interface ColonyMemory {
  /** @deprecated Use remotes instead */
  remoteRooms?: string[];
  /** Game.time when remoteRooms was last auto-populated */
  remoteRoomsLastSync?: number;

  /** Structured remote room configuration (keyed by room name) */
  remotes?: Record<string, RemoteRoomConfig>;

  /** Remote mining settings */
  remoteSettings?: RemoteSettings;
}

// Combat duo state for DuoManager
interface DuoCombatState {
  id: string;
  state: "SPAWNING" | "RALLYING" | "ENGAGING" | "RETREATING" | "RECYCLING";
  attackerId: Id<Creep> | null;
  attackerName: string | null;
  healerId: Id<Creep> | null;
  healerName: string | null;
  assignment: {
    type: "DEFEND_REMOTE" | "DEFEND_ROOM" | "CLEAR_INVADER_CORE" | "ATTACK_ROOM" | "PATROL";
    priority: "CRITICAL" | "HIGH" | "NORMAL";
    targetRoom: string;
    homeRoom: string;
    reason?: string;
  };
  createdAt: number;
  stateChangedAt: number;
}

// Combat system memory
interface CombatMemory {
  useDuos: boolean;
  duos: Record<string, DuoCombatState>;
  nextDuoId: number;
}

// Integration Manager types for active colony integration
interface SpawnDirective {
  source: "INTEGRATION_MANAGER";
  roomName: string;         // Which colony's spawn to use
  role: string;
  priority: number;         // Higher than any utility score (e.g. 200)
  reason: string;           // For logging
  body?: BodyPartConstant[];  // Optional override
  memory?: Partial<CreepMemory>;
  maxActive: number;        // Don't spawn more than this many via directives
}

interface ColonyDiagnostic {
  roomName: string;
  rcl: number;
  hasSpawn: boolean;
  hasSourceContainers: boolean;
  hasStorage: boolean;
  hasControllerContainer: boolean;
  hasControllerLink: boolean;

  // Creep inventory
  harvesters: number;
  haulers: number;
  upgraders: number;
  builders: number;
  pioneers: number;

  // Economy
  energyAvailable: number;
  energyCapacity: number;
  spawnIdle: boolean;

  // Progression
  controllerProgress: number;
  controllerDowngradeTimer: number;
  ticksInState: number;

  // Gaps
  missingRoles: string[];
  stalledReason: string | null;
}

interface IntegrationState {
  diagnostics: {
    lastCheck: number;
    stalledSince: number | null;
    stalledReason: string | null;
    interventions: number;
  };
  directives: SpawnDirective[];
}

// Extend Memory for advisor data, traffic, intel, colonies, combat, and military
interface Memory {
  advisor?: AdvisorData;
  traffic?: { [roomName: string]: TrafficMemory };
  intel?: { [roomName: string]: RoomIntel };
  colonies?: { [roomName: string]: ColonyMemory };
  debug?: DebugFlags;
  settings?: SettingsFlags;
  combat?: CombatMemory;
  military?: MilitaryMemory;
  waveCoordinator?: WaveCoordinatorMemory;
}

// Military Manager types
interface MilitaryMemory {
  campaigns: Record<string, any>;
  nextCampaignId: number;
  posture: "PEACEFUL" | "ALERT" | "OFFENSIVE";
}

// Wave Coordinator types
interface WaveCoordinatorMemory {
  waves: Record<string, any>;
  nextWaveId: number;
}

// ==================== Decision Logging Types ====================

/**
 * Spawn decision - captures why a particular role was chosen
 */
interface SpawnDecision {
  tick: number;
  room: string;
  decision: "SPAWN" | "WAIT_ENERGY" | "QUEUE_FULL" | "NO_CANDIDATES";
  selectedRole: string | null;
  selectedUtility: number;
  selectedCost: number;
  energyAvailable: number;
  energyCapacity: number;
  phase: "BOOTSTRAP" | "DEVELOPING" | "STABLE" | "EMERGENCY";
  candidates: SpawnCandidate[];  // All roles considered, sorted by utility
}

/**
 * Individual spawn candidate with utility breakdown
 */
interface SpawnCandidate {
  role: string;
  utility: number;
  cost: number;
  deficit: number;           // How many more needed vs current count
  factors: Record<string, number>;  // Named factors that went into utility
}

/**
 * Task generation decision - captures phase-based task creation
 */
interface TaskGenDecision {
  tick: number;
  room: string;
  phase: "BOOTSTRAP" | "DEVELOPING" | "STABLE" | "EMERGENCY";
  energyAvailable: number;
  energyCapacity: number;
  tasksGenerated: number;
  tasksByType: Record<string, number>;  // e.g., { HARVEST: 2, BUILD: 3 }
  priorities: Record<string, number>;   // Adjusted priorities by type
}

/**
 * Task assignment decision - captures creep-task matching
 */
interface TaskAssignDecision {
  tick: number;
  room: string;
  creepName: string;
  creepRole: string;
  selectedTask: string | null;  // Task type or null if none
  selectedTaskId: string | null;
  selectedPriority: number;
  selectedDistance: number;
  alternativeCount: number;     // How many other tasks were available
}

/**
 * Creep role decision - captures in-role state transitions
 */
interface CreepDecision {
  tick: number;
  room: string;
  creepName: string;
  creepRole: string;
  decisionType: "STATE_CHANGE" | "TARGET_SELECT" | "RENEWAL" | "ACTION";
  previousState: string | null;
  newState: string | null;
  targetId: string | null;
  targetType: string | null;
  reason: string;               // Human-readable explanation
  factors?: Record<string, number | string | boolean>;  // Decision inputs
}

/**
 * Aggregated decision log for segment export
 */
interface DecisionLog {
  exportedAt: number;           // Game.time
  windowStart: number;          // First tick in this batch
  windowEnd: number;            // Last tick in this batch
  spawn: SpawnDecision[];       // Spawn decisions (max ~50 per export)
  taskGen: TaskGenDecision[];   // Task generation (1 per room per tick)
  taskAssign: TaskAssignDecision[];  // Task assignments (sampled)
  creep: CreepDecision[];       // Creep decisions (sampled, high-value only)
}

/**
 * Decision logging memory storage
 */
interface DecisionMemory {
  enabled: boolean;
  lastExport: number;           // Game.time of last segment write
  windowSize: number;           // Ticks between exports (default: 100)
  sampleRate: number;           // 0-1, fraction of creep decisions to log

  // Rolling buffers (cleared on export)
  spawn: SpawnDecision[];
  taskGen: TaskGenDecision[];
  taskAssign: TaskAssignDecision[];
  creep: CreepDecision[];

  // Stats
  totalSpawnDecisions: number;
  totalTaskAssigns: number;
  totalCreepDecisions: number;
}

// Military campaign types
type MilitaryCampaignPhase =
  | "PLANNING"
  | "SCOUTING"
  | "ATTACKING"
  | "WAITING_SAFE_MODE"
  | "WAITING_COOLDOWN"
  | "TOWER_DRAINING"
  | "CLAIMING"
  | "SECURING"
  | "COMPLETE"
  | "ABORTED"
  | "PAUSED";

interface MilitaryControllerAttackState {
  controllerPos: { x: number; y: number };
  approachDirection: "south" | "west" | "east" | "north";
  lastAttackTick: number;
  attackCount: number;
  currentTargetRCL: number;
  currentTicksToDowngrade: number;
  estimatedTicksRemaining: number;
  towerPositions: { x: number; y: number; lastEnergy: number }[];
  safeModeActive: boolean;
  safeModeEndsAt: number;
  upgradeBlockedUntil: number;
  defendersSeen: boolean;
  defendersLastSeen: number;
  towerDrainNeeded: boolean;
}

interface MilitaryCampaignState {
  id: string;
  type: "CONTROLLER_ATTACK" | "ROOM_ASSAULT" | "TOWER_DRAIN";
  targetRoom: string;
  homeRoom: string;
  supportRooms: string[];
  state: MilitaryCampaignPhase;
  stateChangedAt: number;
  createdAt: number;
  targetOwner: string;
  controllerAttack?: MilitaryControllerAttackState;
}

interface MilitaryMemory {
  campaigns: { [campaignId: string]: MilitaryCampaignState };
  nextCampaignId: number;
  posture: "PEACEFUL" | "ALERT" | "OFFENSIVE";
}

// ==================== AWS Directive System Types ====================

/**
 * Directive execution status tracked in Memory.directives
 */
interface DirectiveExecutionStatus {
  status: "COMPLETED" | "FAILED" | "EXPIRED";
  executedAt: number;
  result?: string;
}

/**
 * Spawn request queued by AWS directive system
 * Different from IntegrationManager's SpawnDirective
 */
interface AWSSpawnDirective {
  directiveId: string;        // Original directive ID for ack tracking
  colony: string;             // Target colony
  role: string;               // Role to spawn
  targetRoom?: string;        // Optional target room for the creep
  body?: BodyPartConstant[];  // Optional body override
  memory?: Partial<CreepMemory>;
  priority: number;           // Spawn priority
  reason: string;             // Human-readable reason
  addedAt: number;            // Game.time when queued
}

// Extend Memory to include decision logging, military, and directives
interface Memory {
  advisor?: AdvisorData;
  traffic?: { [roomName: string]: TrafficMemory };
  intel?: { [roomName: string]: RoomIntel };
  colonies?: { [roomName: string]: ColonyMemory };
  debug?: DebugFlags;
  settings?: SettingsFlags;
  combat?: CombatMemory;
  decisions?: DecisionMemory;
  military?: MilitaryMemory;
  waveCoordinator?: WaveCoordinatorMemory;
  // AWS Directive System
  directives?: { [directiveId: string]: DirectiveExecutionStatus };
  spawnDirectives?: AWSSpawnDirective[];
}

// Global console declaration for Screeps
declare const console: {
  log(...args: unknown[]): void;
};

// Room interface extension for per-tick caching
interface Room {
  /** Cached per-tick: true if home room is in emergency (no harvesters/haulers) */
  _remoteHaulerEmergency?: boolean;
}
