/**
 * Remote Intel Utilities - Shared functions for remote creep intel updates and threat response
 */

import { moveToRoom } from "./movement";

/**
 * Update room intel for the room the creep is in.
 * NOTE: This is now a no-op. Intel gathering is centralized in gatherRoomIntel()
 * which runs at the start of each tick for all visible rooms in main.ts.
 * This function is kept for backward compatibility with existing creep code.
 */
export function updateRoomIntel(_creep: Creep): void {
  // Intel is now gathered centrally in main.ts via gatherRoomIntel()
  // No action needed here
}

/**
 * Check if the creep should flee from hostiles.
 * Returns true if there are dangerous hostiles nearby OR if still fleeing from previous threat.
 */
export function shouldFlee(creep: Creep): boolean {
  const targetRoom = creep.memory.targetRoom;

  // If already fleeing, check if remote room is safe before clearing
  if ((creep.memory as any).isFleeing) {
    const remoteHostiles = getHostileCount(targetRoom || "");
    if (remoteHostiles > 0) {
      return true; // Stay in flee mode
    }
    // Room is safe, clear flee state
    (creep.memory as any).isFleeing = false;
    (creep.memory as any).fleeReason = null;
    return false;
  }

  // Not currently fleeing - check for new threats
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS, {
    filter: (h) =>
      h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0,
  });

  if (hostiles.length === 0) return false;

  // Flee if any hostile is within 8 tiles (increased from 6)
  const nearest = creep.pos.findClosestByRange(hostiles);
  if (nearest && creep.pos.getRangeTo(nearest) < 8) {
    (creep.memory as any).isFleeing = true;
    (creep.memory as any).fleeReason = `${nearest.owner.username} at range ${creep.pos.getRangeTo(nearest)}`;
    return true;
  }

  return false;
}

/**
 * Move creep to safety (home room) and wait there.
 * Call this when shouldFlee() returns true.
 */
export function fleeToSafety(creep: Creep): void {
  const homeRoom = creep.memory.room;
  const targetRoom = creep.memory.targetRoom;

  // If not in home room, go there
  if (creep.room.name !== homeRoom) {
    moveToRoom(creep, homeRoom, "#ff0000");
    creep.say("RUN");
    return;
  }

  // In home room - move away from border and wait
  const pos = creep.pos;
  const onBorder = pos.x <= 2 || pos.x >= 47 || pos.y <= 2 || pos.y >= 47;

  if (onBorder) {
    // Move toward room center
    const center = new RoomPosition(25, 25, homeRoom);
    creep.moveTo(center, {
      visualizePathStyle: { stroke: "#ff0000" },
      reusePath: 5,
    });
    creep.say("RUN");
    return;
  }

  // Safe position in home room - wait here
  // Check if remote room is safe yet
  const remoteHostiles = getHostileCount(targetRoom || "");
  if (remoteHostiles > 0) {
    creep.say(`W${remoteHostiles}`);
    // Stay put, don't clear flee state (shouldFlee handles that)
  } else {
    // Room is safe, shouldFlee will clear the flag next tick
    creep.say("OK");
  }
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

  // Fall back to Memory.intel
  const intel = Memory.intel && Memory.intel[roomName];
  if (intel) {
    return intel.hostiles || 0;
  }
  return 0;
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

  // Fall back to Memory.intel
  const intel = Memory.intel && Memory.intel[roomName];
  if (!intel) return false;

  // Check hostileDetails if available
  const details = intel.hostileDetails;
  if (details && details.length > 0) {
    return details.some((h) => h.hasCombat);
  }

  // If no details, assume any hostiles are dangerous
  return (intel.hostiles || 0) > 0;
}
