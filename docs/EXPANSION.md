# Expansion System

## Overview

The bot supports claiming and developing new rooms through the unified **ExpansionManager** system.
Expansion state is stored in `Memory.empire.expansion` and managed by `EmpireMemory.ts`.

The parent room spawns specialized creeps (Claimer, BootstrapBuilder, BootstrapHauler) to
claim the controller and construct the initial spawn in the target room.

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

All expansion state lives in `Memory.empire.expansion`:

```typescript
Memory.empire.expansion = {
  active: {
    "W1N2": {
      roomName: "W1N2",
      parentRoom: "W1N1",
      state: "CLAIMING" | "BOOTSTRAPPING" | "BUILDING_SPAWN" | "RAMPING" | "INTEGRATING",
      stateChangedAt: 123456,
      startedAt: 123456,
      totalTicks: 500,
      attempts: 1,
      claimer: "claimer_123" | null,
      spawnSitePos: { x: 25, y: 25 },
      spawnProgress: 75
    }
  },
  queue: [
    { target: "W2N1", parent: "W1N1" }
  ],
  history: {
    "W3N1": {
      outcome: "SUCCESS" | "FAILED" | "CANCELLED",
      parentRoom: "W1N1",
      startedAt: 100000,
      completedAt: 105000,
      totalTicks: 5000,
      failureReason: null
    }
  }
}
```

Legacy `Memory.bootstrap`, `Memory.expansion`, and `Memory.empireExpansion`
are auto-migrated on first tick and deleted. See `EmpireMemory.ts`.

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
