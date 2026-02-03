# Creep State Machines

## Why State Machines?

The current codebase uses implicit state via boolean flags:
```typescript
if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
  creep.memory.working = false;
}
```

This is problematic because:
1. `working` means different things for different roles
2. No way to know WHAT the creep is doing, only WHETHER it's "working"
3. State transitions are scattered throughout code
4. Debugging requires reading entire role file

Explicit state machines solve this:
```typescript
switch (creep.memory.state) {
  case CreepState.MOVING_TO_SOURCE:
    // clearly defined behavior
  case CreepState.HARVESTING:
    // clearly defined behavior
  case CreepState.MOVING_TO_DELIVER:
    // clearly defined behavior
}
```

---

## State Definitions

### IDLE

**Description**: Creep has no assigned task.

**Behavior**:
- Move toward spawn area (avoid blocking important locations)
- Check for new task assignment each tick
- Display "💤" indicator

**Transitions**:
- → Any working state when task assigned

---

### MOVING

**Description**: Creep is traveling to a destination.

**Behavior**:
- Use `moveTo()` with path caching (reusePath: 5-10)
- Track position each tick for stuck detection
- Visualize path for debugging

**Stuck Detection**:
```
If position unchanged for 3+ ticks:
  - Try moving in random valid direction
  - Increment stuck counter
  - If stuck > 10 ticks, abandon task
```

**Transitions**:
- → HARVESTING when adjacent to source (harvest task)
- → COLLECTING when adjacent to energy source (supply task)
- → WORKING when in range of work target
- → IDLE if path blocked for too long

---

### HARVESTING

**Description**: Creep is actively mining a source.

**Behavior**:
- Call `creep.harvest(source)` each tick
- Track energy gained

**Transitions**:
- → DELIVERING when inventory full
- → IDLE when source empty AND inventory empty
- → MOVING if pushed off source position

---

### COLLECTING

**Description**: Creep is gathering energy for a task.

**Behavior**:
- Determine best energy source (see priority list below)
- Move to source and withdraw/pickup

**Energy Source Priority**:
1. Dropped energy within 10 tiles (>50 amount)
2. Container with >100 energy
3. Storage
4. Tombstone with energy
5. Harvest directly from source (last resort)

**Transitions**:
- → WORKING when has enough energy for task
- → MOVING when energy source identified but not adjacent
- → IDLE if no energy available anywhere

---

### DELIVERING

**Description**: Creep is depositing energy at a target.

**Behavior**:
- Move to delivery target
- Transfer energy

**Target Selection** (for harvesters):
1. Container at assigned source
2. Storage
3. Drop on ground (creates pickup task for haulers)

**Transitions**:
- → HARVESTING when inventory empty (for harvest task)
- → IDLE when task complete
- → COLLECTING if delivery target no longer valid

---

### WORKING

**Description**: Creep is performing its task action (build, repair, upgrade, etc.)

**Behavior**:
- Execute appropriate action based on task type
- Track progress

**Task-Specific Actions**:
| Task Type | Action | Range |
|-----------|--------|-------|
| UPGRADE | upgradeController() | 3 |
| BUILD | build() | 3 |
| REPAIR | repair() | 3 |
| SUPPLY_* | transfer() | 1 |
| DEFEND | attack() / rangedAttack() | 1 / 3 |

**Transitions**:
- → COLLECTING when out of energy (for work tasks)
- → IDLE when task complete
- → MOVING if pushed out of range

---

### FIGHTING

**Description**: Creep is in combat.

**Behavior**:
- Attack assigned target
- Kite if ranged (maintain distance)
- Retreat if low HP

**Transitions**:
- → IDLE when target dead
- → FLEEING when HP critical
- → MOVING when target moves out of range

---

### FLEEING

**Description**: Creep is escaping danger.

**Behavior**:
- Move away from all hostiles
- Head toward spawn (safe zone)
- Ignore all other tasks

**Transitions**:
- → IDLE when safe (near spawn, no hostiles in range)
- → FIGHTING if cornered (must fight to survive)

---

### RENEWING

**Description**: Creep is being renewed at spawn.

**Behavior**:
- Stay adjacent to spawn
- Wait for renewCreep() calls

**Transitions**:
- → IDLE when TTL restored above threshold
- → Previous state if spawn busy

---

## State Transition Diagram

