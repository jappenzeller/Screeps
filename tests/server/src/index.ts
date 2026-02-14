/**
 * CLI Entry Point for Private Server Tests
 *
 * Usage:
 *   npx ts-node src/index.ts --all              Run all scenarios
 *   npx ts-node src/index.ts --scenario <name>  Run specific scenario
 *   npx ts-node src/index.ts --category <cat>   Run scenarios in category
 *   npx ts-node src/index.ts --verbose          Enable verbose output
 *   npx ts-node src/index.ts --bail             Stop on first failure
 *   npx ts-node src/index.ts --quick            Reduce tick limits for faster runs
 */

import * as path from "path";
import { ServerController } from "./server/ServerController";
import { BotDeployer } from "./deployment/BotDeployer";
import { ScenarioRunner, formatResults } from "./scenarios/ScenarioRunner";
import { ScenarioConfig, CLIArgs } from "./types";

// Import scenarios
import { economicRecoveryScenario } from "../scenarios/economic-recovery";
import { invaderDefenseScenario } from "../scenarios/invader-defense";
// import { bazsiAttackScenario } from "../scenarios/bazsi-attack";

// ============================================
// Scenario Registry
// ============================================

const ALL_SCENARIOS: ScenarioConfig[] = [
  economicRecoveryScenario,
  invaderDefenseScenario,
  // bazsiAttackScenario, // TODO: Enable when ready
];

// ============================================
// CLI Argument Parsing
// ============================================

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--all":
      case "-a":
        result.all = true;
        break;

      case "--scenario":
      case "-s":
        result.scenario = args[++i];
        break;

      case "--category":
      case "-c":
        result.category = args[++i];
        break;

      case "--verbose":
      case "-v":
        result.verbose = true;
        break;

      case "--bail":
      case "-b":
        result.bail = true;
        break;

      case "--quick":
      case "-q":
        result.quick = true;
        break;

      case "--output":
      case "-o":
        result.output = args[++i];
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);

      default:
        if (!arg.startsWith("-")) {
          // Treat as scenario name
          result.scenario = arg;
        }
    }
  }

  // Default to --all if nothing specified
  if (!result.all && !result.scenario && !result.category) {
    result.all = true;
  }

  return result;
}

function printHelp(): void {
  console.log(`
Screeps Private Server Test Runner

Usage:
  npx ts-node src/index.ts [options]

Options:
  --all, -a              Run all scenarios
  --scenario, -s <name>  Run specific scenario by name
  --category, -c <cat>   Run scenarios in a category (economic, combat, expansion)
  --verbose, -v          Enable verbose output
  --bail, -b             Stop on first failure
  --quick, -q            Reduce tick limits for faster runs
  --output, -o <file>    Write results to JSON file
  --help, -h             Show this help message

Examples:
  npx ts-node src/index.ts --all
  npx ts-node src/index.ts --scenario "Economic Recovery"
  npx ts-node src/index.ts --category economic --verbose
  npx ts-node src/index.ts --quick --bail
`);
}

// ============================================
// Scenario Filtering
// ============================================

function filterScenarios(args: CLIArgs): ScenarioConfig[] {
  let scenarios = [...ALL_SCENARIOS];

  if (args.scenario) {
    const query = args.scenario.toLowerCase();
    scenarios = scenarios.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.name.toLowerCase().replace(/\s+/g, "-") === query
    );
  }

  if (args.category) {
    scenarios = scenarios.filter(
      (s) => s.category?.toLowerCase() === args.category?.toLowerCase()
    );
  }

  // Apply --quick modifications
  if (args.quick) {
    scenarios = scenarios.map((s) => ({
      ...s,
      tickLimit: Math.min(s.tickLimit, 200),
      checkInterval: Math.min(s.checkInterval || 100, 50),
    }));
  }

  return scenarios;
}

// ============================================
// Main Entry Point
// ============================================

async function main(): Promise<void> {
  const args = parseArgs();
  const scenarios = filterScenarios(args);

  if (scenarios.length === 0) {
    console.error("No scenarios match the specified criteria.");
    console.error("Use --help to see available options.");
    process.exit(1);
  }

  console.log(`\nScreeps Private Server Test Runner`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Running ${scenarios.length} scenario(s)...\n`);

  // Initialize server
  const server = new ServerController({
    logConsole: args.verbose,
  });

  // Initialize deployer (project root is 3 levels up from src/)
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const deployer = new BotDeployer(projectRoot);

  // Create runner
  const runner = new ScenarioRunner(server, deployer, {
    verbose: args.verbose,
    progressInterval: args.quick ? 50 : 100,
  });

  try {
    console.log("Starting Screeps private server...");
    await server.initialize();
    console.log("Server ready.\n");

    // Build the bot first
    console.log("Building bot code...");
    const buildResult = await deployer.build();
    if (!buildResult.success) {
      console.error(`Build failed: ${buildResult.error}`);
      process.exit(1);
    }
    console.log(`Build completed in ${buildResult.buildTime}ms\n`);

    // Run scenarios
    const results = [];
    for (const scenario of scenarios) {
      const result = await runner.run(scenario);
      results.push(result);

      // Print immediate result
      const icon = result.passed ? "✅" : "❌";
      console.log(`${icon} ${scenario.name}: ${result.passed ? "PASSED" : "FAILED"}`);

      // Bail on failure if requested
      if (args.bail && !result.passed) {
        console.log("\n--bail flag set, stopping on first failure.");
        break;
      }
    }

    // Print summary
    console.log(formatResults(results));

    // Write output file if requested
    if (args.output) {
      const fs = await import("fs");
      fs.writeFileSync(args.output, JSON.stringify(results, null, 2));
      console.log(`\nResults written to ${args.output}`);
    }

    // Exit with appropriate code
    const allPassed = results.every((r) => r.passed);
    await server.shutdown();
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error("\nFatal error:", error);
    await server.shutdown().catch(() => {});
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
