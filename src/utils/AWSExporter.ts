/**
 * AWSExporter: Writes colony data to a memory segment for AWS Lambda to read.
 * Uses segment 90 (reserved for external monitoring)
 */

import { ColonyManager } from "../core/ColonyManager";
import { StatsCollector, TrafficExport } from "./StatsCollector";
import { EconomyTracker, ColonyEconomyMetrics } from "../core/EconomyTracker";
import { RoomEvaluator, RoomScore } from "../empire/RoomEvaluator";
import { ExpansionReadiness, ReadinessCheck, ParentCandidate } from "../empire/ExpansionReadiness";
import { getCreepsByRoom, getHostileCreeps, shouldSkipExport } from "./cpuCache";

// Segment allocation for AWS export
const SEGMENT_COLONIES = 90;    // Colony snapshots (≤50KB target)
const SEGMENT_INTEL = 91;       // Intel delta (≤50KB target)
const SEGMENT_POSITIONS = 92;   // Existing - creep positions
const SEGMENT_DIAGNOSTICS = 93; // Detailed diagnostics (on-demand, 100KB)

// Module-level cache for delta tracking (survives within tick, resets on global reset)
let lastExportTick: number = 0;

// Expansion overview cache (expensive - only refresh every 100 ticks)
let cachedExpansionOverview: ExpansionOverviewExport | null = null;
let expansionOverviewTick = 0;
const EXPANSION_OVERVIEW_CACHE_TICKS = 100;

interface ExpansionCandidateExport {
  roomName: string;
  totalScore: number;
  viable: boolean;
  blockers: string[];
  economic: number;
  strategic: number;
  defensive: number;
  details: {
    sources: number;
    mineral: string | null;
    mineralValue: number;
    swampPercent: number;
    wallPercent: number;
    distanceFromParent: number;
    distanceFromEnemies: number;
    remotePotential: number;
  };
}

interface ParentReadinessExport {
  roomName: string;
  ready: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
  distanceToTarget: number;
}

interface ExpansionOverviewExport {
  canExpand: boolean;
  bestParent: string | null;
  empireBlockers: string[];
  autoExpand: boolean;
  active: EmpireExpansionExport[];
  activeCount: number;
  queue: Array<{ target: string; parent: string }>;
  queueCount: number;
  candidates: ExpansionCandidateExport[];
  candidateCount: number;
  parentReadiness: ParentReadinessExport[];
  history: Record<string, unknown>;
}

interface EmpireExport {
  state: string;
  stateChangedAt: number | undefined;
  priorities: Record<string, number>;
  expansion: {
    active: EmpireExpansionExport[];
    activeCount: number;
    queue: Array<{ target: string; parent: string }>;
    queueCount: number;
    history: Record<string, unknown>;
  };
  expansionOverview: ExpansionOverviewExport;
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
    percent: string;
  };
  colonies: string[];
  colonyCount: number;
}

interface EmpireExpansionExport {
  roomName: string;
  parentRoom: string;
  state: string;
  stateChangedAt: number;
  ticksInState: number;
  startedAt: number;
  totalTicks: number;
  attempts: number;
  claimer: string | null;
  spawnSitePos: { x: number; y: number } | null;
  spawnProgress: {
    progress: number;
    total: number;
    percent: string;
  } | null;
  creeps: {
    pioneers: number;
    total: number;
    names: string[];
  };
  blockers: string[];
  lastFailure: string | null;
}

// Military campaign export
interface MilitaryCampaignExport {
  id: string;
  type: string;
  targetRoom: string;
  targetOwner: string;
  state: string;
  ticksInState: number;
  createdAt: number;
  age: number;
  attack: {
    attackCount: number;
    currentRCL: number;
    currentTimer: number;
    estimatedCycles: number;
    estimatedHours: string;
    defendersSeen: boolean;
    towerDrainNeeded: boolean;
    safeModeActive: boolean;
    stats: {
      totalSpawned: number;
      totalLost: number;
      totalEnergySpent: number;
      rclDowngrades: number;
      safeModeActivations: number;
    };
  };
  creeps: number;
}

interface MilitaryExport {
  posture: string;
  activeCampaigns: number;
  totalCampaigns: number;
  campaigns: MilitaryCampaignExport[];
}

// Legacy combined export (for backward compatibility during transition)
interface AWSExportData {
  timestamp: number;
  gameTick: number;
  shard: string;
  username: string;
  homeRoom: string;
  colonies: ColonyExport[];
  global: GlobalExport;
  diagnostics: Record<string, DiagnosticsExport>;
  intel: Record<string, RoomIntel>;
  empire: EmpireExport | null;
  exportMeta?: ExportMeta;
}

// Segment 90: Colony data (primary monitoring payload)
interface ColonyPayload {
  timestamp: number;
  gameTick: number;
  shard: string;
  username: string;
  homeRoom: string;
  colonies: ColonyExport[];
  global: GlobalExport;
  empire: EmpireExport | null;
  military: MilitaryExport | null;
  exportMeta: ExportMeta;
}

// Segment 91: Intel delta (room scanning data)
interface IntelPayload {
  timestamp: number;
  gameTick: number;
  intel: Record<string, RoomIntel>;
  totalCount: number;
  deltaCount: number;
}

// Segment 93: Detailed diagnostics (on-demand, every 100 ticks)
interface DiagnosticsPayload {
  timestamp: number;
  gameTick: number;
  diagnostics: Record<string, DiagnosticsExport>;
}

interface CreepDetail {
  name: string;
  role: string;
  state: string | undefined;
  pos: { x: number; y: number; room: string };
  ttl: number | undefined;
  energy: number;
  energyCapacity: number;
  fatigue: number;
  workParts: number;
  carryParts: number;
  moveParts: number;
  memory: Record<string, unknown>;
}

interface LinkDetail {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
  cooldown: number;
  type: "source" | "controller" | "storage" | "unknown";
}

interface ContainerDetail {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  hits: number;
  hitsMax: number;
  nearSource: boolean;
  nearController: boolean;
}

interface StructureDetails {
  links: LinkDetail[] | null;
  containers: ContainerDetail[] | null;
  spawns: { name: string; spawning: string | null; energy: number }[] | null;
}

interface ColonyExport {
  roomName: string;
  rcl: number;
  rclProgress: number;
  rclProgressTotal: number;
  energy: {
    available: number;
    capacity: number;
    stored: number;
  };
  creeps: {
    total: number;
    byRole: Record<string, number>;
    details: CreepDetail[] | null;
  };
  threats: {
    hostileCount: number;
    hostileDPS: number;
  };
  structures: {
    constructionSites: number;
    damagedCount: number;
  };
  structureDetails: StructureDetails;
  // New fields
  defense: DefenseExport;
  adjacentRooms: AdjacentRoomExport[] | null;
  remoteMining: RemoteMiningExport | null;
  scouting: ScoutingExport | null;
  traffic: TrafficExport | null;
  remoteDefense: RemoteDefenseStatus | null;
  mineral: MineralExport;
  economy: ColonyEconomyMetrics;
  remoteRooms: string[];
}

interface DefenseExport {
  towerCount: number;
  towerEnergyTotal: number;
  towerEnergyCapacity: number;
  safeModeAvailable: number;
  safeModeCooldown: number;
  safeModeActive: number;
}

interface AdjacentRoomExport {
  roomName: string;
  direction: string;
  sources: number;
  owner: string | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;
  hostiles: number;
  hasKeepers: boolean;
  hasInvaderCore: boolean;
  lastScan: number;
  lastScanAge: number;
  isValidRemoteTarget: boolean;
}

interface RemoteMiningExport {
  targetRooms: RemoteRoomExport[] | null;
  totalMiners: number;
  totalHaulers: number;
  totalReservers: number;
}

