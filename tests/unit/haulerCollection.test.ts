/**
 * Unit tests for hauler collection scoring.
 *
 * Run with: npm run test:unit
 *
 * The cases that matter are the ones collection has actually got wrong: a tier that could
 * always match starving the tier below it (twice, in one feature), a hauler withdrawing
 * from a terminal the delivery side is filling, and storage pulled from only to be
 * delivered straight back into.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

// ============================================================================
// Mocks
// ============================================================================

g.RESOURCE_ENERGY = "energy";
g.FIND_STRUCTURES = 107;
g.FIND_SOURCES = 105;
g.FIND_DROPPED_RESOURCES = 106;
g.FIND_TOMBSTONES = 118;
g.STRUCTURE_CONTAINER = "container";
g.STRUCTURE_TERMINAL = "terminal";
g.STRUCTURE_STORAGE = "storage";
g.Game = { time: 200000, creeps: {}, map: { getRoomLinearDistance: () => 3 } };
g.Memory = {};

/** Net energy flow per room - stands in for EconomyTracker, the single solvency owner. */
const mockFlow: Record<string, number> = {};

const EconomyTracker = require("../../src/core/EconomyTracker");
EconomyTracker.getColonyEconomy = (room: any) => ({
  netFlow: mockFlow[room.name] !== undefined ? mockFlow[room.name] : 5,
  stored: room.storage ? room.storage.store.energy : 0,
});

const HC = require("../../src/creeps/haulerCollection");
const TM = require("../../src/structures/TerminalManager");

// ============================================================================
// Fixtures
// ============================================================================

function container(id: string, x: number, y: number, energy: number, sourceAdjacent = true): any {
  return {
    id,
    x,
    y,
    structureType: "container",
    store: { energy },
    pos: { findInRange: () => (sourceAdjacent ? [{}] : []) },
  };
}

function drop(id: string, x: number, y: number, amount: number): any {
  return { id, x, y, resourceType: "energy", amount };
}

interface RoomOpts {
  name?: string;
  storage?: number | null;
  terminal?: number | null;
  available?: number;
  capacity?: number;
  containers?: any[];
  drops?: any[];
  tombs?: any[];
  netFlow?: number;
  termAt?: [number, number];
  storAt?: [number, number];
}

function makeRoom(o: RoomOpts = {}): any {
  const name = o.name || "E46N37";
  mockFlow[name] = o.netFlow !== undefined ? o.netFlow : 5;
  const [tx, ty] = o.termAt || [25, 25];
  const [sx, sy] = o.storAt || [26, 26];

  const room: any = {
    name,
    controller: { my: true },
    terminal:
      o.terminal === null || o.terminal === undefined
        ? undefined
        : { id: "term", x: tx, y: ty, structureType: "terminal", store: { energy: o.terminal } },
    storage:
      o.storage === null
        ? undefined
        : { id: "stor", x: sx, y: sy, structureType: "storage", store: { energy: o.storage || 0 } },
    energyAvailable: o.available !== undefined ? o.available : 1000,
    energyCapacityAvailable: o.capacity !== undefined ? o.capacity : 2000,
  };

  const containers = o.containers || [];
  room.find = (type: number, opts?: { filter?: (x: any) => boolean }) => {
    let pool: any[] = [];
    if (type === g.FIND_STRUCTURES) {
      pool = containers.concat(room.terminal ? [room.terminal] : [], room.storage ? [room.storage] : []);
    } else if (type === g.FIND_DROPPED_RESOURCES) {
      pool = o.drops || [];
    } else if (type === g.FIND_TOMBSTONES) {
      pool = o.tombs || [];
    }
    return opts && opts.filter ? pool.filter(opts.filter) : pool;
  };
  return room;
}

function makeCreep(
  room: any,
  x: number,
  y: number,
  o: { free?: number; targetContainer?: string; name?: string } = {}
): any {
  return {
    name: o.name || "HAULER_test",
    room,
    pos: { x, y, getRangeTo: (t: any) => Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) },
    store: { getFreeCapacity: () => (o.free !== undefined ? o.free : 1200) },
    memory: { role: "HAULER", state: "COLLECTING", targetContainer: o.targetContainer },
  };
}

// ============================================================================
// Harness
// ============================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  g.Game.creeps = {};
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

console.log("\n=== Hauler collection scoring ===\n");

// ============================================================================
// The defects this conversion exists to end
// ============================================================================

test("a large delivered pile outranks the container the hauler is parked beside", () => {
  // The exact shape that starved the terminal drain twice: a hauler adjacent to its own
  // assigned source container, which holds a trickle and refills at 10/tick.
  const room = makeRoom({
    storage: 0,
    terminal: 19000,
    termAt: [20, 20],
    containers: [container("c1", 11, 10, 10)],
  });
  const creep = makeCreep(room, 10, 10, { targetContainer: "c1" });
  const choice = HC.scoreCollectionSources(creep);
  assertTrue(!!choice, "something should be chosen");
  assertEqual(choice.target.id, "term", "the delivered pile wins");
});

