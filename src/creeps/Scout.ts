import { moveToRoom, smartMoveTo } from "../utils/movement";

const SCOUT_RANGE = 4; // Scout 4 rooms in each direction
const STALE_THRESHOLD = 10000; // Re-scan after 10000 ticks

/**
 * Scout - Explores rooms within 4-tile radius and records comprehensive intel
 * Multiple scouts can scan simultaneously, each avoiding already-targeted rooms
 * Stores room data in Memory.intel for expansion planning and territory mapping
 */
export function runScout(creep: Creep): void {
  const memory = creep.memory as ScoutMemory;

  // Initialize scout memory if needed
  if (!memory.homeRoom) {
    memory.homeRoom = memory.room;
  }
  if (!memory.scoutQueue || memory.scoutQueue.length === 0) {
    memory.scoutQueue = generateScoutQueue(memory.homeRoom, SCOUT_RANGE);
  }
  if (!memory.scannedRooms) {
    memory.scannedRooms = [];
  }

  // Record intel about current room
  gatherRoomIntel(creep.room, memory.homeRoom);

  // If we reached target room, mark as scanned and clear target
  if (memory.targetRoom && creep.room.name === memory.targetRoom) {
    if (!memory.scannedRooms.includes(memory.targetRoom)) {
      memory.scannedRooms.push(memory.targetRoom);
    }
    memory.targetRoom = "";
  }

  // Get next target if needed
  if (!memory.targetRoom) {
    const nextTarget = getNextScoutTarget(memory, creep);
    memory.targetRoom = nextTarget || "";
  }

  if (!memory.targetRoom) {
    // All rooms scouted - recycle at spawn
    if (creep.room.name !== memory.homeRoom) {
      moveToRoom(creep, memory.homeRoom, "#00ffff");
      creep.say("DONE");
      return;
    }

    const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (spawn) {
      if (creep.pos.getRangeTo(spawn) > 1) {
        smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#00ffff" } });
        creep.say("RECYCLE");
      } else {
        spawn.recycleCreep(creep);
      }
    }
    return;
  }

  // Move to target room
  if (creep.room.name !== memory.targetRoom) {
    moveToRoom(creep, memory.targetRoom, "#00ffff");
    creep.say("SCOUT");
  } else {
    // In target room - move toward center for full visibility
    const center = new RoomPosition(25, 25, creep.room.name);
    if (!creep.pos.inRangeTo(center, 10)) {
      smartMoveTo(creep, center, { visualizePathStyle: { stroke: "#00ffff" } });
    }
  }
}

/**
 * Gather comprehensive intel about a room
 * Exported so main loop can gather intel for any visible room
 */
