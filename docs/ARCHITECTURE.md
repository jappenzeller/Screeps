# Architecture

## Overview

The bot follows a tick-based execution model where all game logic runs once per tick (~3 seconds). The architecture centers on three key systems:

1. **ColonyManager** - Central task coordinator per room
2. **Utility Spawning** - Dynamic creep priority
3. **Role-Based Creeps** - Specialized creep behaviors

## Game Loop (main.ts)

```
Each Tick:
1. Initialize memory segments (CommandExecutor + DirectiveReader)
2. Process console commands
3. Process AWS directives (if enabled)
4. Clean dead creep memory
5. Gather room intel (scout data)
6. For each owned room:
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
7. Run expansion manager (skipped if bucket low)
8. Check auto-expansion
9. Process empire events
10. Run combat duo manager
11. Run military manager
12. Run all creeps with error handling
13. Export AWS segment (every 20 ticks)
14. Persist route cache (every 100 ticks)
15. Export decision logs
16. Log status (every 100 ticks)
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

### MilitaryManager (src/military/MilitaryManager.ts)

Coordinates offensive campaigns (controller attacks, room assaults). Uses TacticalSimulator for pre-attack validation to predict outcomes before committing resources.

**Key Features:**

- Campaign state machine (PLANNING → SCOUTING → ATTACKING → CLAIMING)
- Pre-campaign simulation with automatic approach selection
- Wave coordination for multi-creep attacks
- Adaptation triggers (safe mode, defenders, tower drain)

See [MILITARY_MANAGER_DESIGN.md](MILITARY_MANAGER_DESIGN.md) for full details.

### DirectiveReader (src/core/DirectiveReader.ts)

Reads and executes AWS-generated directives from memory segment 95. Enables offloading heavy analysis (spawn scoring, remote selection) to AWS while the bot focuses on real-time execution.

**Directive Types:**

- `SPAWN` - Queue a creep for spawning
- `REMOTE_ADD` - Add a remote mining room
- `REMOTE_REMOVE` - Remove a remote mining room
- `CONSTRUCT` - Place a construction site
- `CONFIG` - Change colony configuration
- `MILITARY` - Launch attack/defend actions
- `EXPAND` - Start expansion to a room

**Lifecycle:**

```
AWS Lambda → Writes to Segment 95 → DirectiveReader.run()
                                         ↓
                                   Execute Directives
                                         ↓
                                   Ack to Segment 90 → AWS Lambda reads
```

**Staleness Protection:**
Directives older than 500 ticks automatically trigger fallback to local logic. Toggle via `Memory.settings.useDirectives`.

### AnomalyDetector (`src/utils/AnomalyDetector.ts`)

Runtime invariant checks on creep behaviour. Static review predicts what code will do;
this measures what it actually does, and exists because a run of production defects broke
one-line runtime invariants that code review did not catch.

Runs after each creep's role, on creeps with CARRY parts. Two generic detectors:

| Detector | Condition | Catches |
|---|---|---|
| `STUCK` | carried energy AND state both unchanged 100+ ticks | waiting on a source that never arrives |
| `FLAP` | state cycling faster than the work could complete | two steps undoing each other |

Excluded to avoid false positives: creeps that have moved more than `TRAVEL_RADIUS` tiles
since their energy last changed (travelling, not stalling), and creeps with WORK parts
standing on a source (static miners deposit into the container beneath them, so their own
store never changes by design).

```
runCreep() → AnomalyDetector.inspect() → Memory.stats.anomalies (capped at 12)
                                              ↓
                            per-colony in Segment 90 → /colonies/{room} → advisor
