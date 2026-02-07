import { moveToRoom } from "../utils/movement";

/**
 * Check if a position is on a room border.
 */
function isOnBorder(pos: RoomPosition): boolean {
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

/**
 * Move to target using PathFinder with maxRooms:1 to avoid border bounce issues.
 */
function moveInRoomSafe(creep: Creep, target: RoomPosition): void {
  const result = PathFinder.search(creep.pos, { pos: target, range: 1 }, {
    maxRooms: 1,
  });

  if (result.path.length > 0) {
    creep.room.visual.poly(result.path.map(p => [p.x, p.y]), { stroke: "#ff00ff" });
    creep.moveByPath(result.path);
  } else {
    // Fallback to regular moveTo with maxRooms:1
    creep.moveTo(target, { reusePath: 10, maxRooms: 1 });
  }
}

/**
 * Claimer - Claims controllers in target rooms for expansion
 * Uses safe pathfinding by default (avoids Source Keeper and hostile rooms).
 * Handles border tile edge cases to prevent bouncing back out.
 */
export function runClaimer(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;

  if (!targetRoom) {
    console.log(`${creep.name}: No target room assigned`);
    return;
  }

  // Not in target room yet - moveToRoom uses safe pathfinding by default
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ff00ff");
    return;
  }

  // In target room - find controller
  const controller = creep.room.controller;
  if (!controller) {
    console.log(`${creep.name}: No controller in ${targetRoom}!`);
    return;
  }

  // If reserved by enemy, attack to clear reservation
  if (controller.reservation && controller.reservation.username !== creep.owner.username) {
    if (creep.attackController(controller) === ERR_NOT_IN_RANGE) {
      // Use safe in-room movement if on border
      if (isOnBorder(creep.pos)) {
        moveInRoomSafe(creep, controller.pos);
      } else {
        creep.moveTo(controller, { reusePath: 10, maxRooms: 1 });
      }
    }
    return;
  }

  // If owned by enemy (shouldn't happen for our targets)
  if (controller.owner && !controller.my) {
    console.log(`${creep.name}: ${targetRoom} is owned by ${controller.owner.username}!`);
    return;
  }

  // Claim it
  const result = creep.claimController(controller);

  if (result === ERR_NOT_IN_RANGE) {
    // Use safe in-room movement if on border to avoid bounce-back
    if (isOnBorder(creep.pos)) {
      moveInRoomSafe(creep, controller.pos);
    } else {
      creep.moveTo(controller, { reusePath: 10, maxRooms: 1 });
    }
  } else if (result === ERR_GCL_NOT_ENOUGH) {
    console.log(`${creep.name}: GCL too low to claim ${targetRoom}`);
  } else if (result === OK) {
    console.log(`CLAIMED ${targetRoom}!`);

    // Update expansion state in Memory.empire.expansion
    if (Memory.empire && Memory.empire.expansion && Memory.empire.expansion.active) {
      var expansionState = Memory.empire.expansion.active[targetRoom];
      if (expansionState) {
        expansionState.state = "BOOTSTRAPPING";
        expansionState.stateChangedAt = Game.time;
        expansionState.claimer = null; // Claimer done
        console.log("[Claimer] Transitioned " + targetRoom + " to BOOTSTRAPPING state");
      }
    }
  }
}
