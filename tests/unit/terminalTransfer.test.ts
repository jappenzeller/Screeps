/**
 * Unit tests for terminal transfer planning.
 *
 * Run with: npm run test:unit
 *
 * These exercise the decision logic with mock rooms - who gives, who receives, how much,
 * and the cases where nothing should happen. The cases worth testing here are the ones
 * this codebase has actually got wrong before: a threshold so high it never fires, a
 * branch chain that always picks the same partner, a gate with no release, and a rich
 * room giving away energy it is in fact losing.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

// No `declare const global/console/process` here. The older tests in this directory do
// that and no longer compile under current @types/node - TS2451, redeclared block-scoped
// variable - which is why they silently produce no output.
const g = global as any;

// ============================================================================
// Mocks
// ============================================================================

g.RESOURCE_ENERGY = "energy";
g.Game = {
  time: 100000,
  rooms: {},
  map: {
    getRoomLinearDistance: (a: string, b: string) => {
      const pa = a.match(/([EW])(\d+)([NS])(\d+)/);
      const pb = b.match(/([EW])(\d+)([NS])(\d+)/);
      if (!pa || !pb) return 50;
      const dx = Math.abs(parseInt(pb[2]) - parseInt(pa[2]));
      const dy = Math.abs(parseInt(pb[4]) - parseInt(pa[4]));
      return Math.max(dx, dy);
    },
  },
};
g.Memory = {};

/** Net energy flow per room, keyed by name - stands in for EconomyTracker. */
const mockFlow: Record<string, number> = {};

