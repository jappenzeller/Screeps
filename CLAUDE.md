# Screeps Bot Development Guide

You are developing a Screeps bot - an AI for a real-time strategy MMO where you write JavaScript/TypeScript code that runs autonomously on a game server. The code executes once per game tick (~3 seconds real-time) with strict CPU limits.

## Project Context

This is a TypeScript Screeps bot targeting the official MMO server (shard0). The codebase uses Rollup for bundling and deploys via the Screeps API. There is also an AWS monitoring stack (Fargate + Lambda) for external alerting.

### Current State
- Functional RCL 1-4 economy with role-based creeps
- ColonyManager for centralized task generation (foundation for future task-based creeps)
- Simple structure placement and spawning
- Basic tower defense
- No link/terminal/lab/factory management
- No combat beyond basic melee defender

### Core Systems

- **ColonyManager** (`src/core/ColonyManager.ts`): Central coordinator that generates tasks based on room state. Tasks stored in `Memory.rooms[name].tasks`. Currently generates tasks but creeps don't consume them yet.
- **ColonyStateManager** (`src/core/ColonyState.ts`): Cached room state with tiered refresh intervals.
- **Simple spawning** (`src/spawning/spawnCreeps.ts`): Predictable creep counts based on room state.
- **Simple structure placement** (`src/structures/placeStructures.ts`): One structure per tick, priority-based.

### Tech Stack
- TypeScript with strict mode
- Rollup bundler with rollup-plugin-screeps for deployment
- @types/screeps for game API types
- lodash available but minimize usage (CPU cost)

---

## Screeps-Specific Concepts You Must Understand

### The Game Loop
```typescript
// main.ts exports a loop() function called every tick
export function loop(): void {
  // This runs once per tick. There is NO persistent state between ticks
  // except what you store in Memory (serialized JSON) or global (cleared on code push)
}
```

### CPU Model
- Each tick has a CPU limit (20-30 for most players)
- Unused CPU accumulates in a "bucket" (max 10,000)
- When bucket is full, you can use CPU > limit
- Bucket < 500 = critical, reduce work immediately
- Game.cpu.getUsed() returns CPU used so far this tick

### Memory
- `Memory` is a global object persisted between ticks
- Serialized as JSON at end of each tick (CPU cost!)
- Every Creep, Room, Spawn, Flag has a `.memory` property that maps to `Memory.creeps[name]`, etc.
- Large memory = slow serialization. Keep it lean.

### Creeps
- Creeps are your units. They have body parts that define capabilities.
- Body parts: WORK (harvest/build/repair), CARRY (hold resources), MOVE (movement), ATTACK, RANGED_ATTACK, HEAL, CLAIM, TOUGH
- Creeps have 1500 tick lifespan (ticksToLive)
- Creeps cost energy to spawn. Bigger bodies = more cost, more spawn time.
- Creeps belong to the room they were spawned in but can move between rooms.

### Room Controller Level (RCL)
- Each owned room has a controller you upgrade with energy
- RCL determines what structures you can build:
  - RCL 1: Spawn (1)
  - RCL 2: Extensions (5), Containers (5), Walls, Ramparts
  - RCL 3: Extensions (10), Tower (1)
  - RCL 4: Extensions (20), Storage (1)
  - RCL 5: Extensions (30), Towers (2), Links (2)
  - RCL 6: Extensions (40), Towers (2), Links (3), Extractor, Terminal, Labs (3)
  - RCL 7: Extensions (50), Towers (3), Links (4), Labs (6), Factory
  - RCL 8: Extensions (60), Towers (6), Links (6), Labs (10), Observer, Power Spawn, Nuker

### Energy Economy
- Sources regenerate 3000 energy every 300 ticks
- Each WORK part harvests 2 energy/tick
- Optimal: 5 WORK parts per source = 10 energy/tick = 3000/300 ticks
- Early game: creeps harvest AND deliver
- Mid game: dedicated miners drop/transfer to containers, haulers distribute
- Late game: links teleport energy, minimal hauling

### Pathfinding
- `creep.moveTo()` caches paths (reusePath option)
- PathFinder.search() for custom pathing
- Avoid recalculating paths every tick - cache them
- Swamps cost 5x fatigue, roads cost 0.5x
- Fatigue = MOVE parts determine speed. 1 MOVE per non-MOVE part for plains speed.

---

## Architecture Decisions (Follow These)

### File Organization
```
src/
├── main.ts           # Entry point, main loop
├── config.ts         # Constants, tuning parameters
├── types.d.ts        # Type extensions
├── core/             # Colony management, spawning, planning
├── creeps/           # Role implementations
├── structures/       # Structure managers (towers, links, labs)
├── combat/           # Threat assessment, squads
└── utils/            # Logging, profiling, caching
```

