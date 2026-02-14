/**
 * HostileBotGenerator - Generate enemy bot code for combat scenarios
 *
 * Creates minimal bot code that simulates various hostile behaviors:
 * - Invaders (attack creeps, then structures)
 * - Harassers (hit and run)
 * - Defenders (protect structures)
 * - Siegers (systematic destruction)
 */

import { HostileBehavior, HostileBotConfig } from "../types";
import {
  BodyPartType,
  ATTACK,
  RANGED_ATTACK,
  HEAL,
  MOVE,
  TOUGH,
  WORK,
  CARRY,
} from "../constants";

/**
 * Generate JavaScript code for a hostile bot
 */
export function generateHostileBotCode(config: HostileBotConfig): Record<string, string> {
  const { behavior, bodies = [] } = config;

  const spawnQueueCode = generateSpawnQueue(bodies);
  const behaviorCode = generateBehaviorCode(behavior);

  const code = `
'use strict';

module.exports.loop = function() {
  // Hostile Bot: ${config.username}
  // Mode: ${behavior.mode}
  // Target: ${behavior.targetRoom || 'local'}

  const spawnQueue = ${spawnQueueCode};

  // Run towers
  for (const name in Game.structures) {
    const struct = Game.structures[name];
    if (struct.structureType === 'tower') {
      ${generateTowerCode(behavior)}
    }
  }

  // Run spawns
  for (const name in Game.spawns) {
    const spawn = Game.spawns[name];
    if (!spawn.spawning && spawnQueue.length > 0) {
      const body = spawnQueue[Game.time % spawnQueue.length];
      const creepName = 'hostile_' + Game.time;
      const result = spawn.spawnCreep(body, creepName, {
        memory: { role: 'hostile', target: '${behavior.targetRoom || ""}' }
      });
    }
  }

  // Run creeps
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    ${behaviorCode}
  }
};
`;

  return { main: code };
}

/**
 * Generate the spawn queue array
 */
function generateSpawnQueue(bodies: BodyPartType[][]): string {
  if (bodies.length === 0) {
    // Default invader body
    return `[['tough', 'tough', 'attack', 'attack', 'move', 'move', 'move', 'move']]`;
  }

  const bodiesStr = bodies
    .map((body) => `[${body.map((p) => `'${p}'`).join(", ")}]`)
    .join(",\n    ");

  return `[\n    ${bodiesStr}\n  ]`;
}

/**
 * Generate tower behavior code
 */
function generateTowerCode(behavior: HostileBehavior): string {
  if (!behavior.useTowers) {
    return "// Towers disabled";
  }

  switch (behavior.mode) {
    case "attack":
    case "harass":
      return `
        const hostile = struct.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (hostile) {
          struct.attack(hostile);
        } else if (${behavior.repairStructures || false}) {
          const damaged = struct.pos.findClosestByRange(FIND_MY_STRUCTURES, {
            filter: s => s.hits < s.hitsMax
          });
          if (damaged) struct.repair(damaged);
        }
      `;

    case "defend":
      return `
        const hostile = struct.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (hostile) {
          struct.attack(hostile);
        } else {
          const damaged = struct.pos.findClosestByRange(FIND_MY_STRUCTURES, {
            filter: s => s.hits < s.hitsMax * 0.8
          });
          if (damaged) struct.repair(damaged);
        }
      `;

    default:
      return "// Passive towers";
  }
}

/**
 * Generate creep behavior code
 */