interface RemoteRoomExport {
  roomName: string;
  status: "ACTIVE" | "NO_MINERS" | "HOSTILE" | "NO_INTEL" | "RESERVED_OTHER" | "OWNED";
  sources: number;
  miners: RemoteCreepExport[];
  haulers: RemoteCreepExport[];
  reserver: RemoteCreepExport | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;
}

interface RemoteCreepExport {
  name: string;
  sourceId?: string;
  ttl: number;
  room: string;
}

interface ScoutingExport {
  scouts: ScoutCreepExport[];
  roomsNeedingScan: string[];
  totalRemaining: number;
  totalScanned: number;
  scannedRooms: Record<string, ScannedRoomSummary>;
}

interface ScoutCreepExport {
  name: string;
  room: string;
  targetRoom: string | null;
  state: string;
  ttl: number;
  pos: { x: number; y: number };
}

interface ScannedRoomSummary {
  sources: number;
  mineral: MineralConstant | null;
  controller: boolean;
  owner: string | null;
  reserved: string | null;
  roomType: string;
  hasKeepers: boolean;
  hasInvaderCore: boolean;
  swampPercent: number;
  wallPercent: number;
  scannedAt: number;
  distance: number;
}

// Remote Defense Diagnostic Interfaces
interface RemoteDefenseStatus {
  roomVisibility: RoomVisibility[];
  remoteCreepStates: RemoteCreepState[];
  spawnTriggers: RemoteDefenseTrigger[];
}

interface RoomVisibility {
  roomName: string;
  hasVision: boolean;
  creepsWithVision: number;
  hostiles: {
    count: number;
    details: Array<{
      owner: string;
      pos: { x: number; y: number };
      bodyParts: number;
      dangerous: boolean;
    }>;
  };
  memoryHostiles: number;
  memoryLastScan: number;
  memoryAge: number;
}

interface RemoteCreepState {
  name: string;
  role: string;
  room: string;
  targetRoom: string;
  state: string;
  ttl: number;
  pos: { x: number; y: number };
  isFleeing: boolean;
  fleeReason: string | null;
}

interface RemoteDefenseTrigger {
  roomName: string;
  shouldSpawnDefender: boolean;
  reasons: string[];
  blockers: string[];
  hostileCount: number;
  hasInvaderCore: boolean;
  existingDefenders: number;
  maxDefenders: number;
}

interface MineralExport {
  type: MineralConstant | null;
  amount: number;
  extractor: boolean;
  harvester: string | null;
}

interface GlobalExport {
  cpu: {
    used: number;
    bucket: number;
    limit: number;
  };
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  credits: number;
  totalCreeps: number;
}

// ==================== Diagnostics Interfaces ====================

interface DiagnosticsExport {
  roomName: string;
  gameTick: number;
  creeps: CreepDiagnostic[];
  structures: {
    links: LinkDiagnostic[];
    containers: ContainerDiagnostic[];
    spawns: SpawnDiagnostic[];
    towers: TowerDiagnostic[];
  };
  controller: {
    level: number;
    progress: number;
    progressTotal: number;
    ticksToDowngrade: number;
    upgradeBlocked: number;
  } | null;
  sources: SourceDiagnostic[];
}

interface CreepDiagnostic {
  name: string;
  role: string;
  room: string;
  pos: { x: number; y: number };
  state: string;
  targetId: string | null;
  taskId: string | null;
  ttl: number;
  energy: number;
  energyCapacity: number;
  fatigue: number;
  body: string;
}

interface LinkDiagnostic {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
  cooldown: number;
}

interface ContainerDiagnostic {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
  hits: number;
  hitsMax: number;
}

interface SpawnDiagnostic {
  id: string;
  name: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
  spawning: {
    name: string;
    remainingTime: number;
  } | null;
}

interface TowerDiagnostic {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
}

interface SourceDiagnostic {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
  ticksToRegeneration: number;
}

interface ExportMeta {
  lastExportTick: number;
  deltaIntelCount: number;
  totalIntelCount: number;
  shedLevel?: number;
  originalSize?: number;
  finalSize?: number;
  complete: boolean;  // true if shedLevel === 0 (no data was shed)
}

// Size thresholds for segment 90 (100KB limit)
const SIZE_LIMIT = 100000;   // Hard limit - must not exceed
const SIZE_TARGET = 90000;   // Aim to stay below this
const SIZE_WARNING = 80000;  // Start shedding above this

/**
 * Shedding Tier 1: Remove diagnostics (least critical, on-demand available)
 */
function shedDiagnostics(payload: AWSExportData): void {
  payload.diagnostics = {};
}

/**
 * Shedding Tier 2: Remove stale intel (older than threshold)
 */
function shedStaleIntel(payload: AWSExportData, maxAge: number): number {
  let removed = 0;
  const now = Game.time;
  for (const roomName in payload.intel) {
    const intel = payload.intel[roomName];
    if (!intel.lastScanned || now - intel.lastScanned > maxAge) {
      delete payload.intel[roomName];
      removed++;
    }
  }
  return removed;
}

/**
 * Shedding Tier 3: Trim creep data to counts only (remove details array)
 * Uses null to indicate "data was shed" vs [] which means "no creeps"
 */
function trimCreepData(payload: AWSExportData): void {
  for (var i = 0; i < payload.colonies.length; i++) {
    payload.colonies[i].creeps.details = null;
  }
}

/**
 * Shedding Tier 3.5: Trim colony structure details
 * Uses null to indicate "data was shed" vs [] which means "no structures"
 */
function trimStructureDetails(payload: AWSExportData): void {
  for (var i = 0; i < payload.colonies.length; i++) {
    payload.colonies[i].structureDetails = {
      links: null,
      containers: null,
      spawns: null,
    };
  }
}

/**
 * Shedding Tier 4.5: Trim remote mining and scouting details
 * Uses null to indicate "data was shed" vs [] which means "verified empty"
 */
function trimRemoteData(payload: AWSExportData): void {
  for (var i = 0; i < payload.colonies.length; i++) {
    var colony = payload.colonies[i];

    // Simplify remote mining - keep counts only, null for details
    if (colony.remoteMining && colony.remoteMining.targetRooms) {
      colony.remoteMining = {
        targetRooms: null,  // Shed detailed room data
        totalMiners: colony.remoteMining.totalMiners,
        totalHaulers: colony.remoteMining.totalHaulers,
        totalReservers: colony.remoteMining.totalReservers,
      };
    }

    // Shed scouting data
    colony.scouting = null;

    // Shed remote defense details
    colony.remoteDefense = null;

    // Shed traffic data
    colony.traffic = null;

    // Shed adjacent rooms detail
    colony.adjacentRooms = null;
  }
}

/**
 * Shedding Tier 5.5: Minimal colony data - just essentials
 * Uses null everywhere to indicate "data was shed"
 */
function trimToMinimalColonies(payload: AWSExportData): void {
  for (var i = 0; i < payload.colonies.length; i++) {
    var colony = payload.colonies[i];

    // Keep only the absolute essentials - use null to indicate shed
    colony.structureDetails = { links: null, containers: null, spawns: null };
    colony.adjacentRooms = null;
    colony.remoteMining = {
      targetRooms: null,
      totalMiners: colony.remoteMining ? colony.remoteMining.totalMiners : 0,
      totalHaulers: colony.remoteMining ? colony.remoteMining.totalHaulers : 0,
      totalReservers: colony.remoteMining ? colony.remoteMining.totalReservers : 0,
    };
    colony.scouting = null;
    colony.remoteDefense = null;
    colony.traffic = null;
    colony.creeps.details = null;
  }
}

