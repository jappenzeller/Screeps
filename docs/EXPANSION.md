# Expansion System

## Overview

The bot supports claiming and developing new rooms through two systems:
1. **BootstrapManager** - Original room claiming (manual/queue-based)
2. **ExpansionManager** - Empire-wide automated expansion

Both spawn special creeps from a parent room to claim and build in the target room.

## Expansion Process

```
1. SCOUTING    - Scout gathers intel on candidate rooms
2. EVALUATION  - RoomEvaluator scores expansion viability
3. CLAIMING    - Claimer travels and claims controller
4. BUILDING    - Bootstrap builders construct spawn
5. RAMPING     - New room develops self-sufficiency
6. COMPLETE    - Normal colony operations
```

## Room Evaluation (RoomEvaluator.ts)

Rooms scored on:

| Factor | Weight | Description |
|--------|--------|-------------|
| Sources | High | 2 sources preferred |
| Mineral | Medium | Valuable minerals boost score |
| Distance | High | Closer to parent = better |
| Terrain | Medium | Plains > swamps |
| Neighbors | Low | Hostile neighbors reduce score |
| Room Type | Critical | No SK rooms, no owned rooms |

**Best candidates:**
- 2 sources
- Within 2-3 rooms of parent
- No source keepers
- Unowned/unclaimed
- Good terrain (not all swamp)

## Expansion Roles

### CLAIMER

**Purpose:** Claim target room controller

**Body:** `[CLAIM, MOVE]` (650 energy)

**Behavior:**
1. Travel to target room
2. Move to controller
3. `claimController()` action
4. Die after claiming (one-use)

**Memory:**
```typescript
{
  role: "CLAIMER",
  room: "W1N1",           // Parent room
  targetRoom: "W1N2"      // Room to claim
}
```

### BOOTSTRAP_BUILDER

**Purpose:** Build spawn in claimed room

**Behavior (3 states):**
1. `TRAVELING_TO_TARGET` - Move to target room
2. `COLLECTING` - Get energy (from parent room or local sources)
3. `BUILDING` - Build spawn construction site

**Body:** Large worker (scales with parent capacity)

**Coordinates with:** Bootstrap haulers for energy delivery

### BOOTSTRAP_HAULER

**Purpose:** Ferry energy from parent to bootstrap operation

**Behavior (4 states):**
1. `LOADING` - Fill up at parent room storage
2. `TRAVELING_TO_TARGET` - Move to target room
3. `DELIVERING` - Give energy to bootstrap builders
4. `RETURNING` - Go back to parent room

**Key:** Critical for energy flow when target room has no economy yet.

## BootstrapManager States

```
IDLE
  ↓ expansion.queueRoom("W1N2", "W1N1")
CLAIMING
  ↓ claimer claims controller
PLACING_SPAWN
  ↓ spawn site created
BUILDING_SPAWN
  ↓ spawn construction complete
RAMPING
  ↓ room self-sufficient
COMPLETE
```

## Memory Structure

### Bootstrap Memory
```typescript
Memory.bootstrap = {
  active: {
    targetRoom: "W1N2",
    parentRoom: "W1N1",
    state: "BUILDING_SPAWN",
    startedAt: 123456,
    spawnProgress: 75,
    claimer: "claimer_123",
    builders: ["bootstrap_1", "bootstrap_2"],
    haulers: ["bshauler_1"]
  },
  queue: ["W2N1", "W3N1"],  // Rooms waiting to expand
  config: {
    maxBuilders: 3,
    maxHaulers: 2,
    timeout: 5000            // Ticks before giving up
  }
}
```

### Empire Expansion Memory
```typescript
Memory.empireExpansion = {
  state: "EXPANDING",        // IDLE | EXPANDING
  autoExpand: true,          // Auto-select targets
  active: {
    "W1N2": {
      state: "BUILDING_SPAWN",
      parentRoom: "W1N1",
      startedAt: 123456,
      spawnLocation: {x: 25, y: 25},
      workers: ["builder_1", "hauler_1"]
    }
  }
}
```

## Spawn Placement (SpawnPlacementCalculator)

Optimal spawn location in new room:
1. Find open area (enough space for extensions)
2. Near sources (reduce hauler travel)
3. Away from edges (room defense)
4. Avoid terrain obstacles

## Readiness Checks (ExpansionReadiness)

Before expanding, parent room must:
- Have stable economy (2+ harvesters, 1+ hauler)
- RCL 4+ (can build CLAIM parts)
- Enough storage energy (buffer for bootstrap)
- Not already bootstrapping another room

## Timeline

Typical expansion timeline:
- **Claim:** 50-100 ticks (claimer travel)
- **Build spawn:** 500-1000 ticks (depends on energy flow)
- **Ramp up:** 1000-2000 ticks (basic economy)
- **Total:** ~2000-3000 ticks (1-2 hours real time)

## Console Commands

```javascript
// BootstrapManager (old system)
bootstrap.status()                    // Current state
bootstrap.queue("W1N2", "W1N1")       // Queue expansion
bootstrap.cancel()                    // Abort current

// ExpansionManager (new system)
expansion.status()                    // Empire expansion state
expansion.evaluate("W1N2")            // Score a room
expansion.expand("W1N2", "W1N1")      // Start expansion
expansion.cancel("W1N2")              // Abort
expansion.auto(true)                  // Enable auto-expand
```

## Common Issues

### Claimer Dies En Route
**Cause:** Hostile room or long path
**Fix:** Scout first, ensure path is safe

### Bootstrap Stalls
**Cause:** No energy reaching target
**Fix:** Check bootstrap haulers spawning

### Spawn Placement Fails
**Cause:** No valid location found
**Fix:** Manual override or pick different room

### Timeout
**Cause:** Bootstrap taking too long
**Fix:** Increase timeout or spawn more builders
