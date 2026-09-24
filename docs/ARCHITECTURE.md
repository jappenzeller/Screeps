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


## Invariants (`src/core/Invariants.ts`)

Assertions checked **at the moment a decision is committed**.

The registry now answers three questions, and they are genuinely distinct:

| Question | Owner |
|---|---|
| Did this system run, and did running accomplish anything? | `Liveness` |
| Is a creep frozen or oscillating? | `AnomalyDetector` |
| Was the decision *right about the quantity*? | `Invariants` |

The third was the gap. Every expensive defect found on 2026-09-16 was a system that ran,
acted, reported success, and was wrong about a number:

- range standing in for reachability - a builder pathing to a site it could not reach
- RCL standing in for income - `maxBuildersByEconomy = Math.min(rcl, 4)`
- capacity standing in for income - a 36-WORK upgrader in a room earning 20/tick
- seconds standing in for milliseconds - 891 advisor rows judged expired
- instantaneous flow standing in for a buffer - the clamp releasing as it succeeded

In all five, liveness reported healthy, and correctly: nothing had stopped. A periodic
sweep sees the *consequence* (netFlow -56, three banks drained) hours or weeks later. A
commit-point check sees the *cause* while the inputs that justified it are still in hand.

**First invariant: `UNSUSTAINABLE_SPAWN`.** At the `spawnCreep` call, a discretionary body's
ongoing burn (`workParts x burnPerWork`) is compared against room income. `BURN_PER_WORK` is
imported from `bodyBuilder` rather than duplicated - one coefficient table.

Three properties worth keeping:

- **It is a backstop, not a discovery mechanism.** The body clamp already prevents the
  ordinary case, so this stays silent most of the time. Its value is catching the clamp
  being *bypassed* - a rescue path, or a regression. It would have caught the escapee leak
  immediately; finding that by hand took an hour of reading `_born` fields.
- **Its threshold is deliberately looser than the clamp's** (0.5 versus 0.35). Reporting at
  the same threshold the clamp enforces would fire on every borderline body and teach the
  reader to skip the findings - the cry-wolf failure this registry exists to prevent.
- **Income roles are never reported.** A harvester's WORK earns and a hauler's CARRY moves;
  flagging them would be noise, and starving them is the deadlock the body budget exists to
  fix.

**No fifth surface.** Findings ride the existing segment-90 export, attached per-colony
alongside `anomalies` and `liveness`, so they arrive at `/colonies/{room}` with everything
else. Four surfaces already existed and the real cost was that nobody read them - adding a
fifth place to look would have made the routing problem worse, not better.

**Not yet covered:** the other four shapes above. A gate binding at a pathological rate and
a target that stays unmet are both checkable this way. The units mismatch is not a runtime
invariant at all - that one wants a type, not a check.

## Liveness (`src/core/Liveness.ts`)

Reports systems that are not running, or that run without ever doing anything.

Every expensive defect this codebase has produced was **silent** - none threw, appeared in
a log, or stopped the colony:

| Defect | How long it was invisible |
|---|---|
| `MemoryManager.cleanup()` never called by anything | unknown; it held the stale-colony purge *and* the scout mortality tracking, so both silently never ran |
| Framework spawn arm failing 191 times out of 191 | until someone counted |
| Remote evaluator proposing an unactivatable room | 75,429 times, then 12,275 more after the first fix |
| Advisor billing $351/month | no token usage was recorded anywhere |

Each was found by a person going to look, days or weeks late. **The discovery rate for
every other class of bug is set by this one.**

Two questions, and an uncalled function cannot answer the first about itself:

1. *Did this run at all?* - requires a **declared** expectation
2. *Did running accomplish anything?* - `ran()` vs `acted()`

Declarations live in `main.ts`'s `declareSystems()`, at the wiring point. A declaration
inside the system would be exactly as silent as the system. Adding a name there without a
matching `ran()` call makes it report `NEVER_RAN` - the intended failure mode.

Findings are `NEVER_RAN`, `STOPPED` (silent for 3x its declared cadence), and
`ALWAYS_NOOP` (ran, never acted). They ride to the AWS advisor in segment 90 alongside
anomalies, and `liveness()` prints them in the console.

