import { moveToRoom, smartMoveTo } from "../utils/movement";

/**
 * Scout - Explores adjacent rooms and records intel
 * Stores room data in Memory.rooms for expansion planning and remote mining
 */
export function runScout(creep: Creep): void {
  // Record intel about current room every tick
  recordRoomIntel(creep.room);

  // Get target room from memory or find new one
  let targetRoom = creep.memory.targetRoom;

  if (!targetRoom || creep.room.name === targetRoom) {
    // Find new room to scout
    targetRoom = findNextScoutTarget(creep);
    creep.memory.targetRoom = targetRoom;
  }

  if (!targetRoom) {
    // No rooms to scout - return home and idle at center
    const homeRoom = creep.memory.room;
    if (creep.room.name !== homeRoom) {
      moveToRoom(creep, homeRoom, "#00ffff");
    } else {
      // Already home - stay away from borders to avoid getting stuck
      const pos = creep.pos;
      if (pos.x <= 2 || pos.x >= 47 || pos.y <= 2 || pos.y >= 47) {
        const center = new RoomPosition(25, 25, creep.room.name);
        smartMoveTo(creep, center, { visualizePathStyle: { stroke: "#00ffff" } });
      }
    }
    return;
  }

  // Move to target room
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#00ffff");
  } else {
    // In target room - move to center for full visibility
    const center = new RoomPosition(25, 25, creep.room.name);
    if (!creep.pos.inRangeTo(center, 10)) {
      smartMoveTo(creep, center, { visualizePathStyle: { stroke: "#00ffff" } });
    }
  }
}

function recordRoomIntel(room: Room): void {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {} as RoomMemory;

  const mem = Memory.rooms[room.name];

  // Basic info
  mem.lastScan = Game.time;

  // Sources
  const sources = room.find(FIND_SOURCES);
  mem.sources = sources.map((s) => s.id);

  // Controller
  if (room.controller) {
    mem.controller = {
      owner: room.controller.owner?.username,
      level: room.controller.level,
      reservation: room.controller.reservation
        ? {
            username: room.controller.reservation.username,
            ticksToEnd: room.controller.reservation.ticksToEnd,
          }
        : undefined,
    };
  }

  // Threats
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  mem.hostiles = hostiles.length;

  mem.hasKeepers =
    room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_KEEPER_LAIR,
    }).length > 0;

  mem.hasInvaderCore =
    room.find(FIND_HOSTILE_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
    }).length > 0;
}

function findNextScoutTarget(creep: Creep): string | undefined {
  const homeRoom = creep.memory.room;
  const exits = Game.map.describeExits(homeRoom);

  if (!exits) return undefined;

  // Find adjacent rooms that haven't been scouted recently
  const candidates: string[] = [];

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const mem = Memory.rooms?.[roomName];
    const lastScan = mem?.lastScan || 0;

    // Scout if never scanned or >2000 ticks old
    if (Game.time - lastScan > 2000) {
      candidates.push(roomName);
    }
  }

  // Prefer rooms closer to home
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const distA = Game.map.getRoomLinearDistance(homeRoom, a);
      const distB = Game.map.getRoomLinearDistance(homeRoom, b);
      return distA - distB;
    });
    return candidates[0];
  }

  return undefined;
}
