/**
 * Main game loop - Simple, working code.
 * Phase 0/1 implementation per docs/00_IMPLEMENTATION_PLAN.md
 */

import { logger } from "./utils/Logger";
import { CONFIG } from "./config";
import { registerConsoleCommands } from "./utils/Console";
import { placeStructures } from "./structures/placeStructures";
import { spawnCreeps } from "./spawning/spawnCreeps";
import { TowerManager } from "./structures/TowerManager";
import { runCreep } from "./creeps/roles";
import { ColonyManager } from "./core/ColonyManager";
import { StatsCollector, EventType } from "./utils/StatsCollector";
import { AWSExporter } from "./utils/AWSExporter";
import { checkAutoSafeMode } from "./defense/AutoSafeMode";

// One-time initialization
declare const global: { [key: string]: unknown };

if (!global._initialized) {
  logger.setLevel(CONFIG.LOG_LEVEL);
  registerConsoleCommands();
  global._initialized = true;
  console.log("=== Screeps Bot Initialized ===");
}

/**
 * Main game loop - runs every tick
 */
export function loop(): void {
  // Start stats tracking for this tick
  StatsCollector.startTick();

  // Clean up dead creep memory
  cleanupMemory();

  // Process each owned room
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    runRoom(room);
  }

  // Run all creeps
  runCreeps();

  // Log status every 100 ticks
  if (Game.time % 100 === 0) {
    logStatus();
  }

  // Export data to memory segment for AWS Lambda (every 100 ticks)
  if (Game.time % 100 === 0) {
    AWSExporter.export();
  }

  // End stats tracking for this tick
  StatsCollector.endTick();
}

function runRoom(room: Room): void {
  // 0. Check auto safe mode (defense emergency)
  checkAutoSafeMode(room);

  // 1. Run ColonyManager to generate/refresh tasks
  const manager = ColonyManager.getInstance(room.name);
  manager.run();

  // 2. Place construction sites (simple, direct)
  placeStructures(room);

  // 3. Spawn creeps
  spawnCreeps(room);

  // 4. Run towers
  const towerManager = new TowerManager(room);
  towerManager.run();
}

function runCreeps(): void {
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    try {
      runCreep(creep);
    } catch (error) {
      logger.error("Main", `Error running creep ${name}:`, error);
      StatsCollector.recordEvent(EventType.CREEP_DEATH, creep.room?.name || "unknown", {
        creep: name,
        role: creep.memory.role,
        error: String(error),
        type: "ERROR",
      });
    }
  }
}

function cleanupMemory(): void {
  // Dead creep cleanup - EVERY tick (it's cheap)
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  }

  // Room memory cleanup - less frequent
  if (Game.time % 100 === 0) {
    for (const roomName in Memory.rooms) {
      // Clean up task references to dead creeps
      const roomMem = Memory.rooms[roomName];
      if (roomMem.tasks) {
        for (const task of roomMem.tasks) {
          if (task.assignedCreep && !Game.creeps[task.assignedCreep]) {
            task.assignedCreep = null;
          }
        }
      }
    }
  }
}

function logStatus(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    const rcl = room.controller.level;
    const progress = Math.floor((room.controller.progress / room.controller.progressTotal) * 100);
    const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === roomName);
    const sites = room.find(FIND_CONSTRUCTION_SITES).length;

    // Count by role
    const roles: Record<string, number> = {};
    for (const c of creeps) {
      const role = c.memory.role || "UNKNOWN";
      roles[role] = (roles[role] || 0) + 1;
    }

    console.log(
      `[${roomName}] RCL ${rcl} (${progress}%) | Energy: ${room.energyAvailable}/${room.energyCapacityAvailable} | Sites: ${sites}`
    );
    console.log(`  Creeps: ${JSON.stringify(roles)}`);
  }
}
