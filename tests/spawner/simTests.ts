/**
 * Economic Loop Simulation Tests
 *
 * Tests colony survival across various scenarios by simulating
 * the spawner over hundreds of ticks.
 */

import {
  simulate,
  SimConfig,
  SimCreep,
  SimState,
  SimEvent,
  SimResult,
  createCreep,
  STANDARD_BODIES,
  loadSpawner,
  SIM_CONSTANTS,
} from "./simulator";

// ============================================
// Test Case Definition
// ============================================

interface TestCase {
  name: string;
  config: SimConfig;
  expectedSurvival: boolean;
  maxTicks: number;
  injections?: ((state: SimState, tick: number, events: SimEvent[]) => SimState)[];
  description?: string;
}

// ============================================
// Test Scenarios
// ============================================

const TEST_CASES: TestCase[] = [
  // ----------------------------------------
  // Recovery Tests
  // ----------------------------------------
  {
    name: "Recovery from zero harvesters",
    description: "Colony has haulers but no harvesters - should spawn harvester first",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 50000,
      initialCreeps: [
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 500),
        createCreep("UPGRADER", STANDARD_BODIES.UPGRADER_SMALL, 800),
      ],
    },
    expectedSurvival: true,
    maxTicks: 500,
  },

  {
    name: "Recovery from zero haulers",
    description: "Colony has harvesters but no haulers - should spawn hauler",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 200,
      initialStored: 0,
      initialCreeps: [
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_MEDIUM, 1000),
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_MEDIUM, 1200),
      ],
    },
    expectedSurvival: true,
    maxTicks: 500,
  },

  {
    name: "Full wipe recovery with 200 energy",
    description: "Zero creeps, minimal energy - must bootstrap from nothing",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 200,
      initialStored: 0,
      initialCreeps: [],
    },
    expectedSurvival: true,
    maxTicks: 1000,
  },

  {
    name: "Full wipe recovery with 300 energy",
    description: "Zero creeps, 300 energy - can spawn full minimal harvester",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 0,
      initialCreeps: [],
    },
    expectedSurvival: true,
    maxTicks: 1000,
  },

  // ----------------------------------------
  // Cascading Failure Tests
  // ----------------------------------------
  {
    name: "Cascading failure prevention - dying harvesters",
    description: "Harvesters about to die - spawner should replace before death",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 500,
      initialStored: 10000,
      initialCreeps: [
        // Harvesters about to die
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_MEDIUM, 50),
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_MEDIUM, 80),
        // Haulers with more TTL
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 500),
      ],
    },
    expectedSurvival: true,
    maxTicks: 500,
  },

  {
    name: "Cascading failure prevention - all dying",
    description: "All creeps dying soon - spawner should prioritize economy",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 800,
      initialStored: 50000,
      initialCreeps: [
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 100),
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 120),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 90),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 110),
        createCreep("UPGRADER", STANDARD_BODIES.UPGRADER_SMALL, 80),
      ],
    },
    expectedSurvival: true,
    maxTicks: 500,
  },

  // ----------------------------------------
  // Early Game (Low RCL) Tests
  // ----------------------------------------
  {
    name: "RCL 1 bootstrap",
    description: "Starting fresh at RCL 1 with 300 energy",
    config: {
      rcl: 1,
      energyCapacity: 300,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 0,
      initialCreeps: [],
    },
    expectedSurvival: true,
    maxTicks: 1000,
  },

  {
    name: "RCL 2 recovery",
    description: "RCL 2 with one dying harvester",
    config: {
      rcl: 2,
      energyCapacity: 550,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 0,
      initialCreeps: [createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_SMALL, 30)],
    },
    expectedSurvival: true,
    maxTicks: 500,
  },

  // ----------------------------------------
  // Sustained Operation Tests
  // ----------------------------------------
  {
    name: "Stable economy sustainability (1500 ticks)",
    description: "Healthy colony should maintain itself over full creep lifetime",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 1000,
      initialStored: 100000,
      initialCreeps: [
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 1000),
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 1200),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 800),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 900),
        createCreep("UPGRADER", STANDARD_BODIES.UPGRADER_SMALL, 600),
      ],
    },
    expectedSurvival: true,
    maxTicks: 1500,
  },

  // ----------------------------------------
  // Injection Tests (Mid-Simulation Events)
  // ----------------------------------------
  {
    name: "Invader attack kills all harvesters",
    description: "After 300 ticks, all harvesters die - colony must recover",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 1000,
      initialStored: 100000,
      initialCreeps: [
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 1000),
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 1200),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 800),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 900),
      ],
    },
    expectedSurvival: true,
    maxTicks: 1000,
    injections: [
      (state: SimState, tick: number, events: SimEvent[]): SimState => {
        if (tick === 300) {
          events.push({
            tick,
            type: "INJECTION",
            details: "Invader attack - all harvesters killed",
          });
          return {
            ...state,
            creeps: state.creeps.filter((c) => c.role !== "HARVESTER"),
            counts: {
              ...state.counts,
              HARVESTER: 0,
            },
          };
        }
        return state;
      },
    ],
  },

  {
    name: "Energy drain event",
    description: "At tick 200, energy drops to 100 - colony must recover",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 1000,
      initialStored: 50000,
      initialCreeps: [
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_FULL, 1000),
        createCreep("HAULER", STANDARD_BODIES.HAULER_MEDIUM, 800),
      ],
    },
    expectedSurvival: true,
    maxTicks: 800,
    injections: [
      (state: SimState, tick: number, events: SimEvent[]): SimState => {
        if (tick === 200) {
          events.push({
            tick,
            type: "INJECTION",
            details: "Energy drain - dropped to 100",
          });
          return {
            ...state,
            energyAvailable: 100,
          };
        }
        return state;
      },
    ],
  },

  // ----------------------------------------
  // Edge Cases
  // ----------------------------------------
  {
    name: "Single source economy",
    description: "Only one source - economy should still function",
    config: {
      rcl: 3,
      energyCapacity: 800,
      sources: 1,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 0,
      initialCreeps: [],
    },
    expectedSurvival: true,
    maxTicks: 1000,
  },

  {
    name: "High RCL with empty spawn",
    description: "RCL 8 colony with no creeps - should still bootstrap",
    config: {
      rcl: 8,
      energyCapacity: 12900,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 300,
      initialStored: 500000,
      initialCreeps: [],
    },
    expectedSurvival: true,
    maxTicks: 1000,
  },
];

