import { CONFIG } from "./config";
import { logger } from "./utils/Logger";
import { registerConsoleCommands } from "./utils/Console";
import { MemoryManager } from "./core/MemoryManager";
import { Colony } from "./core/Colony";
import { Spawner } from "./core/Spawner";
import { RoadPlanner } from "./core/RoadPlanner";
import { ContainerPlanner } from "./structures/ContainerPlanner";
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
  const cpuStart = Game.cpu.getUsed();

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

    // Scan the room and update state
    const state = colony.scan();
    if (!state) continue;

    // Run spawner
    const spawner = new Spawner(colony);
    spawner.run(state);

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

    // Draw visuals
    colony.drawVisuals();
  }

  // Run all creeps
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    try {
      runCreep(creep);
    } catch (error) {
      logger.error("Main", `Error running creep ${name}:`, error);
    }
  }

  // Record stats
  MemoryManager.recordStats();

  // Log CPU usage periodically
  if (Game.time % 10 === 0) {
    const cpuUsed = Game.cpu.getUsed() - cpuStart;
    logger.debug(
      "Main",
      `Tick ${Game.time} | CPU: ${cpuUsed.toFixed(2)} | Bucket: ${Game.cpu.bucket}`
    );
  }
}