`ALWAYS_NOOP` is a fact, not a verdict - a defender evaluator in a quiet week correctly
does nothing. The report states what happened and leaves judgement to the reader, because
the alternative is a threshold that silences real findings.

**A third state: `idle()`.** A planner at its RCL cap, a remote sync with a settled set and
a tower in a quiet room all ran and correctly did nothing. Counting those as no-ops
produced `ALWAYS_NOOP` for systems working exactly as intended, so `idle()` marks a run
that had no work and only `ran - idle > 0` runs count toward the verdict. The distinction
matters in the other direction too: `placeStructures` stays **silent, not idle**, when
structures are missing and no position can be found - that is the ExtensionPlanner defect
exactly, and calling it idle would bury it.

**Declared and instrumented:** `cleanupMemory`, `framework`, `ColonyManager.run`,
`placeStructures`, `spawnCreeps`, `StatsCollector.snapshot`, `syncRemoteRooms`,
`TerminalManager`, `ExtensionPlanner`, `ContainerPlanner`, `TowerManager`, `LinkManager`,
`RampartPlanner`, `RenewalManager`, `checkAutoSafeMode`, `EconomyTracker.track`,
`trackEnergyFlow`, `SmartRoadPlanner`, `RemoteContainerPlanner`.

### What the first real report said

The registry's first output after the boot grace carried three `ALWAYS_NOOP` findings. One
was true and two were mine, which is worth recording exactly:

| Finding | Verdict |
|---|---|
| `placeStructures`: work on 1087 of 3261 runs | **Real.** 1087 is one room's share of 3261 - E47N41 wants six labs and can never position one. Labs need a 4x3 cluster and that room is mostly wall. |
| `TerminalManager`: 1087 of 1087 | False. It had no `idle()` at all, so the correct steady state - no bank above the 20,000 sender floor - reported as a defect. |
| `ContainerPlanner`: 2174 of 3261 | False. The `idle()` condition only fired on a completely empty plan, so a `controller` entry correctly declined because a link serves the upgraders counted as work never done. |

Two lessons, both already paid for. An `idle()` condition must cover *every* correct
no-work path, not the obvious one - a partial condition is worse than none, because it
converts healthy behaviour into a standing accusation. And "already done" must not be
reported through the same channel as "did it": `placeContainerSite` returned `OK` for a
container that already existed, indistinguishable from placing one, which is what made the
second false positive possible.

The real finding is left reported rather than silenced. Whether E47N41 should host labs at
all is a layout decision, and suppressing a true report to make a list look clean is how
the list stops being read.

**Verified once the next boot grace elapsed.** The stated prediction was that the two false
positives would disappear and the true one would persist. `Memory._liveness` then held a
single finding: `placeStructures`, "had work on 203 of 609 runs, never acted". The ratio
corroborates it independently - 203 of 609 is one room in three, the same proportion as the
earlier 1087 of 3261, on counters the deploy had reset. `TerminalManager` and
`ContainerPlanner` were both gone. Both fixes hold.

Worth keeping as method: the fix was committed with a falsifiable prediction attached, so
"did it work" had an answer that did not depend on re-reading the code that produced the
bug. Writing the prediction down first is what made the check take one query.

`checkAutoSafeMode` is the clearest case in the whole registry. Safe mode is the last
defense before a room is lost, every quiet tick reports idle, and so `ALWAYS_NOOP` there
can only mean it decided to activate and the activation failed.

Two declarations come with deliberate limits on what they claim:

- `EconomyTracker.track` guards the **snapshot history** that feeds the advisor export, not
  the affordability decisions. Those go through `getColonyEconomy()`, a cached pure
  function callers invoke inline, which cannot silently stop the way a scheduled system can.
- `trackEnergyFlow` is declared **without** `tracksActs`. It updates its EMA
  unconditionally on every call, so `acted()` would fire on every run and the no-op verdict
  would carry no information. Only "is it still being called" is a real question for it.
  A declaration that cannot produce a meaningful verdict should not pretend to.

