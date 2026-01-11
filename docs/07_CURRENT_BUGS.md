# Current Codebase Bugs

This document catalogs specific bugs in the existing role-based implementation that the task-based refactor must address.

---

## BUG 1: Harvesters Upgrade Instead of Stockpiling

**File**: `src/creeps/Harvester.ts`

**Location**: `deliver()` function, lines ~85-95

**Current Behavior**:
```typescript
// Priority 3: Controller (upgrade if nothing else needs energy)
const controller = creep.room.controller;
if (controller && controller.my) {
  if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
    creep.moveTo(controller, ...);
  }
  return;
}
```

**Problem**: When spawn/extensions are full, harvesters upgrade the controller. This removes energy from the economy instead of stockpiling it for other creeps.

**Observable Symptom**: Upgraders and builders idle while harvesters upgrade.

**Fix Required**: Harvesters should NEVER upgrade. When delivery targets are full:
1. Transfer to container at source
2. Transfer to storage
3. Transfer to any container
4. Drop on ground (haulers collect)

---

## BUG 2: Upgraders Wait Indefinitely

**File**: `src/creeps/Upgrader.ts`

**Location**: `getEnergy()` function, lines ~70-90

**Current Behavior**:
```typescript
// No energy available - wait near controller for haulers to deliver
const controller = creep.room.controller;
if (controller) {
  if (creep.pos.getRangeTo(controller) > 3) {
    creep.moveTo(controller, ...);
  }
  creep.say("💤");
}
```

**Problem**: Upgraders wait passively for energy delivery. No mechanism ensures haulers will deliver to them. They can wait forever.

**Observable Symptom**: Upgraders display "💤" while harvesters burn energy on upgrades.

**Fix Required**: Task-based system should:
1. Only assign UPGRADE tasks when energy is available
2. UPGRADE task includes "get energy" sub-state
3. If no energy accessible within N ticks, creep reports back to coordinator

---

## BUG 3: Builders Wait at Spawn

**File**: `src/creeps/Builder.ts`

**Location**: `getEnergy()` function, lines ~85-95

**Current Behavior**:
```typescript
// No energy available - wait near spawn for haulers to deliver
const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
if (spawn) {
  if (creep.pos.getRangeTo(spawn) > 3) {
    creep.moveTo(spawn, ...);
  }
  creep.say("💤");
}
```

**Problem**: Same as upgraders - passive waiting with no guarantee of delivery.

**Observable Symptom**: Builders clustered near spawn, doing nothing.

**Fix Required**: Same as upgraders.

---

## BUG 4: Hauler Delivers When Half Full

**File**: `src/creeps/Hauler.ts`

**Location**: State transition logic, lines ~10-18

**Current Behavior**:
```typescript
if (!creep.memory.working) {
  const capacity = creep.store.getCapacity();
  const used = creep.store.getUsedCapacity();
  if (used >= capacity * 0.5 || creep.store.getFreeCapacity() === 0) {
    creep.memory.working = true;
    creep.say("📦 deliver");
  }
}
```

**Problem**: Hauler switches to deliver mode at 50% capacity. This means more trips, more travel time, less efficiency.

**Observable Symptom**: Haulers making many short trips instead of fewer full trips.

**Fix Required**: Haulers should fill to 100% before delivering (with exception for urgent needs like low spawn energy).

---

## BUG 5: Variable Shadowing in Upgrader

**File**: `src/creeps/Upgrader.ts`

**Location**: `getEnergy()` function, line ~80

**Current Behavior**:
```typescript
function getEnergy(creep: Creep): void {
  // ... earlier code uses `controller` ...
  
  // No energy available - wait near controller
  const controller = creep.room.controller;  // SHADOWS outer variable
  if (controller) {
    // ...
  }
}
```

**Problem**: The variable `controller` is declared twice - once in function scope, once in the final block. TypeScript may compile this, but it's confusing and bug-prone.

**Observable Symptom**: None directly, but makes code maintenance error-prone.

**Fix Required**: Remove inner declaration, use existing variable.

---

## BUG 6: Harvester Doesn't Handle Full Container

**File**: `src/creeps/Harvester.ts`

**Location**: `runStaticMiner()` function

**Current Behavior**:
```typescript
function runStaticMiner(creep: Creep, source: Source, container: StructureContainer): void {
  // ... harvest source ...
  
  if (creep.store[RESOURCE_ENERGY] > 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    creep.transfer(container, RESOURCE_ENERGY);
  }
}
```

**Problem**: No handling for when container is full. Harvester keeps harvesting into its own inventory, then... nothing. Energy sits in harvester.

**Observable Symptom**: Static miners with full inventory, container full, energy stuck.

