/**
 * ScenarioRunner - Orchestrates scenario execution
 *
 * Handles:
 * - Setting up the world from scenario config
 * - Deploying bots (main + hostile)
 * - Running ticks with periodic assertion checks
 * - Collecting results and timeline events
 */

import { ServerController } from "../server/ServerController";
import { WorldBuilder, RoomBuilder } from "../server/WorldBuilder";
import { BotDeployer } from "../deployment/BotDeployer";
import { generateHostileBotCode } from "../deployment/HostileBotGenerator";
import { checkAssertion } from "./Assertions";
import {
  ScenarioConfig,
  ScenarioResult,
  TimelineEvent,
  AssertionResult,
  GameState,
  RoomConfig,
  BotConfig,
  HostileBotConfig,
  InjectionConfig,
} from "../types";

export interface RunnerConfig {
  /** Log progress every N ticks */
  progressInterval?: number;
  /** Verbose logging */
  verbose?: boolean;
}

/**
 * Runs scenarios against the private server
 */
export class ScenarioRunner {
  private server: ServerController;
  private deployer: BotDeployer;
  private config: RunnerConfig;

  constructor(server: ServerController, deployer: BotDeployer, config: RunnerConfig = {}) {
    this.server = server;
    this.deployer = deployer;
    this.config = {
      progressInterval: config.progressInterval || 100,
      verbose: config.verbose || false,
    };
  }

  /**
   * Run a single scenario
   */
  async run(scenario: ScenarioConfig): Promise<ScenarioResult> {
    const startTime = Date.now();
    const timeline: TimelineEvent[] = [];
    const assertionResults: AssertionResult[] = [];
    const errors: string[] = [];

    this.log(`\n[Scenario] ${scenario.name}`);
    this.log(`  ${scenario.description}`);

    timeline.push({
      tick: 0,
      type: "scenario_start",
      description: `Starting scenario: ${scenario.name}`,
    });

    try {
      // 1. Reset the world
      await this.server.reset();

      // 2. Set up rooms
      const world = new WorldBuilder(this.server);
      for (const roomConfig of scenario.rooms) {
        await this.setupRoom(world, roomConfig);
      }
      await world.build();

      // 3. Deploy our main bot
      await this.deployMainBot(scenario.bot, timeline);

      // 4. Deploy hostile bots (if any)
      if (scenario.hostileBots) {
        for (const hostileConfig of scenario.hostileBots) {
          await this.deployHostileBot(hostileConfig, timeline);
        }
      }

      // 5. Run ticks with assertion checks
      const checkInterval = scenario.checkInterval || 100;
      let currentTick = 0;
      let failedEarly = false;

      while (currentTick < scenario.tickLimit && !failedEarly) {
        // Run a batch of ticks
        const ticksToRun = Math.min(checkInterval, scenario.tickLimit - currentTick);
        await this.server.tick(ticksToRun);
        currentTick += ticksToRun;

        // Get current state
        const state = await this.server.getGameState();

        // Apply any injections scheduled for this tick range
        if (scenario.injections) {
          for (const injection of scenario.injections) {
            if (injection.tick > currentTick - ticksToRun && injection.tick <= currentTick) {
              await this.applyInjection(injection, state, timeline);
            }
          }
        }

        // Check continuous assertions
        for (const assertion of scenario.assertions) {
          if (assertion.timing === "continuous") {
            const result = checkAssertion(assertion, state);
            result.tick = currentTick;
            assertionResults.push(result);

            if (!result.passed) {
              timeline.push({
                tick: currentTick,
                type: "assertion_failed",
                description: result.message,
                data: { assertion: assertion.description || assertion.type },
              });

              if (scenario.bailOnFailure) {
                failedEarly = true;
              }
            }
          }

          // Check after_tick assertions
          if (
            assertion.timing === "after_tick" &&
            assertion.afterTick &&
            currentTick >= assertion.afterTick
          ) {
            const result = checkAssertion(assertion, state);
            result.tick = currentTick;
            assertionResults.push(result);

            if (!result.passed) {
              timeline.push({
                tick: currentTick,
                type: "assertion_failed",
                description: result.message,
                data: { assertion: assertion.description || assertion.type },
              });
            }
          }
        }

        // Progress reporting
        if (currentTick % this.config.progressInterval! === 0) {
          this.log(`  Tick ${currentTick}/${scenario.tickLimit}`);
        }
      }

      // 6. Check end assertions
      const finalState = await this.server.getGameState();
      for (const assertion of scenario.assertions.filter((a) => a.timing === "end")) {
        const result = checkAssertion(assertion, finalState);
        result.tick = currentTick;
        assertionResults.push(result);

        if (!result.passed) {
          timeline.push({
            tick: currentTick,
            type: "assertion_failed",
            description: result.message,
            data: { assertion: assertion.description || assertion.type },
          });
        }
      }

      timeline.push({
        tick: currentTick,
        type: "scenario_end",
        description: `Scenario completed at tick ${currentTick}`,
      });

      // 7. Compile results
      const passed = assertionResults.every((r) => r.passed);
      const duration = Date.now() - startTime;

      return {
        scenario: scenario.name,
        passed,
        duration,
        ticksRun: currentTick,
        assertions: assertionResults,
        errors,
        timeline,
        finalState,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);

      timeline.push({
        tick: await this.server.getCurrentTick().catch(() => 0),
        type: "error",
        description: `Error: ${errorMessage}`,
      });

      return {
        scenario: scenario.name,
        passed: false,
        duration: Date.now() - startTime,
        ticksRun: 0,
        assertions: assertionResults,
        errors,
        timeline,
      };
    }
  }

