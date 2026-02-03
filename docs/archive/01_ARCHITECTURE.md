# Screeps Bot Architecture: State Model

## The Problem

The current codebase uses a **role-based** architecture where each creep type (Harvester, Upgrader, Builder) has hardcoded behavior. This creates several fundamental issues:

### 1. No Colony-Level Coordination

Each creep makes decisions independently based on its role, not based on what the colony actually needs. Result: multiple creeps doing the same low-priority task while high-priority tasks go undone.

### 2. Implicit State

Creeps use a boolean `working` flag that means different things for different roles:
- Harvester: `working=true` means "delivering energy"
- Upgrader: `working=true` means "upgrading controller"
- Builder: `working=true` means "building"

There's no explicit state machine, making behavior unpredictable and hard to debug.

### 3. Hardcoded Fallbacks

When a creep can't do its primary job, it falls back to other behaviors:
- Harvester delivers to spawn, then tower, then **upgrades controller**
- Upgrader looks for storage, container, dropped energy, then **waits at spawn**
- Builder looks for energy sources, then **waits at spawn**

These fallbacks cause the exact problem observed: harvesters upgrade while upgraders wait.

---

## The Solution: Task-Based Coordination

Replace role-based decisions with a centralized task system:

```
┌─────────────────────────────────────────────────────────────────┐
│                     COLONY ASSESSMENT                            │
│                                                                  │
│  Runs once per tick per room. Evaluates:                        │
│  - Energy income (harvesters × work parts)                       │
│  - Energy storage (containers + storage)                         │
│  - Spawn capacity (energy needed for spawn + extensions)         │
│  - Work demands (construction sites, repair needs, upgrade)      │
│  - Threats (hostile creeps, damage potential)                    │
│  - Workforce (total creeps, idle creeps)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     COLONY PHASE                                 │
│                                                                  │
│  BOOTSTRAP:   < 3 workers, establishing basics                  │
│  DEVELOPING:  RCL < 4 or storage < 5000 energy                  │
│  STABLE:      Established economy, normal operations            │
│  EMERGENCY:   Under attack or critical failure                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TASK GENERATION                              │
│                                                                  │
│  Based on phase and needs, generate concrete tasks:             │
│                                                                  │
│  BOOTSTRAP priorities:                                          │
│    1. HARVEST (get energy flowing)                              │
│    2. SUPPLY_SPAWN (enable more spawning)                       │
│    3. UPGRADE (only if spawn full)                              │
│                                                                  │
│  DEVELOPING priorities:                                         │
│    1. SUPPLY_SPAWN                                              │
│    2. HARVEST                                                   │
│    3. SUPPLY_TOWER                                              │
│    4. BUILD                                                     │
│    5. UPGRADE                                                   │
│                                                                  │
│  STABLE priorities:                                             │
│    1. SUPPLY_SPAWN                                              │
│    2. HARVEST                                                   │
│    3. SUPPLY_TOWER                                              │
│    4. BUILD                                                     │
│    5. REPAIR                                                    │
│    6. UPGRADE                                                   │
│    7. SUPPLY_STORAGE                                            │
│                                                                  │
│  EMERGENCY priorities:                                          │
│    0. DEFEND                                                    │
│    1. SUPPLY_TOWER                                              │
│    2. SUPPLY_SPAWN                                              │
│    3. HARVEST                                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TASK ASSIGNMENT                              │
│                                                                  │
│  Match tasks to creeps based on:                                │
│  - Capability (body parts determine what creep CAN do)          │
│  - Proximity (closer creeps preferred)                          │
│  - Current state (idle creeps assigned first)                   │
│                                                                  │
│  A creep with [WORK, CARRY, MOVE] can:                          │
│    - HARVEST (has WORK)                                         │
│    - BUILD/REPAIR/UPGRADE (has WORK)                            │
│    - SUPPLY_* (has CARRY)                                       │
│    - PICKUP/WITHDRAW (has CARRY)                                │
│                                                                  │
│  A creep with [CARRY, CARRY, MOVE, MOVE] can only:              │
│    - SUPPLY_*                                                   │
│    - PICKUP/WITHDRAW                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TASK EXECUTION                               │
│                                                                  │
│  Creep runs state machine to complete assigned task:            │
│                                                                  │
│  ┌──────┐                                                       │
│  │ IDLE │ ◄────────────────────────────────────┐               │
│  └──┬───┘                                      │               │
│     │ task assigned                            │               │
│     ▼                                          │               │
│  ┌──────────┐                                  │               │
│  │ EVALUATE │ ─── need energy? ───┐           │               │
│  └──────────┘                     │           │               │
│     │ no                          │ yes       │               │
│     ▼                             ▼           │               │
│  ┌────────┐                  ┌───────────┐   │               │
│  │ MOVING │                  │ COLLECTING│   │               │
│  └───┬────┘                  └─────┬─────┘   │               │
│      │ arrived                     │ got energy              │
│      ▼                             ▼                          │
│  ┌─────────┐                  ┌────────┐                      │
│  │ WORKING │ ◄────────────────┤ MOVING │                      │
│  └────┬────┘                  └────────┘                      │
│       │ task complete                                         │
│       └───────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Design Principles

### 1. Single Source of Truth

The TaskCoordinator is the only place that decides what work needs doing. Creeps don't decide - they execute.

### 2. Explicit State

Every creep has a clear state: IDLE, MOVING, COLLECTING, WORKING, etc. State transitions are explicit and logged.

### 3. Capability-Based Assignment

Don't ask "what role is this creep?" Ask "what can this creep do?" A creep with WORK+CARRY+MOVE can harvest, build, upgrade, and haul.

### 4. No Hardcoded Fallbacks

If a creep can't complete its task, it reports back to the coordinator. The coordinator reassigns or generates new tasks. Creeps never freelance.

### 5. Energy Flows Through Buffers

Energy should accumulate in containers/storage, not disappear into upgrades. Harvesters put energy IN. Haulers move energy AROUND. Workers take energy OUT.

---

## Implementation Notes

### Memory Schema

```typescript
interface CreepMemory {
  room: string;              // Home room
  task?: {
    id: string;              // Unique task identifier
    type: TaskType;          // HARVEST, SUPPLY_SPAWN, etc.
    targetId?: Id<any>;      // Target object
    state: CreepState;       // Current state machine state
    stateStartedAt: number;  // When we entered this state
  };
}
```

### Task Schema

```typescript
interface Task {
  id: string;
  type: TaskType;
  priority: number;          // Lower = more urgent
  targetId?: Id<any>;
  targetPos?: RoomPosition;  // For pathfinding before target visible
  assignedCreep?: string;    // Creep name, if assigned
  createdAt: number;
  expires?: number;          // Auto-cleanup
}
```

### Coordinator API

```typescript
class TaskCoordinator {
  run(): void;                           // Call once per tick
  getPhase(): ColonyPhase;
  getNeeds(): ColonyNeeds;
  getCreepTask(name: string): Task;
  completeTask(taskId: string): void;    // Creep finished
  abandonTask(taskId: string): void;     // Target died, etc.
}
```
