/**
 * Controller Attacker Role
 *
 * A specialized CLAIM creep that navigates to a target controller and attacks it.
 * Used in controller attack campaigns to downgrade hostile room controllers.
 *
 * Key mechanics:
 * - CLAIM creeps have 600-tick lifespan (not 1500)
 * - attackController() removes 300 × CLAIM_PARTS from ticksToDowngrade
 * - Applies 1000 ticks of upgradeBlocked to the controller
 * - One attack per 1000-tick window (controller-side cooldown)
 */

import { moveToRoom } from "../../utils/movement";
import { recordAttack } from "../MilitaryManager";

export interface ControllerAttackerMemory extends CreepMemory {
  role: "CONTROLLER_ATTACKER";
  room: string;
  targetRoom: string;
  campaignId: string;
  attackState: "TRAVELING" | "APPROACHING" | "ATTACKING" | "DONE";
  attacked: boolean;
}

export function runControllerAttacker(creep: Creep): void {
  var mem = creep.memory as ControllerAttackerMemory;

  // Already attacked - recycle or suicide
  if (mem.attacked) {
    if (creep.room.name === mem.room) {
      var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn && creep.pos.isNearTo(spawn)) {
        spawn.recycleCreep(creep);
        return;
      } else if (spawn) {
        creep.moveTo(spawn);
        creep.say("RECYCLE");
        return;
      }
    }
    // Not worth traveling home with 600 tick lifespan - just suicide
    creep.suicide();
    return;
  }

  // Not in target room - travel
  if (creep.room.name !== mem.targetRoom) {
    moveToRoom(creep, mem.targetRoom, "#ff0000", { avoidDanger: false });
    creep.say("->ATK");
    return;
  }

  // In target room - find controller
  var controller = creep.room.controller;
  if (!controller) {
    creep.say("ERR");
    return;
  }

  // Controller is neutral - we took it down, signal campaign
  if (!controller.owner) {
    mem.attackState = "DONE";
    creep.say("DOWN!");
    console.log("[Military] " + creep.name + ": Controller is neutral! Campaign objective achieved.");
    return;
  }

  // Safe mode active - nothing we can do
  if (controller.safeMode && controller.safeMode > 0) {
    creep.say("SAFE");
    // Move away to avoid wasting our short lifespan waiting
    return;
  }

  // Adjacent to controller - try to attack
  if (creep.pos.isNearTo(controller)) {
    var result = creep.attackController(controller);

    if (result === OK) {
      mem.attacked = true;
      creep.say("HIT!");
      console.log("[Military] " + creep.name + " attacked controller in " + mem.targetRoom +
        " (RCL " + controller.level + ", timer: " + controller.ticksToDowngrade + ")");

      // Record the attack in campaign state
      if (mem.campaignId) {
        recordAttack(mem.campaignId);
      }
    } else if (result === ERR_TIRED) {
      // upgradeBlocked still active, wait
      var blocked = controller.upgradeBlocked || 0;
      creep.say("WAIT " + blocked);
    } else {
      creep.say("E:" + result);
      console.log("[Military] " + creep.name + " attack failed: " + result);
    }
  } else {
    // Move to controller - use PathFinder directly to avoid base
    var goal = { pos: controller.pos, range: 1 };

    var ret = PathFinder.search(creep.pos, goal, {
      maxRooms: 1,
      roomCallback: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return new PathFinder.CostMatrix();

        var costs = new PathFinder.CostMatrix();

        // Avoid hostile creeps
        var hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
        for (var i = 0; i < hostileCreeps.length; i++) {
          var c = hostileCreeps[i];
          costs.set(c.pos.x, c.pos.y, 255);
        }

        // Avoid ramparts (can't walk through hostile ramparts)
        var hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);
        for (var j = 0; j < hostileStructures.length; j++) {
          var s = hostileStructures[j];
          if (s.structureType === STRUCTURE_RAMPART) {
            costs.set(s.pos.x, s.pos.y, 255);
          }
        }

        return costs;
      }
    });

    if (ret.path.length > 0) {
      creep.moveByPath(ret.path);
    }
    creep.say("->CTRL");
  }
}