  /**
   * Run multiple scenarios
   */
  async runAll(scenarios: ScenarioConfig[]): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      const result = await this.run(scenario);
      results.push(result);
    }

    return results;
  }

  /**
   * Set up a room from config
   */
  private async setupRoom(world: WorldBuilder, config: RoomConfig): Promise<void> {
    const room = world.addRoom(config.name);

    // Add controller if owned
    if (config.controllerPos) {
      room.addController(
        config.controllerPos.x,
        config.controllerPos.y,
        config.rcl || 0,
        config.owner || undefined
      );
    }

    // Add sources
    if (config.sources) {
      for (const source of config.sources) {
        room.addSource(source.x, source.y, source.energy);
      }
    }

    // Add mineral
    if (config.mineral) {
      room.addMineral(
        config.mineral.x,
        config.mineral.y,
        config.mineral.mineralType,
        config.mineral.density
      );
    }

    // Add structures
    if (config.structures) {
      for (const struct of config.structures) {
        room.addStructure(struct);
      }
    }

    // Add storage with contents
    if (config.storage) {
      // Find if there's already a storage in structures
      const storageStruct = config.structures?.find((s) => s.type === "storage");
      if (storageStruct && config.owner) {
        // Update storage energy (will be handled in WorldBuilder)
        storageStruct.store = config.storage;
      }
    }

    // Add hostile creeps
    if (config.hostileCreeps) {
      for (const creep of config.hostileCreeps) {
        room.addCreep(creep.owner || "Invader", creep.body, creep.x, creep.y, creep.memory);
      }
    }
  }

  /**
   * Deploy the main bot
   */
  private async deployMainBot(config: BotConfig, timeline: TimelineEvent[]): Promise<void> {
    this.log(`  Deploying bot: ${config.username} in ${config.room}`);

    await this.deployer.deployTo(this.server, config.username, config.room, {
      gcl: config.gcl || 1,
      cpu: config.cpu || 100,
      cpuAvailable: 10000,
      position: { x: 25, y: 25 },
    });

    timeline.push({
      tick: 0,
      type: "bot_deployed",
      description: `Deployed ${config.username} in ${config.room}`,
      data: { username: config.username, room: config.room, rcl: config.rcl },
    });
  }

  /**
   * Deploy a hostile bot
   */
  private async deployHostileBot(
    config: HostileBotConfig,
    timeline: TimelineEvent[]
  ): Promise<void> {
    this.log(`  Deploying hostile: ${config.username} in ${config.room}`);

    const code = generateHostileBotCode(config);

    await this.server.deployBot(
      config.username,
      code,
      config.room,
      config.position || { x: 25, y: 25 },
      {
        gcl: 1,
        cpu: 50,
        cpuAvailable: 5000,
      }
    );

    timeline.push({
      tick: 0,
      type: "bot_deployed",
      description: `Deployed hostile ${config.username} in ${config.room}`,
      data: { username: config.username, room: config.room, behavior: config.behavior.mode },
    });
  }

  /**
   * Apply an injection at the specified tick
   */
  private async applyInjection(
    injection: InjectionConfig,
    state: GameState,
    timeline: TimelineEvent[]
  ): Promise<void> {
    this.log(`  [Injection @ ${injection.tick}] ${injection.description || injection.type}`);

    timeline.push({
      tick: injection.tick,
      type: "injection",
      description: injection.description || `Injection: ${injection.type}`,
      data: { type: injection.type, room: injection.room },
    });

    // Note: Actual injection implementation would require direct database manipulation
    // through the server controller. For now, custom injections should use customFn.
    if (injection.customFn) {
      await injection.customFn(state);
    }
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(message);
    }
  }
}

/**
 * Format scenario results for console output
 */
export function formatResults(results: ScenarioResult[]): string {
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push("SCENARIO RESULTS");
  lines.push("=".repeat(60));

  let passed = 0;
  let failed = 0;

  for (const result of results) {
    const status = result.passed ? "PASSED" : "FAILED";
    const icon = result.passed ? "✅" : "❌";
    lines.push(`\n${icon} ${result.scenario}: ${status}`);
    lines.push(`   Ticks: ${result.ticksRun}, Duration: ${result.duration}ms`);

    if (result.passed) {
      passed++;
    } else {
      failed++;

      // Show failed assertions
      const failedAssertions = result.assertions.filter((a) => !a.passed);
      for (const assertion of failedAssertions) {
        lines.push(`   - ${assertion.message}`);
        if (assertion.actual !== undefined) {
          lines.push(`     Actual: ${JSON.stringify(assertion.actual)}`);
        }
        if (assertion.expected !== undefined) {
          lines.push(`     Expected: ${JSON.stringify(assertion.expected)}`);
        }
      }

      // Show errors
      for (const error of result.errors) {
        lines.push(`   ! Error: ${error}`);
      }
    }
  }

  lines.push("\n" + "=".repeat(60));
  lines.push(`SUMMARY: ${passed} passed, ${failed} failed out of ${results.length}`);
  lines.push("=".repeat(60));

  return lines.join("\n");
}