`LinkManager` earned its place: E43N39 once sat at 1,430/1,800 spawn energy - 79.4% against
a 0.8 threshold - so harvesters never fed a link and the whole network stayed dark with a
storage link built for it, silently. Its `acted()` checks the `transferEnergy` return code
rather than assuming success, or a permanently failing transfer would report as healthy.

`RenewalManager` is declared mostly to catch it not being called at all: a `true` return
makes `main.ts` skip `spawnCreeps()` for the tick, so a fault there stops the colony
reproducing. Not renewing is the normal outcome, so nearly every run reports idle - which
is precisely why the run count, not the act count, is the signal worth having.

`placeStructures` is declared at cadence 10, not 1. It returns at an every-10-ticks gate,
so calling `ran()` from `main.ts` counted nine skipped runs in every ten - measuring the
main loop rather than the system.

**Roughly ten systems remain undeclared**, listed in `declareSystems()` with the reason.
That is now every planner and every defense system covered; what is left is exporters,
monitoring and military - the low end of cost-of-silence. `expect()` without a matching
`ran()` reports `NEVER_RAN`, so declaring them as a batch would manufacture ten false
findings - the cry-wolf failure this registry exists to prevent, and one this codebase has
now caused twice: once by declaring `tracksActs` for systems that never called `acted()`,
and again with `idle()` conditions too narrow to cover every correct no-work path.


## Terminal Transfers (`src/structures/TerminalManager.ts`)

Moves surplus energy between colonies. The three rooms are not equally able to feed
themselves - E43N39 has remotes and banks tens of thousands; E46N37 is boxed in on all
three exits and can never hold more than its own two sources produce - so terminals are
the only way surplus reaches the rooms that cannot generate it.

Runs empire-wide every 10 ticks (the terminal cooldown), because a transfer is a decision
about a **pair** of rooms and a per-room loop would have each pick a partner without
seeing what the others are doing.

**Thresholds are deliberately not the ones in BUILD_PLANNER_IMPLEMENTATION.md.** That
spec says deficit below 50K and surplus above 200K, which suits a mature empire; the
richest room here has peaked at 46K, so those would never once have fired. A threshold
that is never met is a feature that does not exist.

| Constant | Value | Meaning |
|---|---|---|
| `SENDER_MIN_STORAGE` | 20,000 | Keep this much before giving anything away |
| `RECIPIENT_MAX_STORAGE` | 10,000 | Above this a room waits for its own income |
| `RECEIVE_HOLDOFF` | 3,000 ticks | A room that was just sent energy cannot pass it on |
| `TERMINAL_MAX` | 25,000 | Stop filling; terminal space is finite |
| `MIN_SEND` / `MAX_SEND` | 2,000 / 10,000 | Dribbles waste overhead; one send cannot drain the terminal |

Three architectural choices, each one something this codebase already paid to learn:

- **Solvency comes from `EconomyTracker`**, the single owner of "can this room afford it".
  A room can hold a large bank while bleeding, and giving energy away then would be wrong -
  `surplusOf()` returns 0 at negative net flow regardless of storage.
- **The recipient is scored, not branched.** Two rooms at zero storage differ in how badly
  they need energy; `needOf()` weighs an empty spawn network above an empty bank, because
  the former is what stops a room replacing its creeps. A branch chain would silently pick
  the same room every time.
- **One answer for which way energy moves.** `terminalFlow()` returns exactly one of
  `fill`, `drain` or `hold`, and both hauler collection and delivery read it. There used to
  be two predicates, one per side, and they overlapped in two bands where a hauler filled
  and drained the same terminal. A single return value makes that unrepresentable, and
  delivery does not offer a draining terminal at all.
- **Surplus is the whole bank.** `surplusOf()` counts storage plus terminal, so moving
  energy between them cannot flip a room's sender role. A room sent energy within
  `RECEIVE_HOLDOFF` cannot pass it straight on.

Transfers are recorded to `Memory._terminal` (last 10) and readable with `terminal()`.
A feature that moves energy between rooms and leaves no trace would be the next silent
system.

**Tests:** `npm run test:unit` - terminal surplus, need, cost, planning and flow (including
both old overlap bands and the receive holdoff), plus hauler collection scoring.


## Hauler Collection (`src/creeps/haulerCollection.ts`)

