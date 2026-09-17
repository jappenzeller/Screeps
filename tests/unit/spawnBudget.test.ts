/**
 * Unit tests for spawn body budgeting.
 *
 * Run with: npm run test:unit
 *
 * Every branch of resolveSpawnEnergyBudget sized bodies from energy on hand - stock, never
 * flow. Measured live: E46N37 reached 5,600/5,600, the "nearly full" branch handed over the
 * whole 5,600, and the result was a 50-part 36-WORK upgrader burning 36/tick into a room
 * earning 20/tick. Filling the extensions is what caused the next deficit.
 *
 * The rescue branches must survive untouched: starving harvesters and haulers is the
 * deadlock this function was originally written to break, and it cost 191 failed spawns
 * out of 191.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

g.WORK = "work";
g.CARRY = "carry";
g.MOVE = "move";
g.ATTACK = "attack";
g.RANGED_ATTACK = "ranged_attack";
g.HEAL = "heal";
g.TOUGH = "tough";
g.CLAIM = "claim";
g.BODYPART_COST = {
  work: 100,
  carry: 50,
  move: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  tough: 10,
  claim: 600,
};

const BB = require("../../src/spawning/bodyBuilder");

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

/** A healthy mature room: extensions full, no stall, solvent. */
function inputs(over: Partial<any> = {}): any {
  return Object.assign(
    {
      role: "UPGRADER",
      energyAvailable: 5600,
      energyCapacity: 5600,
      energyStored: 50000,
      harvesterCount: 2,
      haulerCount: 2,
      downgradeRisk: false,
      sourceCount: 2,
      stalledTicks: 0,
      incomePerTick: 20,
      canAfford: true,
    },
    over
  );
}

console.log("\n=== Spawn body budget ===\n");

// ============================================================================
// The defect
// ============================================================================

test("an insolvent room does not size an upgrader to its full extensions", () => {
  // E46N37 exactly: 5,600 available, 20/tick income, no buffer.
  const b = BB.resolveSpawnEnergyBudget(inputs({ canAfford: false, energyStored: 70 }));
  assertTrue(b.energy < 5600, `budget ${b.energy} must be below the 5,600 on hand`);
  assertTrue(b.reason.indexOf("income-capped") !== -1, `reason should record the clamp: ${b.reason}`);
});

test("the capped upgrader burns a fraction of income, not double it", () => {
  const b = BB.resolveSpawnEnergyBudget(inputs({ canAfford: false, energyStored: 70 }));
  // UPGRADER pattern [WORK,WORK,WORK,CARRY] in road mode costs 450 per 3 WORK = 150/WORK.
  const work = Math.floor(b.energy / 150);
  assertTrue(work <= 7, `${work} WORK burns ${work}/tick against 20/tick income`);
  assertTrue(work >= 1, "still large enough to be worth spawning");
});

test("a builder is capped harder, because each WORK burns 2.5", () => {
  const b = BB.resolveSpawnEnergyBudget(
    inputs({ role: "BUILDER", canAfford: false, energyStored: 70 })
  );
  // BUILDER pattern [WORK,CARRY,MOVE] costs 200 per WORK, and burns 2.5/tick per WORK.
  const work = Math.floor(b.energy / 200);
  assertTrue(work * 2.5 <= 20, `${work} WORK burns ${work * 2.5}/tick against 20/tick income`);
});

test("more income buys a bigger body", () => {
  const poor = BB.resolveSpawnEnergyBudget(inputs({ canAfford: false, incomePerTick: 20 }));
  const rich = BB.resolveSpawnEnergyBudget(inputs({ canAfford: false, incomePerTick: 200 }));
  assertTrue(rich.energy > poor.energy, "the clamp scales with what the room earns");
});

// ============================================================================
// What must NOT be clamped
// ============================================================================

test("breaking even with an empty bank does not release the clamp", () => {
  // The leak that got through the first version. canAfford was fed
  // canAffordDiscretionary, which accepts netFlow >= 0 - and netFlow is computed from the
  // creeps currently alive, so it reads positive right after the room stops over-spending.
  // Measured live: E46N37 spawned a clamped 2-WORK builder and 6-WORK upgrader, burn fell
  // to ~13 against 20 income, flow went positive, and a 36-WORK upgrader spawned 99 ticks
  // later. Callers now pass hasSpendableBuffer, so an empty bank means canAfford === false
  // however healthy this tick happens to look.
  const b = BB.resolveSpawnEnergyBudget(inputs({ canAfford: false, energyStored: 0 }));
  assertTrue(b.energy < 5600, `budget ${b.energy} must stay clamped on an empty bank`);
  assertTrue(b.reason.indexOf("income-capped") !== -1, `clamp should be recorded: ${b.reason}`);
});

test("a solvent room is untouched", () => {
  const b = BB.resolveSpawnEnergyBudget(inputs({ canAfford: true }));
  assertEqual(b.energy, 5600, "a buffer exists precisely so it can be spent");
  assertEqual(b.reason, "nearly full", "no clamp recorded");
});

test("harvesters are never clamped - they earn, they do not burn", () => {
  const b = BB.resolveSpawnEnergyBudget(
    inputs({ role: "HARVESTER", canAfford: false, incomePerTick: 5 })
  );
  assertEqual(b.energy, 5600, "starving income roles is the deadlock this file exists to fix");
});

test("haulers are never clamped", () => {
  const b = BB.resolveSpawnEnergyBudget(
    inputs({ role: "HAULER", canAfford: false, incomePerTick: 5 })
  );
  assertEqual(b.energy, 5600, "a hauler moves energy, it does not consume it");
});

test("a downgrade rescue outranks the economy", () => {
  const b = BB.resolveSpawnEnergyBudget(
    inputs({ canAfford: false, incomePerTick: 5, downgradeRisk: true })
  );
  assertEqual(b.reason, "downgrade rescue", "losing the controller costs more than the energy");
});

test("an emergency is never clamped", () => {
  const b = BB.resolveSpawnEnergyBudget(
    inputs({ canAfford: false, harvesterCount: 0, haulerCount: 0, incomePerTick: 0 })
  );
  assertEqual(b.reason, "emergency", "a colony with no economy must spawn something now");
});

test("hauler bootstrap is never clamped", () => {
  const b = BB.resolveSpawnEnergyBudget(
    inputs({ role: "HAULER", canAfford: false, haulerCount: 0, incomePerTick: 5 })
  );
  assertEqual(b.reason, "hauler bootstrap", "no haulers means no economy at all");
});

// ============================================================================
// sustainableBodyEnergy directly
// ============================================================================

test("non-discretionary roles have no sustainable cap", () => {
  assertEqual(BB.sustainableBodyEnergy("HARVESTER", 20), null, "harvesters earn");
  assertEqual(BB.sustainableBodyEnergy("HAULER", 20), null, "haulers carry");
  assertEqual(BB.sustainableBodyEnergy("FILLER", 20), null, "fillers carry");
});

test("the cap never drops below the role's minimum body", () => {
  const b = BB.sustainableBodyEnergy("UPGRADER", 1);
  assertTrue(b !== null && b >= 200, `got ${b}: an unbuildable budget would stop spawning entirely`);
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
