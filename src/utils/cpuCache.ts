/**
 * CPU Cache Utilities
 *
 * Provides heap-level and per-tick caches to avoid expensive repeated operations.
 * All caches automatically reset on global reset (heap caches) or each tick (tick caches).
 */

// ============================================================================
// CREEP CACHES - Pre-computed once per tick
// ============================================================================

interface CreepCaches {
  tick: number;
  byRoom: Record<string, Creep[]>;
  byRole: Record<string, Creep[]>;
  byRoomAndRole: Record<string, Record<string, Creep[]>>;
}

let creepCaches: CreepCaches | null = null;

/**
 * Ensure creep caches are built for this tick.
 * Called once per tick, builds all groupings in a single pass.
 */
function ensureCreepCaches(): CreepCaches {
  if (creepCaches && creepCaches.tick === Game.time) {
    return creepCaches;
  }

  const byRoom: Record<string, Creep[]> = {};
  const byRole: Record<string, Creep[]> = {};
  const byRoomAndRole: Record<string, Record<string, Creep[]>> = {};

  const allCreeps = Object.values(Game.creeps);
  for (let i = 0; i < allCreeps.length; i++) {
    const creep = allCreeps[i];
    const room = creep.memory.room || "unknown";
    const role = creep.memory.role || "unknown";

    // By room
    if (!byRoom[room]) byRoom[room] = [];
    byRoom[room].push(creep);

    // By role
    if (!byRole[role]) byRole[role] = [];
    byRole[role].push(creep);

    // By room and role
    if (!byRoomAndRole[room]) byRoomAndRole[room] = {};
    if (!byRoomAndRole[room][role]) byRoomAndRole[room][role] = [];
    byRoomAndRole[room][role].push(creep);
  }

  creepCaches = { tick: Game.time, byRoom, byRole, byRoomAndRole };
  return creepCaches;
}

/**
 * Get all creeps assigned to a room (by memory.room, not physical location).
 */
export function getCreepsByRoom(roomName: string): Creep[] {
  const caches = ensureCreepCaches();
  return caches.byRoom[roomName] || [];
}

/**
 * Get all creeps of a specific role across the empire.
 */
export function getCreepsByRole(role: string): Creep[] {
  const caches = ensureCreepCaches();
  return caches.byRole[role] || [];
}

/**
 * Get creeps of a specific role in a specific room.
 */
export function getCreepsByRoomAndRole(roomName: string, role: string): Creep[] {
  const caches = ensureCreepCaches();
  const roomRoles = caches.byRoomAndRole[roomName];
  if (!roomRoles) return [];
  return roomRoles[role] || [];
}

/**
 * Get count of creeps by role in a room.
 */
export function getCreepCountByRole(roomName: string): Record<string, number> {
  const caches = ensureCreepCaches();
  const roomRoles = caches.byRoomAndRole[roomName];
  if (!roomRoles) return {};

  const counts: Record<string, number> = {};
  for (const role in roomRoles) {
    counts[role] = roomRoles[role].length;
  }
  return counts;
}

// ============================================================================
// CONSTRUCTION SITE CACHE - Per tick
// ============================================================================

let constructionSiteCache: Record<string, ConstructionSite[]> | null = null;
let constructionSiteCacheTick = 0;

/**
 * Get construction sites for a room (cached per tick).
 */
export function getConstructionSites(roomName: string): ConstructionSite[] {
  if (Game.time !== constructionSiteCacheTick) {
    constructionSiteCache = {};
    constructionSiteCacheTick = Game.time;
  }
  if (constructionSiteCache && constructionSiteCache[roomName]) {
    return constructionSiteCache[roomName];
  }

  const room = Game.rooms[roomName];
  const sites = room ? room.find(FIND_CONSTRUCTION_SITES) : [];
  if (constructionSiteCache) {
    constructionSiteCache[roomName] = sites;
  }
  return sites;
}

// ============================================================================
// HOSTILE CREEP CACHE - Per tick
// ============================================================================

let hostileCreepCache: Record<string, Creep[]> | null = null;
let hostileCreepCacheTick = 0;

/**
 * Get hostile creeps in a room (cached per tick).
 */
export function getHostileCreeps(roomName: string): Creep[] {
  if (Game.time !== hostileCreepCacheTick) {
    hostileCreepCache = {};
    hostileCreepCacheTick = Game.time;
  }
  if (hostileCreepCache && hostileCreepCache[roomName]) {
    return hostileCreepCache[roomName];
  }

  const room = Game.rooms[roomName];
  const hostiles = room ? room.find(FIND_HOSTILE_CREEPS) : [];
  if (hostileCreepCache) {
    hostileCreepCache[roomName] = hostiles;
  }
  return hostiles;
}

// ============================================================================
// DROPPED RESOURCE CACHE - Per tick
// ============================================================================

let droppedResourceCache: Record<string, Resource[]> | null = null;
let droppedResourceCacheTick = 0;

/**
 * Get dropped energy resources in a room (cached per tick).
 */
export function getDroppedEnergy(roomName: string): Resource[] {
  if (Game.time !== droppedResourceCacheTick) {
    droppedResourceCache = {};
    droppedResourceCacheTick = Game.time;
  }
  if (droppedResourceCache && droppedResourceCache[roomName]) {
    return droppedResourceCache[roomName];
  }

  const room = Game.rooms[roomName];
  const dropped = room
    ? room.find(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 50,
      })
    : [];
  if (droppedResourceCache) {
    droppedResourceCache[roomName] = dropped;
  }
  return dropped;
}

// ============================================================================
// CPU GUARD
// ============================================================================

/**
 * Check if we should skip non-essential operations due to low CPU bucket.
 */
export function shouldSkipNonEssential(): boolean {
  return Game.cpu.bucket < 2000;
}

/**
 * Check if we should skip expensive evaluations (expansion, attack targets).
 */
export function shouldSkipExpensiveEvaluations(): boolean {
  return Game.cpu.bucket < 5000;
}

/**
 * Check if we should skip export/metrics (rate limited anyway but extra guard).
 */
export function shouldSkipExport(): boolean {
  return Game.cpu.bucket < 3000;
}
