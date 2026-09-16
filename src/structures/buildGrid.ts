/**
 * buildGrid - the shared geometry rules for where a structure may be placed.
 *
 * Two rules live here because two planners need them and had started to disagree. The
 * chokepoint check was private to placeStructures, so ExtensionPlanner placed an extension
 * in the only one-tile corridor out of E47N41 and sealed every remote miner it spawned
 * inside its own room. Extension tile selection was private to ExtensionPlanner, capped at
 * radius 10 from the spawn, and silently stopped placing anything once that area filled.
 *
 * Both are pure: they take predicates rather than a Room, so the geometry can be unit
 * tested against a grid instead of a live colony.
 */

/**
 * Whether a structure of this type stops a creep entering its tile.
 *
 * Roads and containers are walkable, and ramparts are walkable for their owner - every
 * rampart in our own rooms is ours, which is the only place these planners run.
 */
export function blocksMovement(structureType: string): boolean {
  return (
    structureType !== STRUCTURE_ROAD &&
    structureType !== STRUCTURE_CONTAINER &&
    structureType !== STRUCTURE_RAMPART
  );
}

/** True when a creep cannot enter this tile. */
export type BlockedPredicate = (x: number, y: number) => boolean;

/**
 * True when building on this tile would cut its walkable neighbours into separate groups.
 *
 * A structure is a wall creeps cannot pass, so one placed in a one-tile corridor severs
 * whatever is on the far side. The test is local and cheap: an articulation check over the
 * eight surrounding tiles. If the neighbours can still reach one another without stepping
 * on the candidate, the tile is not load-bearing.
 */
export function isChokepoint(x: number, y: number, blocked: BlockedPredicate): boolean {
  const walkable: Array<{ x: number; y: number }> = [];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      if (blocked(nx, ny)) continue;
      walkable.push({ x: nx, y: ny });
    }
  }

  // Nothing to sever, or a dead end either way.
  if (walkable.length <= 1) return false;

  // Flood the neighbours among themselves. Adjacency here means "reachable without
  // stepping on the candidate", which is exactly what building on it would forbid.
  const seen: boolean[] = [];
  for (let i = 0; i < walkable.length; i++) seen.push(false);
  const queue = [0];
  seen[0] = true;
  let reached = 1;

  while (queue.length > 0) {
    const cur = walkable[queue.pop() as number];
    for (let i = 0; i < walkable.length; i++) {
      if (seen[i]) continue;
      const other = walkable[i];
      if (Math.abs(other.x - cur.x) <= 1 && Math.abs(other.y - cur.y) <= 1) {
        seen[i] = true;
        reached++;
        queue.push(i);
      }
    }
  }

  return reached < walkable.length;
}

/** Everything extension selection needs to know about a tile. */
export interface ExtensionTileQuery {
  isWall(x: number, y: number): boolean;
  isSwamp(x: number, y: number): boolean;
  /** Any structure or construction site already claims this tile. */
  isOccupied(x: number, y: number): boolean;
  /** A traffic corridor that must stay clear. */
  isReserved(x: number, y: number): boolean;
  isNearSource(x: number, y: number): boolean;
  isNearController(x: number, y: number): boolean;
  /** Whether a creep is already unable to enter - used for the chokepoint check. */
  blocksMovementAt(x: number, y: number): boolean;
  /** Bonus for sitting beside existing extensions, so the field stays compact. */
  clusterScore(x: number, y: number): number;
}

/** Closest ring searched. Inside this the spawn needs room to manoeuvre. */
export const EXTENSION_MIN_RADIUS = 3;

/**
 * Furthest ring searched.
 *
 * Was 10, which both mature rooms exhausted: zero valid tiles inside it, 183 and 92
 * outside it. Distance is charged as a score penalty rather than a hard limit, so a near
 * tile still wins whenever one exists and the wider rings only matter once it does not.
 */
export const EXTENSION_MAX_RADIUS = 22;

/**
 * Every tile a creep can walk to from the anchor, as "x,y" keys.
 *
 * The anchor is normally a spawn, which blocks its own tile, so the flood starts from the
 * walkable tiles beside it.
 */
export function reachableTiles(
  anchor: { x: number; y: number },
  blocked: BlockedPredicate
): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = anchor.x + dx;
      const y = anchor.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      if (blocked(x, y)) continue;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ x, y });
    }
  }

  while (queue.length > 0) {
    const cur = queue.pop() as { x: number; y: number };
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = cur.x + dx;
        const y = cur.y + dy;
        if (x < 0 || x > 49 || y < 0 || y > 49) continue;
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        if (blocked(x, y)) continue;
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen;
}

/**
 * Choose up to `needed` tiles for new extensions, nearest and most clustered first.
 *
 * Keeps the checkerboard pattern relative to the anchor so creeps can always walk between
 * extensions, and refuses any tile that would seal a corridor - including in combination
 * with the other tiles picked in the same call.
 *
 * Every candidate must also be somewhere a creep can actually get to. The chokepoint check
 * is local to a tile's eight neighbours: it stops a new placement from severing a corridor,
 * but says nothing about ground that was already walled off. Widening the search to radius
 * 22 reached into exactly that in E47N41, whose north is sealed behind a pre-existing
 * extension at 15,18 - five sites were placed where no creep could stand, and a builder
 * hung on one of them for 200 ticks holding 800 energy. Local guards cannot answer a
 * global question, so this one floods the room from the spawn.
 */
export function pickExtensionTiles(
  anchor: { x: number; y: number },
  needed: number,
  q: ExtensionTileQuery,
  maxRadius: number = EXTENSION_MAX_RADIUS
): Array<{ x: number; y: number }> {
  if (needed <= 0) return [];

  const candidates: Array<{ x: number; y: number; score: number }> = [];
  const anchorParity = (anchor.x + anchor.y) % 2;
  const movementBlocked: BlockedPredicate = (x, y) => q.isWall(x, y) || q.blocksMovementAt(x, y);
  const reachable = reachableTiles(anchor, movementBlocked);

  for (let radius = EXTENSION_MIN_RADIUS; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        // Only this radius's ring; inner tiles were considered on earlier passes.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;

        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (x < 2 || x > 47 || y < 2 || y > 47) continue;
        if ((x + y) % 2 !== anchorParity) continue;
        if (q.isWall(x, y)) continue;
        if (q.isOccupied(x, y)) continue;
        if (q.isReserved(x, y)) continue;
        if (q.isNearSource(x, y)) continue;
        if (q.isNearController(x, y)) continue;
        if (!reachable.has(`${x},${y}`)) continue;

        const score = radius + (q.isSwamp(x, y) ? 5 : 0) - q.clusterScore(x, y);
        candidates.push({ x, y, score });
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);

  const chosen: Array<{ x: number; y: number }> = [];
  const chosenKeys = new Set<string>();

  // The chokepoint test has to see the tiles already picked in this call, or two
  // placements that are each harmless alone can close a corridor between them.
  const blocked: BlockedPredicate = (x, y) =>
    movementBlocked(x, y) || chosenKeys.has(`${x},${y}`);

  for (const candidate of candidates) {
    if (chosen.length >= needed) break;
    if (isChokepoint(candidate.x, candidate.y, blocked)) continue;
    chosen.push({ x: candidate.x, y: candidate.y });
    chosenKeys.add(`${candidate.x},${candidate.y}`);
  }

  return chosen;
}