function generateBehaviorCode(behavior: HostileBehavior): string {
  const targetRoom = behavior.targetRoom || "";
  const retreatThreshold = behavior.retreatThreshold || 0.3;

  const baseCode = `
    // Check retreat
    if (creep.hits < creep.hitsMax * ${retreatThreshold}) {
      const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn) {
        creep.moveTo(spawn);
        return;
      }
    }
  `;

  switch (behavior.mode) {
    case "attack":
      return `
    ${baseCode}

    // Move to target room if specified
    ${
      targetRoom
        ? `
    if (creep.room.name !== '${targetRoom}') {
      const exitDir = creep.room.findExitTo('${targetRoom}');
      const exit = creep.pos.findClosestByRange(exitDir);
      if (exit) creep.moveTo(exit);
      return;
    }
    `
        : ""
    }

    // Attack priority: creeps > spawns > other structures
    const hostileCreep = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (hostileCreep) {
      if (creep.attack(hostileCreep) === ERR_NOT_IN_RANGE) {
        creep.moveTo(hostileCreep);
      }
      if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        creep.rangedAttack(hostileCreep);
      }
      return;
    }

    const spawn = creep.pos.findClosestByRange(FIND_HOSTILE_SPAWNS);
    if (spawn) {
      if (creep.attack(spawn) === ERR_NOT_IN_RANGE) {
        creep.moveTo(spawn);
      }
      return;
    }

    const structure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
      filter: s => s.structureType !== 'controller'
    });
    if (structure) {
      if (creep.attack(structure) === ERR_NOT_IN_RANGE) {
        creep.moveTo(structure);
      }
    }
      `;

    case "harass":
      return `
    ${baseCode}

    // Move to target room if specified
    ${
      targetRoom
        ? `
    if (creep.room.name !== '${targetRoom}') {
      const exitDir = creep.room.findExitTo('${targetRoom}');
      const exit = creep.pos.findClosestByRange(exitDir);
      if (exit) creep.moveTo(exit);
      return;
    }
    `
        : ""
    }

    // Harass: attack workers, flee from defenders
    const defender = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
      filter: c => c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0
    });

    if (defender && creep.pos.getRangeTo(defender) < 4) {
      // Flee from defenders
      const path = PathFinder.search(creep.pos, { pos: defender.pos, range: 6 }, { flee: true });
      if (path.path.length > 0) {
        creep.moveByPath(path.path);
      }
      return;
    }

    // Target workers
    const worker = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
      filter: c => c.getActiveBodyparts(WORK) > 0 || c.getActiveBodyparts(CARRY) > 0
    });

    if (worker) {
      if (creep.attack(worker) === ERR_NOT_IN_RANGE) {
        creep.moveTo(worker);
      }
      if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        creep.rangedAttack(worker);
      }
    }
      `;

    case "defend":
      return `
    // Stay near spawn
    const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (spawn && creep.pos.getRangeTo(spawn) > 5) {
      creep.moveTo(spawn);
      return;
    }

    // Attack nearby hostiles
    const hostile = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (hostile) {
      if (creep.attack(hostile) === ERR_NOT_IN_RANGE) {
        creep.moveTo(hostile);
      }
      if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        creep.rangedAttack(hostile);
      }
    }
      `;

    case "siege":
      return `
    ${baseCode}

    // Move to target room if specified
    ${
      targetRoom
        ? `
    if (creep.room.name !== '${targetRoom}') {
      const exitDir = creep.room.findExitTo('${targetRoom}');
      const exit = creep.pos.findClosestByRange(exitDir);
      if (exit) creep.moveTo(exit);
      return;
    }
    `
        : ""
    }

    // Siege: systematically destroy structures
    const targets = [
      FIND_HOSTILE_SPAWNS,
      FIND_HOSTILE_STRUCTURES
    ];

    for (const findType of targets) {
      const target = creep.pos.findClosestByRange(findType, {
        filter: s => s.structureType !== 'controller' && s.structureType !== 'rampart'
      });
      if (target) {
        if (creep.attack(target) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target);
        }
        return;
      }
    }
      `;

    case "passive":
    default:
      return `
    // Passive - do nothing
      `;
  }
}

// ============================================
// Predefined Bot Patterns
// ============================================

/**
 * Generate an invader bot that attacks creeps and structures
 */
export function generateInvaderBot(targetRoom: string): Record<string, string> {
  return generateHostileBotCode({
    username: "Invader",
    room: targetRoom,
    behavior: {
      mode: "attack",
      primaryTarget: "creeps",
      targetRoom,
      retreatThreshold: 0.2,
    },
    bodies: [
      [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      [TOUGH, TOUGH, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE],
    ],
  });
}

/**
 * Generate a Bazsi-style harasser bot
 */
export function generateHarasserBot(targetRoom: string): Record<string, string> {
  return generateHostileBotCode({
    username: "Harasser",
    room: targetRoom,
    behavior: {
      mode: "harass",
      primaryTarget: "creeps",
      targetRoom,
      retreatThreshold: 0.4,
    },
    bodies: [
      [TOUGH, MOVE, MOVE, ATTACK, ATTACK, MOVE, MOVE],
      [MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK, HEAL, MOVE, MOVE],
    ],
  });
}

/**
 * Generate a defender bot that protects its structures
 */
export function generateDefenderBot(): Record<string, string> {
  return generateHostileBotCode({
    username: "Defender",
    room: "W0N0", // Will be overridden
    behavior: {
      mode: "defend",
      useTowers: true,
      repairStructures: true,
    },
    bodies: [
      [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE],
    ],
  });
}

/**
 * Generate a siege bot for systematic destruction
 */
export function generateSiegeBot(targetRoom: string): Record<string, string> {
  return generateHostileBotCode({
    username: "Sieger",
    room: targetRoom,
    behavior: {
      mode: "siege",
      targetRoom,
      retreatThreshold: 0.15,
    },
    bodies: [
      [TOUGH, TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    ],
  });
}
