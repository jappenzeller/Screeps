# Investigation: smartMoveTo Creep Blocking Behavior

## Context
Hauler at (8,28) couldn't path to container at (6,28) for 183+ ticks. Two defenders were sitting at (12,26) and (11,25) — nowhere near the path. Killing the defenders unblocked the hauler. The hauler's `_move.dest` was (5,29) with a stale path from 183 ticks prior.

---

## 1. Full Source of `smartMoveTo`

**File:** [movement.ts:215-235](src/utils/movement.ts#L215-L235)

```typescript
export function smartMoveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveToOpts
): ScreepsReturnCode {
  const targetPos = "pos" in target ? target.pos : target;

  // Handle cross-room movement
  if (targetPos.roomName !== creep.room.name) {
    if (isOnBorder(creep)) {
      moveToRoom(creep, targetPos.roomName, opts?.visualizePathStyle?.stroke);
      return OK;
    }
  }

  // Simple moveTo with high reusePath to minimize recalculation
  return creep.moveTo(targetPos, {
    reusePath: 50,
    ...opts,
  });
}
```

**Key finding:** `smartMoveTo` wraps native `creep.moveTo()` with `reusePath: 50` default. It delegates ALL pathfinding to Screeps' built-in system.

---

## 2. costCallback / costMatrix Manipulation

**Result: NONE FOUND**

No custom cost matrices anywhere in the codebase that set creep tiles to 255 or high values.

The only pathfinding customization is `ignoreCreeps: true` used in **static planning** operations (road planning, extension placement), NOT during active creep movement:
- `Console.ts:15` - road planning
- `ExtensionPlanner.ts:44` - extension placement
- `RoadPlanner.ts:74`, `SmartRoadPlanner.ts:210,417,496` - road planning
- `placeStructures.ts:259,337` - structure placement

---

## 3. findClosestByPath / findPath in Hauler.ts

| Function | Line | Method | Then Uses |
|----------|------|--------|-----------|
| collectFromContainers | 294, 305 | — | smartMoveTo (reusePath: 5) |
| collect | 436-445 | findClosestByPath(FIND_TOMBSTONES) | smartMoveTo (reusePath: 5) |
| collect | 455-465 | findClosestByPath(FIND_DROPPED_RESOURCES) | smartMoveTo (reusePath: 5) |
| collect | 488-491 | findClosestByPath(FIND_SOURCES) | smartMoveTo (reusePath: 10) |
| deliver | 496-510 | findClosestByPath(FIND_MY_STRUCTURES) | smartMoveTo (reusePath: 5) |
| deliver | 513-524 | findClosestByPath(FIND_MY_STRUCTURES) | smartMoveTo (reusePath: 5) |
| deliver | 537-548 | findClosestByPath(FIND_MY_STRUCTURES) | smartMoveTo (reusePath: 5) |
| deliver | 570-575 | findClosestByPath(FIND_MY_SPAWNS) | smartMoveTo (default 50) |

**Known issue documented in Hauler.ts:320-322:**
```typescript
// findClosestByPath can return objects in adjacent rooms, causing haulers to wander
```

---

## 4. reusePath Values in Hauler.ts

| Value | Usage |
|-------|-------|
| 3 | Renewal, moveOffRoad (corrections) |
| 5 | Most active targeting (containers, tombstones, drops, spawns, towers) |
| 10 | Waiting positions (container, source fallback) |
| 50 | Default in smartMoveTo (deliver to spawn fallback line 572) |

---

## 5. Does smartMoveTo Use moveTo or findPath+moveByPath?

**Answer: Native `creep.moveTo()` directly.**

```typescript
return creep.moveTo(targetPos, {
  reusePath: 50,
  ...opts,
});
```

**Implication:** `moveTo()` with `reusePath` caches path in `creep.memory._move`. New obstacles (other creeps) are NOT recalculated until cache expires. This is the PRIMARY mechanism for stale paths.

---

## 6. Global Cost Matrix Setup

**Complete scan of `src/` directory:**

- `PathFinder.CostMatrix`: **0 results**
- `costMatrix.set`: **0 results**
- `costCallback`: **0 results**
- `cost_matrix`: **0 results**

Only `PathFinder.search()` usage: [RemoteDefender.ts:290](src/creeps/RemoteDefender.ts#L290) for flee logic with `{ flee: true }`, no cost matrix.

**Result: No global cost matrix setup. All pathfinding uses vanilla Screeps logic.**

---

## 7. Stuck Detection

**File:** [movement.ts:68-101](src/utils/movement.ts#L68-L101)

**Stuck detection exists ONLY in `moveToRoom()` (cross-room movement), NOT in `smartMoveTo()`:**

```typescript
// Stuck detection: track last position
const lastPos = creep.memory._lastPos;
const currentPos = `${pos.x},${pos.y}`;

if (lastPos === currentPos) {
  const stuckCount = (creep.memory._stuckCount || 0) + 1;
  creep.memory._stuckCount = stuckCount;

  if (stuckCount > 2) {
    // Find alternative exit after 3+ ticks stuck
    const alternativeExit = findAlternativeExit(creep, exitDir);
    if (alternativeExit) {
      creep.moveTo(alternativeExit, { reusePath: 5 });
      return true;
    }

    // Random movement after 5+ ticks stuck
    if (stuckCount > 5) {
      const randomDir = directions[Math.floor(Math.random() * directions.length)];
      creep.move(randomDir);
      creep.memory._stuckCount = 0;
      return true;
    }
  }
} else {
  creep.memory._stuckCount = 0;
}
creep.memory._lastPos = currentPos;
```

**Memory fields:** `_lastPos` (string), `_stuckCount` (number) — defined in [types.d.ts:30-31](src/types.d.ts#L30-L31)

**Scope limitation:** Stuck detection ONLY applies to **cross-room movement**. Single-room movement via `smartMoveTo()` has NO stuck detection.

---

## Synthesis: Root Cause

### How Friendly Creeps Are Handled

1. **smartMoveTo()** wraps native `creep.moveTo()` with `reusePath: 50` default
2. **No custom cost matrices** — vanilla Screeps pathfinding
3. **Cached paths reused for N ticks** — obstacles that appear AFTER path calculation are ignored until cache expires

### Why the Hauler Got Stuck

The `_move.dest` was (5,29) with a 183-tick-old path. The path was calculated when defenders weren't in their current positions. Even though defenders weren't on the direct route (8,28) → (6,28), one of these scenarios likely occurred:

1. **Initial path was blocked:** When the original path was calculated 183 ticks ago, it may have routed around obstacles that included the defenders' old positions, creating a longer cached path that later became invalid
2. **findClosestByPath selected wrong target:** The `findClosestByPath` call may have selected a different container (dest 5,29 vs container at 6,28), then the hauler got stuck trying to reach it
3. **Stale reusePath cache:** With `reusePath: 50` default, the path doesn't recalculate even when obstacles move

### Missing Safeguards

1. **No stuck detection in single-room movement** — only cross-room has it
2. **No path invalidation on blocked tiles** — relies purely on cache expiration
3. **High default reusePath (50)** — 50 ticks is too long for dynamic environments with moving creeps
