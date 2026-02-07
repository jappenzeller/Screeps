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

  // Hauler container targeting (dynamic per-trip selection)
  targetContainer?: Id<StructureContainer> | null;

  // Remote hauler renewal tracking
  _lastRenewTick?: number;
  _renewTicks?: number;
  _renewWaitStart?: number; // Tick when started waiting at spawn for renewal

  // Harvester/defender renewal state
  renewing?: boolean;

  // Defender retreat state (damaged, needs tower healing)
  retreating?: boolean;

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
}

// Visual settings
interface SettingsFlags {
  showVisuals?: boolean;
  logPositions?: boolean;
  lastExportTick?: number; // Last successful AWS export tick for delta tracking
}

// Export metadata for AWS Lambda visibility
interface ExportMeta {
  lastExportTick: number;
  deltaIntelCount: number;
  totalIntelCount: number;
}

// Bootstrap builder creep memory
interface BootstrapBuilderMemory extends CreepMemory {
  role: "BOOTSTRAP_BUILDER";
  parentRoom: string;
  targetRoom: string;
  // New states: TRAVELING, COLLECTING, BUILDING
  // Old states kept for backward compat: TRAVELING_TO_TARGET, RETURNING_FOR_ENERGY
  bootstrapState:
    | "TRAVELING"
    | "COLLECTING"
    | "BUILDING"
    | "TRAVELING_TO_TARGET"
    | "RETURNING_FOR_ENERGY";
  // If true, this builder harvests directly from source instead of waiting for haulers
  selfHarvest?: boolean;
}

// Bootstrap hauler creep memory
interface BootstrapHaulerMemory extends CreepMemory {
  role: "BOOTSTRAP_HAULER";
  parentRoom: string;
  targetRoom: string;
  bootstrapState: "LOADING" | "TRAVELING_TO_TARGET" | "DELIVERING" | "RETURNING";
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

// Extend Memory for advisor data, traffic, intel, and colonies
interface Memory {
  advisor?: AdvisorData;
  traffic?: { [roomName: string]: TrafficMemory };
  intel?: { [roomName: string]: RoomIntel };
  colonies?: { [roomName: string]: ColonyMemory };
  debug?: DebugFlags;
  settings?: SettingsFlags;
}

// Global console declaration for Screeps
declare const console: {
  log(...args: unknown[]): void;
};
