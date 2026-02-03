# Architecture

## Overview

The bot follows a tick-based execution model where all game logic runs once per tick (~3 seconds). The architecture centers on three key systems:

1. **ColonyManager** - Central task coordinator per room
2. **Utility Spawning** - Dynamic creep priority
3. **Role-Based Creeps** - Specialized creep behaviors

## Game Loop (main.ts)

```
Each Tick:
1. Initialize memory segments (CommandExecutor)
2. Process console commands
3. Clean dead creep memory
4. Gather room intel (scout data)
5. For each owned room:
   ├─ Track energy flow
   ├─ Track economy metrics
   ├─ Check auto safe mode
   ├─ Run ColonyManager (generate tasks)
   ├─ Place containers/extensions (priority-gated)
   ├─ Place other structures (1/tick)
   ├─ Attempt creep renewal
   ├─ Spawn creeps (utility system)
   ├─ Run towers
   ├─ Run links (RCL 5+)
   ├─ Record traffic
   ├─ Plan smart roads
   ├─ Plan remote containers
   ├─ Manage remote squads
   └─ Draw visuals
6. Run bootstrap manager
7. Run expansion manager
8. Check auto-expansion
9. Process empire events
10. Run all creeps with error handling
11. Export AWS segment
12. Log status (every 100 ticks)
```

## Core Systems

### ColonyManager (src/core/ColonyManager.ts)

Single source of truth for colony coordination. One instance per owned room.

**Responsibilities:**
- Detect colony phase (BOOTSTRAP, DEVELOPING, STABLE, EMERGENCY)
- Generate task list based on needs
- Assign tasks to creeps
- Track workforce requirements

**Key Methods:**
```typescript
getPhase(): ColonyPhase           // Current colony state
getTasks(): Task[]                // All active tasks
getAvailableTask(creep): Task     // Best task for this creep
needsCreep(role): boolean         // Should spawn this role?
assignTask(creep, task): void     // Give task to creep
completeTask(taskId): void        // Mark done
abandonTask(taskId): void         // Task failed
```

**Task Types:**
- `HARVEST` - Mine sources
- `SUPPLY_SPAWN` - Fill spawn/extensions
- `SUPPLY_TOWER` - Fill towers
- `BUILD` - Construct structures
- `UPGRADE` - Upgrade controller
- `HAUL` - Generic energy transport
- `DEFEND` - Attack hostiles

Tasks are stored in `Memory.rooms[name].tasks[]` and refreshed every 10 ticks.

### ColonyStateManager (src/core/ColonyState.ts)

Caches expensive room queries with tiered refresh intervals.

```typescript
interface CachedColonyState {
  sources: Source[];
  energyAvailable: number;
  energyCapacity: number;
  structures: Structure[];
  threats: Creep[];
  constructionSites: ConstructionSite[];
  // ... more cached data
}
```

Prevents repeated `Room.find()` calls that spike CPU.

### EconomyTracker (src/core/EconomyTracker.ts)

Monitors energy flow for utility spawning decisions:
- Harvest income rate (energy/tick)
- Storage level
- Consumption rate
- Trend analysis

### ConstructionCoordinator (src/core/ConstructionCoordinator.ts)

Gates structure placement by type and room phase. Ensures high-priority structures (containers, extensions) complete before lower-priority (roads).

## Colony Phases

```
BOOTSTRAP (RCL 1-2)
├─ < 3 workers OR no harvesters
├─ Focus: Basic economy survival
└─ Priority: HARVEST > SUPPLY_SPAWN > UPGRADE

DEVELOPING (RCL 3-4)
├─ Building infrastructure
├─ Focus: Containers, extensions, storage
└─ Priority: SUPPLY_SPAWN > HARVEST > BUILD

STABLE (RCL 5+)
├─ Full operations
├─ Focus: Remote mining, optimization
└─ Priority: All systems active

EMERGENCY
├─ Under attack OR no harvesters producing
├─ Focus: Survival
└─ Priority: DEFEND > SUPPLY_TOWER > HARVEST
```

Phase detection in ColonyManager.getPhase():
1. Check emergency conditions first (hostiles, no harvesters)
2. Check RCL and creep counts
3. Default to STABLE

