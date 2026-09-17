/**
 * Unit tests for the builder solvency cap.
 *
 * Run with: npm run test:unit
 *
 * The case that matters: all three colonies measured CRITICAL at the same time with an
 * identical shape - 20/tick of income against 36/tick of upgrading and 40/tick of building,
 * runways of 70, 11 and 4 ticks. Upgraders answered to canAffordDiscretionary and were
 * converging down; builders answered only to `Math.min(rcl, 4)`, a variable named
 * maxBuildersByEconomy whose value was RCL.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const BB = require("../../src/core/builderBudget");

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

/** A solvent RCL 7 room with plenty of sites, as the baseline to vary from. */
function input(over: Partial<any> = {}): any {
  return Object.assign(
    {
      rcl: 7,
      totalSites: 40,
      totalIncome: 100,
      buildBurn: 10,
      builders: 4,
      canAfford: true,
    },
    over
  );
}

console.log("\n=== Builder solvency cap ===\n");

// ============================================================================
// The defect
// ============================================================================

test("an insolvent room overspending on construction sheds a builder", () => {
  // E47N41 and E46N37 exactly: 20/tick income, 40/tick build burn, no buffer.
  const t = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 20, buildBurn: 40, builders: 2 })
  );
  assertEqual(t, 1, "converges down by one per death rather than lurching");
});

test("shedding continues until the burn is gone", () => {
  const t = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 20, buildBurn: 20, builders: 1 })
  );
  assertEqual(t, 0, "builders may reach zero - sites wait, unlike a downgrading controller");
});

test("RCL alone no longer authorises builders", () => {
  // The old rule was min(ceil(sites/10), min(rcl, 4)) with no income term at all, so an
  // RCL 7 room with 40 sites got 4 builders whatever it earned.
  const rich = BB.builderTargetFor(input({ totalIncome: 200, buildBurn: 10 }));
  const poor = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 20, buildBurn: 40, builders: 4 })
  );
  assertEqual(rich, 4, "a room that can pay still builds at full rate");
  assertEqual(poor, 3, "a room that cannot pay starts shedding");
});

// ============================================================================
// When the cap must NOT engage
// ============================================================================

test("breaking even with an empty bank does not release the cap", () => {
  // The same leak found in the body clamp, and the same fix. canAfford was fed
  // canAffordDiscretionary, which accepts netFlow >= 0 - and netFlow is computed from the
  // creeps currently alive, so it reads positive precisely when the room has just stopped
  // over-spending. E47N41 respawned a 16-WORK builder that way after this cap had shipped.
  // The call site now passes hasSpendableBuffer, so an empty bank is never "affordable".
  const t = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 20, buildBurn: 40, builders: 2 })
  );
  assertEqual(t, 1, "still shedding, however healthy this single tick looks");
});

test("a solvent room is untouched however large its burn", () => {
  const t = BB.builderTargetFor(input({ canAfford: true, totalIncome: 20, buildBurn: 99 }));
  assertEqual(t, 4, "a storage buffer is exactly what spending is for");
});

test("insolvency not caused by building leaves builders alone", () => {
  // Losing energy for some other reason - upgraders, towers, a siege. Cutting builders
  // would not fix it, and would stall construction for nothing.
  const t = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 100, buildBurn: 5, builders: 4 })
  );
  assertEqual(t, 4, "build burn is within its share of income");
});

test("the share boundary is not a cliff into zero", () => {
  const atShare = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 100, buildBurn: 30, builders: 4 })
  );
  assertEqual(atShare, 4, "exactly at the share still counts as affordable");
});

// ============================================================================
// Site count still bounds it
// ============================================================================

test("no sites means no builders", () => {
  assertEqual(BB.builderTargetFor(input({ totalSites: 0 })), 0, "nothing to build");
  assertEqual(
    BB.builderTargetFor(input({ totalSites: 0, canAfford: false, buildBurn: 99, builders: 3 })),
    0,
    "and solvency does not change that"
  );
});

test("a few sites do not justify a full crew", () => {
  assertEqual(BB.builderTargetFor(input({ totalSites: 5 })), 1, "one builder per ten sites");
  assertEqual(BB.builderTargetFor(input({ totalSites: 25 })), 3, "scales with the queue");
});

test("a low RCL room is still capped by RCL", () => {
  assertEqual(BB.builderTargetFor(input({ rcl: 4, totalSites: 100 })), 4, "min(rcl, 4)");
  assertEqual(BB.builderTargetFor(input({ rcl: 2, totalSites: 100 })), 2, "RCL still bounds");
});

test("the cap never returns a negative target", () => {
  const t = BB.builderTargetFor(
    input({ canAfford: false, totalIncome: 0, buildBurn: 40, builders: 0 })
  );
  assertEqual(t, 0, "zero builders minus one is still zero");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
