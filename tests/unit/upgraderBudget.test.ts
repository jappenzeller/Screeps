/**
 * Unit tests for the upgrader headcount budget.
 *
 * Run with: npm run test:unit
 *
 * The poverty cap was the last spawn decision keyed on canAffordDiscretionary, which
 * returns true on netFlow >= 0 - and netFlow is computed from the creeps currently alive,
 * so it reads healthiest at the moment the room has just shed the burn that was sinking it.
 * The cap released one death before it had converged and the room respawned what it had
 * just shed. Measured live at E46N37: 20/tick income, 18/tick of upgrading across three
 * upgraders, netFlow -3.3, stored 112, runway 33 - held there rather than converging.
 *
 * The builder cap and the body clamp were both moved to hasSpendableBuffer for this exact
 * reason; this path was missed. Solvency here is an input, so what the tests pin is the
 * arithmetic - the call site in ColonyTargets is what chooses stock over flow.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const UB = require("../../src/core/upgraderBudget");

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

/** A solvent RCL 7 room with storage below the high-water mark, as the baseline to vary from. */
function input(over: Partial<any> = {}): any {
  return Object.assign(
    {
      rcl: 7,
      isEarlyColony: false,
      allExtensions: true,
      storedInStorage: 20000,
      storageHigh: 100000,
      downgradeRisk: false,
      canAfford: true,
      upgradeBurn: 10,
      totalIncome: 100,
      upgraders: 3,
    },
    over
  );
}

console.log("\n=== Upgrader headcount budget ===\n");

// ============================================================================
// The defect
// ============================================================================

test("an insolvent room overspending on the controller sheds an upgrader", () => {
  // E46N37 exactly: 20/tick income, 18/tick upgrade burn, three upgraders, no buffer.
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 20, upgradeBurn: 18, upgraders: 3 })
  );
  assertEqual(t, 2, "converges down by one per death rather than lurching");
});

test("shedding continues on the next death", () => {
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 20, upgradeBurn: 12, upgraders: 2 })
  );
  assertEqual(t, 1, "keeps converging while upgrading is the reason");
});

test("breaking even with an empty bank still sheds", () => {
  // The whole point of the fix. Flow reads healthy here - burn is under income - but the
  // bank is empty, so canAfford is false and the cap must stay engaged. Fed
  // canAffordDiscretionary this room came back affordable and reverted to a target of 3.
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 20, upgradeBurn: 18, upgraders: 3, storedInStorage: 0 })
  );
  assertEqual(t, 2, "an empty bank is not affordable however healthy the tick looks");
});

// ============================================================================
// The floor
// ============================================================================

test("the floor is one upgrader, not zero", () => {
  // Unlike builders. Sites wait; a controller downgrades.
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 20, upgradeBurn: 18, upgraders: 1 })
  );
  assertEqual(t, 1, "a room that reaches zero upgraders loses RCL");
});

test("no upgraders alive still asks for one", () => {
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 0, upgradeBurn: 18, upgraders: 0 })
  );
  assertEqual(t, 1, "the recovery path back from zero");
});

// ============================================================================
// When the cap must NOT engage
// ============================================================================

test("a solvent room is untouched however large its burn", () => {
  const t = UB.upgraderTargetFor(input({ canAfford: true, totalIncome: 20, upgradeBurn: 99 }));
  assertEqual(t, 3, "a storage buffer is exactly what spending is for");
});

test("insolvency not caused by upgrading leaves upgraders alone", () => {
  // Losing energy to building, towers or a siege. Cutting upgraders would not fix it.
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 100, upgradeBurn: 20, upgraders: 3 })
  );
  assertEqual(t, 3, "upgrade burn is within its share of income");
});

test("the share boundary is not a cliff", () => {
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 100, upgradeBurn: 50, upgraders: 3 })
  );
  assertEqual(t, 3, "exactly at the share still counts as affordable");
});

test("a controller near downgrade outranks the economy", () => {
  const t = UB.upgraderTargetFor(
    input({ canAfford: false, totalIncome: 20, upgradeBurn: 99, upgraders: 3, downgradeRisk: true })
  );
  assertEqual(t, 3, "losing the controller costs more than the energy");
});

// ============================================================================
// Base target
// ============================================================================

test("RCL bounds the base target at three", () => {
  assertEqual(UB.upgraderTargetFor(input({ rcl: 2 })), 2, "min(rcl, 3)");
  assertEqual(UB.upgraderTargetFor(input({ rcl: 7 })), 3, "capped at three");
});

test("RCL 8 wants one upgrader", () => {
  assertEqual(UB.upgraderTargetFor(input({ rcl: 8 })), 1, "nothing left to upgrade towards");
});

test("an early colony mid-extensions runs a single upgrader", () => {
  const t = UB.upgraderTargetFor(
    input({ rcl: 3, isEarlyColony: true, allExtensions: false, storedInStorage: null })
  );
  assertEqual(t, 1, "extensions come before controller progress");
});

test("an early colony with its extensions built pushes RCL", () => {
  const t = UB.upgraderTargetFor(
    input({ rcl: 3, isEarlyColony: true, allExtensions: true, storedInStorage: null })
  );
  assertEqual(t, 3, "infrastructure done, spend on the controller");
});

// ============================================================================
// Surplus
// ============================================================================

test("storage above the high-water mark buys extra upgraders", () => {
  // Dead capital, and a capped store starts dropping energy on the ground.
  const t = UB.upgraderTargetFor(input({ storedInStorage: 250000, storageHigh: 100000 }));
  assertEqual(t, 6, "3 base + 3 surplus steps of 50,000");
});

test("the surplus bonus is bounded", () => {
  const t = UB.upgraderTargetFor(input({ storedInStorage: 900000, storageHigh: 100000 }));
  assertEqual(t, 3 + UB.MAX_SURPLUS_UPGRADERS, "a full store does not spawn fifty upgraders");
});

test("RCL 8 takes no surplus bonus", () => {
  const t = UB.upgraderTargetFor(input({ rcl: 8, storedInStorage: 900000, storageHigh: 100000 }));
  assertEqual(t, 1, "an RCL 8 controller has nowhere to put it");
});

test("a room with no storage takes no surplus bonus", () => {
  const t = UB.upgraderTargetFor(input({ storedInStorage: null }));
  assertEqual(t, 3, "nothing to be above the mark");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
