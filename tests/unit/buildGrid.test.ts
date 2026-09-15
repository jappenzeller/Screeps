/**
 * Unit tests for shared build geometry.
 *
 * Run with: npm run test:unit
 *
 * Both rules here were private to one planner and cost a real defect. The chokepoint check
 * lived in placeStructures, so ExtensionPlanner sealed E47N41's only corridor north and
 * every remote miner it spawned idled at home. Extension selection lived in
 * ExtensionPlanner capped at radius 10, and both mature rooms silently stopped growing
 * once that area filled.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

const g = global as any;

g.TERRAIN_MASK_WALL = 1;
g.TERRAIN_MASK_SWAMP = 2;
g.STRUCTURE_ROAD = "road";
g.STRUCTURE_CONTAINER = "container";
g.STRUCTURE_RAMPART = "rampart";
g.STRUCTURE_EXTENSION = "extension";
g.STRUCTURE_TOWER = "tower";

const BG = require("../../src/structures/buildGrid");

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

/**
 * Build a blocked-tile predicate from an ASCII map. '#' is blocked, anything else open.
 * Row index is y, character index is x.
 */
function blockedFrom(rows: string[]): (x: number, y: number) => boolean {
  return (x: number, y: number) => {
    const row = rows[y];
    if (row === undefined) return true;
    const ch = row[x];
    if (ch === undefined) return true;
    return ch === "#";
  };
}

/** A query over an open 50x50 room, with hooks to override individual rules. */
function openRoom(over: Partial<any> = {}): any {
  const base = {
    isWall: () => false,
    isSwamp: () => false,
    isOccupied: () => false,
    isReserved: () => false,
    isNearSource: () => false,
    isNearController: () => false,
    blocksMovementAt: () => false,
    clusterScore: () => 0,
  };
  return Object.assign(base, over);
}

console.log("\n=== Build geometry ===\n");

// ============================================================================
// Chokepoint - the corridor guard
// ============================================================================

test("a tile in a one-wide corridor is a chokepoint", () => {
  // The shape that sealed E47N41: open above and below, walls either side.
  const rows = ["#####", "##.##", "##.##", "##.##", "#####"];
  assertEqual(BG.isChokepoint(2, 2, blockedFrom(rows)), true, "building here severs the corridor");
});

test("a tile in open ground is not a chokepoint", () => {
  const rows = ["#####", "#...#", "#...#", "#...#", "#####"];
  assertEqual(BG.isChokepoint(2, 2, blockedFrom(rows)), false, "neighbours still reach each other");
});

test("a dead end is not a chokepoint", () => {
  const rows = ["#####", "##.##", "##.##", "#####", "#####"];
  assertEqual(BG.isChokepoint(2, 2, blockedFrom(rows)), false, "nothing on the far side to cut off");
});

test("a diagonal corridor is severed too", () => {
  // Creeps move diagonally, so a diagonal passage is a real passage. (1,1) and (3,3) have
  // exactly one common neighbour - the candidate - so building there does cut them apart.
  const rows = ["#####", "#.###", "##.##", "###.#", "#####"];
  assertEqual(BG.isChokepoint(2, 2, blockedFrom(rows)), true, "the only link between them");
});

test("neighbours that touch each other are not severed", () => {
  // Both open tiles sit side by side, so removing the candidate costs them nothing.
  const rows = ["#####", "#..##", "##.##", "#####", "#####"];
  assertEqual(BG.isChokepoint(2, 2, blockedFrom(rows)), false, "they are already adjacent");
});

// ============================================================================
// blocksMovement
// ============================================================================

test("roads, containers and ramparts do not block movement", () => {
  assertEqual(BG.blocksMovement("road"), false, "roads are walkable");
  assertEqual(BG.blocksMovement("container"), false, "containers are walkable");
  assertEqual(BG.blocksMovement("rampart"), false, "our own ramparts are walkable");
  assertEqual(BG.blocksMovement("extension"), true, "extensions are walls to a creep");
  assertEqual(BG.blocksMovement("tower"), true, "towers are walls to a creep");
});

// ============================================================================
// Extension selection
// ============================================================================

test("picks the requested number of tiles, on the anchor's checkerboard", () => {
  const anchor = { x: 25, y: 25 };
  const tiles = BG.pickExtensionTiles(anchor, 2, openRoom());
  assertEqual(tiles.length, 2, "places both requested");
  for (const t of tiles) {
    assertEqual((t.x + t.y) % 2, (anchor.x + anchor.y) % 2, "keeps the walkable checkerboard");
  }
});