test("a terminal the delivery side is filling is never a collection source", () => {
  // A sender's terminal, one tile away and holding energy, against a container eight
  // tiles off. If collection could take it, the hauler would drain what delivery fills.
  const room = makeRoom({
    storage: 30000,
    terminal: 3000,
    termAt: [11, 10],
    available: 2000,
    capacity: 2000,
    containers: [container("c1", 18, 10, 500)],
  });
  assertEqual(TM.terminalFlow(room), "fill", "precondition: a sender below the cap fills");
  const choice = HC.scoreCollectionSources(makeCreep(room, 10, 10));
  assertTrue(!!choice, "something should be chosen");
  assertEqual(choice.target.id, "c1", "collection goes to the container, never the terminal");
});

test("storage is not a pickup point while the spawn network is full", () => {
  // Offered unconditionally, a hauler with nowhere to deliver but storage would withdraw
  // from storage and put it straight back.
  const room = makeRoom({
    storage: 50000,
    storAt: [12, 10],
    terminal: null,
    available: 2000,
    capacity: 2000,
  });
  assertEqual(HC.scoreCollectionSources(makeCreep(room, 10, 10)), null, "no candidates at all");
});

// ============================================================================
// Ordinary ranking
// ============================================================================

test("storage feeds haulers when the spawn network is short", () => {
  const room = makeRoom({ storage: 50000, storAt: [12, 10], terminal: null, available: 500, capacity: 2000 });
  const choice = HC.scoreCollectionSources(makeCreep(room, 10, 10));
  assertTrue(!!choice, "storage should be offered");
  assertEqual(choice.target.id, "stor", "storage is the source");
});

test("a container another hauler is collecting from loses to an equal free one", () => {
  const room = makeRoom({
    storage: 0,
    terminal: null,
    containers: [container("A", 13, 10, 1000), container("B", 7, 10, 1000)],
  });
  g.Game.creeps.other = {
    name: "other",
    memory: { role: "HAULER", state: "COLLECTING", _collectTarget: "A" },
  };
  const choice = HC.scoreCollectionSources(makeCreep(room, 10, 10));
  assertTrue(!!choice, "something should be chosen");
  assertEqual(choice.target.id, "B", "haulers spread across containers rather than queue");
});

test("a decaying drop nearby beats a distant container", () => {
  const room = makeRoom({
    storage: 0,
    terminal: null,
    containers: [container("far", 35, 10, 1000)],
    drops: [drop("d1", 12, 10, 400)],
  });
  const choice = HC.scoreCollectionSources(makeCreep(room, 10, 10));
  assertTrue(!!choice, "something should be chosen");
  assertEqual(choice.target.id, "d1", "the drop is taken before it decays");
  assertEqual(choice.kind, "pickup", "drops are picked up, not withdrawn");
});

test("a recipient's terminal in the old overlap band is drained", () => {
  // 3,000 sat inside the band where the two old predicates both answered yes.
  const room = makeRoom({ storage: 0, terminal: 3000, termAt: [14, 10], containers: [container("c1", 11, 10, 50)] });
  assertEqual(TM.terminalFlow(room), "drain", "a recipient spends what it was sent");
  const choice = HC.scoreCollectionSources(makeCreep(room, 10, 10, { targetContainer: "c1" }));
  assertEqual(choice.target.id, "term", "and collection takes it");
});

// ============================================================================
// Nothing to take
// ============================================================================

test("returns null when nothing holds energy", () => {
  const room = makeRoom({ storage: 0, terminal: null, containers: [container("c1", 11, 10, 0)] });
  assertEqual(HC.scoreCollectionSources(makeCreep(room, 10, 10)), null, "the caller falls back to positioning");
});

test("ignores drops below the minimum worth a trip", () => {
  const room = makeRoom({ storage: 0, terminal: null, drops: [drop("d1", 11, 10, HC.MIN_PICKUP - 1)] });
  assertEqual(HC.scoreCollectionSources(makeCreep(room, 10, 10)), null, "a dribble is not a target");
});

// ============================================================================
// Lease re-validation
// ============================================================================

test("a leased terminal stops being collectable when its room becomes a sender", () => {
  const sender = makeRoom({ storage: 30000, terminal: 3000 });
  assertEqual(HC.stillCollectable(sender, sender.terminal), false, "the flow flipped to fill");

  const recipient = makeRoom({ name: "E47N41", storage: 0, terminal: 3000 });
  assertEqual(HC.stillCollectable(recipient, recipient.terminal), true, "still draining");
});

test("an emptied container is no longer collectable", () => {
  const room = makeRoom({ storage: 0, terminal: null });
  assertEqual(HC.stillCollectable(room, container("c1", 11, 10, 0)), false, "nothing left");
});

test("energyIn and kindOf read every target shape", () => {
  assertEqual(HC.energyIn(drop("d", 0, 0, 300)), 300, "drop amount");
  assertEqual(HC.kindOf(drop("d", 0, 0, 300)), "pickup", "drops are picked up");
  const tomb = { id: "t", x: 0, y: 0, store: { energy: 120 } };
  assertEqual(HC.energyIn(tomb), 120, "tombstone store");
  assertEqual(HC.kindOf(tomb), "withdraw", "tombstones are withdrawn from");
});

// ============================================================================

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
