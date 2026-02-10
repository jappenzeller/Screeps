// Intel API response types
// Matches in-game Memory.intel[roomName] as passed through by Lambda

export interface SourceInfo {
  id: string;
  pos: { x: number; y: number };
}

export interface MineralInfo {
  type: MineralConstant;  // NOTE: field is "type", not "mineralType"
  amount: number;
  id: string;
  pos: { x: number; y: number };
}

export interface HostileDetail {
  id: string;
  owner: string;
  pos: { x: number; y: number };
  bodyParts: number;
  hasCombat: boolean;
}

export interface RoomIntel {
  roomName: string;
  lastScanned: number;

  // Room type — NOTE: no 'highwayIntersection' in game data
  roomType: 'normal' | 'sourceKeeper' | 'center' | 'highway';

  // Ownership — flat fields, no isOwned/isReserved booleans
  owner: string | null;
  ownerRcl: number | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;

  // Resources
  sources: SourceInfo[];
  mineral: MineralInfo | null;

  // Terrain
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
  hostiles: number;           // Count of hostile creeps (number, NOT array)
  lastHostileSeen: number;
  hostileDetails?: HostileDetail[];

  // Distance
  distanceFromHome: number;

  // Scores
  expansionScore?: number;
  remoteMiningScore?: number;
}

export interface IntelResponse {
  rooms: Record<string, RoomIntel>;
  scannedCount: number;
  lastFullScan?: number;
}

export interface EnemyZone {
  owner: string;
  rooms: string[];
  totalCreeps: number;
  threatLevel: 'low' | 'medium' | 'high';
  lastActivity: number;
}

export interface EnemyResponse {
  enemies: EnemyZone[];
  totalHostileRooms: number;
}

export interface ScoredCandidate {
  roomName: string;
  score: number;
  sourceCount: number;
  mineralType?: MineralConstant;
  distanceToNearestColony: number;
  nearestColony: string;
  threats: number;
  swampRatio?: number;
  controllerPos?: { x: number; y: number };
  rank?: number;
}

export interface CandidateResponse {
  candidates: ScoredCandidate[];
  evaluatedCount: number;
  lastEvaluated?: number;
}

// Room coordinate types
export interface RoomCoords {
  wx: number;
  wy: number;
}

export interface GridBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Filter state for the intel map
// NOTE: removed 'highwayIntersection' — doesn't exist in game data
export interface IntelFilters {
  roomTypes: Set<'normal' | 'sourceKeeper' | 'center' | 'highway'>;
  minSources: number;
  maxSources: number;
  mineralFilter: MineralConstant | 'any' | null;
  showOwnedOnly: boolean;
  showHostileOnly: boolean;
  showCandidates: boolean;
  showEnemyZones: boolean;
}

// Mineral type constant (matches Screeps)
export type MineralConstant = 'H' | 'O' | 'U' | 'L' | 'K' | 'Z' | 'X';
