/**
 * Economic Recovery Scenario
 *
 * Tests the bot's ability to recover from a full wipe:
 * - Zero creeps
 * - Storage with energy
 * - Must bootstrap back to stable economy
 */

import { ScenarioConfig } from "../src/types";
import {
  STRUCTURE_SPAWN,
  STRUCTURE_STORAGE,
  STRUCTURE_EXTENSION,
  STRUCTURE_CONTAINER,
  STRUCTURE_TOWER,
} from "../src/constants";
import { generateExtensionCluster } from "../src/utils/scenarioHelpers";
import { botSurvived, creepCountAbove, storageAbove } from "../src/scenarios/Assertions";

const BOT_USERNAME = "TestBot";
const HOME_ROOM = "W0N1";

export const economicRecoveryScenario: ScenarioConfig = {
  name: "Economic Recovery from Full Wipe",
  description:
    "Colony with storage energy but zero creeps must bootstrap back to stable economy.",
  category: "economic",

  rooms: [
    {
      name: HOME_ROOM,
      owner: BOT_USERNAME,
      rcl: 5,
      controllerPos: { x: 25, y: 40 },
      sources: [
        { x: 11, y: 35, energy: 3000 },
        { x: 38, y: 12, energy: 3000 },
      ],
      mineral: { x: 40, y: 40, mineralType: "H", density: 3 },
      structures: [
        // Spawn
        {
          type: STRUCTURE_SPAWN,
          x: 25,
          y: 25,
          owner: BOT_USERNAME,
          energy: 300,
        },
        // Storage with energy
        {
          type: STRUCTURE_STORAGE,
          x: 26,
          y: 25,
          owner: BOT_USERNAME,
          store: { energy: 50000 },
        },
        // Tower for defense
        {
          type: STRUCTURE_TOWER,
          x: 24,
          y: 25,
          owner: BOT_USERNAME,
          energy: 500,
        },
        // Containers at sources
        {
          type: STRUCTURE_CONTAINER,
          x: 12,
          y: 35,
          store: { energy: 1000 },
        },
        {
          type: STRUCTURE_CONTAINER,
          x: 37,
          y: 12,
          store: { energy: 1000 },
        },
        // Extensions (RCL 5 = 30 extensions)
        ...generateExtensionCluster(23, 23, 20, BOT_USERNAME),
      ],
      // No hostile creeps
      hostileCreeps: [],
    },
  ],

  bot: {
    username: BOT_USERNAME,
    room: HOME_ROOM,
    rcl: 5,
    gcl: 2,
    cpu: 100,
    energy: 300, // Spawn energy
    storageEnergy: 50000,
    // Zero initial creeps - must bootstrap
    initialCreeps: [],
  },

  tickLimit: 500,
  checkInterval: 50,
  bailOnFailure: false,

  assertions: [
    // Must survive
    botSurvived(HOME_ROOM, BOT_USERNAME, "Colony must recover from zero creeps"),

    // Should have at least 3 creeps by end (harvester + hauler + something)
    creepCountAbove(HOME_ROOM, 2, BOT_USERNAME, "end", "Should have at least 3 creeps"),

    // Storage should not be fully depleted
    storageAbove(HOME_ROOM, 10000, "end", "Storage should not be depleted"),
  ],
};