export function gatherRoomIntel(room: Room, homeRoom: string): void {
  if (!Memory.intel) Memory.intel = {};

  // Read existing intel to preserve lastHostileSeen across scans with no hostiles
  const existing = Memory.intel[room.name];

  // Count hostile creeps
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
  const hostileCount = hostileCreeps.length;

  // Preserve lastHostileSeen: update if hostiles present, otherwise keep old value
  let lastHostileSeen = 0;
  if (hostileCount > 0) {
    lastHostileSeen = Game.time;
  } else if (existing && existing.lastHostileSeen) {
    lastHostileSeen = existing.lastHostileSeen;
  }

  // Build hostile details for defense decisions
  let hostileDetails: RoomIntel["hostileDetails"] = undefined;
  if (hostileCount > 0) {
    hostileDetails = hostileCreeps.map((h) => ({
      id: h.id,
      owner: h.owner.username,
      pos: { x: h.pos.x, y: h.pos.y },
      bodyParts: h.body.length,
      hasCombat:
        h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0,
    }));
  }

  const exitData = Game.map.describeExits(room.name);
  const intel: RoomIntel = {
    roomName: room.name,
    lastScanned: Game.time,
    roomType: getRoomType(room),
    owner: (room.controller && room.controller.owner) ? room.controller.owner.username : null,
    ownerRcl: (room.controller && room.controller.level) ? room.controller.level : null,
    reservation: (room.controller && room.controller.reservation)
      ? {
          username: room.controller.reservation.username,
          ticksToEnd: room.controller.reservation.ticksToEnd,
        }
      : null,
    sources: room.find(FIND_SOURCES).map((s) => ({
      id: s.id,
      pos: { x: s.pos.x, y: s.pos.y },
    })),
    mineral: getMineral(room),
    terrain: analyzeRoomTerrain(room.name),
    exits: {
      top: (exitData && exitData[TOP]) ? exitData[TOP] : null,
      right: (exitData && exitData[RIGHT]) ? exitData[RIGHT] : null,
      bottom: (exitData && exitData[BOTTOM]) ? exitData[BOTTOM] : null,
      left: (exitData && exitData[LEFT]) ? exitData[LEFT] : null,
    },
    hostileStructures: getHostileStructures(room),
    invaderCore:
      room.find(FIND_HOSTILE_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
      }).length > 0,
    hostiles: hostileCount,
    lastHostileSeen: lastHostileSeen,
    hostileDetails: hostileDetails,
    distanceFromHome: Game.map.getRoomLinearDistance(room.name, homeRoom),
  };

  Memory.intel[room.name] = intel;
}

/**
 * Determine room type based on coordinates and actual room data
 * Uses coordinate-based detection but overrides with actual room data when available
 */
function getRoomType(room: Room): RoomIntel["roomType"] {
  const roomName = room.name;
  const parsed = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!parsed) return "normal";

  const x = parseInt(parsed[1]);
  const y = parseInt(parsed[2]);

  // Highway rooms: x or y divisible by 10
  if (x % 10 === 0 || y % 10 === 0) return "highway";

  // Check for actual keeper lairs - definitive SK detection
  const keeperLairs = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_KEEPER_LAIR,
  });
  if (keeperLairs.length > 0) return "sourceKeeper";

  // If room has a controller (can be claimed), it's not an SK or center room
  if (room.controller) return "normal";

  // Center rooms: x % 10 in [4,5,6] AND y % 10 in [4,5,6]
  // (only if no controller - center rooms have no controller)
  const xMod = x % 10;
  const yMod = y % 10;
  if (xMod >= 4 && xMod <= 6 && yMod >= 4 && yMod <= 6) return "center";

  // Coordinate-based SK detection (fallback when we don't have keeper lairs in view)
  // SK rooms form a ring around the 3x3 center: positions 3 or 7 in the 3-7 range
  if (xMod >= 3 && xMod <= 7 && yMod >= 3 && yMod <= 7) {
    if (xMod === 3 || xMod === 7 || yMod === 3 || yMod === 7) return "sourceKeeper";
  }

  return "normal";
}

/**
 * Get mineral info from room
 */
function getMineral(room: Room): RoomIntel["mineral"] {
  const minerals = room.find(FIND_MINERALS);
  if (minerals.length === 0) return null;

  const m = minerals[0];
  return {
    type: m.mineralType,
    amount: m.mineralAmount,
    id: m.id,
    pos: { x: m.pos.x, y: m.pos.y },
  };
}

/**
 * Analyze room terrain composition
 */
function analyzeRoomTerrain(roomName: string): RoomIntel["terrain"] {
  const terrain = Game.map.getRoomTerrain(roomName);
  let swamp = 0,
    wall = 0,
    plain = 0;

  for (let x = 0; x < 50; x++) {
    for (let y = 0; y < 50; y++) {
      const t = terrain.get(x, y);
      if (t === TERRAIN_MASK_SWAMP) swamp++;
      else if (t === TERRAIN_MASK_WALL) wall++;
      else plain++;
    }
  }

  const total = 2500;
  return {
    swampPercent: Math.round((swamp / total) * 100),
    wallPercent: Math.round((wall / total) * 100),
    plainPercent: Math.round((plain / total) * 100),
  };
}

