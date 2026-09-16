/**
 * Unit tests for hauler delivery scoring.
 *
 * Run with: npm run test:unit
 *
 * The central case is the one that made this module shared: RemoteHauler's own chain
 * returned storage whenever storage had any free capacity, so an empty spawn two tiles
 * away never saw a delivery in any room that owned storage. The rest cover the branches
 * that chain could never reach, and the terminal direction both sides must agree on.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

// ============================================================================
// Mocks
// ============================================================================

g.RESOURCE_ENERGY = "energy";
g.FIND_STRUCTURES = 107;
g.FIND_MY_STRUCTURES = 108;
g.FIND_SOURCES = 105;
g.FIND_MY_CREEPS = 102;
g.STRUCTURE_CONTAINER = "container";
g.STRUCTURE_TERMINAL = "terminal";
g.STRUCTURE_STORAGE = "storage";
g.STRUCTURE_SPAWN = "spawn";
g.STRUCTURE_EXTENSION = "extension";
g.STRUCTURE_TOWER = "tower";
g.STRUCTURE_LINK = "link";
g.Game = { time: 300000, creeps: {}, map: { getRoomLinearDistance: () => 3 } };
g.Memory = {};

/** Net energy flow per room - stands in for EconomyTracker, the single solvency owner. */
const mockFlow: Record<string, number> = {};

const EconomyTracker = require("../../src/core/EconomyTracker");
EconomyTracker.getColonyEconomy = (room: any) => ({
  netFlow: mockFlow[room.name] !== undefined ? mockFlow[room.name] : 5,
  stored: room.storage ? room.storage.store.energy : 0,
});

const HD = require("../../src/creeps/haulerDelivery");
const TM = require("../../src/structures/TerminalManager");

// ============================================================================
// Fixtures
// ============================================================================

function pos(x: number, y: number) {
  return {
    x,
    y,
    getRangeTo: (t: any) => {
      const p = t && t.pos ? t.pos : t;
      return Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
    },
  };
}

function struct(id: string, type: string, x: number, y: number, energy: number, cap: number): any {
  return {
    id,
    structureType: type,
    x,
    y,
    pos: pos(x, y),
    store: {
      energy,
      getFreeCapacity: () => cap - energy,
      getCapacity: () => cap,
    },
  };
}

interface RoomOpts {
  name?: string;
  owned?: any[];
  /** Containers within range 3 of the controller. */
  ctrlContainers?: any[];
  sources?: Array<[number, number]>;
  available?: number;
  capacity?: number;
  fillers?: number;
  netFlow?: number;
}

function makeRoom(o: RoomOpts = {}): any {
  const name = o.name || "E46N37";
  mockFlow[name] = o.netFlow !== undefined ? o.netFlow : 5;
  const owned = o.owned || [];
  const sources = (o.sources || [[40, 40]]).map(([x, y]) => ({ pos: pos(x, y) }));

  const room: any = {
    name,
    energyAvailable: o.available !== undefined ? o.available : 1000,
    energyCapacityAvailable: o.capacity !== undefined ? o.capacity : 2000,
  };

  room.storage = owned.filter((s) => s.structureType === "storage")[0];
  room.terminal = owned.filter((s) => s.structureType === "terminal")[0];

  room.controller = {
    my: true,
    pos: Object.assign(pos(10, 10), {
      findInRange: (_type: number, _range: number, opts?: { filter?: (x: any) => boolean }) => {
        const pool = o.ctrlContainers || [];
        return opts && opts.filter ? pool.filter(opts.filter) : pool;
      },
    }),
  };

  const fillerCreeps: any[] = [];
  for (let i = 0; i < (o.fillers || 0); i++) {
    fillerCreeps.push({ memory: { role: "FILLER" }, ticksToLive: 900 });
  }

  room.find = (type: number, opts?: { filter?: (x: any) => boolean }) => {
    let pool: any[] = [];
    if (type === g.FIND_MY_STRUCTURES) pool = owned;
    else if (type === g.FIND_SOURCES) pool = sources;
    else if (type === g.FIND_MY_CREEPS) pool = fillerCreeps;
    return opts && opts.filter ? pool.filter(opts.filter) : pool;
  };
  return room;
}