Where a hauler picks energy up from, scored with `core/Decision` like delivery.

It was a seven-tier priority chain. Within one feature, two of its tiers turned out to be
branches that could always match, and each silently starved the terminal drain placed
below it. Delivery had been converted earlier and produced no defect of that shape since.
A scored choice has no tier below that never runs.

| Source | Base | Why |
|---|---|---|
| Tombstone | 75 | Expires outright |
| Terminal, flow `drain` only | 70 | Delivered energy, unspendable until moved |
| Dropped energy | 65 | Decays |
| Source container | 60 | The ordinary job; discounted by competing haulers |
| Storage | 20 | Only while the spawn network is short |

Supply and distance scale each base, so a nearly empty high-base source loses to a full
lower one. The container `runHauler()` assigned gets a 1.25 continuity bonus, and a chosen
target is leased for 25 ticks - scoring alone flips between near-equal containers, which
delivery learned first.

Storage is gated on a short spawn network because it is always a valid delivery target:
offered unconditionally, a hauler with full extensions would withdraw from storage and
deliver straight back into it.

The decision lives in its own module so it can be unit tested with mock rooms.
`Hauler.collect()` only honours the lease, executes, and positions the creep when nothing
holds energy.

## Builder Budget (`src/core/builderBudget.ts`)

How many builders a colony can actually pay for.

The mature-colony branch of `getCreepTargets` computed
`maxBuildersByEconomy = Math.min(rcl, 4)`. The name claims a measurement and the value is a
proxy: RCL is not income, so an RCL 7 room got four builders whether it earned 20 energy per
tick or 200. The early-colony branch immediately above it *did* do income arithmetic - only
the mature path, the one running in every developed room, ignored it.

Measured live, all three colonies were CRITICAL at the same moment with an identical shape:

| Room | Income | Burn | netFlow | Runway |
|---|---|---|---|---|
| E43N39 | 30 | 57.2 (upgrade 30, build 25) | -27.2 | 70 |
| E47N41 | 20 | 78.3 (upgrade 36, build 40) | -58.3 | 11 |
| E46N37 | 20 | 78.3 (upgrade 36, build 40) | -58.3 | 4 |

Upgraders already answered to `canAffordDiscretionary` and were converging down to one.
Builders answered to nothing, and were the larger half of a burn no room could pay.

Two details that decide the design:

- It keys on **measured** `buildBurn`, never a per-builder estimate. Burn scales with body
  size - EconomyTracker charges `workParts * 5 * 0.5` - so a single 16-WORK builder burns
  40/tick alone, and a head-count cap would have missed it completely.
- The floor is **zero**, unlike the upgrader cap's one. That floor exists to keep a
  controller off downgrade; construction has no deadline, and sites simply wait.

Shedding one builder per death converges instead of lurching, and reverses on its own when
income recovers - the same mechanism, and the same reasoning, as the upgrader cap.

## Upgrader Budget (`src/core/upgraderBudget.ts`)

How many upgraders a colony wants, and how many it can pay for: a base target from RCL, a
surplus bonus once storage passes the high-water mark, and a poverty cap that mirrors the
builder one.

The poverty cap was the **last** spawn decision still keyed on `canAffordDiscretionary`. The
builder headcount and the body clamp on both spawn paths were moved to `hasSpendableBuffer`
after the same defect was measured twice; this path was missed, and the rule it broke is
stated in EconomyTracker's own doc comment - *a body or a headcount is a commitment for the
creep's whole 1,500-tick life, so it has to answer to stock, not to a one-tick reading of
flow.*

Because `netFlow` is computed from the creeps currently alive, it reads healthiest at the
moment the room has just shed the burn that was sinking it. So the cap released one death
before it had finished converging, the target reverted to its RCL value, and the room
respawned what it had just shed. Measured live at E46N37, held rather than converging:

| Income | Upgrade burn | Upgraders | netFlow | Stored | Runway |
|---|---|---|---|---|---|
| 20/tick | 18/tick | 3 | -3.3 | 112 | 33 |

