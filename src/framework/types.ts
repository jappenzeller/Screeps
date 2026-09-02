/**
 * Declarative Framework Core Types
 *
 * These interfaces define the contract for the utility-based decision system.
 * All evaluators produce ScoredOptions, the Arbitrator resolves conflicts,
 * and Telemetry logs decisions for AI advisor analysis.
 */

// ============================================================================
// WORLD STATE TYPES
// ============================================================================

/**
 * Immutable snapshot of the game world, captured once per tick.
 * All evaluators read from this - no direct game API calls.
 */
export interface WorldState {
  tick: number;
  colonies: Map<string, ColonySnapshot>;
  intel: Map<string, RoomIntelSnapshot>;
  empire: EmpireSnapshot;
  weights: WeightTable;
}

/**
 * Complete colony state snapshot
 */
export interface ColonySnapshot {
  // Identity
  roomName: string;
  rcl: number;
  rclProgress: number;
  rclProgressTotal: number;

  // Energy economy
  energyAvailable: number;
  energyCapacity: number;
  energyStored: number;
  harvestIncome: number; // energy/tick from active harvesters
  maxHarvestIncome: number; // theoretical max (sources * 10)
  totalBurn: number; // energy/tick consumption (builders + upgraders)
  netFlow: number; // harvestIncome - totalBurn

  // Population
  creeps: CreepSnapshot[];
  counts: Record<string, number>; // role -> count
  dyingSoon: Record<string, number>; // role -> count with TTL < threshold
  /**
   * How many of each role the colony wants, from core/ColonyTargets - the same answer
   * utilitySpawning uses. The evaluator used to compute this itself and disagreed often
   * enough to propose nothing on 62% of the ticks where a spawn actually happened.
   */
  targets: Record<string, number>;

  // Infrastructure
  structures: StructureSnapshot[];
  structureCounts: Record<string, number>; // type -> count
  constructionSites: SiteSnapshot[];
  siteCounts: Record<string, number>; // type -> count

  // Milestones (key progression markers)
  milestones: ColonyMilestones;

  // Threats
  hostileCount: number;
  hostileDPS: number;
  threatLevel: ThreatLevel;
  spawnUnderAttack: boolean;

  // Remote mining
  remotes: RemoteSnapshot[];
  activeRemoteCount: number;

  // Derived convenience fields
  sourceCount: number;
  containerCount: number;
  sourceContainerCount: number;
  extensionCount: number;
  maxExtensions: number;
  towerCount: number;
  maxTowers: number;
  linkCount: number;
  maxLinks: number;
  hasStorage: boolean;
  hasTerminal: boolean;

  // Traffic data (for road scoring)
  trafficHotspots: TrafficHotspot[];
}

/**
 * Key colony progression markers
 */
export interface ColonyMilestones {
  hasSourceContainers: boolean; // All sources have containers
  hasControllerContainer: boolean;
  hasControllerLink: boolean;
  hasStorageLink: boolean;
  hasFullExtensions: boolean; // All extensions for current RCL built
  hasAllTowers: boolean; // All towers for current RCL built
  hasLabs: boolean;
  hasFactory: boolean;
}

/**
 * Threat level enum (matches existing ColonyState)
 */
export enum ThreatLevel {
  NONE = 0,
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  CRITICAL = 4,
}

/**
 * Creep snapshot for workforce analysis
 */
export interface CreepSnapshot {
  id: Id<Creep>;
  name: string;
  role: string;
  roomName: string;
  ticksToLive: number;
  bodyParts: Record<string, number>; // WORK -> count, etc.
  carrying: number;
  carryCapacity: number;
  fatigue: number;
  spawning: boolean;
  pos: { x: number; y: number; roomName: string };
}

/**
 * Structure snapshot
 */
export interface StructureSnapshot {
  id: Id<AnyStructure>;
  type: StructureConstant;
  pos: { x: number; y: number };
  hits: number;
  hitsMax: number;
  energy?: number; // for containers, storage, etc.
  energyCapacity?: number;
}

/**
 * Construction site snapshot
 */
