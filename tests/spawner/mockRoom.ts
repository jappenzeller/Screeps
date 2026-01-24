import { TestColonyState } from "./invariants";

// Screeps constants
const FIND_SOURCES = 105;
const FIND_CONSTRUCTION_SITES = 111;
const FIND_HOSTILE_CREEPS = 103;
const FIND_MY_SPAWNS = 110;
const FIND_MY_STRUCTURES = 109;
const FIND_STRUCTURES = 108;

/**
 * Create a mock Room object from test state
 * Only implements properties needed by getSpawnCandidate
 */
export function createMockRoom(state: TestColonyState): any {
  return {
    name: "W1N1",
    controller: {
      level: state.rcl,
      my: true,
    },
    energyAvailable: state.energyAvailable,
    energyCapacityAvailable: state.energyCapacity,
    storage:
      state.energyStored > 0
        ? {
            store: {
              energy: state.energyStored,
              getUsedCapacity: (type: string) => (type === "energy" ? state.energyStored : 0),
            },
          }
        : undefined,
    find: (type: number, _opts?: any) => {
      switch (type) {
        case FIND_SOURCES:
          return [{ id: "source1" }, { id: "source2" }];
        case FIND_CONSTRUCTION_SITES:
          return Array(state.constructionSites).fill({ id: "site", structureType: "road" });
        case FIND_HOSTILE_CREEPS:
          return Array(state.homeThreats).fill({
            id: "hostile",
            owner: { username: "Invader" },
            getActiveBodyparts: () => 1,
          });
        case FIND_MY_SPAWNS:
          return [{ id: "spawn1", spawning: null, owner: { username: "TestUser" } }];
        case FIND_MY_STRUCTURES:
          return [];
        case FIND_STRUCTURES:
          return [];
        default:
          return [];
      }
    },
  };
}

/**
 * Mock Game.creeps based on state.counts
 */
export function setupMockGameCreeps(state: TestColonyState): void {
  const creeps: Record<string, any> = {};
  let id = 0;

  for (const [role, count] of Object.entries(state.counts)) {
    for (let i = 0; i < count; i++) {
      const name = `${role}_${id++}`;
      creeps[name] = {
        name,
        memory: {
          role,
          room: "W1N1",
        },
        ticksToLive: 1000,
        getActiveBodyparts: (type: string) => (type === "work" ? 5 : 0),
      };
    }
  }

  // @ts-ignore - mocking global
  global.Game = {
    creeps,
    spawns: { Spawn1: { owner: { username: "TestUser" } } } as any,
    time: 1000000,
    map: {
      describeExits: () => ({ "1": "W1N2", "3": "W2N1" }),
      getRoomLinearDistance: () => 1,
    } as any,
    rooms: {
      W1N1: createMockRoom(state),
    },
  } as any;

  // @ts-ignore - mocking global
  global.Memory = {
    rooms: {
      W1N1: {
        lastScan: 999000,
      },
      W1N2: {
        lastScan: 999000,
        sources: ["remoteSource1", "remoteSource2"],
        controller: {},
        hostiles: state.remoteThreatsByRoom["W1N2"] || 0,
        hasKeepers: false,
      },
      W2N1: {
        lastScan: 999000,
        sources: ["remoteSource3", "remoteSource4"],
        controller: {},
        hostiles: state.remoteThreatsByRoom["W2N1"] || 0,
        hasKeepers: false,
      },
    },
  };

  // Mock Screeps constants
  // @ts-ignore
  global.WORK = "work";
  // @ts-ignore
  global.CARRY = "carry";
  // @ts-ignore
  global.MOVE = "move";
  // @ts-ignore
  global.ATTACK = "attack";
  // @ts-ignore
  global.RANGED_ATTACK = "ranged_attack";
  // @ts-ignore
  global.HEAL = "heal";
  // @ts-ignore
  global.CLAIM = "claim";
  // @ts-ignore
  global.TOUGH = "tough";
  // @ts-ignore
  global.BODYPART_COST = {
    move: 50,
    work: 100,
    carry: 50,
    attack: 80,
    ranged_attack: 150,
    heal: 250,
    claim: 600,
    tough: 10,
  };
  // @ts-ignore
  global.FIND_SOURCES = 105;
  // @ts-ignore
  global.FIND_CONSTRUCTION_SITES = 111;
  // @ts-ignore
  global.FIND_HOSTILE_CREEPS = 103;
  // @ts-ignore
  global.FIND_MY_SPAWNS = 110;
  // @ts-ignore
  global.FIND_MY_STRUCTURES = 109;
  // @ts-ignore
  global.FIND_STRUCTURES = 108;
}