function makeCreep(room: any, x: number, y: number): any {
  return { name: "HAULER_test", room, pos: pos(x, y), memory: { role: "HAULER" } };
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

console.log("\n=== Hauler delivery scoring ===\n");

// ============================================================================
// The defect this module exists to end
// ============================================================================

test("an empty spawn outranks a storage with free capacity", () => {
  // RemoteHauler's Priority 1 returned storage whenever it had any free capacity. Storage
  // holds 1,000,000, so it effectively always did, and every branch below it was dead.
  const room = makeRoom({
    owned: [
      struct("stor", "storage", 11, 10, 400000, 1000000),
      struct("spawn", "spawn", 20, 10, 0, 300),
    ],
    available: 0,
    capacity: 300,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertTrue(!!best, "something should be chosen");
  assertEqual(best.target.id, "spawn", "the spawn is fed first, even though storage is nearer");
});

test("storage still wins when the spawn network is already full", () => {
  const room = makeRoom({
    owned: [
      struct("stor", "storage", 30, 10, 400000, 1000000),
      struct("spawn", "spawn", 11, 10, 300, 300),
    ],
    available: 300,
    capacity: 300,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertTrue(!!best, "storage is never unreachable");
  assertEqual(best.target.id, "stor", "a full spawn is not a candidate at all");
});

// ============================================================================
// Ordering that used to be control flow
// ============================================================================

test("a tower that cannot defend outranks everything", () => {
  const room = makeRoom({
    owned: [
      struct("tower", "tower", 40, 40, 100, 1000),
      struct("spawn", "spawn", 11, 10, 0, 300),
      struct("stor", "storage", 11, 11, 0, 1000000),
    ],
    available: 0,
    capacity: 300,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "tower", "defence first, distance notwithstanding");
});

test("a topped-up tower does not capture deliveries", () => {
  // The old chain had a "below 500" test, so a tower parked at 490 took every delivery
  // forever. At 810 it is ordinary filler work and loses to an empty spawn.
  const room = makeRoom({
    owned: [
      struct("tower", "tower", 11, 10, 810, 1000),
      struct("spawn", "spawn", 20, 10, 0, 300),
    ],
    available: 0,
    capacity: 300,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "spawn", "the spawn needs it more");
});

test("the controller container is reachable, unlike under the old chain", () => {
  const ctrl = struct("ctrl", "container", 12, 10, 0, 2000);
  const room = makeRoom({
    owned: [struct("stor", "storage", 11, 10, 400000, 1000000), struct("spawn", "spawn", 11, 11, 300, 300)],
    ctrlContainers: [ctrl],
    sources: [[40, 40]],
    available: 300,
    capacity: 300,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "ctrl", "the only sink that produces RCL beats the buffer");
});

test("a source container is never a delivery target", () => {
  // Delivering into one lets a hauler withdraw and immediately deposit into the same
  // structure - the withdraw/deposit loop that cost E47N41 a hauler for 100+ ticks.
  const srcContainer = struct("srcc", "container", 41, 40, 0, 2000);
  const room = makeRoom({
    owned: [struct("stor", "storage", 30, 30, 0, 1000000)],
    ctrlContainers: [srcContainer],
    sources: [[40, 40]],
    available: 300,
    capacity: 300,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "stor", "the source container is excluded from the option set");
});

test("links are not offered - they belong to LINK_FILLER", () => {
  const room = makeRoom({
    owned: [struct("link", "link", 11, 10, 0, 800)],
    available: 300,
    capacity: 300,
  });
  assertEqual(HD.scoreDeliveryTargets(makeCreep(room, 10, 10)), null, "no candidates at all");
});

// ============================================================================
// Filler interaction
// ============================================================================

test("a filler that is keeping up deprioritises the spawn network", () => {
  // Same geometry as the test below, so the filler is the only variable: storage adjacent,
  // extension across the room. The deprioritisation is deliberately mild (12 against
  // storage's 10, not zero), so it only decides cases distance does not already settle.
  const room = makeRoom({
    owned: [
      struct("stor", "storage", 11, 10, 400000, 1000000),
      struct("ext", "extension", 30, 10, 0, 200),
    ],
    fillers: 1,
    available: 1800,
    capacity: 2000,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "stor", "the hauler leaves the fill loop to the filler");
});

test("a nearby empty extension still wins even while the filler copes", () => {
  // The deprioritisation must not become an exclusion. base 12 is small but real, so an
  // adjacent empty extension outranks a distant storage - the filler is preferred, not
  // made the only one allowed.
  const room = makeRoom({
    owned: [
      struct("stor", "storage", 30, 10, 400000, 1000000),
      struct("ext", "extension", 11, 10, 0, 200),
    ],
    fillers: 1,
    available: 1800,
    capacity: 2000,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "ext", "energy underfoot goes where it is needed");
});

test("a filler that has fallen behind does not block haulers", () => {
  // base 0 for spawn/extensions turned "the filler is preferred" into "the filler is the
  // only one allowed", and E43N39 sat with 586,590 in storage and 19 empty extensions.
  const room = makeRoom({
    owned: [
      struct("stor", "storage", 11, 10, 400000, 1000000),
      struct("ext", "extension", 30, 10, 0, 200),
    ],
    fillers: 1,
    available: 400,
    capacity: 2000,
  });
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "ext", "haulers resume filling when the room is short");
});

// ============================================================================
// Terminal direction - both sides read terminalFlow()
// ============================================================================

test("a draining terminal is not a delivery target", () => {
  const room = makeRoom({
    name: "E47N41",
    owned: [
      struct("term", "terminal", 11, 10, 3000, 300000),
      struct("stor", "storage", 30, 30, 0, 1000000),
    ],
    available: 300,
    capacity: 300,
  });
  assertEqual(TM.terminalFlow(room), "drain", "precondition: a recipient spends what it got");
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "stor", "delivery must not refill what collection is draining");
});

test("a filling terminal outranks topping up a deep storage", () => {
  const room = makeRoom({
    owned: [
      struct("term", "terminal", 20, 10, 3000, 300000),
      struct("stor", "storage", 11, 10, 30000, 1000000),
    ],
    available: 300,
    capacity: 300,
  });
  assertEqual(TM.terminalFlow(room), "fill", "precondition: a sender below the cap fills");
  const best = HD.scoreDeliveryTargets(makeCreep(room, 10, 10));
  assertEqual(best.target.id, "term", "an unusable terminal is 100,000 energy wasted");
});

// ============================================================================
// Nothing to do
// ============================================================================

test("returns null when every sink is full", () => {
  const room = makeRoom({
    owned: [struct("spawn", "spawn", 11, 10, 300, 300), struct("stor", "storage", 12, 10, 1000000, 1000000)],
    available: 300,
    capacity: 300,
  });
  assertEqual(HD.scoreDeliveryTargets(makeCreep(room, 10, 10)), null, "the caller parks instead");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