```

**Deep diagnosis.** When a STUCK is confirmed, one pathfinding pass runs to explain *why*
— rate-limited to one per tick empire-wide, so the cost is paid a handful of times per
thousand ticks rather than continuously. It distinguishes causes that are otherwise
expensive to tell apart:

| Diagnosis | Meaning |
|---|---|
| `no map route to X` | the room graph itself has no path |
| `map route exists but no exit toward X is reachable` | walls or terrain seal that border — `Game.map.findRoute` cannot see this |
| `isolated - cannot reach any exit or spawn` | the creep is walled into a pocket |
| `energy present in room but none of it is reachable` | supply exists, path does not |
| `sink reachable at x,y - not delivering to it` | topology is fine; the fault is in role logic |

The last distinction matters most: it separates "the world is shaped wrong" from "our code
is wrong", which is the first question worth answering about any stall.

Read locally with `anomalies()`. The advisor is prompted to treat findings as
high-confidence evidence and to correlate them against metrics, so a defect can surface
without a human suspecting it first. Findings are pruned when their creep dies.

**Known limit:** only catches code paths that actually execute. Static review still
covers the rest.

### Declarative Framework (`src/framework/`)

A second decision system running every tick. **Scoped to remotes only**, deliberately.

The framework duplicates four domains that already have working owners, and its executors
are real — every action type routes to something that acts. Measuring what it actually
achieved over ~140 ticks settled how to resolve that:

| Domain | Result |
|---|---|
| `spawn` | 0 ok / **191 fail** — "Not enough energy" |
| `build` | 0 ok / **101 fail** — "No valid position for lab" |
| `defend` | 7 ok / 0 fail — but every success is a no-op that logs and returns true |
| `remotes` | acts for real; the only arm doing useful work |

Three of four arms produced ~292 failed operations per 140 ticks, forever. The spawn arm
was not idle by design: it runs **before** `spawnCreeps` and failed only because its
`getMinCost` gate is stricter than `utilitySpawning`'s body sizing. Had energy ever
cleared that bar it would have spawned a creep of its own choosing ahead of the real
spawner. The military `attack` path likewise creates a real `MilitaryManager` campaign.

### Framework migration

The framework is not a dead end to be deleted. Git history shows it is the **deliberate
successor** to the managers — the managers landed Jan 16/23, the framework Feb 14 with the
commit message *"Score everything, gate nothing"*, which is the same conclusion the
boundary-condition work reached independently. The split architecture is an unfinished
migration, not an accident, and the resolution is to finish it rather than to pick a side.

Migration proceeds one domain at a time, and each domain passes through three states:

| State | Registered with | Executes? |
|---|---|---|
| Dormant | not registered | no |
| **Shadow** | `registerShadow()` | no — scored and compared only |
| Live | `register()` | yes |

**Spawning is currently in SHADOW.** `SpawnEvaluator` is scored every tick against live
state; its actions are split out in `runFramework()` and recorded by
`src/framework/ShadowSpawn.ts` instead of being executed. When `utilitySpawning` actually
spawns, the two choices are compared. Read the result with `fxShadow()`:

```
=== Framework spawn shadow (2400 ticks) ===
  agree 11 / disagree 2 / shadow-silent 1
  agreement: 79% over 14 spawns
