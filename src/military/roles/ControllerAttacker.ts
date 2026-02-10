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
import * as WaveCoordinator from "../WaveCoordinator";

export interface ControllerAttackerMemory extends CreepMemory {
  role: "CONTROLLER_ATTACKER";
  room: string;
  targetRoom: string;
  campaignId: string;
  attackState: "TRAVELING" | "APPROACHING" | "ATTACKING" | "DONE";
  attacked: boolean;
  approachRoom?: string;  // Route through this room before entering target
  waveId?: string;        // Wave coordination ID (if part of a wave)
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

  // === Wave Rally Check ===
  // If part of a wave, check if we should rally instead of proceeding
  if (mem.waveId) {
    var rallyPoint = WaveCoordinator.shouldRally(creep);
    if (rallyPoint) {
      // Wave not yet released - rally instead of attacking
      if (creep.room.name !== rallyPoint.room) {
        // Move to rally room
        moveToRoom(creep, rallyPoint.room, "#ffaa00", { avoidDanger: false });
        creep.say("RALLY");
        return;
      }

      // In rally room - move to rally position
      var dist = Math.max(
        Math.abs(creep.pos.x - rallyPoint.x),
        Math.abs(creep.pos.y - rallyPoint.y)
      );

      if (dist > 5) {
        creep.moveTo(rallyPoint.x, rallyPoint.y, {
          visualizePathStyle: { stroke: "#ffaa00" },
          reusePath: 5,
        });
        creep.say("→RALLY");
      } else {
        // At rally point - wait for release
        creep.say("READY");
      }
      return;
    }
    // Wave has been released - continue to target
  }

  // === Cross-room movement ===
  if (creep.room.name !== mem.targetRoom) {
    // If we have an approach room, route through it first
    if (mem.approachRoom && creep.room.name !== mem.approachRoom) {
      // Haven't reached the approach room yet — go there first
      moveToRoom(creep, mem.approachRoom, "#ff0000", { avoidDanger: false });
      creep.say("→" + mem.approachRoom.substring(0, 4));
      return;
    }

    // Either no approach room, or we're in the approach room
    // Now move to target room (will enter from the correct side)
    moveToRoom(creep, mem.targetRoom, "#ff0000", { avoidDanger: false });
    creep.say("→" + mem.targetRoom.substring(0, 4));
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
        recordAttack(mem.campaignId, controller.level, controller.ticksToDowngrade || 0);
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

        // Find hostile structures
        var hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);

        // Avoid ramparts (can't walk through hostile ramparts)
        for (var j = 0; j < hostileStructures.length; j++) {
          var s = hostileStructures[j];
          if (s.structureType === STRUCTURE_RAMPART) {
            costs.set(s.pos.x, s.pos.y, 255);
          }
        }

        // Add tower avoidance - prefer paths that stay out of tower range
        // Tower damage: 600 at range 5, drops linearly to 150 at range 20
        for (var k = 0; k < hostileStructures.length; k++) {
          var struct = hostileStructures[k];
          if (struct.structureType !== STRUCTURE_TOWER) continue;

          var tower = struct as StructureTower;
          // Only avoid towers with energy (drained towers are safe)
          if (tower.store[RESOURCE_ENERGY] < 10) continue;

          // Add cost based on tower range
          // Range 5 or less = max damage zone, avoid heavily
          // Range 6-20 = decreasing damage
          for (var dx = -20; dx <= 20; dx++) {
            for (var dy = -20; dy <= 20; dy++) {
              var tx = tower.pos.x + dx;
              var ty = tower.pos.y + dy;
              if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;

              var range = Math.max(Math.abs(dx), Math.abs(dy));
              if (range > 20) continue;

              var existingCost = costs.get(tx, ty);
              if (existingCost === 255) continue; // Already blocked

              // Cost scaling: range 5 or less = +30, decreases with range
              var addedCost = 0;
              if (range <= 5) {
                addedCost = 30; // Max damage zone
              } else if (range <= 10) {
                addedCost = 20;
              } else if (range <= 15) {
                addedCost = 10;
              } else {
                addedCost = 5;
              }

              var newCost = Math.min(existingCost + addedCost, 254);
              costs.set(tx, ty, newCost);
            }
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
