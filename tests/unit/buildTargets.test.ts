/**
 * Unit tests for construction site selection.
 *
 * Run with: npm run test:unit
 *
 * The case that matters: a builder in E47N41 sat in a dead-end pocket holding 800 energy
 * for 200 ticks, reselecting the nearest-by-straight-line extension site it could not path
 * to. Clearing its target by hand changed nothing, because the selection criterion itself
 * was the defect - range standing in for reachability.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

g.STRUCTURE_SPAWN = "spawn";
g.STRUCTURE_CONTAINER = "container";
g.STRUCTURE_EXTENSION = "extension";
g.STRUCTURE_TOWER = "tower";
g.STRUCTURE_STORAGE = "storage";
g.STRUCTURE_LINK = "link";
g.STRUCTURE_TERMINAL = "terminal";
g.STRUCTURE_LAB = "lab";
g.STRUCTURE_WALL = "constructedWall";
g.STRUCTURE_RAMPART = "rampart";
g.STRUCTURE_ROAD = "road";

const BT = require("../../src/creeps/buildTargets");

// ============================================================================
// Fixtures
// ============================================================================

/** Sites named here cannot be pathed to by the mock creep. */
let unreachable: string[] = [];

function site(id: string, type: string, x: number, y: number, room = "E47N41"): any {
  return { id, structureType: type, pos: { x, y, roomName: room } };
}

function makeCreep(x: number, y: number, room = "E47N41"): any {
  return {
    name: "BUILDER_test",
    room: { name: room },
    pos: {
      x,
      y,
      roomName: room,
      getRangeTo: (t: any) => {
        const p = t.pos || t;
        if (p.roomName && p.roomName !== room) return Infinity;
        return Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
      },
      findClosestByPath: (list: any[]) => {
        const ok = list.filter((s) => unreachable.indexOf(s.id) === -1);
        if (ok.length === 0) return null;
        ok.sort(
          (a, b) =>
            Math.max(Math.abs(a.pos.x - x), Math.abs(a.pos.y - y)) -
            Math.max(Math.abs(b.pos.x - x), Math.abs(b.pos.y - y))
        );
        return ok[0];
      },
      findPathTo: (t: any) => (unreachable.indexOf(t.id) === -1 ? [{ x: 1, y: 1 }] : []),
    },
  };
}

// ============================================================================
// Harness
// ============================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  unreachable = [];
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

console.log("\n=== Construction site selection ===\n");

// ============================================================================
// The defect
// ============================================================================

test("skips the nearest site when it cannot be reached", () => {
  // The E47N41 shape: an unreachable site 5 tiles away as the crow flies, a reachable one
  // 20 tiles off. Range alone picks the first and the builder never builds anything.
  unreachable = ["near"];
  const sites = [site("near", "extension", 15, 14), site("far", "extension", 35, 20)];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "far", "reachability beats proximity");
});

test("a tier nothing can reach does not block the tier below it", () => {
  // Extensions outrank towers, but if no extension is reachable a tower should still be
  // built. Strict ordering without a release condition is what stranded the builder.
  unreachable = ["ext1", "ext2"];
  const sites = [
    site("ext1", "extension", 15, 14),
    site("ext2", "extension", 16, 13),
    site("tower", "tower", 30, 30),
  ];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "tower", "falls through to the next priority");
});

test("returns null when nothing at all is reachable", () => {
  unreachable = ["a", "b"];
  const sites = [site("a", "extension", 15, 14), site("b", "tower", 30, 30)];
  assertEqual(BT.chooseHomeSite(makeCreep(15, 19), sites), null, "the caller repairs instead");
});

// ============================================================================
// Priority is still honoured
// ============================================================================

test("a spawn is built before an extension, whatever the distance", () => {
  const sites = [site("ext", "extension", 16, 19), site("spawn", "spawn", 40, 40)];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "spawn", "a room with no spawn has no future");
});

test("a container outranks an extension", () => {
  const sites = [site("ext", "extension", 16, 19), site("cont", "container", 30, 30)];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "cont", "static mining pays for everything else");
});

test("within one tier the nearest reachable site wins", () => {
  const sites = [site("far", "extension", 40, 40), site("near", "extension", 18, 19)];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "near", "no needless walking");
});

test("walls and ramparts come last", () => {
  const sites = [site("rampart", "rampart", 16, 19), site("lab", "lab", 40, 40)];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "lab", "defence upkeep is the lowest priority");
});

// ============================================================================
// Range and rooms
// ============================================================================

test("a site already in build range is taken without pathing", () => {
  // findPathTo to an adjacent tile can return an empty path, which would otherwise read as
  // unreachable for the very site the creep is standing beside.
  unreachable = ["adjacent"];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), [site("adjacent", "extension", 16, 20)]);
  assertEqual(pick.id, "adjacent", "range 1 is buildable");
});

test("a site in another room is accepted on trust", () => {
  const sites = [site("remote", "container", 25, 25, "E41N39")];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites);
  assertEqual(pick.id, "remote", "cross-room travel is the mover's job");
});

test("an empty list yields nothing", () => {
  assertEqual(BT.chooseHomeSite(makeCreep(15, 19), []), null, "no sites, no choice");
});

// ============================================================================
// A caller's own build order
// ============================================================================

test("a caller can supply its own priority order", () => {
  // Pioneer ranks a container beside a source above any other container: in a bootstrap
  // room static mining is what makes everything else affordable.
  const sourceContainer = site("srcc", "container", 40, 40);
  const plainContainer = site("plain", "container", 16, 19);
  const pioneerPriority = (s: any) => (s.id === "srcc" ? 1 : 3);
  const pick = BT.chooseHomeSite(makeCreep(15, 19), [plainContainer, sourceContainer], pioneerPriority);
  assertEqual(pick.id, "srcc", "the caller's order is honoured over the default");
});

test("a custom order still yields to reachability", () => {
  unreachable = ["srcc"];
  const sites = [site("plain", "container", 16, 19), site("srcc", "container", 40, 40)];
  const pick = BT.chooseHomeSite(makeCreep(15, 19), sites, (s: any) => (s.id === "srcc" ? 1 : 3));
  assertEqual(pick.id, "plain", "an unreachable top tier does not block the rest");
});

// ============================================================================
// firstReachable - ordering the caller cares about
// ============================================================================

test("firstReachable keeps the caller's order", () => {
  // RoadBuilder pays out from storage outward, so the nearest road to the creep is not the
  // one it should build next.
  const sites = [site("a", "road", 40, 40), site("b", "road", 16, 19)];
  const pick = BT.firstReachable(makeCreep(15, 19), sites);
  assertEqual(pick.id, "a", "first in the list, not nearest to the creep");
});

test("firstReachable skips an unreachable head of the list", () => {
  unreachable = ["a"];
  const sites = [site("a", "road", 40, 40), site("b", "road", 41, 41)];
  const pick = BT.firstReachable(makeCreep(15, 19), sites);
  assertEqual(pick.id, "b", "order is a preference, reachability is a requirement");
});

test("firstReachable caps how many paths it tests", () => {
  unreachable = ["a", "b", "c", "d", "e"];
  const sites = ["a", "b", "c", "d", "e"].map((id, i) => site(id, "road", 40, 40 + i));
  assertEqual(BT.firstReachable(makeCreep(15, 19), sites, 2), null, "gives up rather than burn CPU");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
