/**
 * Invader Defense Scenario
 *
 * Tests the bot's ability to defend against invaders:
 * - Stable colony with remote mining
 * - Invaders spawn in remote room
 * - Must eliminate invaders and continue operations
 */

import { ScenarioConfig, InjectionConfig } from "../src/types";
import {
  STRUCTURE_SPAWN,
  STRUCTURE_STORAGE,
  STRUCTURE_TOWER,
  STRUCTURE_CONTAINER,
  TOUGH,
  ATTACK,
  RANGED_ATTACK,
  MOVE,
  HEAL,
} from "../src/constants";
import { generateExtensionCluster, HARVESTER_BODIES, HAULER_BODIES } from "../src/utils/scenarioHelpers";
import { botSurvived, creepCountAbove, custom } from "../src/scenarios/Assertions";

const BOT_USERNAME = "TestBot";
const HOME_ROOM = "W0N1";
const REMOTE_ROOM = "W1N1";

export const invaderDefenseScenario: ScenarioConfig = {
  name: "Invader Defense",
  description:
    "Stable colony with remote mining operations gets hit by invaders. Must eliminate them and continue operations.",
  category: "combat",

  rooms: [
    // Home room - established colony
    {
      name: HOME_ROOM,
      owner: BOT_USERNAME,
      rcl: 6,
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
        // Storage with substantial energy
        {
          type: STRUCTURE_STORAGE,
          x: 26,
          y: 25,
          owner: BOT_USERNAME,
          store: { energy: 150000 },
        },
        // Two towers for defense
        {
          type: STRUCTURE_TOWER,
          x: 24,
          y: 25,
          owner: BOT_USERNAME,
          energy: 1000,
        },
        {
          type: STRUCTURE_TOWER,
          x: 27,
          y: 25,
          owner: BOT_USERNAME,
          energy: 1000,
        },
        // Containers at sources
        {
          type: STRUCTURE_CONTAINER,
          x: 12,
          y: 35,
          store: { energy: 2000 },
        },
        {
          type: STRUCTURE_CONTAINER,
          x: 37,
          y: 12,
          store: { energy: 2000 },
        },
        // Extensions (RCL 6 = 40 extensions)
        ...generateExtensionCluster(23, 23, 24, BOT_USERNAME),
      ],
    },
    // Remote mining room
    {
      name: REMOTE_ROOM,
      owner: null, // Unowned
      rcl: undefined,
      controllerPos: { x: 25, y: 25 },
      sources: [
        { x: 15, y: 25, energy: 3000 },
        { x: 35, y: 25, energy: 3000 },
      ],
      structures: [
        // Remote containers
        {
          type: STRUCTURE_CONTAINER,
          x: 16,
          y: 25,
          store: { energy: 1500 },
        },
        {
          type: STRUCTURE_CONTAINER,
          x: 34,
          y: 25,
          store: { energy: 1500 },
        },
      ],
      // Invaders will be in this room
      hostileCreeps: [
        // Invader pair: attacker + healer
        {
          body: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
          x: 45,
          y: 25,
          owner: "Invader",
        },
        {
          body: [TOUGH, TOUGH, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE],
          x: 46,
          y: 25,
          owner: "Invader",
        },
      ],
    },
  ],

  bot: {
    username: BOT_USERNAME,
    room: HOME_ROOM,
    rcl: 6,
    gcl: 3,
    cpu: 100,
    energy: 300,
    storageEnergy: 150000,
    // Start with a healthy economy
    initialCreeps: [
      {
        role: "HARVESTER",
        body: HARVESTER_BODIES[6],
        x: 12,
        y: 34,
        memory: { role: "HARVESTER", room: HOME_ROOM },
        ticksToLive: 1200,
      },
      {
        role: "HARVESTER",
        body: HARVESTER_BODIES[6],
        x: 37,
        y: 11,
        memory: { role: "HARVESTER", room: HOME_ROOM },
        ticksToLive: 1100,
      },
      {
        role: "HAULER",
        body: HAULER_BODIES[6],
        x: 25,
        y: 26,
        memory: { role: "HAULER", room: HOME_ROOM },
        ticksToLive: 1000,
      },
      {
        role: "HAULER",
        body: HAULER_BODIES[6],
        x: 26,
        y: 26,
        memory: { role: "HAULER", room: HOME_ROOM },
        ticksToLive: 900,
      },
    ],
  },

  // Hostile bots not needed - we placed static invader creeps
  hostileBots: [],

  tickLimit: 800,
  checkInterval: 50,
  bailOnFailure: false,

  assertions: [
    // Home colony must survive
    botSurvived(HOME_ROOM, BOT_USERNAME, "Home colony must survive"),

    // Should maintain economy
    creepCountAbove(HOME_ROOM, 3, BOT_USERNAME, "end", "Should maintain economy with 4+ creeps"),

    // Custom: Check that invaders are eventually dealt with
    // (either killed or fled - no invaders in either room at end)
    custom(
      (state) => {
        const homeRoom = state.rooms.get(HOME_ROOM);
        const remoteRoom = state.rooms.get(REMOTE_ROOM);

        const homeInvaders = homeRoom?.creeps.filter((c) => c.owner === "Invader").length || 0;
        const remoteInvaders = remoteRoom?.creeps.filter((c) => c.owner === "Invader").length || 0;
        const totalInvaders = homeInvaders + remoteInvaders;

        return {
          passed: totalInvaders === 0,
          message:
            totalInvaders === 0
              ? "All invaders eliminated"
              : `${totalInvaders} invaders remaining (home: ${homeInvaders}, remote: ${remoteInvaders})`,
          actual: totalInvaders,
          expected: 0,
        };
      },
      "end",
      "Invaders should be eliminated"
    ),
  ],
};