export interface SiteSnapshot {
  id: Id<ConstructionSite>;
  type: BuildableStructureConstant;
  pos: { x: number; y: number };
  progress: number;
  progressTotal: number;
}

/**
 * Remote mining room snapshot
 */
export interface RemoteSnapshot {
  roomName: string;
  distance: number;
  via?: string;
  sources: number;
  active: boolean;
  paused: boolean;
  pauseReason?: string;
  minerCount: number;
  haulerCount: number;
  hasContainers: boolean;
  hasReserver: boolean;
  hostilePresent: boolean;
  estimatedIncome: number;
}

/**
 * Room intel snapshot (for non-owned rooms)
 */
export interface RoomIntelSnapshot {
  roomName: string;
  lastScanned: number;
  roomType: "normal" | "sourceKeeper" | "center" | "highway";
  owner: string | null;
  ownerRcl: number | null;
  sources: number;
  hostile: boolean;
  hostileCount: number;
  invaderCore: boolean;
  distanceFromHome: number;
}

/**
 * Empire-level snapshot
 */
export interface EmpireSnapshot {
  ownedRooms: string[];
  totalCreeps: number;
  totalEnergy: number;
  gcl: number;
  gclProgress: number;
  cpuUsed: number;
  cpuLimit: number;
  bucket: number;
  expansionTarget: string | null;
}

/**
 * Traffic hotspot for road planning
 */
export interface TrafficHotspot {
  pos: { x: number; y: number };
  visits: number;
  hasRoad: boolean;
}

// ============================================================================
// WEIGHT TABLE TYPES
// ============================================================================

/**
 * The entire bot's behavior parameterized through weights.
 * AI advisor tunes these; game code reads them.
 */
export interface WeightTable {
  version: number;
  updatedAt: number;
  updatedBy: "default" | "ai_advisor" | "manual";

  // Spawning weights
  spawning: SpawningWeights;

  // Construction weights
  construction: ConstructionWeights;

  // Remote mining weights
  remotes: RemoteWeights;

  // Military weights
  military: MilitaryWeights;

  // Economy weights
  economy: EconomyWeights;
}

export interface SpawningWeights {
  // Role base priorities (0-100)
  basePriority: Record<string, number>;

  // Factor weights
  factors: {
    deficit: number; // How much deficit matters
    economy: number; // How much economy health matters
    rcl: number; // How much RCL progression matters
    threat: number; // How much threat level matters
    saturation: number; // Diminishing returns on count
  };

  // Per-role configuration
  roles: Record<string, RoleConfig>;
}

export interface RoleConfig {
  minCount: number; // Always maintain at least this many
  maxCount: number; // Never exceed this many
  minRcl: number; // Earliest RCL this role is useful (soft gate)
  rclPenalty: number; // Score multiplier when below minRcl (0.0-1.0)
  economyThreshold: number; // Economy health below which score is penalized
  replacementTTL: number; // Spawn replacement when TTL below this
}

export interface ConstructionWeights {
  // Structure type base priorities
  basePriority: Record<string, number>;

  // Factor weights
  factors: {
    rclProgress: number; // How much RCL advancement matters
    economyImpact: number; // How much economic benefit matters
    defensiveValue: number; // How much defensive benefit matters
    trafficBenefit: number; // How much path optimization matters
    completionGap: number; // Penalty for unfinished structures
  };

  // Per-structure-type configuration
  types: Record<string, StructureTypeConfig>;
}

export interface StructureTypeConfig {
  minRcl: number; // Soft minimum (penalized below, not blocked)
  rclPenalty: number; // Multiplier when below minRcl
  maxConcurrentSites: number;
  requiresStorage: boolean; // Penalty factor if no storage
  noStoragePenalty: number; // 0.0-1.0 multiplier when no storage
}

export interface RemoteWeights {
  // Factor weights
  factors: {
    sourceCount: number;
    distance: number; // Negative = penalty
    safety: number;
    pathQuality: number;
    profitability: number;
  };

  // Minimum sources required by distance
  minSources: Record<number, number>; // distance -> min sources

  // Maximum active remotes
  maxActive: number;
}

