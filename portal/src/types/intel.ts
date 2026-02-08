// Intel API response types

export interface SourceInfo {
  id: string;
  pos: { x: number; y: number };
}

export interface MineralInfo {
  id: string;
  mineralType: MineralConstant;
  pos: { x: number; y: number };
  density?: number;
}

export interface ControllerInfo {
  id: string;
  pos: { x: number; y: number };
  level: number;
  owner?: string;
  reservation?: {
    username: string;
    ticksToEnd: number;
  };
  safeMode?: number;
  safeModeAvailable?: number;
}

export interface HostileInfo {
  owner: string;
  count: number;
  bodyParts?: Record<string, number>;
  lastSeen: number;
}

export interface StructureCount {
  type: string;
  count: number;
}

export interface RoomIntel {
  roomName: string;
  roomType: 'normal' | 'sourceKeeper' | 'center' | 'highway' | 'highwayIntersection';
  lastScanned: number;
  sources: SourceInfo[];
  mineral?: MineralInfo;
  controller?: ControllerInfo;
  hostiles?: HostileInfo[];
  structures?: StructureCount[];
  hasInvaderCore?: boolean;
  isOwned?: boolean;
  owner?: string;
  isReserved?: boolean;
  reservedBy?: string;
  // Calculated fields
  distanceToColony?: number;
  nearestColony?: string;
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
}

export interface CandidateResponse {
  candidates: ScoredCandidate[];
  evaluatedCount: number;
  lastEvaluated?: number;
}

// Room coordinate types
export interface RoomCoords {
  wx: number; // West-East coordinate (negative for West)
  wy: number; // North-South coordinate (negative for North)
}

export interface GridBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Filter state for the intel map
export interface IntelFilters {
  roomTypes: Set<RoomIntel['roomType']>;
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
