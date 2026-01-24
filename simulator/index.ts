/**
 * Screeps Economic Loop Simulator
 * 
 * Tests spawner logic by simulating colony evolution over time.
 * 
 * Usage:
 *   npm test              - Run all scenarios
 *   npm test -- --verbose - Run with detailed output
 *   npm test -- --scenario "name" - Run specific scenario
 */

import { simulate } from './simulator';
import { SCENARIOS } from './scenarios';
import { SimResult, TestScenario } from './types';

interface TestResult {
  scenario: TestScenario;
  simResult: SimResult;
  passed: boolean;
  reason?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function runScenario(scenario: TestScenario, verbose: boolean): TestResult {
  const startTime = Date.now();
  
  const simResult = simulate(
    scenario.config,
    scenario.maxTicks,
    scenario.injections || [],
    verbose ? 10 : 50  // More frequent snapshots in verbose mode
  );
  
  const duration = Date.now() - startTime;
  
  // Check basic survival
  let passed = simResult.survived === scenario.expectedSurvival;
  let reason: string | undefined;
  
  if (!passed) {
    reason = scenario.expectedSurvival 
      ? `Colony died at tick ${simResult.deathTick}`
      : `Colony survived but expected death`;
  }
  
  // Run custom validation if survival matches
  if (passed && scenario.validate) {
    const validation = scenario.validate(simResult);
    passed = validation.passed;
    reason = validation.reason;
  }
  
  if (verbose) {
    console.log(`\n  Duration: ${formatDuration(duration)}`);
    console.log(`  Final tick: ${simResult.finalTick}`);
    console.log(`  Creeps: ${simResult.minCreeps} min / ${simResult.peakCreeps} peak`);
    console.log(`  Spawned: ${simResult.totalSpawned}, Deaths: ${simResult.totalDeaths}, Renewals: ${simResult.totalRenewals}`);
    console.log(`  Avg energy: ${simResult.averageEnergy.toFixed(0)}`);
    
    // Show first 10 events
    console.log(`  Events (first 10):`);
    for (const event of simResult.events.slice(0, 10)) {
      console.log(`    [${event.tick}] ${event.type} ${event.role || ''} ${event.details || ''}`);
    }
    if (simResult.events.length > 10) {
      console.log(`    ... and ${simResult.events.length - 10} more events`);
    }
  }
  
  return { scenario, simResult, passed, reason };
}

function printSummary(results: TestResult[]): void {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\nFailed scenarios:');
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  ❌ ${result.scenario.name}`);
      console.log(`     ${result.reason}`);
    }
  }
  
  console.log('='.repeat(60));
}

function printDetailedFailure(result: TestResult): void {
  console.log('\n' + '='.repeat(60));
  console.log(`FAILURE DETAILS: ${result.scenario.name}`);
  console.log('='.repeat(60));
  console.log(`Description: ${result.scenario.description}`);
  console.log(`Expected survival: ${result.scenario.expectedSurvival}`);
  console.log(`Actual survival: ${result.simResult.survived}`);
  console.log(`Death tick: ${result.simResult.deathTick || 'N/A'}`);
  console.log(`Reason: ${result.reason}`);
  
  console.log('\nEvent timeline:');
  for (const event of result.simResult.events) {
    const marker = event.type === 'WIPE' ? '💀' 
      : event.type === 'SPAWN_START' ? '🔨'
      : event.type === 'SPAWN_COMPLETE' ? '✅'
      : event.type === 'DEATH' ? '☠️'
      : event.type === 'RENEW' ? '♻️'
      : event.type === 'INJECT' ? '💉'
      : '•';
    console.log(`  [${event.tick.toString().padStart(4)}] ${marker} ${event.type.padEnd(14)} ${event.role || ''} ${event.details || ''}`);
  }
  
  console.log('\nCreep counts over time:');
  for (const snapshot of result.simResult.history) {
    const counts = Object.entries(snapshot.counts)
      .map(([role, count]) => `${role}:${count}`)
      .join(' ');
    console.log(`  [${snapshot.tick.toString().padStart(4)}] ${counts || '(empty)'} | energy:${snapshot.energyAvailable}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const scenarioFilter = args.find((a, i) => args[i - 1] === '--scenario');
  
  console.log('='.repeat(60));
  console.log('SCREEPS ECONOMIC LOOP SIMULATOR');
  console.log('='.repeat(60));
  
  let scenariosToRun = SCENARIOS;
  
  if (scenarioFilter) {
    scenariosToRun = SCENARIOS.filter(s => 
      s.name.toLowerCase().includes(scenarioFilter.toLowerCase())
    );
    if (scenariosToRun.length === 0) {
      console.log(`No scenarios match filter: "${scenarioFilter}"`);
      console.log('Available scenarios:');
      for (const s of SCENARIOS) {
        console.log(`  - ${s.name}`);
      }
      process.exit(1);
    }
  }
  
  console.log(`\nRunning ${scenariosToRun.length} scenarios...`);
  if (verbose) {
    console.log('(Verbose mode enabled)');
  }
  
  const results: TestResult[] = [];
  
  for (const scenario of scenariosToRun) {
    const icon = scenario.expectedSurvival ? '🏠' : '💀';
    process.stdout.write(`\n${icon} ${scenario.name}... `);
    
    const result = runScenario(scenario, verbose);
    results.push(result);
    
    if (result.passed) {
      console.log('✅ PASSED');
    } else {
      console.log('❌ FAILED');
      if (!verbose) {
        console.log(`   Reason: ${result.reason}`);
      }
    }
  }
  
  printSummary(results);
  
  // Print detailed failure info for first failure
  const firstFailure = results.find(r => !r.passed);
  if (firstFailure && !verbose) {
    printDetailedFailure(firstFailure);
  }
  
  // Exit with error code if any failures
  const exitCode = results.some(r => !r.passed) ? 1 : 0;
  process.exit(exitCode);
}

// Run if this is the entry point
main();