export interface MilitaryWeights {
  factors: {
    threatLevel: number;
    strategicValue: number;
    economicLoss: number;
    winProbability: number;
  };
}

export interface EconomyWeights {
  targetSurplusRatio: number; // Desired income/burn ratio
  storageTargets: Record<number, number>; // rcl -> target stored energy
  emergencyThreshold: number; // Below this, emergency mode
}

// ============================================================================
// EVALUATOR TYPES
// ============================================================================

/**
 * Base evaluator interface. Each evaluator owns one decision domain.
 */
export interface Evaluator<T> {
  readonly domain: string;

  /**
   * Evaluate options for a colony and return scored options.
   * Evaluators read WorldState - they never execute actions.
   */
  evaluate(state: WorldState, colony: ColonySnapshot): ScoredOption<T>[];
}

/**
 * A scored option produced by an evaluator
 */
export interface ScoredOption<T> {
  action: T;
  score: number; // 0-100, comparable within domain
  raw?: number; // Pre-compression score; > 100 means the option was in the saturated band
  factors: FactorBreakdown; // For telemetry/debugging
  label: string; // Human-readable description
}

/**
 * Breakdown of how a score was calculated
 */
export interface FactorBreakdown {
  [factorName: string]: {
    raw: number; // Raw input value
    weight: number; // From WeightTable
    contribution: number; // raw * weight or computed contribution
  };
}

// ============================================================================
// ACTION TYPES
// ============================================================================

/**
 * Spawn action
 */
export interface SpawnAction {
  type: "spawn";
  role: string;
  colony: string;
  body?: BodyPartConstant[];
  memory?: Partial<CreepMemory>;
}

/**
 * Build action (place construction site)
 */
export interface BuildAction {
  type: "build";
  structureType: BuildableStructureConstant;
  colony: string;
  pos?: { x: number; y: number }; // If known, otherwise placer determines
}

/**
 * Remote mining action
 */
export interface RemoteAction {
  type: "activate_remote" | "deactivate_remote" | "pause_remote";
  room: string;
  colony: string;
  distance?: number;
  via?: string;
  reason?: string;
}

/**
 * Military action
 */
export interface MilitaryAction {
  type: "attack" | "defend" | "retreat" | "patrol";
  targetRoom: string;
  homeRoom: string;
  priority: "CRITICAL" | "HIGH" | "NORMAL";
}

/**
 * Union of all action types
 */
export type FrameworkAction = SpawnAction | BuildAction | RemoteAction | MilitaryAction;

// ============================================================================
// ARBITRATOR TYPES
// ============================================================================

/**
 * Arbitrator resolves conflicts between competing options
 */
export interface Arbitrator {
  /**
   * Resolve scored options from all evaluators into executable actions.
   * Handles resource contention (spawn time, site slots, etc.)
   */
  resolve(
    options: Map<string, ScoredOption<FrameworkAction>[]>,
    state: WorldState,
    colony: ColonySnapshot
  ): FrameworkAction[];
}

// ============================================================================
// TELEMETRY TYPES
// ============================================================================

/**
 * Decision log entry for AI advisor analysis
 */
export interface DecisionLogEntry {
  tick: number;
  colony: string;
  domain: string;
  chosen: {
    action: string;
    score: number;
    factors: FactorBreakdown;
  };
  alternatives: {
    action: string;
    score: number;
  }[];
  outcome?: {
    metric: string;
    before: number;
    after: number;
    delta: number;
  };
}

/**
 * Weight patch from AI advisor
 */
export interface WeightPatch {
  path: string; // e.g., "spawning.roles.UPGRADER.minCount"
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  confidence: number; // 0-1
  appliedAt?: number;
}

/**
 * Telemetry export format
 */
export interface TelemetryExport {
  exportedAt: number;
  windowStart: number;
  windowEnd: number;
  decisions: DecisionLogEntry[];
  weightPatches: WeightPatch[];
  colonyMetrics: Record<
    string,
    {
      rcl: number;
      rclProgress: number;
      energyStored: number;
      netFlow: number;
      creepCount: number;
    }
  >;
}
