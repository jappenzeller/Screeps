/**
 * Remote Intel Utilities - Shared functions for remote creep intel updates and threat response
 */

import { moveToRoom } from "./movement";

/**
 * Update room intel for the room the creep is in.
 * Should be called at the start of every remote creep's run function.
 */
export function updateRoomIntel(creep: Creep): void {
  const room = creep.room;
  if (!room) return;

  // Initialize memory if needed
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) {
    Memory.rooms[room.name] = {} as RoomMemory;
  }

  const intel = Memory.rooms[room.name];

  // Update hostile count
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  intel.hostiles = hostiles.length;
  intel.lastScan = Game.time;

  // Store hostile details for defense decisions
  if (hostiles.length > 0) {
    (intel as any).hostileDetails = hostiles.map((h) => ({
      id: h.id,
      owner: h.owner.username,
      pos: { x: h.pos.x, y: h.pos.y },
      bodyParts: h.body.length,
      hasCombat:
        h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0,
    }));
  } else {
    delete (intel as any).hostileDetails;
  }

  // Also check for invader cores
  const invaderCores = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_INVADER_CORE,
  });
  intel.hasInvaderCore = invaderCores.length > 0;
}

/**
 * Check if the creep should flee from hostiles.
 * Returns true if there are dangerous hostiles nearby.
 */
export function shouldFlee(creep: Creep): boolean {
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: (h) =>
      h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0,
  });

  if (hostiles.length === 0) return false;

  // Flee if any hostile is within 6 tiles
  const nearest = creep.pos.findClosestByRange(hostiles);
  if (nearest && creep.pos.getRangeTo(nearest) < 6) {
    (creep.memory as any).isFleeing = true;
    (creep.memory as any).fleeReason = `${nearest.owner.username} at range ${creep.pos.getRangeTo(nearest)}`;
    return true;
  }

  return false;
}

/**
 * Move creep to safety (home room).
 * Call this when shouldFlee() returns true.
 */
export function fleeToSafety(creep: Creep): void {
  const homeRoom = creep.memory.room;

  // If already in home room, clear flee state
  if (creep.room.name === homeRoom) {
    (creep.memory as any).isFleeing = false;
    (creep.memory as any).fleeReason = null;
    return;
  }

  // Move toward home room
  moveToRoom(creep, homeRoom, "#ff0000");
  creep.say("🏃");
}

/**
 * Get hostile count for a room, preferring live vision over memory.
 */
export function getHostileCount(roomName: string): number {
  // If we have vision, use live data
  const room = Game.rooms[roomName];
  if (room) {
    return room.find(FIND_HOSTILE_CREEPS).length;
  }

  // Fall back to memory intel
  return Memory.rooms?.[roomName]?.hostiles || 0;
}

/**
 * Check if room has dangerous hostiles (with attack parts).
 */
export function hasDangerousHostiles(roomName: string): boolean {
  // If we have vision, use live data
  const room = Game.rooms[roomName];
  if (room) {
    const dangerous = room.find(FIND_HOSTILE_CREEPS, {
      filter: (h) =>
        h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0,
    });
    return dangerous.length > 0;
  }

  // Fall back to memory intel - check hostileDetails if available
  const intel = Memory.rooms?.[roomName];
  if (!intel) return false;

  const details = (intel as any).hostileDetails;
  if (details && Array.isArray(details)) {
    return details.some((h: any) => h.hasCombat);
  }

  // If no details, assume any hostiles are dangerous
  return (intel.hostiles || 0) > 0;
}
