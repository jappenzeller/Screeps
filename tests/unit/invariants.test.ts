/**
 * Unit tests for decision-time invariants.
 *
 * Run with: npm run test:unit
 *
 * Liveness answers "did it run" and "did it act"; AnomalyDetector answers "is a creep
 * frozen". Neither catches a system that runs, acts, reports success, and is wrong about
 * the quantity - which is what every expensive defect on 2026-09-16 turned out to be. The
 * case below is the live one: a 36-WORK upgrader spawned into a room earning 20/tick,
 * which took an hour of hand-reading `_born` fields to find and would have been one line
 * in the log.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

// bodyConfig builds its patterns at module load, so the part constants and cost table must
// exist before the require below.
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
g.Game = { time: 500000 };
g.Memory = {};

const INV = require("../../src/core/Invariants");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  g.Memory = {};
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

/** A poor room: 20/tick income, no buffer - E46N37 and E47N41 all session. */
function spawn(over: Partial<any> = {}): any {
  return Object.assign(
    { role: "UPGRADER", workParts: 6, incomePerTick: 20, storedEnergy: 0 },
    over
  );
}

console.log("\n=== Decision-time invariants ===\n");

// ============================================================================
// The live defect
// ============================================================================

test("a 36-WORK upgrader in a room earning 20/tick is reported", () => {
  const why = INV.unsustainableSpawn(spawn({ workParts: 36 }));
  assertTrue(why !== null, "this is the escapee that cost an hour to find by hand");
  assertTrue(why.indexOf("36 WORK") !== -1, `detail should state the body: ${why}`);
  assertTrue(why.indexOf("36/tick") !== -1, `detail should state the burn: ${why}`);
});

test("a 16-WORK builder in the same room is reported", () => {
  // Builders burn 2.5 per WORK, so 16 WORK is 40/tick against 20/tick of income.
  const why = INV.unsustainableSpawn(spawn({ role: "BUILDER", workParts: 16 }));
  assertTrue(why !== null, "the other escapee");
  assertTrue(why.indexOf("40/tick") !== -1, `2.5 per WORK should be applied: ${why}`);
});

test("a clamped body is not reported", () => {
  // What the clamp now produces: 6 WORK burning 6/tick against 20/tick.
  assertEqual(INV.unsustainableSpawn(spawn({ workParts: 6 })), null, "6/tick is sustainable");
  assertEqual(
    INV.unsustainableSpawn(spawn({ role: "BUILDER", workParts: 2 })),
    null,
    "2 WORK burning 5/tick is sustainable"
  );
});

// ============================================================================
// What must never be reported
// ============================================================================

test("income roles are never reported, however large", () => {
  // A harvester's WORK parts earn; a hauler carries. Flagging these would be the cry-wolf
  // failure that makes a registry worthless - and starving them is the deadlock the body
  // budget was written to fix.
  assertEqual(INV.unsustainableSpawn(spawn({ role: "HARVESTER", workParts: 30 })), null, "earns");
  assertEqual(INV.unsustainableSpawn(spawn({ role: "HAULER", workParts: 0 })), null, "carries");
  assertEqual(INV.unsustainableSpawn(spawn({ role: "FILLER", workParts: 0 })), null, "carries");
  assertEqual(INV.unsustainableSpawn(spawn({ role: "MINERAL_HARVESTER", workParts: 20 })), null, "earns");
});

test("a room with a buffer may spend it on a large body", () => {
  const why = INV.unsustainableSpawn(spawn({ workParts: 36, storedEnergy: 50000 }));
  assertEqual(why, null, "a buffer exists precisely to be spent");
});

test("the report threshold is looser than the clamp's, deliberately", () => {
  // The clamp enforces a 0.35 share; this reports above 0.5. Reporting at the same
  // threshold the clamp enforces would fire on every borderline body and teach the reader
  // to skip the findings - which is the failure mode this whole registry exists to avoid.
  const at = INV.unsustainableSpawn(spawn({ workParts: 10 })); // 10/tick vs 20 * 0.5 = 10
  assertEqual(at, null, "exactly at the share is not a finding");
  const over = INV.unsustainableSpawn(spawn({ workParts: 11 }));
  assertTrue(over !== null, "above it is");
});

test("zero income still reports a discretionary body", () => {
  const why = INV.unsustainableSpawn(spawn({ workParts: 6, incomePerTick: 0 }));
  assertTrue(why !== null, "any ongoing burn is unsustainable against no income");
});

// ============================================================================
// Recording
// ============================================================================

test("a finding is recorded and readable per room", () => {
  INV.record({ type: "UNSUSTAINABLE_SPAWN", room: "E46N37", detail: "x", tick: 500000 });
  assertEqual(INV.get().length, 1, "stored");
  assertEqual(INV.forRoom("E46N37").length, 1, "found by room");
  assertEqual(INV.forRoom("E43N39").length, 0, "not attributed to another room");
});

test("re-committing the same decision replaces rather than accumulates", () => {
  INV.record({ type: "UNSUSTAINABLE_SPAWN", room: "E46N37", detail: "first", tick: 500000 });
  INV.record({ type: "UNSUSTAINABLE_SPAWN", room: "E46N37", detail: "second", tick: 500100 });
  assertEqual(INV.get().length, 1, "one entry per type per room");
  assertEqual(INV.get()[0].detail, "second", "newest wins");
});

test("findings age out", () => {
  INV.record({ type: "UNSUSTAINABLE_SPAWN", room: "E46N37", detail: "old", tick: 100 });
  g.Game.time = 500000;
  INV.prune();
  assertEqual(INV.get().length, 0, "a claim about a past decision expires on age alone");
});

test("a recent finding survives pruning", () => {
  INV.record({ type: "UNSUSTAINABLE_SPAWN", room: "E46N37", detail: "new", tick: 499900 });
  g.Game.time = 500000;
  INV.prune();
  assertEqual(INV.get().length, 1, "still current");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
