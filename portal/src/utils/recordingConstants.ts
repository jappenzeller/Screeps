export const TERRAIN_COLORS: Record<number, string> = {
  0: '#2b2b2b',  // plain
  1: '#1a1a1a',  // wall
  2: '#2b3b2b',  // swamp
  3: '#1a1a1a',  // wall+swamp
};

export const STRUCTURE_COLORS: Record<string, string> = {
  spawn: '#ffcc00',
  extension: '#ffcc00',
  storage: '#ffaa00',
  terminal: '#cc8800',
  tower: '#ff4444',
  link: '#44aaff',
  container: '#888888',
  road: '#555555',
  constructedWall: '#446644',
  rampart: '#44ff44',
  controller: '#ffffff',
  extractor: '#aa44ff',
  lab: '#ff44ff',
  observer: '#44ffff',
  powerSpawn: '#ff8800',
  nuker: '#ff0000',
  factory: '#aaaaaa',
};

export const RECORDING_ROLE_COLORS: Record<string, string> = {
  HARVESTER: '#ffff00',
  HAULER: '#ff8800',
  UPGRADER: '#8844ff',
  BUILDER: '#44ff44',
  REPAIRER: '#44ffaa',
  DEFENDER: '#ff0000',
  REMOTE_MINER: '#aaaa00',
  REMOTE_HAULER: '#aa6600',
  REMOTE_DEFENDER: '#cc0000',
  RESERVER: '#0088ff',
  SCOUT: '#aaaaaa',
  LINK_FILLER: '#4488ff',
  MINERAL_HARVESTER: '#ff44ff',
  PIONEER: '#ffffff',
  CLAIMER: '#00ffff',
  BOOTSTRAP_BUILDER: '#88ff88',
  BOOTSTRAP_HAULER: '#ffaa44',
  UNKNOWN: '#888888',
};

export const ROLE_PREFIXES: Record<string, string> = {
  'H': 'HARVESTER',
  'T': 'HAULER',
  'U': 'UPGRADER',
  'B': 'BUILDER',
  'R': 'REPAIRER',
  'S': 'SCOUT',
  'C': 'CLAIMER',
  'D': 'DEFENDER',
  'M': 'MINERAL_HARVESTER',
  'RH': 'REMOTE_MINER',
  'RT': 'REMOTE_HAULER',
  'P': 'PIONEER',
  'RD': 'REMOTE_DEFENDER',
  'RS': 'RESERVER',
  'LF': 'LINK_FILLER',
};

export function parseRole(name: string): string {
  // Check longer prefixes first to avoid 'R' matching before 'RH'
  const sortedPrefixes = Object.entries(ROLE_PREFIXES)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [prefix, role] of sortedPrefixes) {
    if (name.startsWith(prefix + '-') || name.startsWith(prefix + '_')) {
      return role;
    }
  }
  return 'UNKNOWN';
}

export function heatmapColor(normalized: number): string {
  if (normalized < 0.25) return `rgba(0, 0, 255, ${normalized * 2})`;
  if (normalized < 0.5) return 'rgba(0, 255, 255, 0.5)';
  if (normalized < 0.75) return 'rgba(255, 255, 0, 0.6)';
  return 'rgba(255, 0, 0, 0.7)';
}

export function getTerrainAt(terrain: string, x: number, y: number): number {
  const index = y * 50 + x;
  if (index < 0 || index >= terrain.length) return 0;
  return (terrain.charCodeAt(index) - 48) & 0x03;
}

export function getTerrainName(terrainType: number): string {
  switch (terrainType) {
    case 0: return 'plain';
    case 1: return 'wall';
    case 2: return 'swamp';
    case 3: return 'wall';
    default: return 'unknown';
  }
}
