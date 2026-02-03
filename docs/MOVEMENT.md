# Movement System

## Overview

Movement is handled through:
- **`smartMoveTo()`** - Enhanced moveTo with stuck detection
- **`moveToRoom()`** - Cross-room navigation
- **Traffic monitoring** - Heatmap for road planning

**Key File:** `src/utils/movement.ts`

## smartMoveTo()

Wraps native `creep.moveTo()` with stuck detection and dynamic options.

```typescript
export function smartMoveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveToOpts
): ScreepsReturnCode
```

### Features

1. **Stuck Detection**
   - Tracks `_lastPos` and `_stuckCount` in creep memory
   - If same position for 3+ ticks: recalculate with `ignoreCreeps: true`
   - If same position for 5+ ticks: random shove to break deadlock

2. **Short-Range ignoreCreeps**
   - When target ≤ 3 tiles away, automatically enables `ignoreCreeps`
   - Prevents creeps from routing around each other at close range

3. **Dynamic reusePath**
   - Default: 10 ticks (more responsive than Screeps' 50)
   - On stuck: 0 (force immediate recalculation)

### Implementation

```typescript
// Stuck detection
const currentPos = creep.pos.x + "," + creep.pos.y;
if (creep.memory._lastPos === currentPos) {
  creep.memory._stuckCount = (creep.memory._stuckCount || 0) + 1;
} else {
  creep.memory._stuckCount = 0;
}
creep.memory._lastPos = currentPos;

// After 5 ticks: random movement
if (stuckCount > 5) {
  const directions = [TOP, TOP_RIGHT, RIGHT, ...];
  creep.move(directions[Math.floor(Math.random() * 8)]);
  creep.memory._stuckCount = 0;
  return OK;
}

// After 3 ticks: recalculate ignoring creeps
if (stuckCount > 2) {
  moveOpts.reusePath = 0;
  moveOpts.ignoreCreeps = true;
}
```

## moveToRoom()

Handles cross-room navigation with border edge cases.

```typescript
export function moveToRoom(
  creep: Creep,
  targetRoom: string,
  visualStroke?: string
): boolean
```

### Behavior

1. Find exit direction to target room
2. If on correct border tile: step across
3. If on wrong border: step off first
4. If stuck at border: try adjacent exit tiles
5. If stuck 5+ ticks: random movement

### Border Handling

```typescript
// On correct border - step across
if (exitDir === FIND_EXIT_LEFT && pos.x === 0) {
  creep.move(LEFT);
  return true;
}

// On wrong border - step off
if (isOnBorder(creep)) {
  stepOffBorder(creep);
  return true;
}
```

## Traffic Monitoring

Tracks creep movement patterns for road planning.

**Stored in:** `Memory.traffic[roomName].heatmap`

```typescript
{
  heatmap: { "25:30": 150, "26:30": 145, ... },
  lastReset: 123000,
  windowSize: 10000,
  roadsSuggested: ["25:30", "26:30"],
  roadsBuilt: ["25:30"]
}
```

### How It Works

1. Each tick, record creep positions (sampled)
2. Increment tile counter in heatmap
3. After window, identify high-traffic tiles
4. Suggest roads for tiles above threshold

### Console Commands

```javascript
traffic("W1N1")          // View traffic stats
showTraffic(true)        // Toggle visual heatmap
suggestRoads("W1N1")     // Get road suggestions
```

## Pathfinding Options

### reusePath

How many ticks to cache path before recalculating.

| Value | Use Case |
|-------|----------|
| 0 | Force recalculate (stuck recovery) |
| 3-5 | Dynamic environments, many creeps |
| 10 | Normal operations (default) |
| 20+ | Static paths (harvester to container) |

### ignoreCreeps

Whether to path through other creeps.

| Value | Effect |
|-------|--------|
| false | Paths around creeps (default) |
| true | Paths through, pushes creeps aside |

**Use `true` when:**
- Target is close (≤ 3 tiles)
- Stuck detection triggered
- Dense traffic areas

### visualizePathStyle

Draws path for debugging:

```typescript
creep.moveTo(target, {
  visualizePathStyle: { stroke: '#ffffff', opacity: 0.5 }
});
```

## Memory Fields

```typescript
interface CreepMemory {
  _lastPos: string;      // "x,y" - last position
  _stuckCount: number;   // Ticks at same position
}
```

## Fatigue System

Creeps have fatigue that prevents movement:
- Each non-MOVE part generates fatigue (2 on plains, 10 on swamp)
- Each MOVE part removes 2 fatigue per tick
- Roads halve fatigue generation

### Movement Speed

| Ratio | Plains | Roads | Swamp |
|-------|--------|-------|-------|
| 1:1 (MOVE = other) | Every tick | Every tick | Every 5 ticks |
| 2:1 (2 other : 1 MOVE) | Every 2 ticks | Every tick | Every 10 ticks |

## Common Issues

### Creeps Oscillating
**Symptom:** Creep moves back and forth
**Cause:** Two creeps blocking each other's path
**Fix:** `ignoreCreeps: true` at short range

### Creep Stuck at Border
**Symptom:** Creep won't cross room boundary
**Cause:** Adjacent tile blocked
**Fix:** `tryAdjacentExit()` finds alternate exit

### Pathfinding Expensive
**Symptom:** High CPU on movement
**Cause:** Low `reusePath`, frequent recalculation
**Fix:** Increase `reusePath` for stable paths

### Creeps Bunching
**Symptom:** Many creeps at same location
**Cause:** All targeting same point
**Fix:** Traffic-aware target selection (see ECONOMY.md)
