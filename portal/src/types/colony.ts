// Response from GET /colonies/{room}
export interface ColonyDetail {
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
  structureDetails: {
    links: LinkDetail[] | null;
    containers: ContainerDetail[] | null;
    spawns: SpawnDetail[] | null;
  };
  defense: {
    towerCount: number;
    towerEnergyTotal: number;
    towerEnergyCapacity: number;
    safeModeAvailable: number;
    safeModeCooldown: number;
    safeModeActive: number;
  };
  remoteMining: RemoteMiningExport | null;
  mineral: {
    type: string | null;
    amount: number;
    density: string | null;
    cooldown: number;
    extractor: boolean;
  };
  economy: ColonyEconomyMetrics;
  remoteRooms: string[];
  phase?: string;
  // Metadata from API envelope
  source?: string;
  freshness?: number;
  gameTick?: number;
}

export interface CreepDetail {
  name: string;
  role: string;
  body: string[];
  hits: number;
  hitsMax: number;
  ticksToLive: number;
  fatigue: number;
  pos: { x: number; y: number; roomName: string };
  state?: string;
  targetRoom?: string;
  spawning?: boolean;
}

export interface LinkDetail {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  energyCapacity: number;
  cooldown: number;
  type: 'source' | 'controller' | 'storage' | 'unknown';
}

export interface ContainerDetail {
  id: string;
  pos: { x: number; y: number };
  energy: number;
  hits: number;
  hitsMax: number;
  nearSource: boolean;
  nearController: boolean;
}

export interface SpawnDetail {
  name: string;
  spawning: string | null;
  energy: number;
}

export interface RemoteMiningExport {
  targetRooms: RemoteRoomExport[] | null;
  totalMiners: number;
  totalHaulers: number;
  totalReservers: number;
}

export interface RemoteRoomExport {
  roomName: string;
  status: 'ACTIVE' | 'NO_MINERS' | 'HOSTILE' | 'NO_INTEL' | 'RESERVED_OTHER' | 'OWNED';
  sources: number;
  miners: RemoteCreepExport[];
  haulers: RemoteCreepExport[];
  reserver: RemoteCreepExport | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;
}

export interface RemoteCreepExport {
  name: string;
  sourceId?: string;
  ticksToLive: number;
  spawning?: boolean;
}

export interface ColonyEconomyMetrics {
  harvestRate: number;
  upgradeRate: number;
  buildRate: number;
  repairRate: number;
  spawnRate: number;
  storageLevel: number;
  storageTrend: 'rising' | 'falling' | 'stable';
}

// Response from GET /metrics/{room}?hours=N
export interface MetricDataPoint {
  roomName: string;
  timestamp: number;
  metrics: {
    energy_available?: number;
    energy_capacity?: number;
    storage_energy?: number;
    terminal_energy?: number;
    rcl?: number;
    controller_progress?: number;
    controller_progress_total?: number;
    creep_count?: number;
    cpu_used?: number;
    cpu_bucket?: number;
    [key: string]: number | undefined;
  };
}
