/**
 * Debug script to inspect room state after setup
 */

import { ServerController } from "./src/server/ServerController";
import { WorldBuilder } from "./src/server/WorldBuilder";
import { BotDeployer, createDefaultDeployer } from "./src/deployment/BotDeployer";
import { STRUCTURE_SPAWN, STRUCTURE_STORAGE } from "./src/constants";

async function debugState() {
  console.log("Starting debug inspection...\n");

  const server = new ServerController({ logConsole: true });
  const deployer = createDefaultDeployer();

  try {
    // 1. Initialize server
    console.log("Initializing server...");
    await server.initialize();
    console.log("Server initialized.\n");

    // 2. Reset world
    await server.reset();

    // 3. Set up a simple room like economic-recovery
    const world = new WorldBuilder(server);
    const room = world.addRoom("W0N1");

    room.addController(25, 40, 5, "TestBot");
    room.addSource(11, 35, 3000);
    room.addSource(38, 12, 3000);
    room.addMineral(40, 40, "H", 3);

    // Add spawn
    room.addStructure({
      type: STRUCTURE_SPAWN,
      x: 25,
      y: 25,
      owner: "TestBot",
      energy: 300,
    });

    // Add storage
    room.addStructure({
      type: STRUCTURE_STORAGE,
      x: 26,
      y: 25,
      owner: "TestBot",
      store: { energy: 50000 },
    });

    await world.build();
    console.log("Room built.\n");

    // 4. Inspect room state BEFORE bot deployment
    console.log("=== Room state BEFORE bot deployment ===");
    const objectsBefore = await server.getRoomObjects("W0N1");

    const controllerBefore = objectsBefore.find((o) => o.type === "controller");
    console.log("Controller:", JSON.stringify(controllerBefore, null, 2));

    const spawnsBefore = objectsBefore.filter((o) => o.type === "spawn");
    console.log("Spawns:", JSON.stringify(spawnsBefore, null, 2));

    // 5. Deploy the bot
    console.log("\n=== Deploying bot ===");
    await deployer.deployTo(server, "TestBot", "W0N1", {
      gcl: 2,
      cpu: 100,
      cpuAvailable: 10000,
      position: { x: 25, y: 25 },
    });
    console.log("Bot deployed.\n");

    // 6. Inspect room state AFTER bot deployment
    console.log("=== Room state AFTER bot deployment ===");
    const objectsAfter = await server.getRoomObjects("W0N1");

    const controllerAfter = objectsAfter.find((o) => o.type === "controller");
    console.log("Controller:", JSON.stringify(controllerAfter, null, 2));

    const spawnsAfter = objectsAfter.filter((o) => o.type === "spawn");
    console.log("Spawns:", JSON.stringify(spawnsAfter, null, 2));

    // 7. Check user database
    console.log("\n=== User database ===");
    const db = (server as any).db;
    if (db) {
      const users = await db.users.find({});
      console.log("Users:", JSON.stringify(users, null, 2));
    }

    // 8. Run a tick and check for spawning
    console.log("\n=== Running 10 ticks ===");
    await server.tick(10);

    const stateAfterTicks = await server.getGameState();
    const roomState = stateAfterTicks.rooms.get("W0N1");

    console.log("Creeps after 10 ticks:", roomState?.creeps.length || 0);
    if (roomState?.creeps.length) {
      console.log("Creeps:", JSON.stringify(roomState.creeps, null, 2));
    }

    // Check console logs
    const logs = server.getConsoleLogs("TestBot");
    if (logs.length) {
      console.log("\n=== Console logs ===");
      for (const log of logs.slice(0, 20)) {
        console.log(`  ${log}`);
      }
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await server.shutdown();
    console.log("\nServer stopped.");
  }
}

debugState().catch(console.error);