The floor is **one**, unlike the builder cap's zero: sites wait, but a controller
downgrades. The arithmetic holds that floor without a separate `upgraders > 1` guard - an
earlier version had one and it made the cap oscillate rather than converge, because shedding
to a single upgrader switched the guard off and the target reverted to 3.

## Spawn Body Budget (`src/spawning/bodyBuilder.ts`)

How large a body a room should build, as distinct from how large a body it can pay for
*right now*.

Every branch of `resolveSpawnEnergyBudget` returned `energyAvailable` or `energyCapacity` -
**stock, never flow**. Measured live, E46N37 reached 5,600/5,600, the "nearly full" branch
handed over the whole 5,600, and `buildBody` produced a 50-part, 4,300-energy, **36-WORK
upgrader** burning 36/tick into a room earning 20/tick. Filling the extensions is what
*caused* the next deficit; the peak was not a recovery, it was the trigger.

The conversion from flow to body size is arithmetic, and both halves are checkable against
observed creeps:

| Role | Burn per WORK | Energy per WORK | Observed |
|---|---|---|---|
| UPGRADER | 1/tick | 150 (`[W,W,W,CARRY]` + road MOVE) | 36 WORK = 4,300 |
| BUILDER | 2.5/tick (5 at ~50% uptime) | 200 (`[W,CARRY,MOVE]`) | 16 WORK = 3,200 |

`sustainableBodyEnergy` turns income into a ceiling: `income x share / burnPerWork`, times
cost per WORK. At 20/tick and a 0.35 share that is a 6-WORK upgrader burning 6/tick and a
2-WORK builder burning 5/tick.

Three exemptions, each paid for by an earlier defect:

- **Only discretionary roles.** HARVESTER, HAULER and FILLER sized to stock is *correct* -
  they earn and move energy rather than consuming it. Starving them is the deadlock this
  function was written to fix, which cost 191 failed spawns out of 191.
- **Never the rescue paths.** `emergency`, `hauler bootstrap` and `downgrade rescue` pass
  through unclamped; each exists to break a specific deadlock, and a cap would restore it.
- **Only when insolvent** - and *insolvent* means an empty bank, not negative flow. This is
  the distinction that makes the clamp hold, and getting it wrong leaked twice.

**Stock, not a one-tick reading of flow.** The first version released the clamp on
`canAffordDiscretionary`, which accepts `netFlow >= 0`. But `netFlow` is computed from the
creeps *currently alive*, so it reads healthiest at exactly the moment the room has stopped
over-spending. Measured live: E46N37 spawned a clamped 2-WORK builder and a 6-WORK upgrader,
burn fell to ~13 against 20 income, flow went positive, the clamp released, and a **36-WORK
upgrader** spawned 99 ticks later - straight back to -56. E47N41 did the same with a 16-WORK
builder. Both were born well after the clamp shipped.

A body or a headcount is a commitment for the creep's whole 1,500-tick life, so it must
answer to a stored buffer (`hasSpendableBuffer`), never to instantaneous flow.
`canAffordDiscretionary` keeps the flow test, which is correct for a *recurring* decision
like renewal: if the room is not losing ground, renewing one creep is affordable.

The effect once corrected, within one creep turnover:

| Room | before | after |
|---|---|---|
| E43N39 | -25.2/tick, runway 4, stored 120 | **-15.7, runway 208, stored 3,272** |
| E47N41 | -56.3, upgraders at 36 WORK | **-32.3, upgrade burn 36 -> 12** |
| E46N37 | -56.3, builders at 16 WORK | **-27.3, build burn 40 -> 5** |

The function stays pure, so both spawn paths can share it and it can be unit tested. Its
own history is the reason that matters: when `utilitySpawning` and the framework's
`Arbitrator` disagreed about body sizing, one of them silently never spawned anything.

## Worker Energy (`src/creeps/workerEnergy.ts`)

One owner for "where does a creep take energy from", shared by Builder, RemoteBuilder,
RoadBuilder and RemoteHauler.

RemoteHauler joined last, and it is why the module is no longer only about *workers*. Its
collection was three tiers - dropped, containers, tombstones - each returning
unconditionally, so a single 50-energy pile anywhere in a remote room starved the container
branch beneath it. In a remote room that container holds the miner's entire output, so the
cost was the whole point of the remote. It calls with `allowHarvest: false`: a hauler has no
WORK parts, and mining in someone else's room is not its job.