test("prefers nearer rings", () => {
  const tiles = BG.pickExtensionTiles({ x: 25, y: 25 }, 1, openRoom());
  const radius = Math.max(Math.abs(tiles[0].x - 25), Math.abs(tiles[0].y - 25));
  assertEqual(radius, BG.EXTENSION_MIN_RADIUS, "starts at the closest allowed ring");
});

test("searches beyond radius 10 once the inner area is full", () => {
  // The live defect. Both mature rooms had zero valid tiles inside radius 10 and plenty
  // outside it, and the old cap meant they simply stopped growing.
  const anchor = { x: 25, y: 25 };
  const q = openRoom({
    isOccupied: (x: number, y: number) =>
      Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) <= 10,
  });
  const tiles = BG.pickExtensionTiles(anchor, 2, q);
  assertEqual(tiles.length, 2, "finds tiles the old radius could not reach");
  for (const t of tiles) {
    const radius = Math.max(Math.abs(t.x - anchor.x), Math.abs(t.y - anchor.y));
    assertTrue(radius > 10, `tile at radius ${radius} lies outside the old cap`);
  }
});

test("places nothing rather than seal the only corridor", () => {
  // A room that is solid wall except one vertical passage. Every tile the selector could
  // take is load-bearing, so the honest answer is to place nothing and let the caller
  // report it - which is what sealed E47N41's route north when the guard was missing.
  const q = openRoom({ isWall: (x: number) => x !== 25 });
  assertEqual(BG.pickExtensionTiles({ x: 25, y: 25 }, 2, q).length, 0, "the corridor stays open");
});

test("takes an open tile while refusing the corridor beside it", () => {
  // Same passage, plus one pocket of open ground. The guard must reject without also
  // rejecting the safe tile - a guard that blocks everything is as bad as none.
  const open = (x: number, y: number): boolean => x >= 30 && x <= 34 && y >= 30 && y <= 34;
  const q = openRoom({ isWall: (x: number, y: number) => x !== 25 && !open(x, y) });
  const tiles = BG.pickExtensionTiles({ x: 25, y: 25 }, 1, q);
  assertEqual(tiles.length, 1, "the pocket is usable");
  assertTrue(open(tiles[0].x, tiles[0].y), `chose ${tiles[0].x},${tiles[0].y} in the open pocket`);
});

test("two tiles picked together cannot close a passage between them", () => {
  // Each tile is harmless alone. Taken as a pair they pinch a two-wide corridor shut, so
  // the second choice has to see the first.
  const q = openRoom({ isWall: (x: number) => x !== 25 && x !== 26 });
  const tiles = BG.pickExtensionTiles({ x: 25, y: 25 }, 4, q);
  const keys = new Set(tiles.map((t: { x: number; y: number }) => `${t.x},${t.y}`));
  for (const t of tiles) {
    const others = new Set(keys);
    others.delete(`${t.x},${t.y}`);
    const blocked = (bx: number, by: number) =>
      (bx !== 25 && bx !== 26) || others.has(`${bx},${by}`);
    assertEqual(BG.isChokepoint(t.x, t.y, blocked), false, `${t.x},${t.y} pinches the corridor`);
  }
});

test("respects reserved traffic corridors, sources and the controller", () => {
  const anchor = { x: 25, y: 25 };
  const q = openRoom({
    isReserved: (x: number, y: number) => x === 28,
    isNearSource: (x: number, y: number) => y === 22,
    isNearController: (x: number, y: number) => x === 22,
  });
  const tiles = BG.pickExtensionTiles(anchor, 6, q);
  assertTrue(tiles.length > 0, "there is still space elsewhere");
  for (const t of tiles) {
    assertTrue(t.x !== 28, "stays off the traffic corridor");
    assertTrue(t.y !== 22, "leaves source tiles for harvesters");
    assertTrue(t.x !== 22, "leaves controller tiles for upgraders");
  }
});

test("returns nothing when the room has no valid tile", () => {
  const q = openRoom({ isOccupied: () => true });
  assertEqual(BG.pickExtensionTiles({ x: 25, y: 25 }, 2, q).length, 0, "the caller reports it");
});

test("asking for nothing places nothing", () => {
  assertEqual(BG.pickExtensionTiles({ x: 25, y: 25 }, 0, openRoom()).length, 0, "no work, no tiles");
});

test("clustering pulls placement together", () => {
  // A far tile with neighbouring extensions should beat a nearer bare one.
  const anchor = { x: 25, y: 25 };
  const q = openRoom({
    clusterScore: (x: number, y: number) => (x === 25 && y === 33 ? 20 : 0),
  });
  const tiles = BG.pickExtensionTiles(anchor, 1, q);
  assertEqual(tiles[0].x, 25, "took the clustered tile");
  assertEqual(tiles[0].y, 33, "even though it sits further out");
});

console.log("\n========================================");
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) process.exit(1);