**Fix Required**: When container full:
1. Stop harvesting (save CPU)
2. OR drop energy for hauler pickup
3. OR deliver to storage directly

---

## BUG 7: RemoteMiner No Distance Limit

**File**: `src/core/Spawner.ts`

**Location**: `getRemoteMiningTargets()` function

**Current Behavior**:
```typescript
for (const dir in exits) {
  const adjacentRoom = exits[dir as ExitKey];
  // ... check if room is valid ...
  targets.push(adjacentRoom);
}
```

**Problem**: Only checks immediately adjacent rooms. Remote mining 3+ rooms away is inefficient but code doesn't prevent it.

**Observable Symptom**: Remote miners spawned for distant rooms, spending more time traveling than mining.

**Fix Required**: 
1. Calculate round-trip time vs energy gained
2. Only mine rooms where profit > 0
3. Typically limit to 1-2 rooms away

---

## BUG 8: No Colony Coordination

**File**: All role files

**Problem**: Each creep makes independent decisions. No central coordinator ensures work is distributed efficiently.

**Observable Symptom**: Multiple creeps doing same low-priority task while high-priority tasks undone.

**Example Scenario**:
```
Spawn: FULL (300/300)
Source 1: Harvester A mining
Source 2: Harvester B mining

Harvester A: "I have energy, spawn full... upgrade!"
Harvester B: "I have energy, spawn full... upgrade!"
Upgrader A: "Need energy, nothing available... wait"
Upgrader B: "Need energy, nothing available... wait"
```

Both harvesters upgrade while both upgraders wait. A coordinator would recognize the mismatch and reassign.

**Fix Required**: Implement TaskCoordinator that:
1. Assesses colony needs
2. Generates tasks based on priority
3. Assigns tasks to capable idle creeps
4. Prevents duplicate/conflicting assignments

---

## BUG 9: Memory Cleanup Too Infrequent

**File**: `src/core/MemoryManager.ts`

**Location**: `cleanup()` function

**Current Behavior**:
```typescript
if (Game.time % CONFIG.MEMORY_CLEANUP_INTERVAL !== 0) return;
// CONFIG.MEMORY_CLEANUP_INTERVAL = 100
```

**Problem**: Dead creeps persist in Memory for up to 100 ticks. If code references dead creep memory, stale data causes bugs.

**Observable Symptom**: Ghost tasks, incorrect creep counts.

**Fix Required**: Clean up dead creeps every tick. It's cheap (one object iteration) and prevents bugs.

---

## BUG 10: AWS Credentials in Code

**File**: `aws/task-definition.json`

**Location**: Environment variables

**Current Behavior**:
```json
"environment": [
  {
    "name": "SCREEPS_TOKEN",
    "value": "7a601a02-0b71-49db-a9c9-cdad848eaa82"
  }
]
```

**Problem**: Hardcoded API token in source file. Should use AWS Secrets Manager or environment variables.

**Observable Symptom**: Security vulnerability - token exposed in git history.

**Fix Required**: Use AWS Secrets Manager or Parameter Store. Reference secret ARN instead of value.

---

## Architectural Bug: Role-Based Design

**Not a code bug, but a design flaw.**

The current architecture assigns creeps to roles at spawn time. Each role has hardcoded behavior. This creates:

1. **Inflexibility**: Can't reassign creep to different work
2. **Duplication**: Similar code in each role file
3. **Priority Blindness**: Roles don't know colony priorities
4. **Coordination Gap**: No way to balance work across creeps

**Fix Required**: Replace role-based with task-based architecture where:
- Creeps have capabilities (not roles)
- Coordinator assigns tasks based on priorities
- Creeps execute assigned tasks
- Tasks complete and new ones are assigned

---

## Bug Summary Table

| Bug | Severity | File | Immediate Fix | Long-term Fix |
|-----|----------|------|---------------|---------------|
| Harvesters upgrade | HIGH | Harvester.ts | Remove upgrade fallback | Task-based |
| Upgraders wait | HIGH | Upgrader.ts | Add harvest fallback | Task-based |
| Builders wait | HIGH | Builder.ts | Add harvest fallback | Task-based |
| Hauler 50% | MEDIUM | Hauler.ts | Change to 100% | Task-based |
| Variable shadow | LOW | Upgrader.ts | Remove redeclaration | Refactor |
| Full container | MEDIUM | Harvester.ts | Add drop fallback | Task-based |
| Remote distance | LOW | Spawner.ts | Add distance check | Remote mining system |
| No coordination | HIGH | All | N/A | Task-based (required) |
| Memory cleanup | LOW | MemoryManager.ts | Every tick cleanup | Same |
| AWS credentials | HIGH | task-definition.json | Use Secrets Manager | Same |
