import {
  CRITICAL_INVARIANTS,
  WARNING_INVARIANTS,
  TestColonyState,
  SpawnCandidate,
} from "./invariants";
import { generateRandomState, generateEdgeCaseStates } from "./stateGenerator";
import { createMockRoom, setupMockGameCreeps } from "./mockRoom";

// Import will happen after mocks are set up
let getSpawnCandidate: (room: any) => SpawnCandidate | null;

interface TestResult {
  state: TestColonyState;
  candidate: SpawnCandidate | null;
  violations: { invariant: string; message: string; severity: "CRITICAL" | "WARNING" }[];
}

interface TestSummary {
  totalTests: number;
  passed: number;
  failed: number;
  criticalViolations: number;
  warningViolations: number;
  failures: TestResult[];
}

/**
 * Run a single test case
 */
function runTestCase(state: TestColonyState): TestResult {
  // Setup mocks
  setupMockGameCreeps(state);
  const mockRoom = createMockRoom(state);

  // Run the actual spawner logic
  let candidate: SpawnCandidate | null = null;
  try {
    candidate = getSpawnCandidate(mockRoom);
  } catch (error) {
    return {
      state,
      candidate: null,
      violations: [
        {
          invariant: "RUNTIME_ERROR",
          message: `Exception: ${error}`,
          severity: "CRITICAL",
        },
      ],
    };
  }

  // Check all invariants
  const violations: TestResult["violations"] = [];

  for (const [name, check] of Object.entries(CRITICAL_INVARIANTS)) {
    const result = check(state, candidate);
    if (result) {
      violations.push({ invariant: name, message: result, severity: "CRITICAL" });
    }
  }

  for (const [name, check] of Object.entries(WARNING_INVARIANTS)) {
    const result = check(state, candidate);
    if (result) {
      violations.push({ invariant: name, message: result, severity: "WARNING" });
    }
  }

  return { state, candidate, violations };
}

/**
 * Run Monte Carlo tests
 */
export function runMonteCarloTests(iterations: number = 10000): TestSummary {
  const summary: TestSummary = {
    totalTests: iterations,
    passed: 0,
    failed: 0,
    criticalViolations: 0,
    warningViolations: 0,
    failures: [],
  };

  // Run random state tests
  for (let i = 0; i < iterations; i++) {
    const state = generateRandomState();
    const result = runTestCase(state);

    if (result.violations.length === 0) {
      summary.passed++;
    } else {
      summary.failed++;
      summary.criticalViolations += result.violations.filter(
        (v) => v.severity === "CRITICAL"
      ).length;
      summary.warningViolations += result.violations.filter(
        (v) => v.severity === "WARNING"
      ).length;

      // Only store first 100 failures to avoid memory issues
      if (summary.failures.length < 100) {
        summary.failures.push(result);
      }
    }
  }

  // Also run edge cases
  const edgeCases = generateEdgeCaseStates();
  for (const state of edgeCases) {
    summary.totalTests++;
    const result = runTestCase(state);

    if (result.violations.length === 0) {
      summary.passed++;
    } else {
      summary.failed++;
      summary.criticalViolations += result.violations.filter(
        (v) => v.severity === "CRITICAL"
      ).length;
      summary.warningViolations += result.violations.filter(
        (v) => v.severity === "WARNING"
      ).length;
      summary.failures.push(result);
    }
  }

  return summary;
}

/**
 * Main entry point
 */
async function main() {
  console.log("Setting up mocks...\n");

  // Setup initial mocks so we can import the module
  setupMockGameCreeps({
    rcl: 5,
    energyAvailable: 1000,
    energyCapacity: 1800,
    energyStored: 100000,
    energyIncome: 20,
    energyIncomeMax: 20,
    counts: {},
    targets: {},
    homeThreats: 0,
    remoteThreatsByRoom: {},
    constructionSites: 0,
    remoteRooms: [],
    dyingSoon: {},
  });

  // Now import the spawner module
  try {
    const utilitySpawning = await import("../../src/spawning/utilitySpawning");
    getSpawnCandidate = utilitySpawning.getSpawnCandidate;
  } catch (error) {
    console.error("Failed to import utilitySpawning module:", error);
    process.exit(1);
  }

  console.log("Running Monte Carlo spawner invariant tests...\n");

  const iterations = process.argv.includes("--quick") ? 1000 : 10000;
  const summary = runMonteCarloTests(iterations);

  console.log("=== TEST SUMMARY ===");
  console.log(`Total tests: ${summary.totalTests}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Critical violations: ${summary.criticalViolations}`);
  console.log(`Warning violations: ${summary.warningViolations}`);

  if (summary.failures.length > 0) {
    console.log("\n=== FAILURES ===\n");

    for (const failure of summary.failures.slice(0, 10)) {
      console.log(
        "State:",
        JSON.stringify(
          {
            rcl: failure.state.rcl,
            energyAvailable: failure.state.energyAvailable,
            energyCapacity: failure.state.energyCapacity,
            counts: failure.state.counts,
            homeThreats: failure.state.homeThreats,
            constructionSites: failure.state.constructionSites,
          },
          null,
          2
        )
      );
      console.log(
        "Candidate:",
        failure.candidate
          ? `${failure.candidate.role} (utility: ${failure.candidate.utility.toFixed(1)})`
          : "null"
      );
      console.log("Violations:");
      for (const v of failure.violations) {
        console.log(`  [${v.severity}] ${v.invariant}: ${v.message}`);
      }
      console.log("");
    }

    if (summary.failures.length > 10) {
      console.log(`... and ${summary.failures.length - 10} more failures`);
    }

    process.exit(1);
  } else {
    console.log("\n✅ All tests passed!");
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Test runner failed:", error);
  process.exit(1);
});
