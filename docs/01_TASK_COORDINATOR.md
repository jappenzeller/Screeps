# PROMPT: Implement TaskCoordinator

## Context

You are implementing a task-based coordination system for a Screeps bot. The TaskCoordinator is the central brain that runs once per tick per room. It assesses colony needs, determines the current phase, generates tasks, and assigns them to creeps.

## Reference Documents

Before implementing, read these documents in order:
1. `docs/01_ARCHITECTURE.md` - Overall system design
2. `docs/02_ENERGY_FLOW.md` - How energy should move through the colony
3. `docs/03_TASK_TYPES.md` - All task types and their requirements
4. `docs/05_COLONY_PHASES.md` - Phase detection and phase-specific behavior

## File to Create

`src/core/TaskCoordinator.ts`

## Requirements

### 1. Colony Assessment

The coordinator must evaluate the room state each tick:

```
ColonyNeeds {
  // Energy metrics
  energyAvailable: number       // spawn + extensions current
  energyCapacity: number        // spawn + extensions max
  storageEnergy: number         // storage.store[RESOURCE_ENERGY]
  containerEnergy: number       // sum of all containers
  droppedEnergy: number         // sum of all dropped resources
  
  // Source utilization
  sources: Array<{
    id: Id<Source>
    assignedWorkParts: number   // WORK parts currently harvesting
    maxWorkParts: number        // always 5 (saturates at 10 energy/tick)
    hasContainer: boolean
  }>
  
  // Work demands
  constructionSites: number     // count of sites
  repairNeeded: number          // structures below 75% HP
  controllerTicksToDowngrade: number
  
  // Threats
  hostiles: Array<{
    id: Id<Creep>
    dps: number                 // ATTACK*30 + RANGED_ATTACK*10
    healing: number             // HEAL*12
  }>
  totalHostileDPS: number
  
  // Workforce
  creeps: Map<string, {
    name: string
    workParts: number
    carryParts: number
    attackParts: number
    currentTaskId: string | null
    state: CreepState
  }>
  idleCreeps: string[]          // creep names without tasks
}
```

### 2. Phase Detection

Determine colony phase based on needs:

```
BOOTSTRAP:  idleCreeps.length + busyCreeps.length < 3
EMERGENCY:  totalHostileDPS > 0 OR controllerTicksToDowngrade < 2000
DEVELOPING: RCL < 4 OR storageEnergy < 5000
STABLE:     everything else
```

Phase must be stored in Memory and logged on change.

### 3. Task Generation

Generate tasks based on phase. Each task type has generation rules:

**HARVEST tasks:**
- One task per source
- Only generate if source has available work capacity
- Task includes sourceId

**SUPPLY_SPAWN tasks:**
- Generate when energyAvailable < energyCapacity
- One task per structure needing energy
- Priority 0 (highest)

**SUPPLY_TOWER tasks:**
- Generate when tower.store[RESOURCE_ENERGY] < 800
- One task per tower
- Priority varies by phase (0 in EMERGENCY, 2 otherwise)

**BUILD tasks:**
- Generate when construction sites exist
- One task per site
- Limit to 3 concurrent (avoid congestion)
- Priority by structure type (spawn > extension > tower > container > road)

**UPGRADE tasks:**
- Generate based on available workforce
- Number = idleCreeps - otherTasksGenerated
- Minimum 1 if controller downgrade < 10000
- Priority 5 (low)

**DEFEND tasks:**
- Generate one per hostile
- Only in EMERGENCY phase
- Priority 0

### 4. Task Assignment

Match tasks to creeps:

```
for each unassigned task (sorted by priority):
  candidates = creeps that:
    - are idle (no current task)
    - have required body parts for task type
    - are in same room as task target
  
  if candidates.length > 0:
    select candidate with:
      - closest distance to task target
      - tie-breaker: most relevant body parts
    
    assign task to candidate
    mark candidate as busy
```

### 5. Task Completion/Abandonment

Provide methods for creeps to report:

```
completeTask(taskId: string): void
  - Remove task from active list
  - Mark creep as idle
  - Log completion

abandonTask(taskId: string, reason: string): void
  - Remove task from active list
  - Mark creep as idle
  - Log reason
  - Possibly regenerate task if still needed
```

### 6. Memory Schema

```
Memory.colonies[roomName] = {
  phase: ColonyPhase
  phaseChangedAt: number
  tasks: Task[]
  needs: ColonyNeeds  // cached, updated each tick
}
```

## Interface Definitions

```typescript
enum ColonyPhase {
  BOOTSTRAP = 'BOOTSTRAP',
  DEVELOPING = 'DEVELOPING', 
  STABLE = 'STABLE',
  EMERGENCY = 'EMERGENCY'
}

enum TaskType {
  HARVEST = 'HARVEST',
  PICKUP = 'PICKUP',
  WITHDRAW = 'WITHDRAW',
  SUPPLY_SPAWN = 'SUPPLY_SPAWN',
  SUPPLY_TOWER = 'SUPPLY_TOWER',
  SUPPLY_STORAGE = 'SUPPLY_STORAGE',
  BUILD = 'BUILD',
  REPAIR = 'REPAIR',
  UPGRADE = 'UPGRADE',
  DEFEND = 'DEFEND'
}

interface Task {
  id: string                    // unique identifier
  type: TaskType
  priority: number              // lower = more urgent
  targetId?: Id<any>
  targetPos?: RoomPosition
  roomName: string
  assignedCreep?: string        // creep name
  createdAt: number             // Game.time
  expiresAt?: number            // auto-cleanup
}
```

## Public API

```typescript
class TaskCoordinator {
  constructor(roomName: string)
  
  // Called once per tick from main loop
  run(): void
  
  // Getters
  getPhase(): ColonyPhase
  getNeeds(): ColonyNeeds
  getTasks(): Task[]
  getCreepTask(creepName: string): Task | null
  
  // Task lifecycle
  completeTask(taskId: string): void
  abandonTask(taskId: string, reason: string): void
  
  // Debug
  visualize(): void  // Draw task assignments on room
}
```

## Constraints

1. Must run in < 1 CPU per room (target 0.5 CPU)
2. Must handle rooms with no spawn (claimed but not built)
3. Must not crash if structures are destroyed mid-tick
4. All state must be reconstructable from Game objects + Memory

## Testing Checklist

- [ ] Phase correctly detected for each scenario
- [ ] Tasks generated match phase priorities
- [ ] No duplicate tasks for same target
- [ ] Creeps assigned to tasks they can perform
- [ ] Completed tasks removed from queue
- [ ] Abandoned tasks regenerated if still needed
- [ ] Memory cleaned up for dead creeps
- [ ] Handles edge case: 0 creeps
- [ ] Handles edge case: 0 sources visible
- [ ] Handles edge case: hostile in room at tick 0
