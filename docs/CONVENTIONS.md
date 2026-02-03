# Code Conventions

## TypeScript Style

### Strict Mode
All code uses TypeScript strict mode. No `any` unless unavoidable.

### Null Handling
Always handle undefined/null explicitly. Objects can die between ticks.

```typescript
// Good
const target = Game.getObjectById(creep.memory.targetId);
if (!target) {
  delete creep.memory.targetId;
  return;
}

// Bad - assumes target exists
const target = Game.getObjectById(creep.memory.targetId)!;
```

### Early Returns
Prefer early returns over deep nesting.

```typescript
// Good
function process(creep: Creep): void {
  if (!creep.memory.taskId) return;
  if (creep.spawning) return;
  // main logic
}

// Bad
function process(creep: Creep): void {
  if (creep.memory.taskId) {
    if (!creep.spawning) {
      // deeply nested
    }
  }
}
```

## Naming Conventions

### Files
- `PascalCase` for class files: `ColonyManager.ts`
- `camelCase` for utility files: `utilitySpawning.ts`
- Creep roles in `src/creeps/` match role name: `Harvester.ts`

### Variables
```typescript
const creepCount: number;      // camelCase for variables
const ECONOMY_ROLES: string[]; // UPPER_CASE for constants
interface ColonyState { }      // PascalCase for types
```

### Memory Keys
```typescript
creep.memory.targetId;   // camelCase
creep.memory._lastPos;   // _prefix for internal/temporary
Memory.rooms[name].tasks; // Nested paths
```

## Error Handling

### Wrap Role Execution
```typescript
try {
  runCreep(creep);
} catch (error) {
  console.log(`Error running ${creep.name}: ${error}`);
  // Don't let one creep error kill the tick
}
```

### Use Return Codes
```typescript
const result = creep.harvest(source);
if (result === ERR_NOT_IN_RANGE) {
  creep.moveTo(source);
} else if (result === ERR_NOT_ENOUGH_RESOURCES) {
  // Handle empty source
}
```

## Memory Management

### Keep Memory Lean
- Don't store object references (they don't serialize)
- Store IDs, not objects
- Recalculate what you can from game state

```typescript
// Good
creep.memory.sourceId = source.id;

// Bad - won't serialize
creep.memory.source = source;
```

### Clean Dead Creeps
Memory for dead creeps doesn't auto-clean. Main loop handles this:
```typescript
for (const name in Memory.creeps) {
  if (!Game.creeps[name]) {
    delete Memory.creeps[name];
  }
}
```

## CPU Efficiency

### Cache Expensive Lookups
```typescript
// Bad - Room.find every tick
const targets = creep.room.find(FIND_STRUCTURES, { filter: ... });

// Good - Cache with ColonyStateManager
const state = ColonyStateManager.getState(room);
const targets = state.structures;
```

### Batch Operations
```typescript
// Bad - Multiple find calls
const spawns = room.find(FIND_MY_SPAWNS);
const extensions = room.find(FIND_MY_STRUCTURES, { filter: ... });
const containers = room.find(FIND_STRUCTURES, { filter: ... });

// Good - Single find, filter in code
const structures = room.find(FIND_STRUCTURES);
const spawns = structures.filter(s => s.structureType === STRUCTURE_SPAWN);
```

### Use Constants
```typescript
// Good - Uses game constants
if (result === ERR_NOT_IN_RANGE)
creep.moveTo(target, { reusePath: 10 })

// Bad - Magic numbers
if (result === -9)
```

## Screeps Patterns

### Action + Move Pattern
```typescript
const result = creep.harvest(source);
if (result === ERR_NOT_IN_RANGE) {
  creep.moveTo(source);
}
```

### State Machine
```typescript
switch (creep.memory.state) {
  case 'COLLECTING':
    if (creep.store.getFreeCapacity() === 0) {
      creep.memory.state = 'DELIVERING';
    }
    collectEnergy(creep);
    break;
  case 'DELIVERING':
    if (creep.store.getUsedCapacity() === 0) {
      creep.memory.state = 'COLLECTING';
    }
    deliverEnergy(creep);
    break;
}
```

### Safe Object Access
```typescript
const target = Game.getObjectById(memory.targetId);
if (!target) {
  delete memory.targetId;
  return;
}
// Now target is guaranteed to exist
```

## Logging

### Use Logger
```typescript
import { logger } from "../utils/Logger";

logger.info("Spawner", `Spawning ${role} in ${room.name}`);
logger.warn("Economy", "Storage empty");
logger.error("Defense", `Lost spawn in ${room.name}`);
```

### Log Levels
- `TRACE` - Very verbose, function entry/exit
- `DEBUG` - Debugging info
- `INFO` - Normal operations
- `WARN` - Unusual but handled
- `ERROR` - Something went wrong

Controlled by `CONFIG.LOG_LEVEL`.

## Comments

### When to Comment
- Complex algorithms
- Non-obvious behavior
- Bug workarounds
- TODO items

### JSDoc for Public Functions
```typescript
/**
 * Find best energy source considering distance and congestion.
 * @param creep - The creep looking for energy
 * @param minEnergy - Minimum energy to consider (default 50)
 * @returns Best energy source or null
 */
export function findBestEnergySource(creep: Creep, minEnergy = 50): EnergySource | null
```

## File Organization

### Import Order
1. External libraries (lodash, etc.)
2. Type imports
3. Local utilities
4. Local modules

```typescript
import _ from 'lodash';
import { CreepMemory, ColonyPhase } from '../types';
import { logger } from '../utils/Logger';
import { ColonyManager } from '../core/ColonyManager';
```

### Export Style
```typescript
// Named exports for functions/classes
export function runHarvester(creep: Creep): void { }
export class ColonyManager { }

// Default exports only for main entry points
export default loop;
```

## Testing

### Test Files Location
```
tests/spawner/
├── invariants.ts      # Test rules
├── stateGenerator.ts  # Mock state
├── runTests.ts        # Monte Carlo tests
└── simulator.ts       # Economic simulation
```

### Running Tests
```bash
cd tests/spawner
npm run test:all
```