/**
 * Shedding Tier 4: Keep only operationally critical intel
 * (owned rooms, active remotes, active expansions, adjacent rooms)
 */
function shedDistantIntel(payload: AWSExportData): number {
  var essentialRooms = new Set<string>();

  // Owned rooms - always keep
  for (var i = 0; i < payload.colonies.length; i++) {
    var colony = payload.colonies[i];
    essentialRooms.add(colony.roomName);

    // Adjacent rooms - need for threat awareness (if not already shed)
    if (colony.adjacentRooms) {
      for (var j = 0; j < colony.adjacentRooms.length; j++) {
        essentialRooms.add(colony.adjacentRooms[j].roomName);
      }
    }

    // Active remote targets - always keep
    var remotes = colony.remoteRooms || [];
    for (var k = 0; k < remotes.length; k++) {
      essentialRooms.add(remotes[k]);
    }
  }

  // Active expansion targets - always keep
  var empire = payload.empire;
  if (empire && empire.expansion && empire.expansion.active) {
    for (var m = 0; m < empire.expansion.active.length; m++) {
      essentialRooms.add(empire.expansion.active[m].roomName);
    }
  }

  // Queued expansions
  if (empire && empire.expansion && empire.expansion.queue) {
    for (var n = 0; n < empire.expansion.queue.length; n++) {
      essentialRooms.add(empire.expansion.queue[n].target);
    }
  }

  var removed = 0;
  for (var roomName in payload.intel) {
    if (!essentialRooms.has(roomName)) {
      delete payload.intel[roomName];
      removed++;
    }
  }
  return removed;
}

/**
 * Build payload with tiered shedding to stay under size limit
 */
function buildAndShedPayload(payload: AWSExportData): { json: string; shedLevel: number; originalSize: number } {
  let json = JSON.stringify(payload);
  const originalSize = json.length;
  let shedLevel = 0;

  // Tier 1: Shed diagnostics if over warning threshold
  if (json.length > SIZE_WARNING) {
    shedDiagnostics(payload);
    json = JSON.stringify(payload);
    shedLevel = 1;
    if (Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 1: Shed diagnostics. Size: " + json.length);
    }
  }

  // Tier 2: Shed stale intel (>5000 ticks old)
  if (json.length > SIZE_TARGET) {
    const removed = shedStaleIntel(payload, 5000);
    json = JSON.stringify(payload);
    shedLevel = 2;
    if (removed > 0 && Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 2: Shed " + removed + " stale intel entries. Size: " + json.length);
    }
  }

  // Tier 3: Trim creep details to just counts
  if (json.length > SIZE_TARGET) {
    trimCreepData(payload);
    json = JSON.stringify(payload);
    shedLevel = 3;
    if (Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 3: Trimmed creep details. Size: " + json.length);
    }
  }

  // Tier 3.5: Trim structure details
  if (json.length > SIZE_TARGET) {
    trimStructureDetails(payload);
    json = JSON.stringify(payload);
    shedLevel = 3.5;
    if (Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 3.5: Trimmed structure details. Size: " + json.length);
    }
  }

  // Tier 4: Shed older intel (>1000 ticks old)
  if (json.length > SIZE_TARGET) {
    const removed = shedStaleIntel(payload, 1000);
    json = JSON.stringify(payload);
    shedLevel = 4;
    if (removed > 0 && Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 4: Shed " + removed + " older intel entries. Size: " + json.length);
    }
  }

  // Tier 4.5: Trim remote/scouting/traffic data
  if (json.length > SIZE_TARGET) {
    trimRemoteData(payload);
    json = JSON.stringify(payload);
    shedLevel = 4.5;
    if (Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 4.5: Trimmed remote/scouting data. Size: " + json.length);
    }
  }

  // Tier 5: Keep only essential intel (owned + adjacent + remotes + expansions)
  if (json.length > SIZE_TARGET) {
    const removed = shedDistantIntel(payload);
    json = JSON.stringify(payload);
    shedLevel = 5;
    if (removed > 0 && Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 5: Shed " + removed + " distant intel entries. Size: " + json.length);
    }
  }

  // Tier 5.5: Minimal colony data
  if (json.length > SIZE_TARGET) {
    trimToMinimalColonies(payload);
    json = JSON.stringify(payload);
    shedLevel = 5.5;
    if (Game.time % 100 === 0) {
      console.log("[AWSExporter] Tier 5.5: Trimmed to minimal colonies. Size: " + json.length);
    }
  }

  // Tier 6: Drop all intel as last resort
  if (json.length > SIZE_LIMIT) {
    payload.intel = {};
    json = JSON.stringify(payload);
    shedLevel = 6;
    console.log("[AWSExporter] Tier 6: CRITICAL - Dropped all intel. Size: " + json.length);
  }

  // Tier 7: Drop empire data too
  if (json.length > SIZE_LIMIT) {
    payload.empire = null;
    json = JSON.stringify(payload);
    shedLevel = 7;
    console.log("[AWSExporter] Tier 7: CRITICAL - Dropped empire data. Size: " + json.length);
  }

  // Final check - if still over limit, we have a serious problem
  if (json.length > SIZE_LIMIT) {
    console.log("[AWSExporter] CRITICAL: Payload still " + json.length + " bytes after all shedding!");
  }

  return { json, shedLevel, originalSize };
}

/**
 * Build colony payload with tiered shedding (simplified for segment 90 only)
 * Since intel and diagnostics are now in separate segments, shedding is simpler.
 */
function buildAndShedColonyPayload(payload: ColonyPayload): { json: string; shedLevel: number; originalSize: number } {
  var json = JSON.stringify(payload);
  var originalSize = json.length;
  var shedLevel = 0;

  // Segment 90 target: 50KB (half of old combined limit since data is split)
  var COLONY_SIZE_TARGET = 50000;
  var COLONY_SIZE_LIMIT = 60000;

  // Tier 1: Trim creep details
  if (json.length > COLONY_SIZE_TARGET) {
    for (var i = 0; i < payload.colonies.length; i++) {
      payload.colonies[i].creeps.details = null;
    }
    json = JSON.stringify(payload);
    shedLevel = 1;
  }

  // Tier 2: Trim structure details
  if (json.length > COLONY_SIZE_TARGET) {
    for (var j = 0; j < payload.colonies.length; j++) {
      payload.colonies[j].structureDetails = {
        links: null,
        containers: null,
        spawns: null,
      };
    }
    json = JSON.stringify(payload);
    shedLevel = 2;
  }

  // Tier 3: Trim remote/scouting/traffic data
  if (json.length > COLONY_SIZE_TARGET) {
    for (var k = 0; k < payload.colonies.length; k++) {
      var colony = payload.colonies[k];
      if (colony.remoteMining && colony.remoteMining.targetRooms) {
        colony.remoteMining = {
          targetRooms: null,
          totalMiners: colony.remoteMining.totalMiners,
          totalHaulers: colony.remoteMining.totalHaulers,
          totalReservers: colony.remoteMining.totalReservers,
        };
      }
      colony.scouting = null;
      colony.remoteDefense = null;
      colony.traffic = null;
      colony.adjacentRooms = null;
    }
    json = JSON.stringify(payload);
    shedLevel = 3;
  }

  // Tier 4: Minimal colony data
  if (json.length > COLONY_SIZE_TARGET) {
    for (var m = 0; m < payload.colonies.length; m++) {
      var col = payload.colonies[m];
      col.structureDetails = { links: null, containers: null, spawns: null };
      col.adjacentRooms = null;
      col.remoteMining = {
        targetRooms: null,
        totalMiners: col.remoteMining ? col.remoteMining.totalMiners : 0,
        totalHaulers: col.remoteMining ? col.remoteMining.totalHaulers : 0,
        totalReservers: col.remoteMining ? col.remoteMining.totalReservers : 0,
      };
      col.scouting = null;
      col.remoteDefense = null;
      col.traffic = null;
      col.creeps.details = null;
    }
    json = JSON.stringify(payload);
    shedLevel = 4;
  }

  // Tier 5: Drop empire data as last resort
  if (json.length > COLONY_SIZE_LIMIT) {
    payload.empire = null;
    json = JSON.stringify(payload);
    shedLevel = 5;
    console.log("[AWSExporter] CRITICAL: Dropped empire data. Size: " + json.length);
  }

  if (json.length > COLONY_SIZE_LIMIT) {
    console.log("[AWSExporter] CRITICAL: Colony payload still " + json.length + " bytes after shedding!");
  }

  return { json: json, shedLevel: shedLevel, originalSize: originalSize };
}

