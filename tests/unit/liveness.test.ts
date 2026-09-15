/**
 * Unit tests for the liveness registry.
 *
 * Run with: npm run test:unit
 *
 * The registry is only useful if its findings can be trusted. Two ways it has already
 * failed that: shipping with acted() wired for one system out of seven, which would have
 * produced six false ALWAYS_NOOP findings, and reporting systems that were correctly idle
 * - a planner at its cap, a sync with nothing to change - as never having acted.
 *
 * Module state is shared across tests (bootTick is set by the first expect()), so each
 * test uses its own system name and filters findings by it.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;
g.Game = { time: 1000 };
g.Memory = {};

const L = require("../../src/core/Liveness");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e}`);
  }
}

function assertEqual(actual: any, expected: any, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function findingsFor(system: string): Array<{ type: string; detail: string }> {
  return L.report().filter((f: { system: string }) => f.system === system);
}

console.log("\n=== Liveness registry ===\n");

// Must run first: the first expect() fixes bootTick at Game.time.
test("nothing is reported inside the boot grace after a deploy", () => {
  g.Game.time = 1000;
  L.expect("graceSys", 1, true);
  assertEqual(findingsFor("graceSys").length, 0, "global was just wiped; everything looks dead");
});

test("a declared system that never runs is NEVER_RAN", () => {
  g.Game.time = 5000;
  L.expect("deadSys", 1, true);
  const f = findingsFor("deadSys");
  assertEqual(f.length, 1, "one finding");
  assertEqual(f[0].type, "NEVER_RAN", "declared on paper, absent from the tick");
});

test("a system silent past three times its cadence is STOPPED", () => {
  g.Game.time = 5000;
  L.expect("slowSys", 10, false);
  L.ran("slowSys");
  g.Game.time = 5031;
  const f = findingsFor("slowSys");
  assertEqual(f.length, 1, "one finding");
  assertEqual(f[0].type, "STOPPED", "expected every 10, silent for 31");
});

test("a system that had work and never acted is ALWAYS_NOOP", () => {
  g.Game.time = 6000;
  L.expect("stuckSys", 1, true);
  for (let i = 0; i < 5; i++) L.ran("stuckSys");
  const f = findingsFor("stuckSys");
  assertEqual(f.length, 1, "one finding");
  assertEqual(f[0].type, "ALWAYS_NOOP", "work existed, nothing happened");
  assertTrue(f[0].detail.indexOf("5 of 5") !== -1, `detail counts the runs with work: ${f[0].detail}`);
});

test("a system idle on every run is not ALWAYS_NOOP", () => {
  // A planner already at its cap. It ran, checked, and correctly did nothing.
  g.Game.time = 6000;
  L.expect("idleSys", 1, true);
  for (let i = 0; i < 5; i++) {
    L.ran("idleSys");
    L.idle("idleSys");
  }
  assertEqual(findingsFor("idleSys").length, 0, "correctly idle is not a finding");
});

test("only the runs that had work count toward ALWAYS_NOOP", () => {
  g.Game.time = 6000;
  L.expect("mixedSys", 1, true);
  for (let i = 0; i < 5; i++) L.ran("mixedSys");
  for (let i = 0; i < 3; i++) L.idle("mixedSys");
  const f = findingsFor("mixedSys");
  assertEqual(f.length, 1, "two runs had work and never acted");
  assertTrue(f[0].detail.indexOf("2 of 5") !== -1, `detail reports the working runs: ${f[0].detail}`);
});

test("acting once clears ALWAYS_NOOP", () => {
  g.Game.time = 6000;
  L.expect("workingSys", 1, true);
  for (let i = 0; i < 3; i++) L.ran("workingSys");
  L.acted("workingSys");
  assertEqual(findingsFor("workingSys").length, 0, "it did something");
});

test("an uninstrumented system is never judged ALWAYS_NOOP", () => {
  // Silence from a system that does not report acted() is absence of evidence.
  g.Game.time = 6000;
  L.expect("untrackedSys", 1, false);
  for (let i = 0; i < 5; i++) L.ran("untrackedSys");
  assertEqual(findingsFor("untrackedSys").length, 0, "no acted() wiring, no verdict");
});

test("reporting on an undeclared system is harmless", () => {
  L.ran("neverDeclared");
  L.idle("neverDeclared");
  L.acted("neverDeclared");
  assertEqual(findingsFor("neverDeclared").length, 0, "expect() is the registration point");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
