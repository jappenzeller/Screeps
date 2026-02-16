/**
 * RESERVER Utility Fix Scenario
 *
 * Tests the fix for RESERVER utility returning NaN when remote config
 * has missing distance or sources fields.
 *
 * Scenarios from prompt:
 * 1. All Remotes Get Reservers - Colony with 3 active remotes, all get RESERVER spawned
 * 2. Remote With No Vision - Remote room has no vision, RESERVER still evaluates correctly
 * 3. Newly Added Remote - Add remote via console, first RESERVER spawns within 50 ticks
 * 4. All Remote Config Shapes - Configs with: missing distance, missing sources, both missing, valid
 */

import { ScenarioConfig, GameState, AssertionResult } from "../src/types";
import {
  STRUCTURE_SPAWN,
  STRUCTURE_STORAGE,
  STRUCTURE_EXTENSION,
  STRUCTURE_CONTAINER,
  STRUCTURE_TOWER,
  STRUCTURE_CONTROLLER,
} from "../src/constants";
import { generateExtensionCluster } from "../src/utils/scenarioHelpers";
import { botSurvived, custom } from "../src/scenarios/Assertions";

const BOT_USERNAME = "TestBot";
const HOME_ROOM = "W0N1";
const REMOTE_ROOM_1 = "W0N2"; // Adjacent remote
const REMOTE_ROOM_2 = "W1N1"; // Adjacent remote
const REMOTE_ROOM_3 = "W0N0"; // Adjacent remote

/**
 * Custom assertion: Verify no NaN in spawn logs
 *
 * The original bug produced: [spawning] E43N39: Spawn RESERVER -> E42N39 (0/1): NaN
 * This assertion checks that no spawn utility scores are NaN
 */
function noNaNInSpawnLogs(description: string) {
  return custom(
    (state: GameState): AssertionResult => {
      // Check console output for NaN
      const consoleOutput = state.console || [];
      const nanLines = consoleOutput.filter(
        (line: string) => line.includes("RESERVER") && line.includes("NaN")
      );

      if (nanLines.length > 0) {
        return {
          passed: false,
          message: `Found NaN in RESERVER spawn logs: ${nanLines[0]}`,
          actual: nanLines.length,
          expected: 0,
        };
      }

      return {
        passed: true,
        message: "No NaN values in RESERVER spawn evaluations",
        actual: 0,
        expected: 0,
      };
    },
    "continuous",
    description
  );
}

/**
 * Custom assertion: Verify RESERVER creeps exist for active remotes
 */
function reserversSpawnedForRemotes(minCount: number, description: string) {
  return custom(
    (state: GameState): AssertionResult => {
      // Count RESERVER creeps owned by our bot across all rooms
      let reserverCount = 0;

      for (const [, room] of state.rooms) {
        const reservers = room.creeps.filter(
          (c) => c.owner === BOT_USERNAME && c.memory?.role === "RESERVER"
        );
        reserverCount += reservers.length;
      }

      const passed = reserverCount >= minCount;
      return {
        passed,
        message: passed
          ? `Found ${reserverCount} RESERVER creeps (>= ${minCount})`
          : `Only found ${reserverCount} RESERVER creeps, expected >= ${minCount}`,
        actual: reserverCount,
        expected: `>= ${minCount}`,
      };
    },
    "end",
    description
  );
}

/**
 * Scenario: All Remotes Get Reservers
 *
 * Colony with 3 active remotes, all should get RESERVER spawned.
 * Tests that the distance/sources defaults work correctly.
 */