### Creep Role Pattern
Each role file exports a single run function:
```typescript
export function runHarvester(creep: Creep): void {
  // Role logic here
}
```

Roles register in `src/creeps/roles.ts`. The main loop iterates creeps and dispatches to the appropriate runner.

### State Machine for Creeps
Use explicit states, not just booleans:
```typescript
// BAD
creep.memory.working = true;

// GOOD
creep.memory.state = 'HARVESTING' | 'TRAVELING' | 'DELIVERING' | 'IDLE';
```

### Memory Schema
Keep memory minimal. Avoid storing:
- Object references (they don't serialize)
- Redundant data (recalculate from game state)
- Historical data (use memory segments for stats)

Store:
- Creep role and assigned targets (by ID string)
- Room intel (source positions, threat level)
- Construction queue
- Configuration overrides

---

## Strategic Development Principles

### 1. Early Game Survival (RCL 1-3)

**Critical insight**: The first minutes after spawning determine survival. A single spawn with 300 energy must bootstrap an entire economy.

- First creep MUST be able to harvest AND deliver (e.g., [WORK, CARRY, MOVE])
- Don't spawn specialists until you have 2+ generalists
- Extensions increase energy capacity - prioritize building them
- At RCL 2, immediately place containers at sources
- Harvesters transition to static miners when containers exist

**Mistake to avoid**: Spawning a dedicated hauler before containers exist. The hauler has nothing to haul.

### 2. Energy Flow Design

Think of energy as flowing through a network:
```
Sources → Containers → Haulers → Spawn/Extensions/Towers
                    ↘ Storage ↗
                         ↓
              Links → Controller
```

Design each component to pull from upstream, not push downstream. Haulers check what needs energy and fetch from the most appropriate source.

### 3. Scaling Body Parts

Bodies should scale with available energy capacity:
```typescript
// Base body for 300 energy spawn
const base = [WORK, CARRY, MOVE];

// Scale up when capacity allows
function getBody(role: string, capacity: number): BodyPartConstant[] {
  // Add parts until cost exceeds capacity
  // Respect 50 body part limit
  // Maintain movement ratio (1 MOVE per 2 other parts on roads, 1:1 on plains)
}
```

**Critical**: Don't hardcode bodies. A [WORK, CARRY, MOVE] harvester at RCL 7 is wasteful.

### 4. Remote Mining Economics

Remote mining is the primary income multiplier but has overhead:
- Travel time reduces effective harvest rate
- Need reservers to prevent invader cores (every 4000 ticks)
- Need haulers specifically for remote routes
- Hostiles can kill miners with no tower defense

**Formula**: Only mine a remote room if `(energy_per_tick - hauler_upkeep) > 0`

Don't remote mine rooms more than 2 rooms away until you have robust hauler replacement.

### 5. Defense Layers

1. **Tower defense** (primary): Towers can hit anywhere in room instantly
2. **Ramparts**: Force enemies to break through chokepoints
3. **Safe mode**: Emergency button, 20,000 tick cooldown
4. **Active defenders**: Only spawn when towers can't handle threat

**Mistake to avoid**: Spawning defenders for every hostile. Towers handle most threats. Defenders are for sustained sieges.

### 6. Construction Prioritization

Build order matters enormously:
1. Extensions (more spawn capacity)
2. Containers at sources (enable static mining)
3. Container at controller (upgrader efficiency)
4. Roads spawn→sources (reduce fatigue)
5. Tower (defense)
6. Storage (buffer)
7. Roads to controller
8. Ramparts/walls (last - they require constant repair)

### 7. CPU Budget Allocation

Approximate CPU budget per tick:
- Creep logic: 0.2-0.5 CPU per creep
- Pathfinding: 0.5-2 CPU per search
- Room.find(): 0.2-0.5 CPU per call
- Memory serialization: proportional to size

**Cache aggressively**:
```typescript
// BAD: Room.find every tick
const targets = creep.room.find(FIND_STRUCTURES, { filter: ... });

// GOOD: Cache for N ticks
if (!room.memory._structureCache || Game.time % 10 === 0) {
  room.memory._structureCache = room.find(...).map(s => s.id);
}
const targets = room.memory._structureCache.map(id => Game.getObjectById(id)).filter(Boolean);
```

### 8. Failure Recovery

Your bot WILL encounter:
- All creeps dying (spawn interrupted, hostiles)
- Full storage (production > consumption)
- Empty storage (consumption > production)
- Bucket death spiral (too much CPU usage)

Build recovery paths:
- If no harvesters exist, spawn emergency bootstrap creep
- If storage full, reduce mining, increase upgrading
- If bucket < 1000, skip non-essential operations
- If spawn under attack, trigger safe mode before it dies

---

## Code Quality Standards

### Do
- Use strict TypeScript (no `any` unless unavoidable)
- Handle undefined/null explicitly (objects can die between ticks)
- Return early to avoid deep nesting
- Use descriptive variable names
- Cache expensive lookups
- Add JSDoc comments for complex functions
- Use constants from the game API (OK, ERR_NOT_IN_RANGE, etc.)

### Don't
- Use `delete` on Memory properties in loops (causes deoptimization)
- Store object references in memory (they serialize as empty objects)
- Use console.log for debugging (use the logger utility)
- Assume objects exist (creeps die, structures get destroyed)
- Use global variables for state (use Memory)
- Mutate arrays during iteration

### Error Handling
```typescript
// Always wrap main operations
try {
  runCreep(creep);
} catch (error) {
  console.log(`Error running ${creep.name}: ${error}`);
  // Don't let one creep error kill the whole tick
}
```

### Idiomatic Screeps Patterns

```typescript
// Check action result and move if not in range
const result = creep.harvest(source);
if (result === ERR_NOT_IN_RANGE) {
  creep.moveTo(source);
}

// Get object by stored ID (handles death)
const target = Game.getObjectById(creep.memory.targetId);
if (!target) {
  delete creep.memory.targetId;
  return;
}

// Filter structures efficiently
const extensions = room.find(FIND_MY_STRUCTURES, {
  filter: { structureType: STRUCTURE_EXTENSION }
}) as StructureExtension[];

// Check if spawner is busy
if (spawn.spawning) return;

// Safe memory access
creep.memory.state = creep.memory.state || 'IDLE';
```

---

## Implementation Checklist for New Features

When adding a new system:

1. **Define the memory schema first**
   - What data needs to persist?
   - What can be recalculated?

2. **Handle the empty state**
   - What happens on first run?
   - What if all relevant creeps are dead?

3. **Add to the scheduler appropriately**
   - Every tick? Every N ticks?
   - Only when bucket allows?

4. **Add CPU profiling**
   - Wrap in profiler calls
   - Log if exceeds expected cost

5. **Add console commands for debugging**
   - Status check
   - Manual trigger
   - Force reset

6. **Test failure cases**
   - What if the structure is destroyed?
   - What if memory is corrupted?
   - What if no CPU available?

---

## Current Codebase Issues to Fix

1. **ColonyManager tasks not consumed** - Tasks are generated but creeps still use role-based logic

2. **Harvester static miner** - No handling for full container; creep just idles

3. **RemoteMiner** - No distance limiting on target room selection

4. **Reserver/Claimer** - Listed in roles.ts but not implemented

5. **No link support** - Missing entirely

6. **AWS task-definition.json** - Hardcoded Screeps token, should use Secrets Manager

---

## Testing Your Changes

1. Build: `npm run build`
2. Deploy to sim: `npm run push:sim`
3. Deploy to main: `npm run push`
4. Watch Screeps console for errors
5. Use console commands: `status()`, `creeps()`, `cpu()`

Always test in simulation first for major changes.

---

## Common Screeps API Reference

```typescript
// Find operations
room.find(FIND_SOURCES)
room.find(FIND_MY_SPAWNS)
room.find(FIND_HOSTILE_CREEPS)
room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_CONTAINER } })
room.find(FIND_DROPPED_RESOURCES)
room.find(FIND_CONSTRUCTION_SITES)

// Position operations
pos.findClosestByPath(FIND_SOURCES)
pos.findInRange(FIND_STRUCTURES, 3)
pos.getRangeTo(target)
pos.isEqualTo(otherPos)
pos.isNearTo(target) // range 1

// Creep actions (return OK or ERR_*)
creep.harvest(source)
creep.transfer(target, RESOURCE_ENERGY)
creep.withdraw(target, RESOURCE_ENERGY)
creep.pickup(droppedResource)
creep.build(constructionSite)
creep.repair(structure)
creep.upgradeController(controller)
creep.moveTo(target, { reusePath: 5 })
creep.attack(target)
creep.rangedAttack(target)
creep.heal(target)

// Spawn operations
spawn.spawnCreep(body, name, { memory: {...} })
spawn.spawning // null or { name, remainingTime }

// Structure operations
tower.attack(target)
tower.heal(creep)
tower.repair(structure)
link.transferEnergy(targetLink)
storage.store[RESOURCE_ENERGY]
terminal.send(resourceType, amount, destination)
```

---

## Summary

Build incrementally. Each system should work in isolation before integrating. Prioritize economic stability over features. When in doubt, check CPU usage and bucket level. A bot that runs consistently at 15 CPU is better than one that spikes to 50 and crashes.