/**
 * Get hostile structure counts
 */
function getHostileStructures(room: Room): RoomIntel["hostileStructures"] {
  const hostiles = room.find(FIND_HOSTILE_STRUCTURES);
  return {
    towers: hostiles.filter((s) => s.structureType === STRUCTURE_TOWER).length,
    spawns: hostiles.filter((s) => s.structureType === STRUCTURE_SPAWN).length,
    hasTerminal: hostiles.some((s) => s.structureType === STRUCTURE_TERMINAL),
  };
}

/**
 * Generate scout queue in spiral/BFS order from home room
 */
export function generateScoutQueue(homeRoom: string, maxRange: number): string[] {
  const queue: string[] = [];
  const visited = new Set<string>();

  const parsed = /^([WE])(\d+)([NS])(\d+)$/.exec(homeRoom);
  if (!parsed) return [];

  const [, ew, xStr, ns, yStr] = parsed;
  const homeX = parseInt(xStr) * (ew === "E" ? 1 : -1);
  const homeY = parseInt(yStr) * (ns === "N" ? 1 : -1);

  // BFS spiral outward - process each range level
  for (let range = 1; range <= maxRange; range++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        // Only process rooms at exactly this range (perimeter)
        if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;

        const x = homeX + dx;
        const y = homeY + dy;
        const roomName = coordsToRoomName(x, y);

        if (!visited.has(roomName)) {
          visited.add(roomName);
          queue.push(roomName);
        }
      }
    }
  }

  return queue;
}

/**
 * Convert numeric coordinates to room name
 */
function coordsToRoomName(x: number, y: number): string {
  const ew = x >= 0 ? "E" : "W";
  const ns = y >= 0 ? "N" : "S";
  return `${ew}${Math.abs(x)}${ns}${Math.abs(y)}`;
}

/**
 * Get next room to scout from queue
 * Avoids rooms already targeted by other scouts and sorts by proximity
 */
function getNextScoutTarget(memory: ScoutMemory, creep: Creep): string | undefined {
  const intel = Memory.intel || {};
  const scannedRooms = memory.scannedRooms || [];

  // Get rooms already targeted by other scouts
  const targetedByOthers = Object.values(Game.creeps)
    .filter(
      (c) =>
        c.memory.role === "SCOUT" &&
        c.name !== creep.name &&
        c.memory.room === memory.homeRoom &&
        (c.memory as ScoutMemory).targetRoom
    )
    .map((c) => (c.memory as ScoutMemory).targetRoom);

  // Find rooms that need scanning and aren't already targeted
  const candidates = memory.scoutQueue.filter((room) => {
    // Skip if this scout already scanned it
    if (scannedRooms.includes(room)) return false;

    // Skip if another scout is targeting it
    if (targetedByOthers.includes(room)) return false;

    // Check if room needs scanning
    const existing = intel[room];
    if (!existing) return true; // Never scanned
    if (Game.time - existing.lastScanned > STALE_THRESHOLD) return true; // Stale

    return false;
  });

  if (candidates.length === 0) return undefined;

  // Sort by distance to current position (nearest first)
  candidates.sort((a, b) => {
    const distA = Game.map.getRoomLinearDistance(creep.room.name, a);
    const distB = Game.map.getRoomLinearDistance(creep.room.name, b);
    return distA - distB;
  });

  return candidates[0];
}

/**
 * Count rooms that need scouting
 */
export function countRoomsNeedingScan(homeRoom: string, maxRange: number): number {
  const intel = Memory.intel || {};
  const queue = generateScoutQueue(homeRoom, maxRange);

  return queue.filter((room) => {
    const existing = intel[room];
    return !existing || Game.time - existing.lastScanned > STALE_THRESHOLD;
  }).length;
}