Three roles carried three copies of the same chain, and two of them opened with "storage,
if it holds more than 1,000". A developed room's storage nearly always does, so the
container and dropped-energy branches below were unreachable in practice - dropped energy
decayed on the ground while a worker walked across the room to storage. RemoteBuilder
carried a *fourth* copy as a partial-load release check, whose own comment warned that
divergence would make the creep "either strand or thrash"; that check now calls the
collector itself, so the two cannot drift apart.

Score = `base(source) x supply(how much is there) x proximity`: storage 80, tombstone 78,
dropped 75, ruin 72, container 70, direct harvest 25. Tombstones and ruins were Pioneer's
alone, as tiers 2 and 3 of its own chain; folding them in here is what let that chain be
replaced without losing capability, and it gives the three builder roles a recovery path
they never had - a dead hauler's full load used to decay untouched unless a pioneer
happened to be in the room. The 1,000 floor on storage is deliberately gone - a hard
floor means "no source at all" the moment storage dips below it, which is the shape that
left E46N37's haulers parked while extensions sat empty. Under scoring a nearly-empty
storage simply loses on supply. Harvest stays in the set at a low weight, so a worker that
can mine is never stranded.

## Construction Targets (`src/creeps/buildTargets.ts`)

Which site a builder works on. Selection sorted candidates by `getRangeTo` and returned the
nearest - straight-line distance standing in for "can I get there". In E47N41 the two came
apart: a builder in a dead-end pocket held 800 energy for 200 ticks reselecting the
nearest-by-air site it could not path to. Clearing its target by hand changed nothing,
because the criterion itself was the defect.

`chooseHomeSite` honours structure-type priority strictly - a spawn before an extension -
but a tier nothing can reach no longer blocks the tiers below it. `firstReachable` keeps a
caller's own ordering, for callers whose order carries intent that nearest-to-creep would
discard (RoadBuilder pays out from storage outward), while still requiring a path. Path
tests are capped, since the useful candidates sit at the front of an ordered list anyway.

## Hauler Delivery (`src/creeps/haulerDelivery.ts`)

One owner for "where does this energy go", shared by Hauler, RemoteHauler, Harvester and
Pioneer.

It was private to Hauler while RemoteHauler kept its own ordered chain, and that chain
opened with "storage, if it has any free capacity" - which a 1,000,000-capacity storage
effectively always does - so its controller-container, spawn/extension and container
branches were unreachable in every room owning storage.

Score = `base(role) x urgency(how empty) x proximity`. Base weights carry the intent the
old priorities encoded in control flow: a tower that cannot defend 1000, spawn/extensions
90 (12 while a filler is keeping up, never 0), controller container 55, a filling terminal
45, storage 10. Storage being lowest rather than first is the whole fix, and it is why
RemoteHauler no longer needs a separate emergency case.

## Build Geometry (`src/structures/buildGrid.ts`)

Two placement rules that were each private to one planner, and had started to disagree.

**The corridor guard.** A structure is a wall creeps cannot pass, so one placed in a
one-tile corridor severs whatever is behind it. The check was private to `placeStructures`,
so `ExtensionPlanner` placed an extension in E47N41's only route north and sealed every
remote miner it spawned inside its own room. Both planners now share it.

**Extension tile selection.** Searched rings 3 to 10 from the spawn. Measured live, both
mature rooms had zero valid tiles inside that radius and 183 and 92 outside it, so they
stopped growing 19 extensions short with no signal. The search now runs to radius 22 and
charges distance as a score penalty, so a near tile still wins whenever one exists.

**Reachability.** A candidate must be somewhere a creep can actually stand, established by
flooding the room from the spawn. The chokepoint guard is local to eight neighbours and
cannot see a region that was already sealed: widening the radius put five sites in
E47N41's walled-off north and hung a builder on one of them for 200 ticks. Local guards
cannot answer global questions.

Both are pure and take predicates rather than a `Room`, so the geometry is unit tested
against a grid instead of a live colony.

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