```

Promotion to `register()` is justified by agreement on live data, not by code review — the
spawn arm read correctly and still failed 191 times out of 191.

**First result: agreement is ~4%** (3 agree / 68 disagree over ~1,000 ticks). Cutover is
not justified. The disagreements are informative rather than random, though:

- The evaluator repeatedly wants `LINK_FILLER` in E43N39, which has two links and no link
  filler. The incumbent never spawns one. The evaluator is right here.
- It wants `UPGRADER` (target 3) in E46N37 and E47N41, which both hold zero stored energy.
  Acting on that would starve them further. The incumbent is right here.
- The incumbent spends heavily on `SCOUT` and `REMOTE_MINER`; the evaluator scores neither
  highly. Given E46N37 is boxed in on all three exits and has no viable remote, that
  spending is questionable — but the evaluator's alternative is not obviously better.

So neither system dominates, and the migration cannot proceed on agreement alone. The
useful next step is to reconcile them factor by factor rather than to pick a winner.

Shadow mode also earned its keep immediately by exposing the score clamp (below), which
was invisible in the winner alone.

**Fixed as part of this:** `executeSpawn()` sized bodies to `energyCapacityAvailable`,
which is why it never once spawned — E43N39 does not reach capacity. Both spawn paths now
call the shared `resolveSpawnEnergyBudget()` in `bodyBuilder.ts`, so they cannot disagree
about body size. Spawns declined because the room genuinely cannot afford the body are now
counted as `wait`, not `fail`, so the failure count stays a real defect signal.

`ConstructionEvaluator` and `MilitaryEvaluator` remain dormant on disk, next in the queue.

**One owner per domain:**

| Domain | Owner |
|---|---|
| Spawning | `utilitySpawning` |
| Construction | the planners + `ConstructionCoordinator` |
| Military | `MilitaryManager` |
| Remotes | `ColonyManager` (config, cap, expiry) **+** `RemoteMiningEvaluator` (threat pausing) |

Remotes are the one shared domain, and the split is now explicit: `syncRemoteRooms()`
every 1000 ticks owns validity, distance, cap, overlap and pause expiry; the evaluator
every tick owns pause-on-threat and activation proposals.

**The boundary is now enforced, not just documented.** `executeRemote()`'s activate path
used to call `addRemote()`, so the evaluator was performing discovery — a domain
`syncRemoteRooms()` owns. It re-proposed E45N41 every tick, `addRemote` rejected it on
distance every tick, and neither side remembered: 622 failed operations against 21
successes. Activation now only reactivates a remote already in the config, and declining
an out-of-lane proposal is recorded as `wait`, not `fail`. The executor's failure count is
**zero**.

**Threat sensitivity:** pausing keys on hostiles carrying combat parts, not on any hostile
presence. Treating a passing enemy scout as a threat paused every remote in the empire for
5,000 ticks at a time, permanently, in a neighbourhood with 33 hostile rooms.

## The Decision Primitive (`src/core/Decision.ts`)

Every decision this bot makes has one shape: enumerate the options, score each as a base
weight times some factors, take the highest. That shape was implemented **five separate
times** — `utilitySpawning.calculateUtility`, the framework's `SpawnEvaluator`, and the
`Hauler`, `Upgrader` and `Builder` roles. `Upgrader.ts` and `Builder.ts` had drifted to
byte-identical scoring lines by copy-paste.

The split worth caring about was never managers-vs-framework. Both systems compute
`base × ∏ factors → pick max`; they differ in coefficients, not in design. It is one
design written five times, and **each copy independently reintroduced the same defect**,
because the defect lives in the arithmetic rather than in any caller.

`core/Decision` is that arithmetic, extracted once, with the failure modes made
structurally impossible:

| Rule | Failure it prevents | Observed as |
|---|---|---|
| Factors floored, never zero | A zero factor annihilates the product, deleting an option every other factor rated highly | Haulers scored spawn delivery `hasFiller ? 0 : 90` and abandoned a room holding 586,590 energy with 11 in the spawn |
| Order-preserving `softCeiling` | A hard `Math.min(100, …)` maps strong options onto one value; arbitration falls through to array order | E43N39 scored LINK_FILLER 116 and UPGRADER 107; both became 100 and array order picked the weaker |
| Exclusion ≠ score of zero | "Never choose this" and "this input read zero" become indistinguishable | `SpawnEvaluator` set `score = 0` for `target === 0`, inside the same product carrying every real signal |
| `emptyReason()` | "Nothing scored well" and "there were no options" conflate into one `null`, and callers idle on both | The general shape behind the frozen remote creeps |

The underlying rule is the one this codebase already learned the hard way: **a predicate
that gates progress must have a release condition.** Scoring is how that rule gets
enforced by construction instead of by review.

### Using it

```ts
const chooser = new Chooser<Target>();
chooser.consider(target, label, base, supplyFactor(have, need), proximityFactor(range));
const winner = chooser.best();          // null only per emptyReason()
```

`consider()` ignores a non-positive base — that is how an option is excluded. Never pass
a zero factor to mean "not allowed"; simply do not offer the option.

The geometric mean in `utils/smoothing` follows the same rule with its own epsilon:
`FACTOR_FLOOR` (0.01) would be pulled back to ~0.32 by a fourth root, so `UTILITY_EPSILON`
(1e-9) is used there to survive the root as a decisive suppression.

### Where it is used

`Hauler`, `Upgrader`, `Builder` (via `Chooser`); `BaseEvaluator` and every framework
evaluator (via `softCeiling` and the factor floor); `RoomEvaluator`'s expansion scoring;
`utilitySpawning` (via the floored geometric mean). Adding a new scored decision means
calling this, not writing a sixth copy.


### One coefficient table

Base priorities had **three** homes: `WeightTable.spawning.basePriority`,
`CONFIG.SPAWNING.BASE_UTILITY`, and a hardcoded literal inside each utility function. The
literals shadowed `CONFIG`, so tuning `CONFIG` did nothing for six roles — and `CONFIG`
had drifted out of agreement with live behaviour on four more:

| Role | CONFIG said | Live actually used |
|---|---|---|
| `REMOTE_HAULER` | 35 | 40 |
| `REMOTE_DEFENDER` | 45 | 65 |
| `RESERVER` | 25 | 45 |
| `SCOUT` | 25 | 10 |

Three tables meant the AI advisor could tune the one that was not being read.

`WeightTable.spawning.basePriority` is now the only table, reached through
`basePriority(role)`. Its defaults were seeded from **what utilitySpawning actually used**,
not from either stale table, so the collapse changed no live behaviour. `CONFIG.SPAWNING.BASE_UTILITY`
is deleted, as is `OPTIMAL_COUNTS`, which had no readers at all — dead configuration is
worse than none, because it reads as the knob to turn.

`basePriority()` falls back rather than returning 0 for an unknown role: zero annihilates
in both scoring pipelines, so a role missing from the table would become unspawnable
rather than merely untuned.

Both spawn implementations now read one table, so a tuning change reaches both.


### One target table (`src/core/ColonyTargets.ts`)

"How many of this role does the colony want" had two answers: `utilitySpawning`'s
`getCreepTargets()` and the framework's own `SpawnEvaluator.computeTarget()` switch. They
disagreed often enough to be measurable — over 20,265 ticks of shadow comparison the
evaluator proposed **nothing** on 870 of the ticks where a spawn actually happened (62%),
because its target came back 0 where the live system wanted a creep.

That made the shadow comparison measure schema drift rather than judgement, which had to
go before there could be one spawn implementation.

A target is a fact about the colony, not a policy of whichever module asks.
`getCreepTargets()` — the version that has been running the colony — moved verbatim into
`core/ColonyTargets`, is computed once in `captureWorldState()`, rides on
`ColonySnapshot.targets`, and is read by both spawners. The evaluator's parallel switch
and its six helper functions (197 lines) are deleted.

### One definition of a working creep (`src/core/ColonyPopulation.ts`)

The captures disagreed on semantics, not just shape. `utilitySpawning` counted *effective*
creeps — a hauler with zero CARRY transports nothing, so it does not count — while the
framework's snapshot counted raw roles. That is a disagreement about the most basic input
to a spawn decision: how many of this role do we have. Counting a broken creep as present
means the colony never replaces it, and the role silently goes unfilled while every count
says it is staffed.

`getEffectiveCounts()` now lives in `core/ColonyPopulation` and both captures use it.

**Result: shadow agreement moved from 6% to 50%.** Most of what looked like judgement
disagreement was the two systems reading different worlds.

Three follow-on defects surfaced from having one table to look at:

- **`maxCount` was a second target table.** `SCOUT.maxCount` was 1 while the live system
  ran 2, so the evaluator excluded SCOUT outright. `targets` already bounds a role and the
  saturation factor already scores down past it, so the `maxCount` exclusion is gone.
  `minCount` stays — it is a floor expressed as a boost, not a competing target.
- **`ROAD_BUILDER` and `REMOTE_BUILDER` were in the evaluator's role lists but had no
  `roles` config**, so `evaluateHomeRole()` returned null for them every tick. Roles the
  live colony runs were silently unscoreable — a role in one list and not the other is
  invisible rather than erroneous, which is why it went unnoticed.
- **Roles escaping the map.** `DEFENDER` was hardcoded to 0 with a "dynamic based on
  threats" comment, and `SCOUT` was a 1/0 flag while the live cap was 2. A role whose
  target is permanently wrong has escaped the map, and every reader then special-cases it
  — which is how two spawners drift apart again. Both now state their real number.


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
│   ├── DirectiveReader.ts  # AWS directive execution
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
├── military/
│   ├── MilitaryManager.ts  # Campaign coordinator
│   └── TacticalSimulator.ts # Pre-attack simulation
└── utils/
    ├── Console.ts          # Debug commands
    ├── AWSExporter.ts      # AWS integration
    ├── cpuCache.ts         # CPU bucket guards
    ├── movement.ts         # Pathfinding + route cache
    ├── Logger.ts           # Logging
    ├── StatsCollector.ts   # Metrics
    └── AnomalyDetector.ts  # Runtime invariant checks (stuck/flap)
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

### CPU Caching Utilities (src/utils/cpuCache.ts)

Guards for skipping expensive operations when CPU bucket is low:

```typescript
shouldSkipNonEssential(): boolean    // Skip at bucket < 2000
shouldSkipExpensiveEvaluations(): boolean  // Skip at bucket < 1000
```

Used in main loop to protect:

- Framework evaluators (spawning, construction, military)
- Expansion manager
- Decision logging
- Military visuals

### Route Cache Persistence (src/utils/movement.ts)

Persists `Game.map.findRoute()` results across global resets:

```typescript
restoreRouteCacheFromMemory()  // Called on init
saveRouteCacheToMemory()       // Called every 100 ticks
```

Prevents CPU spikes after code pushes when routes need recalculation.