export class AWSExporter {
  /**
   * Export colony data to memory segments for AWS Lambda
   * Splits data across multiple segments:
   * - Segment 90: Colony snapshots (primary)
   * - Segment 91: Intel delta
   * - Segment 93: Diagnostics (every 100 ticks)
   *
   * Call this every 20 ticks or so
   */
  static export(): void {
    // Skip export when CPU bucket is low
    if (shouldSkipExport()) {
      return;
    }

    // Request multiple segments for next tick
    RawMemory.setActiveSegments([SEGMENT_COLONIES, SEGMENT_INTEL, SEGMENT_DIAGNOSTICS]);

    // Read persisted lastExportTick from Memory.settings
    if (!Memory.settings) Memory.settings = {} as SettingsFlags;
    if (Memory.settings.lastExportTick) {
      lastExportTick = Memory.settings.lastExportTick;
    }

    // Get username from first spawn
    var username = "unknown";
    var spawns = Object.values(Game.spawns);
    if (spawns.length > 0 && spawns[0].owner) {
      username = spawns[0].owner.username;
    }

    // Get home room (first owned room)
    var homeRoom = "E46N37";
    for (var roomName in Game.rooms) {
      var room = Game.rooms[roomName];
      if (room.controller && room.controller.my) {
        homeRoom = roomName;
        break;
      }
    }

    // Delta-based: only export intel scanned since last export
    var deltaIntel: Record<string, RoomIntel> = {};
    var deltaCount = 0;
    var allIntel = Memory.intel || {};
    for (var intelRoom in allIntel) {
      var intel = allIntel[intelRoom];
      if (!intel || !intel.lastScanned) continue;
      if (intel.lastScanned > lastExportTick) {
        deltaIntel[intelRoom] = intel;
        deltaCount++;
      }
    }
    var totalIntelCount = Object.keys(allIntel).length;

    var colonies = this.getColonies();
    var timestamp = Date.now();
    var gameTick = Game.time;
    var shard = Game.shard ? Game.shard.name : "unknown";

    // === SEGMENT 90: Colony Data ===
    var colonyPayload: ColonyPayload = {
      timestamp: timestamp,
      gameTick: gameTick,
      shard: shard,
      username: username,
      homeRoom: homeRoom,
      colonies: colonies,
      global: this.getGlobalStats(),
      empire: this.getEmpireStatus(),
      military: this.getMilitaryStatus(),
      exportMeta: {
        lastExportTick: lastExportTick,
        deltaIntelCount: deltaCount,
        totalIntelCount: totalIntelCount,
        complete: true,
      },
    };

    // Apply tiered shedding to colony payload only
    var shedResult = buildAndShedColonyPayload(colonyPayload);
    colonyPayload.exportMeta.shedLevel = shedResult.shedLevel;
    colonyPayload.exportMeta.originalSize = shedResult.originalSize;
    colonyPayload.exportMeta.finalSize = shedResult.json.length;
    colonyPayload.exportMeta.complete = shedResult.shedLevel === 0;

    RawMemory.segments[SEGMENT_COLONIES] = shedResult.json;

    // === SEGMENT 91: Intel Delta ===
    var intelPayload: IntelPayload = {
      timestamp: timestamp,
      gameTick: gameTick,
      intel: deltaIntel,
      totalCount: totalIntelCount,
      deltaCount: deltaCount,
    };
    var intelJson = JSON.stringify(intelPayload);
    RawMemory.segments[SEGMENT_INTEL] = intelJson;

    // === SEGMENT 93: Diagnostics (every 100 ticks to save CPU) ===
    if (Game.time % 100 === 0) {
      var diagnostics: Record<string, DiagnosticsExport> = {};
      for (var diagRoom in Game.rooms) {
        var diagRoomObj = Game.rooms[diagRoom];
        if (diagRoomObj.controller && diagRoomObj.controller.my) {
          var diag = this.getDiagnostics(diagRoom);
          if (diag) diagnostics[diagRoom] = diag;
        }
      }

      var diagnosticsPayload: DiagnosticsPayload = {
        timestamp: timestamp,
        gameTick: gameTick,
        diagnostics: diagnostics,
      };
      var diagJson = JSON.stringify(diagnosticsPayload);
      RawMemory.segments[SEGMENT_DIAGNOSTICS] = diagJson;
    }

    // Log sizes periodically
    if (Game.time % 100 === 0) {
      var shedInfo = shedResult.shedLevel > 0
        ? " (shed " + shedResult.shedLevel + ", was " + Math.round(shedResult.originalSize / 1000) + "KB)"
        : "";
      console.log("[AWSExporter] Seg90: " + Math.round(shedResult.json.length / 1000) + "KB" + shedInfo +
        ", Seg91: " + Math.round(intelJson.length / 1000) + "KB (" + deltaCount + " delta)");
    }

    // Persist lastExportTick after successful write
    Memory.settings.lastExportTick = Game.time;
    lastExportTick = Game.time;
  }

  private static getColonies(): ColonyExport[] {
    const colonies: ColonyExport[] = [];

    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller?.my) continue;

      // Get creeps for this room (using cached lookup)
      const creeps = getCreepsByRoom(roomName);
      const byRole: Record<string, number> = {};
      const creepDetails: CreepDetail[] = [];

      for (const creep of creeps) {
        const role = creep.memory.role || "UNKNOWN";
        byRole[role] = (byRole[role] || 0) + 1;

        // Export curated memory subset - drop _move, _lastPos, _stuckCount noise
        const curatedMemory: Record<string, unknown> = {
          state: creep.memory.state,
          targetContainer: creep.memory.targetContainer,
          targetRoom: creep.memory.targetRoom,
          sourceId: creep.memory.sourceId,
          taskId: creep.memory.taskId,
          role: creep.memory.role,
          room: creep.memory.room,
        };

        creepDetails.push({
          name: creep.name,
          role: role,
          state: creep.memory.state,
          pos: { x: creep.pos.x, y: creep.pos.y, room: creep.pos.roomName },
          ttl: creep.ticksToLive,
          energy: creep.store[RESOURCE_ENERGY] || 0,
          energyCapacity: creep.store.getCapacity(RESOURCE_ENERGY) || 0,
          fatigue: creep.fatigue,
          workParts: creep.getActiveBodyparts(WORK),
          carryParts: creep.getActiveBodyparts(CARRY),
          moveParts: creep.getActiveBodyparts(MOVE),
          memory: curatedMemory,
        });
      }

      // Get hostiles (using cached lookup)
      const hostiles = getHostileCreeps(roomName);
      const hostileDPS = hostiles.reduce((sum, h) => {
        const attack = h.body.filter((p) => p.type === ATTACK && p.hits > 0).length * 30;
        const ranged = h.body.filter((p) => p.type === RANGED_ATTACK && p.hits > 0).length * 10;
        return sum + attack + ranged;
      }, 0);

