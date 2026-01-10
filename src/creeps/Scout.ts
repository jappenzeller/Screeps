import { logger } from "../utils/Logger";

/**
 * Scout - Explores adjacent rooms and records intel
 * Stores room data in Memory.rooms for expansion planning
 */
export function runScout(creep: Creep): void {
  // Get target room from memory or find new one
  let targetRoom = creep.memory.targetRoom;

  if (!targetRoom || creep.room.name === targetRoom) {
    // Record intel for current room
    recordRoomIntel(creep.room);

    // Find next room to scout
    targetRoom = findNextScoutTarget(creep);
    creep.memory.targetRoom = targetRoom;
  }

  if (!targetRoom) {
    // No rooms to scout - return home
    const homeRoom = creep.memory.room;
    if (creep.room.name !== homeRoom) {
      const exitDir = creep.room.findExitTo(homeRoom);
      if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
        const exit = creep.pos.findClosestByPath(exitDir);
        if (exit) {
          creep.moveTo(exit, { visualizePathStyle: { stroke: "#00ffff" } });
        }
      }
    }
    return;
  }

  // Move to target room
  if (creep.room.name !== targetRoom) {
    const exitDir = creep.room.findExitTo(targetRoom);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      const exit = creep.pos.findClosestByPath(exitDir);
      if (exit) {
        creep.moveTo(exit, { visualizePathStyle: { stroke: "#00ffff" } });
      }
    }
  } else {
    // In target room - explore it
    recordRoomIntel(creep.room);

    // Move to center to get full visibility
    const center = new RoomPosition(25, 25, creep.room.name);
    if (!creep.pos.inRangeTo(center, 10)) {
      creep.moveTo(center, { visualizePathStyle: { stroke: "#00ffff" } });
    }
  }
}

function recordRoomIntel(room: Room): void {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};

  const intel = Memory.rooms[room.name];
  intel.lastScan = Game.time;

  // Record sources
  const sources = room.find(FIND_SOURCES);
  intel.sources = sources.map((s) => s.id);

  // Record controller info
  if (room.controller) {
    intel.controller = {
      owner: room.controller.owner ? room.controller.owner.username : undefined,
      level: room.controller.level,
      reservation: room.controller.reservation
        ? {
            username: room.controller.reservation.username,
            ticksToEnd: room.controller.reservation.ticksToEnd,
          }
        : undefined,
    };
  }

  // Record hostiles
  intel.hostiles = room.find(FIND_HOSTILE_CREEPS).length;

  // Record structures of interest
  const structures = room.find(FIND_STRUCTURES);
  intel.hasKeepers = structures.some((s) => s.structureType === STRUCTURE_KEEPER_LAIR);
  intel.hasInvaderCore = structures.some((s) => s.structureType === STRUCTURE_INVADER_CORE);

  logger.debug("Scout", `Recorded intel for ${room.name}: ${sources.length} sources`);
}

function findNextScoutTarget(creep: Creep): string | undefined {
  const homeRoom = creep.memory.room;
  const exits = Game.map.describeExits(creep.room.name);

  if (!exits) return undefined;

  // Find rooms we haven't scouted recently
  const candidates: string[] = [];

  for (const dir in exits) {
    const roomName = exits[dir as ExitKey];
    if (!roomName) continue;

    const intel = Memory.rooms ? Memory.rooms[roomName] : undefined;

    // Scout if never visited or data is old (>1000 ticks)
    if (!intel || !intel.lastScan || Game.time - intel.lastScan > 1000) {
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

// Extend memory types for scout intel
declare global {
  interface RoomMemory {
    controller?: {
      owner?: string;
      level: number;
      reservation?: {
        username: string;
        ticksToEnd: number;
      };
    };
    hasKeepers?: boolean;
    hasInvaderCore?: boolean;
  }

  interface CreepMemory {
    targetRoom?: string;
  }
}