```
                                    ┌─────────────────────────────┐
                                    │           IDLE              │
                                    │   (waiting for task)        │
                                    └─────────────┬───────────────┘
                                                  │
                              task assigned       │
                    ┌─────────────────────────────┼─────────────────────────────┐
                    │                             │                             │
                    ▼                             ▼                             ▼
          ┌─────────────────┐           ┌─────────────────┐           ┌─────────────────┐
          │    HARVESTING   │           │   COLLECTING    │           │    FIGHTING     │
          │  (for HARVEST)  │           │ (need energy)   │           │  (for DEFEND)   │
          └────────┬────────┘           └────────┬────────┘           └────────┬────────┘
                   │                             │                             │
                   │ full                        │ got energy                  │ target dead
                   ▼                             ▼                             │
          ┌─────────────────┐           ┌─────────────────┐                   │
          │   DELIVERING    │           │    WORKING      │                   │
          │ (drop/transfer) │           │ (build/repair/  │                   │
          └────────┬────────┘           │  upgrade/supply)│                   │
                   │                    └────────┬────────┘                   │
                   │ empty                       │                             │
                   │                             │ empty OR complete           │
                   │                             │                             │
                   └─────────────────────────────┴─────────────────────────────┘
                                                 │
                                                 ▼
                                    ┌─────────────────────────────┐
                                    │           IDLE              │
                                    │   (task complete)           │
                                    └─────────────────────────────┘


                        EMERGENCY TRANSITIONS (from any state)
                        
    ┌─────────────────────────────────────────────────────────────────────────┐
    │                                                                         │
    │   HP < 50% AND hostile nearby  ──────►  FLEEING                        │
    │                                                                         │
    │   TTL < 100 AND near spawn     ──────►  RENEWING                       │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘
```

---

## Memory Structure

```typescript
interface CreepTaskMemory {
  // Current state
  state: CreepState;
  stateStartedAt: number;       // Game.time when entered state
  
  // Task info
  taskId: string | null;
  taskType: TaskType | null;
  targetId: Id<any> | null;
  targetPos: { x: number, y: number, roomName: string } | null;
  
  // Movement tracking
  lastPos: { x: number, y: number } | null;
  stuckCount: number;
  
  // Task-specific data
  energyCollected: number;      // For tracking harvest efficiency
  damageDealt: number;          // For combat logging
}
```

---

## State Execution Pattern

Each tick, the executor runs:

```
1. Check emergency transitions (flee, renew)
2. Check if task is still valid (target exists, not expired)
3. Execute current state behavior
4. Check for state transitions
5. Update memory
```

Pseudo-code:
```
function executeCreep(creep):
    memory = creep.memory.task
    
    // Emergency checks
    if shouldFlee(creep):
        setState(FLEEING)
        return executeFlee(creep)
    
    if shouldRenew(creep):
        setState(RENEWING)
        return executeRenew(creep)
    
    // Validate task
    if memory.taskId:
        task = coordinator.getTask(memory.taskId)
        if not task or taskExpired(task) or targetInvalid(task):
            coordinator.abandonTask(memory.taskId)
            setState(IDLE)
            return
    
    // Execute based on state
    switch memory.state:
        case IDLE:
            return executeIdle(creep)
        case MOVING:
            return executeMoving(creep)
        case HARVESTING:
            return executeHarvesting(creep)
        // ... etc
```

---

## Stuck Detection Details

Creeps get stuck when:
- Another creep is blocking their path
- Path goes through a newly placed structure
- Creep is in a corner and can't path around obstacle

Detection:
```
function updateStuckDetection(creep, memory):
    currentPos = { x: creep.pos.x, y: creep.pos.y }
    
    if memory.lastPos:
        if currentPos.x == memory.lastPos.x AND currentPos.y == memory.lastPos.y:
            memory.stuckCount++
        else:
            memory.stuckCount = 0
    
    memory.lastPos = currentPos
    
    if memory.stuckCount >= 3:
        return true  // Creep is stuck
    return false
```

Resolution:
```
function resolveStuck(creep):
    // Try random adjacent walkable tile
    directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT]
    shuffle(directions)
    
    for dir in directions:
        result = creep.move(dir)
        if result == OK:
            return true
    
    // Completely stuck, abandon task
    return false
```

---

## Visual Indicators

Each state should display a visual cue:

| State | Say | Path Color |
|-------|-----|------------|
| IDLE | 💤 | none |
| MOVING | 🚶 | white |
| HARVESTING | ⛏️ | yellow |
| COLLECTING | 📥 | orange |
| DELIVERING | 📦 | green |
| WORKING (build) | 🔨 | green |
| WORKING (repair) | 🔧 | orange |
| WORKING (upgrade) | ⚡ | cyan |
| FIGHTING | ⚔️ | red |
| FLEEING | 🏃 | red (dashed) |
| RENEWING | ♻️ | white |
