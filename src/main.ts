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
import { LinkManager } from "./structures/LinkManager";
import { runCreep } from "./creeps/roles";
import { ColonyManager } from "./core/ColonyManager";
import { StatsCollector, EventType } from "./utils/StatsCollector";
import { AWSExporter } from "./utils/AWSExporter";
import { checkAutoSafeMode } from "./defense/AutoSafeMode";
import { TrafficMonitor } from "./core/TrafficMonitor";
import { SmartRoadPlanner } from "./core/SmartRoadPlanner";
import { RemoteContainerPlanner } from "./core/RemoteContainerPlanner";
import { RemoteSquadManager } from "./defense/RemoteSquadManager";

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

  // Export data to memory segment for AWS Lambda (every 20 ticks)
  if (Game.time % 20 === 0) {
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

  // 5. Run links (RCL 5+)
  if (room.controller && room.controller.level >= 5) {
    const linkManager = new LinkManager(room);
    linkManager.run();
  }

  // 6. Traffic monitoring - record every tick
  const trafficMonitor = new TrafficMonitor(room);
  trafficMonitor.recordTick();

  // Visualize traffic heatmap if debug flag is set
  if (Memory.debug?.showTraffic) {
    trafficMonitor.visualize();
  }

  // 7. Smart road planning - every 100 ticks
  if (Game.time % 100 === 0) {
    const roadPlanner = new SmartRoadPlanner(room);
    roadPlanner.run();
  }

  // 8. Remote container planning - every 100 ticks
  if (Game.time % 100 === 0) {
    const containerPlanner = new RemoteContainerPlanner(room);
    containerPlanner.run();
  }

  // 9. Remote squad management (RCL 4+)
  if (room.controller && room.controller.level >= 4) {
    const squadManager = new RemoteSquadManager(room);

    // Analyze threats in remote rooms and request squads
    const exits = Game.map.describeExits(room.name);
    if (exits) {
      for (const dir in exits) {
        const remoteName = exits[dir as ExitKey];
        if (!remoteName) continue;

        // Skip rooms we're not mining
        const intel = Memory.rooms?.[remoteName];
        if (!intel?.sources || intel.sources.length === 0) continue;
        if (intel.hasKeepers) continue;

        // Check for threats
        const threat = squadManager.analyzeThreat(remoteName);
        if (threat.recommendedSquadSize > 0) {
          squadManager.requestSquad(remoteName, threat.recommendedSquadSize);
        }
      }
    }

    // Cleanup dead members and timed out squads
    squadManager.cleanup();
  }
}

function runCreeps(): void {
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.spawning) continue;
    try {
      runCreep(creep);
    } catch (error) {
      const errMsg = error instanceof Error
        ? (error.stack || error.message)
        : String(error);
      console.log(`[ERROR] Creep ${name} (${creep.memory.role}): ${errMsg}`);
      StatsCollector.recordEvent(EventType.CREEP_DEATH, creep.room?.name || "unknown", {
        creep: name,
        role: creep.memory.role,
        error: errMsg,
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
