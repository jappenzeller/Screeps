import { CONFIG } from "./config";
import { logger } from "./utils/Logger";
import { registerConsoleCommands } from "./utils/Console";
import { StatsCollector } from "./utils/StatsCollector";
import { MemoryManager } from "./core/MemoryManager";
import { Colony } from "./core/Colony";
import { Spawner } from "./core/Spawner";
import { RoadPlanner } from "./core/RoadPlanner";
import { ContainerPlanner } from "./structures/ContainerPlanner";
import { TowerManager } from "./structures/TowerManager";
import { LinkManager } from "./structures/LinkManager";
import { CPUBudget } from "./core/CPUBudget";
import { ColonyStateManager } from "./core/ColonyState";
import { TaskManager } from "./core/TaskManager";
import { FailureRecovery } from "./core/FailureRecovery";
import { runCreep } from "./creeps/roles";

// Screeps global object for persistent state
declare const global: {
  [key: string]: unknown;
  _initialized?: boolean;
  colonies?: Map<string, Colony>;
};

// One-time initialization (survives global resets within same tick)
if (!global._initialized) {
  logger.setLevel(CONFIG.LOG_LEVEL);
  registerConsoleCommands();
  global.colonies = new Map();
  global._initialized = true;
}

// Colony instances (stored on global to survive module re-execution)
const colonies = global.colonies as Map<string, Colony>;

/**
 * Main game loop - runs every tick
 */
export function loop(): void {
  // Start CPU tracking
  CPUBudget.startTick();

  // Start stats collection for this tick
  StatsCollector.startTick();

  // Initialize memory on first run
  MemoryManager.init();

  // Clean up dead creep memory
  MemoryManager.cleanup();

  // Process each owned room as a colony
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];

    // Only manage rooms we own
    if (!room.controller?.my) continue;

    // Get or create colony for this room
    let colony = colonies.get(roomName);
    if (!colony) {
      logger.info("Main", `Initializing colony in ${roomName}`);
      colony = new Colony(roomName);
      colonies.set(roomName, colony);
    }

    // Get centralized state (uses tiered caching)
    const cpuStateStart = Game.cpu.getUsed();
    const state = ColonyStateManager.getState(roomName);
    CPUBudget.trackSystem("colonyState", cpuStateStart);

    if (!state) continue;

    // Check for emergency conditions and handle recovery
    const cpuRecoveryStart = Game.cpu.getUsed();
    const emergencyHandled = FailureRecovery.check(state);
    CPUBudget.trackSystem("other", cpuRecoveryStart);

    // Generate tasks for this room
    const cpuTasksStart = Game.cpu.getUsed();
    TaskManager.generateTasks(state);
    CPUBudget.trackSystem("tasks", cpuTasksStart);

    // Run spawner (unless emergency was just handled)
    if (!emergencyHandled) {
      const cpuSpawnerStart = Game.cpu.getUsed();
      const spawner = new Spawner(colony);
      spawner.run(state);
      CPUBudget.trackSystem("spawner", cpuSpawnerStart);
    }

    // Run tower defense (every tick - critical for defense)
    const cpuTowersStart = Game.cpu.getUsed();
    const towerManager = new TowerManager(room);
    towerManager.run();
    CPUBudget.trackSystem("towers", cpuTowersStart);

    // Run link transfers (RCL 5+)
    if (room.controller && room.controller.level >= 5) {
      const linkManager = new LinkManager(room);
      linkManager.run();
    }

    // Skip non-essential operations if bucket is low
    if (CPUBudget.canRunExpensive()) {
      // Plan containers (every 20 ticks at RCL 2+)
      if (Game.time % 20 === 0) {
        const containerPlanner = new ContainerPlanner(room);
        containerPlanner.run();
      }

      // Plan roads periodically (every 50 ticks)
      if (Game.time % 50 === 0) {
        const roadPlanner = new RoadPlanner(room);
        roadPlanner.run();
      }
    }

    // Draw visuals
    colony.drawVisuals();
  }

  // Run all creeps (with CPU limiting if bucket is low)
  const cpuCreepsStart = Game.cpu.getUsed();
  const creepLimit = CPUBudget.getCreepLimit();
  let creepsProcessed = 0;

  for (const name in Game.creeps) {
    if (creepsProcessed >= creepLimit) {
      logger.debug("Main", `Skipped ${Object.keys(Game.creeps).length - creepsProcessed} creeps due to CPU limit`);
      break;
    }

    const creep = Game.creeps[name];
    try {
      runCreep(creep);
    } catch (error) {
      logger.error("Main", `Error running creep ${name}:`, error);
    }
    creepsProcessed++;
  }
  CPUBudget.trackSystem("creeps", cpuCreepsStart);

  // Finalize stats collection for this tick
  StatsCollector.endTick();

  // End CPU tracking
  CPUBudget.endTick();

  // Log CPU usage periodically
  if (Game.time % 10 === 0) {
    logger.debug(
      "Main",
      `Tick ${Game.time} | CPU: ${CPUBudget.getCurrentTickCPU().toFixed(2)} | ` +
        `Avg: ${CPUBudget.getAverageCPU().toFixed(2)} | Bucket: ${Game.cpu.bucket}`
    );
  }
}