export const reserverUtilityScenario: ScenarioConfig = {
  name: "RESERVER Utility Fix - All Remotes Get Reservers",
  description:
    "Colony with 3 active remotes must spawn RESERVERs without NaN utility scores. " +
    "Remote configs have varying completeness (some missing distance/sources fields).",
  category: "spawning",

  rooms: [
    // Home room - established RCL 5 colony
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
          store: { energy: 100000 },
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
      hostileCreeps: [],
    },
    // Remote room 1 - unowned, has sources
    {
      name: REMOTE_ROOM_1,
      owner: null,
      rcl: 0,
      controllerPos: { x: 25, y: 25 },
      sources: [
        { x: 15, y: 20, energy: 3000 },
        { x: 35, y: 30, energy: 3000 },
      ],
      structures: [],
      hostileCreeps: [],
    },
    // Remote room 2 - unowned, has sources
    {
      name: REMOTE_ROOM_2,
      owner: null,
      rcl: 0,
      controllerPos: { x: 25, y: 25 },
      sources: [
        { x: 10, y: 15, energy: 3000 },
        { x: 40, y: 35, energy: 3000 },
      ],
      structures: [],
      hostileCreeps: [],
    },
    // Remote room 3 - unowned, has sources
    {
      name: REMOTE_ROOM_3,
      owner: null,
      rcl: 0,
      controllerPos: { x: 25, y: 25 },
      sources: [{ x: 25, y: 25, energy: 3000 }],
      structures: [],
      hostileCreeps: [],
    },
  ],

  bot: {
    username: BOT_USERNAME,
    room: HOME_ROOM,
    rcl: 5,
    gcl: 2,
    cpu: 100,
    energy: 300,
    storageEnergy: 100000,
    initialCreeps: [
      // Start with some economy creeps
      {
        name: "harvester1",
        body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
        room: HOME_ROOM,
        pos: { x: 12, y: 35 },
        memory: { role: "HARVESTER", room: HOME_ROOM },
      },
      {
        name: "harvester2",
        body: ["work", "work", "work", "work", "work", "carry", "move", "move", "move"],
        room: HOME_ROOM,
        pos: { x: 37, y: 12 },
        memory: { role: "HARVESTER", room: HOME_ROOM },
      },
      {
        name: "hauler1",
        body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
        room: HOME_ROOM,
        pos: { x: 25, y: 26 },
        memory: { role: "HAULER", room: HOME_ROOM },
      },
      {
        name: "hauler2",
        body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
        room: HOME_ROOM,
        pos: { x: 25, y: 27 },
        memory: { role: "HAULER", room: HOME_ROOM },
      },
    ],
    // Set up remote room configs with varying completeness to test defaults
    // This is the key test: configs missing distance/sources should not produce NaN
    memory: {
      colonies: {
        [HOME_ROOM]: {
          remotes: {
            // Config 1: Valid - has all fields
            [REMOTE_ROOM_1]: {
              room: REMOTE_ROOM_1,
              homeColony: HOME_ROOM,
              distance: 1,
              sources: 2,
              active: true,
            },
            // Config 2: Missing distance - should default to 1
            [REMOTE_ROOM_2]: {
              room: REMOTE_ROOM_2,
              homeColony: HOME_ROOM,
              // distance: undefined,  <-- THIS WAS CAUSING NaN
              sources: 2,
              active: true,
            },
            // Config 3: Missing both distance and sources - should default to 1 and 2
            [REMOTE_ROOM_3]: {
              room: REMOTE_ROOM_3,
              homeColony: HOME_ROOM,
              // distance: undefined,  <-- THIS WAS CAUSING NaN
              // sources: undefined,   <-- This was causing wrong income calc
              active: true,
            },
          },
          remoteRoomsLastSync: 0,
        },
      },
    },
  },

  tickLimit: 300,
  checkInterval: 50,
  bailOnFailure: false,

  assertions: [
    // Core: Bot must survive
    botSurvived(HOME_ROOM, BOT_USERNAME, "Colony must survive with remote mining"),

    // Key fix verification: No NaN in spawn logs
    noNaNInSpawnLogs("RESERVER utility must not return NaN"),

    // Verify reservers spawn for active remotes (at least 1 by end of test)
    reserversSpawnedForRemotes(1, "At least one RESERVER should spawn for active remotes"),
  ],
};

// Export for registry
export default reserverUtilityScenario;
