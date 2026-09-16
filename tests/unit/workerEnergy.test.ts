/**
 * Unit tests for worker energy collection scoring.
 *
 * Run with: npm run test:unit
 *
 * Three roles carried three copies of this chain and two opened with "storage, if it holds
 * more than 1,000" - so in any developed room the container and dropped-energy branches
 * below were unreachable, and dropped energy decayed while a worker walked to storage.
 * RemoteBuilder carried a fourth copy as a release check, with a comment warning what
 * happens when the two disagree.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

g.RESOURCE_ENERGY = "energy";
g.FIND_STRUCTURES = 107;
g.FIND_DROPPED_RESOURCES = 106;
g.FIND_SOURCES_ACTIVE = 104;
g.FIND_TOMBSTONES = 118;
g.FIND_RUINS = 123;
g.STRUCTURE_CONTAINER = "container";
g.STRUCTURE_STORAGE = "storage";
g.Game = { time: 400000, creeps: {} };
g.Memory = {};

const WE = require("../../src/creeps/workerEnergy");

// ============================================================================
// Fixtures
// ============================================================================

function container(id: string, x: number, y: number, energy: number): any {
  return { id, x, y, structureType: "container", pos: { x, y }, store: { energy } };
}

function drop(id: string, x: number, y: number, amount: number): any {
  return { id, x, y, resourceType: "energy", amount, pos: { x, y } };
}

interface RoomOpts {
  name?: string;
  storage?: number | null;
  storAt?: [number, number];
  containers?: any[];
  drops?: any[];
  tombs?: any[];
  ruins?: any[];
  source?: { x: number; y: number; energy: number };
}

function makeRoom(o: RoomOpts = {}): any {
  const [sx, sy] = o.storAt || [30, 30];
  const room: any = {
    name: o.name || "E47N41",
    storage:
      o.storage === null || o.storage === undefined
        ? undefined
        : { id: "stor", x: sx, y: sy, structureType: "storage", pos: { x: sx, y: sy }, store: { energy: o.storage } },
  };
  room._source = o.source;
  room.find = (type: number, opts?: { filter?: (x: any) => boolean }) => {
    let pool: any[] = [];
    if (type === g.FIND_STRUCTURES) pool = (o.containers || []).concat(room.storage ? [room.storage] : []);
    else if (type === g.FIND_DROPPED_RESOURCES) pool = o.drops || [];
    else if (type === g.FIND_TOMBSTONES) pool = o.tombs || [];
    else if (type === g.FIND_RUINS) pool = o.ruins || [];
    return opts && opts.filter ? pool.filter(opts.filter) : pool;
  };
  return room;
}

function makeCreep(room: any, x: number, y: number, free = 1000): any {
  return {
    name: "BUILDER_test",
    room,
    memory: { role: "BUILDER", room: room.name },
    store: { getFreeCapacity: () => free },
    pos: {
      x,
      y,
      getRangeTo: (t: any) => {
        const p = t.pos || t;
        return Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
      },
      findClosestByRange: (_type: number) => {
        const s = room._source;
        return s ? { id: "src", x: s.x, y: s.y, pos: { x: s.x, y: s.y }, energy: s.energy } : null;
      },
    },
  };
}

// ============================================================================
// Harness
// ============================================================================

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

console.log("\n=== Worker energy scoring ===\n");

// ============================================================================
// The dead branches
// ============================================================================

test("dropped energy underfoot beats a full storage across the room", () => {
  // The chain went to storage first whenever it held over 1,000, so this pile decayed.
  const room = makeRoom({ storage: 400000, storAt: [40, 40], drops: [drop("d1", 11, 10, 400)] });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), { allowHarvest: true });
  assertTrue(!!best, "something should be chosen");
  assertEqual(best.target.id, "d1", "take what is decaying first");
  assertEqual(best.kind, "pickup", "drops are picked up");
});

test("a full container nearby beats a full storage far away", () => {
  const room = makeRoom({ storage: 400000, storAt: [40, 40], containers: [container("c1", 12, 10, 1800)] });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), { allowHarvest: true });
  assertEqual(best.target.id, "c1", "the container branch is reachable now");
});

test("storage below the old 1,000 floor is still offered", () => {
  // A hard floor means "no source at all" the moment storage dips under it - the shape
  // that left E46N37's haulers parked while extensions sat empty.
  const room = makeRoom({ storage: 900, storAt: [11, 10] });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), { allowHarvest: false });
  assertTrue(!!best, "900 energy is still energy");
  assertEqual(best.target.id, "stor", "it loses on supply, it does not vanish");
});

test("an empty storage is not a candidate", () => {
  const room = makeRoom({ storage: 0, storAt: [11, 10] });
  assertEqual(WE.scoreWorkerEnergy(makeCreep(room, 10, 10), {}), null, "nothing to withdraw");
});

// ============================================================================
// Harvest fallback
// ============================================================================

test("harvest is available when allowed and nothing else holds energy", () => {
  const room = makeRoom({ storage: 0, source: { x: 14, y: 10, energy: 3000 } });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), { allowHarvest: true });
  assertTrue(!!best, "a worker that can harvest is never stranded");
  assertEqual(best.kind, "harvest", "falls back to the source");
});

test("harvest is withheld from a worker that must not mine here", () => {
  // A remote builder should head home, not start mining in someone else's room.
  const room = makeRoom({ storage: 0, source: { x: 14, y: 10, energy: 3000 } });
  assertEqual(WE.scoreWorkerEnergy(makeCreep(room, 10, 10), { allowHarvest: false }), null, "go home");
});

test("a stocked container outranks harvesting beside it", () => {
  const room = makeRoom({
    storage: 0,
    containers: [container("c1", 12, 10, 1500)],
    source: { x: 11, y: 10, energy: 3000 },
  });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), { allowHarvest: true });
  assertEqual(best.target.id, "c1", "mining by hand is the last resort");
});

// ============================================================================
// Thresholds and the release check
// ============================================================================

test("piles and containers below the minimum are ignored", () => {
  const room = makeRoom({
    storage: 0,
    containers: [container("c1", 11, 10, WE.MIN_CONTAINER)],
    drops: [drop("d1", 11, 11, WE.MIN_PICKUP - 1)],
  });
  assertEqual(WE.scoreWorkerEnergy(makeCreep(room, 10, 10), {}), null, "not worth the trip");
});

test("a tombstone is collected, and outranks equal dropped energy", () => {
  // Tombstones and ruins were Pioneer's alone. Folding them in is what let its five-tier
  // chain be replaced without losing capability - and it gives builders a recovery path
  // they never had: a dead hauler's load used to decay untouched.
  const room = makeRoom({
    storage: 0,
    tombs: [{ id: "t1", x: 12, y: 10, pos: { x: 12, y: 10 }, store: { energy: 600 } }],
    drops: [drop("d1", 12, 10, 600)],
  });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), {});
  assertEqual(best.target.id, "t1", "the tombstone expires outright");
  assertEqual(best.kind, "withdraw", "tombstones are withdrawn from");
});

test("a ruin is collected when nothing better is around", () => {
  const room = makeRoom({
    storage: 0,
    ruins: [{ id: "r1", x: 12, y: 10, pos: { x: 12, y: 10 }, store: { energy: 900 } }],
  });
  const best = WE.scoreWorkerEnergy(makeCreep(room, 10, 10), {});
  assertEqual(best.target.id, "r1", "free energy is free energy");
});

test("a nearly-empty tombstone is not worth the trip", () => {
  const room = makeRoom({
    storage: 0,
    tombs: [{ id: "t1", x: 12, y: 10, pos: { x: 12, y: 10 }, store: { energy: WE.MIN_PICKUP - 1 } }],
  });
  assertEqual(WE.scoreWorkerEnergy(makeCreep(room, 10, 10), {}), null, "below the minimum");
});

test("another room can be asked whether it holds anything", () => {
  // RemoteBuilder's release check: "would there be anything to collect if I went home".
  // Same function as the collecting, so the two cannot drift apart.
  const home = makeRoom({ name: "E43N39", containers: [container("hc", 25, 25, 1200)] });
  const away = makeRoom({ name: "E41N39", storage: 0 });
  const creep = makeCreep(away, 10, 10);
  assertTrue(!!WE.scoreWorkerEnergy(creep, { room: home }), "home has energy");
  assertEqual(WE.scoreWorkerEnergy(creep, { room: away }), null, "the remote does not");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
