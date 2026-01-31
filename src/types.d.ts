// Extend Screeps memory types
// The @types/screeps package provides empty interfaces for us to extend

// Creep state machine states
type CreepState = "IDLE" | "COLLECTING" | "DELIVERING" | "BUILDING" | "UPGRADING" | "HARVESTING" | "TRAVELING";

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
interface RoomMemory {
  sources?: Id<Source>[];
  hostiles?: number;
  lastScan?: number;
  containerPlan?: ContainerPlan;
  tasks?: RoomTask[];

  // Assignment tracking
  assignments?: {
    harvesters: Record<string, string>; // sourceId -> creepName
    haulers: Record<string, string[]>; // containerId -> creepNames
  };

  // Scout intel
  controller?: {
    owner?: string;
    level?: number;
    reservation?: {
      username: string;
      ticksToEnd: number;
    };
  };
  hasKeepers?: boolean;
  hasInvaderCore?: boolean;
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
}

// Debug flags
interface DebugFlags {
  showTraffic?: boolean;
}

// Extend Memory for advisor data, traffic, and intel
interface Memory {
  advisor?: AdvisorData;
  traffic?: { [roomName: string]: TrafficMemory };
  intel?: { [roomName: string]: RoomIntel };
  homeRoom?: string;
  debug?: DebugFlags;
}

// Global console declaration for Screeps
declare const console: {
  log(...args: unknown[]): void;
};