      // Get damaged structures
      const structures = room.find(FIND_STRUCTURES);
      const damagedCount = structures.filter((s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return s.hits < 10000;
        }
        return s.hits < s.hitsMax * 0.75;
      }).length;

      // Get storage energy
      const storageEnergy = room.storage?.store[RESOURCE_ENERGY] || 0;
      const containers = room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER },
      }) as StructureContainer[];
      const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);

      // Build structure details
      const links = room.find(FIND_MY_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_LINK,
      }) as StructureLink[];
      const spawns = room.find(FIND_MY_SPAWNS);
      const sources = room.find(FIND_SOURCES);
      const controller = room.controller;
      const storage = room.storage;

      const structureDetails: StructureDetails = {
        links: links.map((l) => ({
          id: l.id,
          pos: { x: l.pos.x, y: l.pos.y },
          energy: l.store[RESOURCE_ENERGY] || 0,
          energyCapacity: l.store.getCapacity(RESOURCE_ENERGY) || 800,
          cooldown: l.cooldown,
          type: sources.some((s) => l.pos.inRangeTo(s, 2))
            ? "source"
            : controller && l.pos.inRangeTo(controller, 4)
              ? "controller"
              : storage && l.pos.inRangeTo(storage, 2)
                ? "storage"
                : "unknown",
        })),
        containers: containers.map((c) => ({
          id: c.id,
          pos: { x: c.pos.x, y: c.pos.y },
          energy: c.store[RESOURCE_ENERGY] || 0,
          hits: c.hits,
          hitsMax: c.hitsMax,
          nearSource: sources.some((s) => c.pos.inRangeTo(s, 2)),
          nearController: controller ? c.pos.inRangeTo(controller, 4) : false,
        })),
        spawns: spawns.map((s) => ({
          name: s.name,
          spawning: s.spawning?.name || null,
          energy: s.store[RESOURCE_ENERGY] || 0,
        })),
      };

      colonies.push({
        roomName,
        rcl: room.controller.level,
        rclProgress: room.controller.progress,
        rclProgressTotal: room.controller.progressTotal,
        energy: {
          available: room.energyAvailable,
          capacity: room.energyCapacityAvailable,
          stored: storageEnergy + containerEnergy,
        },
        creeps: {
          total: creeps.length,
          byRole,
          details: creepDetails,
        },
        threats: {
          hostileCount: hostiles.length,
          hostileDPS,
        },
        structures: {
          constructionSites: room.find(FIND_CONSTRUCTION_SITES).length,
          damagedCount,
        },
        structureDetails,
        defense: this.getDefenseStatus(room),
        adjacentRooms: this.getAdjacentRoomIntel(roomName),
        remoteMining: this.getRemoteMiningStatus(roomName),
        scouting: this.getScoutingStatus(roomName),
        traffic: StatsCollector.exportTrafficMetrics(room),
        remoteDefense: this.getRemoteDefenseStatus(roomName),
        mineral: this.getMineralStatus(room, roomName),
        economy: new EconomyTracker(room).getMetrics(),
        remoteRooms: this.getActiveRemoteRooms(roomName),
      });
    }

    return colonies;
  }

  /**
   * Get active remote room names for a colony.
   */
  private static getActiveRemoteRooms(roomName: string): string[] {
    if (!Memory.colonies) return [];
    var colonyMem = Memory.colonies[roomName];
    if (!colonyMem || !colonyMem.remotes) return [];

    var activeRooms: string[] = [];
    for (var remoteName in colonyMem.remotes) {
      if (colonyMem.remotes[remoteName].active) {
        activeRooms.push(remoteName);
      }
    }
    return activeRooms;
  }

  /**
   * Get defense status for a room
   */
  private static getDefenseStatus(room: Room): DefenseExport {
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_TOWER },
    }) as StructureTower[];

    const towerEnergyTotal = towers.reduce((sum, t) => sum + t.store[RESOURCE_ENERGY], 0);
    const towerEnergyCapacity = towers.length * TOWER_CAPACITY;

    const controller = room.controller;

    return {
      towerCount: towers.length,
      towerEnergyTotal,
      towerEnergyCapacity,
      safeModeAvailable: controller?.safeModeAvailable || 0,
      safeModeCooldown: controller?.safeModeCooldown || 0,
      safeModeActive: controller?.safeMode || 0,
    };
  }

  /**
   * Get intel for all adjacent rooms
   */
  private static getAdjacentRoomIntel(homeRoom: string): AdjacentRoomExport[] {
    const adjacent: AdjacentRoomExport[] = [];
    const exits = Game.map.describeExits(homeRoom);

    if (!exits) return adjacent;

    // Get our username
    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;
    const colonyManager = ColonyManager.getInstance(homeRoom);
    const validRemoteTargets = new Set(colonyManager.getRemoteMiningTargets());

    const directionNames: Record<string, string> = {
      "1": "TOP",
      "3": "RIGHT",
      "5": "BOTTOM",
      "7": "LEFT",
    };

    for (const dir in exits) {
      const roomName = exits[dir as ExitKey];
      if (!roomName) continue;

      const intel = Memory.intel && Memory.intel[roomName];
      const lastScan = (intel && intel.lastScanned) ? intel.lastScanned : 0;
      const lastScanAge = Game.time - lastScan;

      // Check ownership
      const owner = (intel && intel.owner) ? intel.owner : null;
      const reservation = (intel && intel.reservation) ? intel.reservation : null;

      // Determine if valid remote target using same logic as ColonyManager
      const isValidRemoteTarget = validRemoteTargets.has(roomName);

      adjacent.push({
        roomName,
        direction: directionNames[dir] || dir,
        sources: (intel && intel.sources) ? intel.sources.length : 0,
        owner,
        reservation,
        hostiles: (intel && intel.hostiles) ? intel.hostiles : 0,
        hasKeepers: intel ? intel.roomType === "sourceKeeper" : false,
        hasInvaderCore: (intel && intel.invaderCore) ? intel.invaderCore : false,
        lastScan,
        lastScanAge,
        isValidRemoteTarget,
      });
    }

    return adjacent;
  }

  /**
   * Get remote mining status for all target rooms
   */
  private static getRemoteMiningStatus(homeRoom: string): RemoteMiningExport {
    const colonyManager = ColonyManager.getInstance(homeRoom);
    const targetRoomNames = colonyManager.getRemoteMiningTargets();

    // Also include rooms with active miners that aren't in the target list
    const allRemoteCreeps = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.room === homeRoom &&
        (c.memory.role === "REMOTE_MINER" ||
          c.memory.role === "REMOTE_HAULER" ||
          c.memory.role === "RESERVER")
    );

    // Find all remote rooms with creeps
    const roomsWithCreeps = new Set<string>();
    for (const creep of allRemoteCreeps) {
      if (creep.memory.targetRoom) {
        roomsWithCreeps.add(creep.memory.targetRoom);
      }
    }

    // Combine both lists
    const allRemoteRooms = new Set([...targetRoomNames, ...roomsWithCreeps]);

    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

    const targetRooms: RemoteRoomExport[] = [];
    let totalMiners = 0;
    let totalHaulers = 0;
    let totalReservers = 0;

    for (const roomName of allRemoteRooms) {
      const intel = Memory.intel && Memory.intel[roomName];

      // Get creeps assigned to this remote room
      const miners = allRemoteCreeps
        .filter((c) => c.memory.role === "REMOTE_MINER" && c.memory.targetRoom === roomName)
        .map((c) => ({
          name: c.name,
          sourceId: c.memory.sourceId,
          ttl: c.ticksToLive || 0,
          room: (c.room && c.room.name) ? c.room.name : "unknown",
        }));

      const haulers = allRemoteCreeps
        .filter((c) => c.memory.role === "REMOTE_HAULER" && c.memory.targetRoom === roomName)
        .map((c) => ({
          name: c.name,
          ttl: c.ticksToLive || 0,
          room: (c.room && c.room.name) ? c.room.name : "unknown",
        }));

      const reserverCreep = allRemoteCreeps.find(
        (c) => c.memory.role === "RESERVER" && c.memory.targetRoom === roomName
      );
      const reserver = reserverCreep
        ? {
            name: reserverCreep.name,
            ttl: reserverCreep.ticksToLive || 0,
            room: (reserverCreep.room && reserverCreep.room.name) ? reserverCreep.room.name : "unknown",
          }
        : null;

      // Determine status
      let status: RemoteRoomExport["status"] = "ACTIVE";

      if (!intel || !intel.lastScanned) {
        status = "NO_INTEL";
      } else if (intel.owner && intel.owner !== myUsername) {
        status = "OWNED";
      } else if (intel.reservation && intel.reservation.username !== myUsername) {
        status = "RESERVED_OTHER";
      } else if ((intel.hostiles || 0) > 0) {
        status = "HOSTILE";
      } else if (miners.length === 0) {
        status = "NO_MINERS";
      }

      totalMiners += miners.length;
      totalHaulers += haulers.length;
      if (reserver) totalReservers++;

      targetRooms.push({
        roomName,
        status,
        sources: (intel && intel.sources) ? intel.sources.length : 0,
        miners,
        haulers,
        reserver,
        reservation: (intel && intel.reservation) ? intel.reservation : null,
      });
    }

    return {
      targetRooms,
      totalMiners,
      totalHaulers,
      totalReservers,
    };
  }

  /**
   * Get scouting status
   */
  private static getScoutingStatus(homeRoom: string): ScoutingExport {
    // Get scout creeps for this home room
    const scouts = Object.values(Game.creeps)
      .filter((c) => c.memory.room === homeRoom && c.memory.role === "SCOUT")
      .map((c) => ({
        name: c.name,
        room: c.room?.name || "unknown",
        targetRoom: c.memory.targetRoom || null,
        state: c.memory.state || "SCOUTING",
        ttl: c.ticksToLive || 0,
        pos: { x: c.pos.x, y: c.pos.y },
      }));

    // Get scout queue from any active scout
    const scoutWithQueue = Object.values(Game.creeps).find(
      (c) =>
        c.memory.room === homeRoom &&
        c.memory.role === "SCOUT" &&
        (c.memory as ScoutMemory).scoutQueue
    );
    const scoutQueue = (scoutWithQueue?.memory as ScoutMemory)?.scoutQueue || [];

    // Get intel data
    const intel = Memory.intel || {};
    const STALE_THRESHOLD = 10000;

    // Find rooms needing scan from scout queue
    const roomsNeedingScan = scoutQueue.filter((room) => {
      const existing = intel[room];
      return !existing || Game.time - existing.lastScanned > STALE_THRESHOLD;
    });

    // Build scanned rooms summary from Memory.intel
    const scannedRooms: Record<string, ScannedRoomSummary> = {};
    for (const [roomName, data] of Object.entries(intel)) {
      scannedRooms[roomName] = {
        sources: data.sources?.length || 0,
        mineral: data.mineral?.type || null,
        controller: !!data.ownerRcl || data.roomType === "normal",
        owner: data.owner || null,
        reserved: data.reservation?.username || null,
        roomType: data.roomType || "normal",
        hasKeepers: data.roomType === "sourceKeeper",
        hasInvaderCore: data.invaderCore || false,
        swampPercent: data.terrain?.swampPercent || 0,
        wallPercent: data.terrain?.wallPercent || 0,
        scannedAt: data.lastScanned || 0,
        distance: data.distanceFromHome || Game.map.getRoomLinearDistance(homeRoom, roomName),
      };
    }

    return {
      scouts,
      roomsNeedingScan,
      totalRemaining: roomsNeedingScan.length,
      totalScanned: Object.keys(scannedRooms).length,
      scannedRooms,
    };
  }

  /**
   * Get remote defense diagnostic status - helps diagnose why defenders aren't spawning
   */
  private static getRemoteDefenseStatus(homeRoom: string): RemoteDefenseStatus {
    const exits = Game.map.describeExits(homeRoom);
    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

    const roomVisibility: RoomVisibility[] = [];
    const remoteCreepStates: RemoteCreepState[] = [];
    const spawnTriggers: RemoteDefenseTrigger[] = [];

    // Get all remote creeps for this home room
    const remoteCreeps = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.room === homeRoom &&
        (c.memory.role === "REMOTE_MINER" ||
          c.memory.role === "REMOTE_HAULER" ||
          c.memory.role === "REMOTE_DEFENDER" ||
          c.memory.role === "RESERVER")
    );

    // Track which rooms we care about
    const targetRooms = new Set<string>();
    if (exits) {
      for (const dir in exits) {
        const roomName = exits[dir as ExitKey];
        if (roomName) targetRooms.add(roomName);
      }
    }

    // Add rooms from creep assignments
    for (const creep of remoteCreeps) {
      if (creep.memory.targetRoom) {
        targetRooms.add(creep.memory.targetRoom);
      }
    }

    // Build room visibility data
    for (const roomName of targetRooms) {
      const room = Game.rooms[roomName];
      const intel = Memory.intel && Memory.intel[roomName];
      const lastScan = (intel && intel.lastScanned) ? intel.lastScanned : 0;

      // Count creeps with vision in this room
      const creepsWithVision = remoteCreeps.filter((c) => c.room && c.room.name === roomName).length;

      // Get real-time hostile data if we have vision
      let hostileDetails: RoomVisibility["hostiles"]["details"] = [];
      let realTimeHostileCount = 0;

      if (room) {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        realTimeHostileCount = hostiles.length;
        hostileDetails = hostiles.map((h) => ({
          owner: h.owner.username,
          pos: { x: h.pos.x, y: h.pos.y },
          bodyParts: h.body.length,
          dangerous:
            h.body.some((p) => p.type === ATTACK || p.type === RANGED_ATTACK) ||
            h.owner.username === "Invader",
        }));
      }

      roomVisibility.push({
        roomName,
        hasVision: !!room,
        creepsWithVision,
        hostiles: {
          count: realTimeHostileCount,
          details: hostileDetails,
        },
        memoryHostiles: (intel && intel.hostiles) ? intel.hostiles : 0,
        memoryLastScan: lastScan,
        memoryAge: Game.time - lastScan,
      });
    }

    // Build creep state data
    for (const creep of remoteCreeps) {
      const state = creep.memory.state as string | undefined;
      const isFleeing =
        state === "FLEEING" ||
        state === "RETREAT" ||
        (creep.memory as any).fleeing === true;

      remoteCreepStates.push({
        name: creep.name,
        role: creep.memory.role,
        room: creep.room?.name || "unknown",
        targetRoom: creep.memory.targetRoom || "",
        state: creep.memory.state || "unknown",
        ttl: creep.ticksToLive || 0,
        pos: { x: creep.pos.x, y: creep.pos.y },
        isFleeing,
        fleeReason: isFleeing ? ((creep.memory as any).fleeReason || "unknown") : null,
      });
    }

    // Build spawn trigger analysis for each potential remote room
    const currentDefenders = remoteCreeps.filter((c) => c.memory.role === "REMOTE_DEFENDER");
    const totalDefenders = currentDefenders.length;
    const maxDefenders = 2; // From spawnCreeps.ts

    for (const roomName of targetRooms) {
      const intel = Memory.intel && Memory.intel[roomName];
      const reasons: string[] = [];
      const blockers: string[] = [];

      const hostileCount = (intel && intel.hostiles) ? intel.hostiles : 0;
      const hasInvaderCore = (intel && intel.invaderCore) ? true : false;
      const hasSources = (intel && intel.sources && intel.sources.length > 0) ? true : false;
      const hasKeepers = intel ? intel.roomType === "sourceKeeper" : false;
      const ownerOther = (intel && intel.owner && intel.owner !== myUsername) ? true : false;
      const reservedOther = (intel && intel.reservation && intel.reservation.username !== myUsername) ? true : false;

      // Check what would trigger defender spawning
      if (hostileCount > 0) reasons.push(`${hostileCount} hostiles in memory`);
      if (hasInvaderCore) reasons.push("Has invader core");

      // Check what would block spawning
      if (!hasSources) blockers.push("No sources (not a mining target)");
      if (hasKeepers) blockers.push("Source keeper room");
      if (ownerOther) blockers.push("Owned by another player");
      if (reservedOther) blockers.push("Reserved by another player");
      if (totalDefenders >= maxDefenders) blockers.push(`At max defenders (${totalDefenders}/${maxDefenders})`);

      const existingForRoom = currentDefenders.filter(
        (c) => c.memory.targetRoom === roomName
      ).length;
      if (existingForRoom > 0) blockers.push(`Already has ${existingForRoom} defender(s) assigned`);

      // Would this room trigger a spawn?
      const shouldSpawn =
        (hostileCount > 0 || hasInvaderCore) &&
        hasSources &&
        !hasKeepers &&
        !ownerOther &&
        !reservedOther &&
        totalDefenders < maxDefenders &&
        existingForRoom < 1;

      spawnTriggers.push({
        roomName,
        shouldSpawnDefender: shouldSpawn,
        reasons,
        blockers,
        hostileCount,
        hasInvaderCore,
        existingDefenders: existingForRoom,
        maxDefenders,
      });
    }

    return {
      roomVisibility,
      remoteCreepStates,
      spawnTriggers,
    };
  }

  /**
   * Get mineral harvesting status for a room
   */
  private static getMineralStatus(room: Room, roomName: string): MineralExport {
    const minerals = room.find(FIND_MINERALS);
    const mineral = minerals[0];

    const extractor = room.find(FIND_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTRACTOR,
    }).length > 0;

    const harvester = Object.values(Game.creeps).find(
      (c) => c.memory.role === "MINERAL_HARVESTER" && c.memory.room === roomName
    )?.name || null;

    return {
      type: mineral?.mineralType || null,
      amount: mineral?.mineralAmount || 0,
      extractor,
      harvester,
    };
  }

  private static getGlobalStats(): GlobalExport {
    return {
      cpu: {
        used: Game.cpu.getUsed(),
        bucket: Game.cpu.bucket,
        limit: Game.cpu.limit,
      },
      gcl: {
        level: Game.gcl.level,
        progress: Game.gcl.progress,
        progressTotal: Game.gcl.progressTotal,
      },
      credits: Game.market?.credits || 0,
      totalCreeps: Object.keys(Game.creeps).length,
    };
  }

  /**
   * Get empire and expansion status for API export
   */
  private static getEmpireStatus(): EmpireExport | null {
    if (!Memory.empire) {
      return null;
    }

    var exp = Memory.empire.expansion;
    var active = exp ? exp.active : {};
    const activeExpansions: EmpireExpansionExport[] = [];

    for (const roomName in active) {
      const exp = active[roomName];

      // Count alive pioneers
      const pioneers = exp.bootstrapCreeps.filter(
        (n) => Game.creeps[n]?.memory.role === "PIONEER"
      ).length;

      // Get spawn site progress if exists
      let spawnProgress: EmpireExpansionExport["spawnProgress"] = null;
      if (exp.spawnSiteId) {
        const site = Game.getObjectById(exp.spawnSiteId as Id<ConstructionSite>);
        if (site) {
          spawnProgress = {
            progress: site.progress,
            total: site.progressTotal,
            percent: ((site.progress / site.progressTotal) * 100).toFixed(1),
          };
        }
      }

      activeExpansions.push({
        roomName: exp.roomName,
        parentRoom: exp.parentRoom,
        state: exp.state,
        stateChangedAt: exp.stateChangedAt,
        ticksInState: Game.time - exp.stateChangedAt,
        startedAt: exp.startedAt,
        totalTicks: Game.time - exp.startedAt,
        attempts: exp.attempts,
        claimer: exp.claimer,
        spawnSitePos: exp.spawnSitePos,
        spawnProgress,
        creeps: {
          pioneers,
          total: exp.bootstrapCreeps.length,
          names: exp.bootstrapCreeps,
        },
        blockers: exp.blockers,
        lastFailure: exp.lastFailure,
      });
    }

    // Get expansion overview with candidates and readiness
    const expansionOverview = this.getExpansionOverview(activeExpansions);

    return {
      state: Memory.empire ? Memory.empire.state : "UNKNOWN",
      stateChangedAt: Memory.empire ? Memory.empire.stateChangedAt : undefined,
      priorities: Memory.empire && Memory.empire.priorities ? Memory.empire.priorities : {},
      expansion: {
        active: activeExpansions,
        activeCount: activeExpansions.length,
        queue: exp ? exp.queue : [],
        queueCount: exp && exp.queue ? exp.queue.length : 0,
        history: exp ? exp.history : {},
      },
      expansionOverview,
      gcl: {
        level: Game.gcl.level,
        progress: Game.gcl.progress,
        progressTotal: Game.gcl.progressTotal,
        percent: ((Game.gcl.progress / Game.gcl.progressTotal) * 100).toFixed(2),
      },
      colonies: Object.values(Game.rooms)
        .filter((r) => r.controller?.my)
        .map((r) => r.name),
      colonyCount: Object.values(Game.rooms).filter((r) => r.controller?.my).length,
    };
  }

  /**
   * Get expansion overview with candidates and parent readiness
   */
  private static getExpansionOverview(activeExpansions: EmpireExpansionExport[]): ExpansionOverviewExport {
    // Use cached version if recent (expensive evaluation)
    if (
      cachedExpansionOverview &&
      Game.time - expansionOverviewTick < EXPANSION_OVERVIEW_CACHE_TICKS
    ) {
      // Update only the dynamic parts (active expansions)
      cachedExpansionOverview.active = activeExpansions;
      cachedExpansionOverview.activeCount = activeExpansions.length;
      return cachedExpansionOverview;
    }

    const readiness = new ExpansionReadiness();
    const evaluator = new RoomEvaluator();

    // Check if empire can expand
    const { ready: canExpand, bestParent, blockers: empireBlockers } = readiness.canExpand();

    // Get config
    var autoExpand = Memory.empire && Memory.empire.config && Memory.empire.config.autoExpand !== undefined
      ? Memory.empire.config.autoExpand
      : true;

    // Get ranked candidates (top 10)
    const candidates: ExpansionCandidateExport[] = evaluator.rankCandidates(10).map((score: RoomScore) => ({
      roomName: score.roomName,
      totalScore: score.totalScore,
      viable: score.viable,
      blockers: score.blockers,
      economic: score.economic,
      strategic: score.strategic,
      defensive: score.defensive,
      details: {
        sources: score.details.sources,
        mineral: score.details.mineral,
        mineralValue: score.details.mineralValue,
        swampPercent: score.details.swampPercent,
        wallPercent: score.details.wallPercent,
        distanceFromParent: score.details.distanceFromParent,
        distanceFromEnemies: score.details.distanceFromEnemies,
        remotePotential: score.details.remotePotential,
      },
    }));

    // Get parent readiness for all colonies
    const parentReadiness: ParentReadinessExport[] = readiness.rankParentColonies().map((p: ParentCandidate) => ({
      roomName: p.roomName,
      ready: p.readiness.ready,
      score: p.readiness.score,
      blockers: p.readiness.blockers,
      warnings: p.readiness.warnings,
      distanceToTarget: p.distanceToTarget,
    }));

    var exp = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
    cachedExpansionOverview = {
      canExpand,
      bestParent,
      empireBlockers,
      autoExpand,
      active: activeExpansions,
      activeCount: activeExpansions.length,
      queue: exp ? exp.queue : [],
      queueCount: exp && exp.queue ? exp.queue.length : 0,
      candidates,
      candidateCount: candidates.length,
      parentReadiness,
      history: exp ? exp.history : {},
    };
    expansionOverviewTick = Game.time;
    return cachedExpansionOverview;
  }

  /**
   * Get military campaign status for API export
   */
  private static getMilitaryStatus(): MilitaryExport | null {
    var militaryMem = (Memory as any).military;
    if (!militaryMem) return null;

    var campaigns: MilitaryCampaignExport[] = [];
    var activeCampaigns = 0;

    for (var id in militaryMem.campaigns) {
      var c = militaryMem.campaigns[id];
      var a = c.controllerAttack;
      if (!a) continue;

      if (c.state !== "COMPLETE" && c.state !== "ABORTED") {
        activeCampaigns++;
      }

      var estHours = ((a.estimatedCyclesRemaining || 0) * 1000 / 3600 * 3).toFixed(1);

      // Count creeps for this campaign
      var creepCount = 0;
      for (var name in Game.creeps) {
        if ((Game.creeps[name].memory as any).campaignId === id) {
          creepCount++;
        }
      }

      var stats = a.stats || {
        totalSpawned: 0,
        totalLost: 0,
        totalEnergySpent: 0,
        rclDowngrades: [],
        safeModeActivations: 0,
      };

      campaigns.push({
        id: id,
        type: c.type,
        targetRoom: c.targetRoom,
        targetOwner: c.targetOwner,
        state: c.state,
        ticksInState: Game.time - c.stateChangedAt,
        createdAt: c.createdAt,
        age: Game.time - c.createdAt,
        attack: {
          attackCount: a.attackCount,
          currentRCL: a.currentTargetRCL,
          currentTimer: a.currentTicksToDowngrade,
          estimatedCycles: a.estimatedCyclesRemaining || 0,
          estimatedHours: estHours,
          defendersSeen: a.defendersSeen,
          towerDrainNeeded: a.towerDrainNeeded,
          safeModeActive: a.safeModeActive,
          stats: {
            totalSpawned: stats.totalSpawned,
            totalLost: stats.totalLost,
            totalEnergySpent: stats.totalEnergySpent,
            rclDowngrades: stats.rclDowngrades ? stats.rclDowngrades.length : 0,
            safeModeActivations: stats.safeModeActivations,
          },
        },
        creeps: creepCount,
      });
    }

    return {
      posture: militaryMem.posture || "PEACEFUL",
      activeCampaigns: activeCampaigns,
      totalCampaigns: Object.keys(militaryMem.campaigns).length,
      campaigns: campaigns,
    };
  }

  /**
   * Get detailed diagnostics for a specific room
   */
  static getDiagnostics(roomName: string): DiagnosticsExport | null {
    const room = Game.rooms[roomName];
    if (!room || !room.controller?.my) return null;

    // Get all creeps for this room (using cached lookup)
    const creeps = getCreepsByRoom(roomName)
      .map((c) => ({
        name: c.name,
        role: c.memory.role || "UNKNOWN",
        room: c.room?.name || "unknown",
        pos: { x: c.pos.x, y: c.pos.y },
        state: c.memory.state || "unknown",
        targetId: (c.memory.targetId as string) || null,
        taskId: (c.memory.taskId as string) || null,
        ttl: c.ticksToLive || 0,
        energy: c.store[RESOURCE_ENERGY] || 0,
        energyCapacity: c.store.getCapacity(RESOURCE_ENERGY) || 0,
        fatigue: c.fatigue,
        body: c.body.map((p) => p.type[0].toUpperCase()).join(""),
      }));

    // Get links
    const links = (
      room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_LINK },
      }) as StructureLink[]
    ).map((l) => ({
      id: l.id,
      pos: { x: l.pos.x, y: l.pos.y },
      energy: l.store[RESOURCE_ENERGY],
      energyCapacity: l.store.getCapacity(RESOURCE_ENERGY),
      cooldown: l.cooldown,
    }));

    // Get containers
    const containers = (
      room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER },
      }) as StructureContainer[]
    ).map((c) => ({
      id: c.id,
      pos: { x: c.pos.x, y: c.pos.y },
      energy: c.store[RESOURCE_ENERGY],
      energyCapacity: c.store.getCapacity(RESOURCE_ENERGY),
      hits: c.hits,
      hitsMax: c.hitsMax,
    }));

    // Get spawns
    const spawns = (
      room.find(FIND_MY_SPAWNS) as StructureSpawn[]
    ).map((s) => ({
      id: s.id,
      name: s.name,
      pos: { x: s.pos.x, y: s.pos.y },
      energy: s.store[RESOURCE_ENERGY],
      energyCapacity: s.store.getCapacity(RESOURCE_ENERGY),
      spawning: s.spawning
        ? {
            name: s.spawning.name,
            remainingTime: s.spawning.remainingTime,
          }
        : null,
    }));

    // Get towers
    const towers = (
      room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_TOWER },
      }) as StructureTower[]
    ).map((t) => ({
      id: t.id,
      pos: { x: t.pos.x, y: t.pos.y },
      energy: t.store[RESOURCE_ENERGY],
      energyCapacity: t.store.getCapacity(RESOURCE_ENERGY),
    }));

    // Get sources
    const sources = room.find(FIND_SOURCES).map((s) => ({
      id: s.id,
      pos: { x: s.pos.x, y: s.pos.y },
      energy: s.energy,
      energyCapacity: s.energyCapacity,
      ticksToRegeneration: s.ticksToRegeneration || 0,
    }));

    // Get controller info
    const controller = room.controller
      ? {
          level: room.controller.level,
          progress: room.controller.progress,
          progressTotal: room.controller.progressTotal,
          ticksToDowngrade: room.controller.ticksToDowngrade || 0,
          upgradeBlocked: room.controller.upgradeBlocked || 0,
        }
      : null;

    return {
      roomName,
      gameTick: Game.time,
      creeps,
      structures: {
        links,
        containers,
        spawns,
        towers,
      },
      controller,
      sources,
    };
  }

  /**
   * Read the current export data (for debugging)
   */
  /**
   * Read colony data from segment 90 (for debugging)
   */
  static readColonies(): ColonyPayload | null {
    var raw = RawMemory.segments[SEGMENT_COLONIES];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ColonyPayload;
    } catch (e) {
      return null;
    }
  }

  /**
   * Read intel data from segment 91 (for debugging)
   */
  static readIntel(): IntelPayload | null {
    var raw = RawMemory.segments[SEGMENT_INTEL];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IntelPayload;
    } catch (e) {
      return null;
    }
  }

  /**
   * Read diagnostics from segment 93 (for debugging)
   */
  static readDiagnostics(): DiagnosticsPayload | null {
    var raw = RawMemory.segments[SEGMENT_DIAGNOSTICS];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DiagnosticsPayload;
    } catch (e) {
      return null;
    }
  }

  /**
   * Read combined data (legacy format, for backward compatibility)
   * @deprecated Use readColonies(), readIntel(), or readDiagnostics() instead
   */
  static read(): AWSExportData | null {
    var raw = RawMemory.segments[SEGMENT_COLONIES];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AWSExportData;
    } catch (e) {
      return null;
    }
  }
}