// EconomyTracker is the single owner of solvency; the planner must consult it rather
// than re-deriving affordability, so the mock is injected at that seam.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const EconomyTracker = require("../../src/core/EconomyTracker");
EconomyTracker.getColonyEconomy = (room: any) => ({
  netFlow: mockFlow[room.name] !== undefined ? mockFlow[room.name] : 5,
  stored: room.storage ? room.storage.store.energy : 0,
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TM = require("../../src/structures/TerminalManager");

// ============================================================================
// Helpers
// ============================================================================

interface MockOpts {
  storage?: number;
  terminal?: number;
  cooldown?: number;
  available?: number;
  capacity?: number;
  netFlow?: number;
  mine?: boolean;
  hasTerminal?: boolean;
}

function mockRoom(name: string, o: MockOpts = {}): any {
  const hasTerminal = o.hasTerminal !== false;
  mockFlow[name] = o.netFlow !== undefined ? o.netFlow : 5;

  return {
    name,
    controller: { my: o.mine !== false },
    storage: { store: { energy: o.storage || 0 } },
    terminal: hasTerminal
      ? { store: { energy: o.terminal || 0 }, cooldown: o.cooldown || 0 }
      : undefined,
    energyAvailable: o.available !== undefined ? o.available : 1000,
    energyCapacityAvailable: o.capacity !== undefined ? o.capacity : 2000,
  };
}

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

console.log("\n=== Terminal transfer planning ===\n");

// ============================================================================
// Surplus: who is allowed to give
// ============================================================================

test("a rich, solvent room has surplus above the floor", () => {
  const room = mockRoom("E43N39", { storage: 46000, netFlow: 5 });
  assertEqual(TM.surplusOf(room), 46000 - TM.SENDER_MIN_STORAGE, "surplus is storage above the floor");
});

test("a rich room that is LOSING energy has no surplus", () => {
  // The bank is what is keeping it alive. Storage alone is not solvency - this is the
  // distinction the upgrader cap had to learn twice.
  const room = mockRoom("E43N39", { storage: 46000, netFlow: -20 });
  assertEqual(TM.surplusOf(room), 0, "negative flow means nothing to give");
});

test("a room below the storage floor has no surplus", () => {
  const room = mockRoom("E43N39", { storage: TM.SENDER_MIN_STORAGE - 1, netFlow: 50 });
  assertEqual(TM.surplusOf(room), 0, "below the floor, keep it");
});

test("a room with no terminal has no surplus", () => {
  const room = mockRoom("E43N39", { storage: 46000, hasTerminal: false });
  assertEqual(TM.surplusOf(room), 0, "cannot send without a terminal");
});

// ============================================================================
// Need: who should receive, and how urgently
// ============================================================================

test("an empty room needs energy", () => {
  const room = mockRoom("E47N41", { storage: 0, available: 300, capacity: 4600 });
  assertTrue(TM.needOf(room) > 0, "zero storage and empty extensions is a need");
});

test("empty extensions outrank an empty bank", () => {
  // Replacing creeps is what stops a decline; a bank that refills slowly does not.
  const starving = mockRoom("A", { storage: 0, available: 100, capacity: 4600 });
  const idle = mockRoom("B", { storage: 0, available: 4600, capacity: 4600 });
  assertTrue(TM.needOf(starving) > TM.needOf(idle), "the room that cannot spawn needs it more");
});

test("a room with a healthy bank does not need a handout", () => {
  const room = mockRoom("E43N39", { storage: TM.RECIPIENT_MAX_STORAGE + 1 });
  assertEqual(TM.needOf(room), 0, "it can wait for its own income");
});

// ============================================================================
// Cost
// ============================================================================

test("send cost grows with distance and is charged on top", () => {
  const near = TM.sendCost(10000, "E43N39", "E46N37");
  const far = TM.sendCost(10000, "E43N39", "E47N41");
  assertTrue(far > near, "further costs more");
  assertTrue(near > 0 && near < 10000, "cost is a fraction of the amount");
});

// ============================================================================
// Planning: the whole decision
// ============================================================================

test("plans a transfer from the rich room to the starving one", () => {
  const rooms = [
    mockRoom("E43N39", { storage: 46000, terminal: 12000 }),
    mockRoom("E47N41", { storage: 0, available: 300, capacity: 4600 }),
  ];
  const plan = TM.planTransfer(rooms);
  assertTrue(!!plan, "a plan should exist");
  assertEqual(plan.from, "E43N39", "rich room sends");
  assertEqual(plan.to, "E47N41", "starving room receives");
  assertTrue(plan.amount >= TM.MIN_SEND, "sends a worthwhile amount");
  assertTrue(plan.amount <= TM.MAX_SEND, "respects the per-send cap");
});

test("picks the needier of two candidates rather than the first", () => {
  // A branch chain would take whichever room it happened to visit first. Both are at
  // zero storage; only the extension fill separates them.
  const rooms = [
    mockRoom("E43N39", { storage: 46000, terminal: 12000 }),
    mockRoom("E46N37", { storage: 0, available: 5600, capacity: 5600 }),
    mockRoom("E47N41", { storage: 0, available: 200, capacity: 4600 }),
  ];
  const plan = TM.planTransfer(rooms);
  assertTrue(!!plan, "a plan should exist");
  assertEqual(plan.to, "E47N41", "the room that cannot spawn wins");
});

test("never sends more than the terminal actually holds", () => {
  const rooms = [
    mockRoom("E43N39", { storage: 46000, terminal: TM.MIN_SEND + 500 }),
    mockRoom("E47N41", { storage: 0, available: 100, capacity: 4600 }),
  ];
  const plan = TM.planTransfer(rooms);
  assertTrue(!!plan, "a plan should exist");
  assertEqual(plan.amount, TM.MIN_SEND + 500, "bounded by terminal contents, not by storage");
});

test("no plan while the terminal is on cooldown", () => {
  const rooms = [
    mockRoom("E43N39", { storage: 46000, terminal: 12000, cooldown: 7 }),
    mockRoom("E47N41", { storage: 0, available: 100, capacity: 4600 }),
  ];
  assertEqual(TM.planTransfer(rooms), null, "cooldown blocks the send");
});

test("no plan when every room is poor", () => {
  const rooms = [
    mockRoom("E46N37", { storage: 0, available: 100, capacity: 5600 }),
    mockRoom("E47N41", { storage: 0, available: 100, capacity: 4600 }),
  ];
  assertEqual(TM.planTransfer(rooms), null, "nothing to share");
});

test("no plan when nobody needs anything", () => {
  const rooms = [
    mockRoom("E43N39", { storage: 46000, terminal: 12000 }),
    mockRoom("E46N37", { storage: 40000, terminal: 8000 }),
  ];
  assertEqual(TM.planTransfer(rooms), null, "both are comfortable");
});

test("a room is never chosen to send to itself", () => {
  const rooms = [mockRoom("E43N39", { storage: 46000, terminal: 12000, available: 0, capacity: 2000 })];
  assertEqual(TM.planTransfer(rooms), null, "self-transfer is not a transfer");
});

test("rooms that are not ours are ignored entirely", () => {
  const rooms = [
    mockRoom("E43N39", { storage: 46000, terminal: 12000 }),
    mockRoom("E44N40", { storage: 0, available: 0, capacity: 4600, mine: false }),
  ];
  assertEqual(TM.planTransfer(rooms), null, "do not gift a neighbour");
});

// ============================================================================
// Terminal flow - the one answer hauler collection and delivery both read
// ============================================================================

test("a sender below the cap fills", () => {
  const room = mockRoom("E43N39", { storage: 46000, terminal: 0 });
  assertEqual(TM.terminalFlow(room), "fill", "a terminal that cannot send is dead weight");
});

test("a sender at the cap holds, and over it drains only the excess", () => {
  const atCap = mockRoom("E43N39", { storage: 46000, terminal: TM.TERMINAL_MAX });
  assertEqual(TM.terminalFlow(atCap), "hold", "the cap releases the fill");
  const overCap = mockRoom("E43N39", { storage: 46000, terminal: TM.TERMINAL_MAX + 1 });
  assertEqual(TM.terminalFlow(overCap), "drain", "only what is over the cap is shed");
});

test("a sender stops filling once storage is down to its working floor", () => {
  // Upgraders and builders draw from storage, not the terminal. The room is still a
  // sender by its whole bank, but pulling more into the terminal would starve them.
  const room = mockRoom("E43N39", { storage: TM.SENDER_MIN_STORAGE - 1, terminal: 8000 });
  assertTrue(TM.surplusOf(room) > 0, "precondition: still a sender by its whole bank");
  assertEqual(TM.terminalFlow(room), "hold", "hold rather than drain storage further");
});

test("a recipient drains what it was sent, and never stocks", () => {
  const sent = mockRoom("E46N37", { storage: 0, terminal: 15000 });
  assertEqual(TM.terminalFlow(sent), "drain", "spend the delivery");
  const empty = mockRoom("E47N41", { storage: 0, terminal: 0 });
  assertEqual(TM.terminalFlow(empty), "hold", "an empty recipient terminal is left alone");
});

test("both old overlap bands now resolve to exactly one direction", () => {
  // Recipient 0-5,000 and sender 5,000-25,000: in each band both old predicates said
  // yes, and E46N37's haulers hovered at the terminal carrying nothing, flagged FLAP.
  const recipient = mockRoom("E46N37", { storage: 0, terminal: 3000 });
  assertEqual(TM.terminalFlow(recipient), "drain", "recipient band drains, never fills");
  const sender = mockRoom("E43N39", { storage: 46000, terminal: 12000 });
  assertEqual(TM.terminalFlow(sender), "fill", "sender band fills, never drains");
});

test("moving energy between storage and terminal does not flip a sender's role", () => {
  // The same 30,000 bank split two ways. Counting storage alone, the second split would
  // demote the room and its terminal would drain straight back into storage.
  const before = mockRoom("E43N39", { storage: 26000, terminal: 4000 });
  const after = mockRoom("E43N39", { storage: 19000, terminal: 11000 });
  assertEqual(TM.surplusOf(before), TM.surplusOf(after), "surplus is the whole bank");
  assertTrue(TM.surplusOf(after) > 0, "still a sender after filling its terminal");
});

test("a room that just received a transfer does not pass it straight on", () => {
  g.Memory._terminal = [
    { tick: g.Game.time - 100, from: "E43N39", to: "E46N37", amount: 10000, cost: 952 },
  ];
  const room = mockRoom("E46N37", { storage: 0, terminal: 30000 });
  assertEqual(TM.surplusOf(room), 0, "no surplus inside the holdoff");
  assertEqual(TM.terminalFlow(room), "drain", "it spends the delivery instead");
  g.Memory._terminal = [];
});

test("the receive holdoff expires", () => {
  g.Memory._terminal = [
    { tick: g.Game.time - TM.RECEIVE_HOLDOFF - 1, from: "E43N39", to: "E46N37", amount: 10000, cost: 952 },
  ];
  const room = mockRoom("E46N37", { storage: 0, terminal: 30000 });
  assertTrue(TM.surplusOf(room) > 0, "a release condition, not a permanent ban");
  g.Memory._terminal = [];
});

test("delivered energy counts against need", () => {
  // E46N37 took three 10,000 sends, reached 30,000 in its terminal, and still reported a
  // need of 2.15 because need was measured from storage and extensions alone.
  const room = mockRoom("E46N37", { storage: 0, terminal: 30000, available: 100, capacity: 5600 });
  assertEqual(TM.needOf(room), 0, "a full terminal is delivered energy, not an empty room");
});

// ============================================================================

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