## Memory Schema

### Room Memory
```typescript
Memory.rooms[roomName] = {
  tasks: Task[];              // ColonyManager task list
  assignments: {              // Harvester/hauler assignments
    [sourceId]: creepName;
  };
  containerPlan: {            // Planned container locations
    [sourceId]: RoomPosition;
  };
  sources?: Id<Source>[];     // Cached source IDs
  sourceContainers?: Record<Id<Source>, Id<StructureContainer>>;
}
// Note: Intel data (hostiles, lastScan, controller, hasKeepers)
// lives in Memory.intel[roomName] — see RoomIntel interface
```

### Creep Memory
```typescript
Memory.creeps[name] = {
  role: string;               // HARVESTER, HAULER, etc
  room: string;               // Home room
  state: string;              // IDLE, COLLECTING, BUILDING, etc
  taskId: string;             // Current task from ColonyManager
  targetRoom: string;         // For remote roles
  sourceId: string;           // For mining roles
  targetContainer: Id;        // For haulers (dynamic)
  renewing: boolean;          // Self-renewing?
  _lastPos: string;           // Stuck detection
  _stuckCount: number;        // Ticks stuck
}
```

### Intel Memory
```typescript
Memory.intel[roomName] = {
  lastScanned: number;
  owner: string | null;
  sources: [{id, pos}];
  mineral: {type, amount, pos};
  roomType: "normal|sourceKeeper|center|highway";
  expansionScore?: number;
}
```

### Bootstrap Memory
```typescript
Memory.bootstrap = {
  active: BootstrapState | null;
  queue: string[];
  config: BootstrapConfig;
}
```

### Expansion Memory
```typescript
Memory.empireExpansion = {
  active: Record<string, EmpireExpansionState>;
  state: "IDLE|EXPANDING";
  autoExpand: boolean;
}
```

### Traffic Memory
```typescript
Memory.traffic[roomName] = {
  heatmap: {"x:y": visitCount};
  lastReset: number;
  windowSize: number;
  roadsSuggested: string[];
  roadsBuilt: string[];
}
```

## File Organization

```
src/
├── main.ts                 # Entry point
├── config.ts               # Constants (CONFIG object)
├── types.d.ts              # Type extensions
├── core/
│   ├── ColonyManager.ts    # Task generation
│   ├── ColonyState.ts      # Cached state
│   ├── EconomyTracker.ts   # Energy metrics
│   ├── ConstructionCoordinator.ts
│   ├── TrafficMonitor.ts   # Movement tracking
│   └── CommandExecutor.ts  # Console commands
├── spawning/
│   ├── utilitySpawning.ts  # Spawn priority
│   ├── bodyBuilder.ts      # Body scaling
│   └── bodyConfig.ts       # Role templates
├── creeps/
│   ├── roles.ts            # Role dispatcher
│   ├── Harvester.ts
│   ├── Hauler.ts
│   └── ...                 # 15 role files
├── structures/
│   ├── placeStructures.ts  # Structure placement
│   ├── TowerManager.ts
│   ├── LinkManager.ts
│   ├── ContainerPlanner.ts
│   └── ExtensionPlanner.ts
├── expansion/
│   ├── BootstrapManager.ts # Room bootstrap
│   ├── ExpansionManager.ts # Empire expansion
│   └── RoomEvaluator.ts    # Room scoring
└── utils/
    ├── Console.ts          # Debug commands
    ├── AWSExporter.ts      # AWS integration
    ├── movement.ts         # Pathfinding
    ├── Logger.ts           # Logging
    └── StatsCollector.ts   # Metrics
```

## CPU Management

Budget allocation per tick (~20 CPU limit):
- Creep logic: 0.2-0.5 CPU per creep
- Pathfinding: 0.5-2 CPU per search
- Room.find(): 0.2-0.5 CPU per call
- Memory serialization: proportional to size

Key optimizations:
1. **ColonyStateManager** caches room queries
2. **Utility spawning** runs once per spawn, not per role
3. **Task refresh** every 10 ticks, not every tick
4. **Path reuse** via moveTo's reusePath option
5. **Traffic recording** samples rather than logs every move