// ============================================
// Test Runner
// ============================================

interface TestResult {
  name: string;
  passed: boolean;
  result: SimResult;
  expectedSurvival: boolean;
}

async function runTest(test: TestCase): Promise<TestResult> {
  const result = await simulate(test.config, {
    maxTicks: test.maxTicks,
    snapshotInterval: 50,
    injections: test.injections,
  });

  return {
    name: test.name,
    passed: result.survived === test.expectedSurvival,
    result,
    expectedSurvival: test.expectedSurvival,
  };
}

function formatEvents(events: SimEvent[], limit: number = 15): string {
  const filtered = events.filter(
    (e) => e.type === "SPAWN_START" || e.type === "WIPE" || e.type === "INJECTION"
  );
  const shown = filtered.slice(0, limit);
  const lines = shown.map(
    (e) =>
      `    tick ${e.tick.toString().padStart(4)}: ${e.type}${e.role ? ` (${e.role})` : ""}${e.details ? ` - ${e.details}` : ""}`
  );

  if (filtered.length > limit) {
    lines.push(`    ... and ${filtered.length - limit} more events`);
  }

  return lines.join("\n");
}

function analyzeFailure(result: SimResult): string {
  const analysis: string[] = [];

  // Check first few spawns
  const spawns = result.events.filter((e) => e.type === "SPAWN_START").slice(0, 5);
  if (spawns.length > 0) {
    analysis.push(`First spawns: ${spawns.map((e) => e.role).join(", ")}`);
  }

  // Check if we had harvesters
  const harvesterSpawns = result.events.filter(
    (e) => e.type === "SPAWN_START" && e.role === "HARVESTER"
  );
  if (harvesterSpawns.length === 0) {
    analysis.push("⚠️  Never spawned a HARVESTER!");
  }

  // Check death tick
  if (result.deathTick) {
    const eventsBeforeDeath = result.events.filter((e) => e.tick <= result.deathTick!);
    const lastSpawn = [...eventsBeforeDeath]
      .reverse()
      .find((e) => e.type === "SPAWN_START");
    if (lastSpawn) {
      analysis.push(`Last spawn before death: ${lastSpawn.role} at tick ${lastSpawn.tick}`);
    }
  }

  return analysis.join("\n    ");
}

export async function runAllSimTests(): Promise<{ passed: number; failed: number }> {
  console.log("Loading spawner module...\n");
  await loadSpawner();

  console.log("Running Economic Loop Simulation Tests\n");
  console.log("=".repeat(60) + "\n");

  let passed = 0;
  let failed = 0;

  for (const test of TEST_CASES) {
    process.stdout.write(`Testing: ${test.name}... `);

    try {
      const result = await runTest(test);

      if (result.passed) {
        console.log("✅ PASSED");
        if (test.description) {
          console.log(`    ${test.description}`);
        }
        console.log(
          `    Final: ${result.result.finalState.creeps.length} creeps, ` +
            `peak: ${result.result.peakCreeps}, ` +
            `min: ${result.result.minCreeps}`
        );
        passed++;
      } else {
        console.log("❌ FAILED");
        if (test.description) {
          console.log(`    ${test.description}`);
        }
        console.log(`    Expected: survived=${result.expectedSurvival}`);
        console.log(
          `    Actual: survived=${result.result.survived}, deathTick=${result.result.deathTick}`
        );
        console.log(`    Analysis: ${analyzeFailure(result.result)}`);
        console.log(`    Events:\n${formatEvents(result.result.events)}`);
        failed++;
      }
    } catch (error) {
      console.log("❌ ERROR");
      console.log(`    ${error}`);
      failed++;
    }

    console.log();
  }

  console.log("=".repeat(60));
  console.log(`\nSummary: ${passed} passed, ${failed} failed out of ${TEST_CASES.length} tests`);

  return { passed, failed };
}

// ============================================
// Main Entry Point
// ============================================

async function main(): Promise<void> {
  const { passed, failed } = await runAllSimTests();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Simulation runner failed:", error);
  process.exit(1);
});
