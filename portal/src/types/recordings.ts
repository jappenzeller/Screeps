export type AnalysisType = 'heatmap' | 'oscillations' | 'stuck' | 'roads' | 'bottlenecks';

// From GET /recordings (after extraction from { recordings: [...] })
export interface Recording {
  recordingId: string;
  room: string;
  shard: string;
  status: 'active' | 'complete' | 'paused';
  startTick: number | null;
  endTick: number | null;
  lastCapturedTick: number | null;
  durationTicks: number;
  tickInterval: number;
  ticksCaptured: number;
  continuous: boolean;
  terrainCaptured: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt?: number;
  analysisStatus?: 'complete' | 'in_progress' | 'not_started' | 'failed';
  analysisAt?: string;
}

// From GET /recordings/{id} — same shape as Recording
export type RecordingDetail = Recording;

// From GET /recordings/{id}/snapshots — API returns bare array, we transform to this
export interface SnapshotIndex {
  ticks: number[];
  count: number;
}

// From GET /recordings/{id}/snapshots/{tick}
export interface Snapshot {
  tick?: number;
  creeps?: SnapshotCreep[];
  structures?: SnapshotStructure[];
  constructionSites?: SnapshotStructure[];
  droppedResources?: SnapshotResource[];
  tombstones?: unknown[];
  ruins?: unknown[];
  sources?: SnapshotSource[];
  minerals?: SnapshotMineral[];
}

export interface SnapshotCreep {
  name: string;
  x: number;
  y: number;
  hits?: number;
  hitsMax?: number;
  owner?: string;
  body?: string[];
}

export interface SnapshotStructure {
  structureType: string;
  x: number;
  y: number;
  hits?: number;
  hitsMax?: number;
  energy?: number;
  energyCapacity?: number;
  store?: Record<string, number>;
  progress?: number;
  progressTotal?: number;
}

export interface SnapshotResource {
  resourceType: string;
  x: number;
  y: number;
  amount?: number;
}

export interface SnapshotSource {
  x: number;
  y: number;
  energy?: number;
  energyCapacity?: number;
}

export interface SnapshotMineral {
  x: number;
  y: number;
  mineralType?: string;
  mineralAmount?: number;
}

// Terrain API response
// The `encoded` field is a 2500-char string where each char encodes terrain at (x, y)
// Index = y * 50 + x, value = (charCode - 48) & 0x03
// 0 = plain, 1 = wall, 2 = swamp, 3 = wall
export interface TerrainData {
  room: string;
  encoded: string;
  capturedAt: string;
}

// From GET /recordings/{id}/analysis
export interface AnalysisSummary {
  recordingId: string;
  room: string;
  analyzedAt: string;
  tickRange: [number, number];
  snapshotsAnalyzed: number;
  uniqueCreeps: number;
  totalOscillationEvents: number;
  totalStuckEvents: number;
  roadSuggestions: number;
  bottlenecks: number;
}

// Heatmap analysis data
export interface HeatmapData {
  total: number[][];        // 50x50 grid of visit counts
  byRole?: Record<string, number[][]>;
  maxValue?: number;
}

// Oscillation analysis data
export interface OscillationData {
  events: OscillationEvent[];
  hotspots: OscillationHotspot[];
}

export interface OscillationEvent {
  creepName: string;
  role: string;
  positions: { x: number; y: number }[];
  startTick: number;
  endTick: number;
  duration: number;
}

export interface OscillationHotspot {
  x: number;
  y: number;
  totalEvents: number;
  totalDuration: number;
  affectedRoles: string[];
}

// Stuck analysis data
export interface StuckData {
  events: StuckEvent[];
  hotspots: StuckHotspot[];
}

export interface StuckEvent {
  creepName: string;
  role: string;
  position: { x: number; y: number } | [number, number];
  startTick: number;
  endTick: number;
  duration: number;
}

export interface StuckHotspot {
  x: number;
  y: number;
  totalEvents: number;
  totalDuration: number;
  affectedRoles: string[];
}

// Road suggestion data
export interface RoadData {
  suggestions: RoadSuggestion[];
  existingRoadCount: number;
  totalHighTrafficTiles: number;
  coveredByRoads: number;
  coveragePercent: string;
}

export interface RoadSuggestion {
  x: number;
  y: number;
  visits: number;
  terrain: 'plain' | 'swamp';
  score: number;
  nearbyRoads: number;
  reason: string;
}

// Bottleneck data
export interface BottleneckData {
  tiles: BottleneckTile[];
}

export interface BottleneckTile {
  x: number;
  y: number;
  concurrentTicks: number;
  percentOfRecording: string;
  nearbyStructures: string[];
}
