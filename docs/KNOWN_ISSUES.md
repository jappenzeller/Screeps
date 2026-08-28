# Known Issues

## Active Issues

### AWS AI Advisor Produced Nothing for Months

**Status:** Fixed

**Issue:** The advisor looked healthy from CloudWatch — 288 data-collector runs/day, 864 metrics writes, 24 analysis runs, **zero Lambda errors** — but the recommendations table was completely empty and no AI analysis had ever been stored.

**Root Cause:** Four independent defects, none of which surfaced as a Lambda error:

1. **Retired model.** `analysis-engine` called `claude-sonnet-4-20250514`, which now 404s (`not_found_error`). Every hourly run died at the Claude call. The Lambda caught the exception, so `Errors` stayed at 0 and the failure was invisible to metrics-based monitoring.
2. **Unpaginated Scan.** `getActiveRooms()` issued a single `ScanCommand`. DynamoDB caps a scan page at 1MB of *pre-filter* data and the snapshots table is 2.7MB, so it only ever saw a slice of the table and discovered a subset of rooms — a 3-colony empire was being analyzed one room at a time.
3. **Dead API path.** `fetchLiveData()` called `/live` and `/live/{room}`, which no longer exist (the API exposes `/colonies` and `/colonies/{room}`). Every analysis silently fell back to 5-minute-old snapshots instead of ~40-second-fresh live segment data.
4. **Stale SDK.** `@anthropic-ai/sdk` was pinned at `^0.20.0` (early 2024), which predates adaptive thinking and `output_config.effort`.

**Fix Applied:**

- Model moved to `claude-opus-5` via a `MODEL_ID` env override, with adaptive thinking and `effort: medium`.
- Response parsing selects the `text` block explicitly instead of indexing `content[0]` — with thinking enabled the first block is a thinking block.
- `getActiveRooms()` paginates on `LastEvaluatedKey`.
- `fetchLiveData()` points at `/colonies`.
- SDK upgraded to `^0.122.0`.
- Lambda timeout raised 120s → 300s (a 3-room run takes ~101s and would have been cut off as the empire grows).

**Verified:** all 3 rooms analyzed, live data available, recommendations table populated. The advisor independently detected `RCL_STALL` + `STORAGE_FULL` on E43N39, `NO_UPGRADERS` on E46N37, and `REMOTE_HAULER_SHORTAGE` — matching hand analysis.

**Files:** `aws/lambda/analysis-engine/index.js`, `aws/lambda/analysis-engine/package.json`

**Note:** monitoring this pipeline on Lambda `Errors` is misleading — the handler swallows per-room analysis failures. Alarm on "recommendations table received no writes in N hours" instead.

---

### Remote Mining Deadlocked by Expired Pauses

**Status:** Fixed

**Issue:** All three owned colonies (E46N37, E47N41, E43N39) had **zero** active remotes — 0/20, 0/27 and 0/28 respectively — despite ~60 unclaimed source rooms in intel. The two RCL 7 rooms were left on 2 local sources each and could not fill their storage.

**Root Cause:** A chain of three defects that together made the state permanent:

1. `RemoteMiningEvaluator` pauses a remote on hostile contact, setting `pausedUntil = Game.time + 5000` and `pauseReason = "Hostile detected"`. **No code path ever cleared an expired pause.** Live pauses had `pausedUntil: 73355699` against a current tick of 77,264,600 — expired 3.9M ticks earlier and still in force.
2. `syncRemoteRooms()` Phase 1 skipped cleanup for any entry with a `pauseReason` regardless of expiry, so dead entries were never removed either — including rooms HailHydra had since taken.
3. Phase 3 counted **all** remotes toward `maxRemotes` (4), not just active ones. 20–28 stale entries saturated the cap, so Phase 4 never added a replacement.
4. `findPotentialRemotes()` excludes rooms already in `colony.remotes`, so the framework's `activate_remote` path could not recover them either.

**Fix Applied:** In `syncRemoteRooms()`:

- Expired pauses are cleared and reactivated, then re-validated normally (hostile-owned rooms get removed as usual). Indefinite pauses (`pauseReason` with no `pausedUntil`) are still respected as deliberate.
- `currentCount` counts only active remotes toward the cap.
- New Phase 3b trims over-cap actives by score (weakest first) after a batch reactivation.
- Phase 4 reactivates a known-but-inactive remote instead of skipping it, so trimmed remotes are not stranded off permanently.

**File:** `src/core/ColonyManager.ts`

---

### Full Storage Cannot Be Spent Down

**Status:** Fixed

**Issue:** E43N39 sat at 1,000,000 / 1,000,000 stored energy and dropped 5,418 energy on the ground while remaining at RCL 5.

**Root Cause:** `upgraderTarget = rcl < 8 ? Math.min(rcl, 3) : 1` caps upgraders at 3 regardless of stored energy. `storageUtility()` also saturates at the `high` threshold (400k), so nothing in the system responds to storage beyond that point. A room past the cap has no sink for its surplus.

**Fix Applied:** Rooms with storage above the high-water mark add up to `MAX_SURPLUS_UPGRADERS` (4) extra upgraders, one per half-threshold of surplus, converting dead capital into RCL progress. Rooms with empty storage are unaffected.

**File:** `src/spawning/utilitySpawning.ts`

---

### No Ramparts on Critical Structures

**Status:** Fixed

**Issue:** All three owned rooms had **0 ramparts**. Spawns, towers, storage and terminals were bare, and E46N37 additionally had no safe mode available.

**Root Cause:** No rampart planner existed. `ConstructionCoordinator` listed `STRUCTURE_RAMPART` at priority 7, but nothing generated rampart sites — and that gate requires every higher-priority structure type to be complete first, which would have stalled ramparts behind unfinished extensions anyway.

**Fix Applied:** Added `RampartPlanner`, which ramparts spawns → towers → storage → terminal, up to 3 concurrent sites, running every 25 ticks. It deliberately bypasses `ConstructionCoordinator` so defense does not queue behind economy. Existing `TowerManager` repair logic (ramparts below 10k hits) maintains them. Not a perimeter/min-cut planner — a full wall line is unaffordable for an energy-starved room.

**Files:** `src/structures/RampartPlanner.ts`, `src/main.ts`, `src/utils/Console.ts` (`ramparts()`)

---

### Tick Metrics Collector Records Only Zeros

**Status:** Open

**Issue:** All 100 entries in `Memory.stats.tickStats` have `energyHarvested: 0`, and zero across every field of `energySpent` and `creepActions`, while creeps are demonstrably harvesting, building and upgrading. The segment-90 export to AWS still carries correct snapshot data, so the advisor sees room state but no activity data.

**Impact:** AWS AI Advisor recommendations are generated without any activity signal.

**File:** `src/utils/StatsCollector.ts` (suspected)

---

### smartMoveTo Blocking Investigation

**Status:** Investigated, fix implemented

**Issue:** Hauler at (8,28) couldn't path to container at (6,28) for 183+ ticks. Defenders at (12,26) and (11,25) somehow blocked the path.

**Root Cause:**
1. `smartMoveTo` used high `reusePath` (50) caching stale paths
2. No stuck detection for single-room movement
3. Path calculated 183 ticks ago when defenders were elsewhere

**Fix Applied:**
- Added stuck detection (`_lastPos`, `_stuckCount`)
- After 3 ticks stuck: recalculate with `ignoreCreeps: true`
- After 5 ticks stuck: random shove to break deadlock
- Lowered default `reusePath` from 50 to 10
- Short-range `ignoreCreeps` when target ≤ 3 tiles

**File:** `src/utils/movement.ts`

**Investigation Doc:** `docs/investigation-smartmoveto-blocking.md`

---

### PIONEER Spawning When No Expansion Active

**Status:** Fixed

**Issue:** PIONEER creeps spawning with `Memory.empire.expansion.active = {}` and `Memory.empire.expansion.queue = []`. Spawn log showed `PIONEER (2/0): 22.5` — 2 current, 0 target, but still getting utility 22.5.

**Root Cause:** In SpawnEvaluator, the saturation factor check was `if (current > 0 && target > 0)`. When target=0, the saturation penalty was skipped entirely. The deficit factor only reduced score by 50% instead of zeroing it.

**Fix Applied:** Added explicit handling for target=0 case in saturation logic:

```typescript
if (target === 0) {
  score = 0;  // Don't spawn when target is 0, regardless of current count
}
```

**File:** `src/framework/evaluators/SpawnEvaluator.ts`

---

### Duplicate Reserver Spawning

**Status:** Fixed

**Issue:** Multiple reservers spawning for same remote room.

**Root Cause:** TTL check pattern `c.ticksToLive && c.ticksToLive > N` didn't count spawning creeps (undefined TTL).

**Fix Applied:** Changed to `(!c.ticksToLive || c.ticksToLive > N)` pattern.

**Files:** `src/spawning/utilitySpawning.ts` (reserverUtility, remoteDefenderUtility, remoteHaulerUtility)

---

### Segment 90 Size Limit

**Status:** Fixed

**Issue:** Memory segment 90 exceeding 100KB limit, causing export failures.

**Fix Applied:**
- Intel TTL filter (1500 ticks)
- Curated creep memory export (essential fields only)
- Graceful degradation (drop diagnostics first, then reduce intel)
- Periodic size logging

**File:** `src/utils/AWSExporter.ts`

---

### Bootstrap Builder Missing selfHarvest Flag

**Status:** Fixed

**Issue:** Bootstrap builders for new colonies weren't getting the `selfHarvest` flag, so they couldn't harvest their own energy and had to wait for haulers.

**Root Cause:** `getCreepMemory()` in utilitySpawning.ts constructed its own memory object instead of using the spawn request from `ExpansionManager.getSpawnRequests()` which includes the `selfHarvest` flag.

**Fix Applied:** Changed `getCreepMemory()` for BOOTSTRAP_BUILDER to use the memory from `ExpansionManager.getSpawnRequests()` which correctly determines which builder should self-harvest.

**File:** `src/spawning/utilitySpawning.ts`

---

### Duplicate Intel Storage (Memory.rooms vs Memory.intel)

**Status:** Fixed (Phase 1 Migration)

**Issue:** Room intel was stored in both `Memory.rooms[roomName]` and `Memory.intel[roomName]`, causing inconsistencies and confusion.

**Root Cause:** Legacy code used `Memory.rooms` for all room data (owned + remote intel), while newer code used `Memory.intel` for scouted room data.

**Fix Applied:**

- All intel reads now use `Memory.intel` exclusively
- `updateRoomIntel()` in remoteIntel.ts is now a no-op (intel gathered centrally)
- `gatherRoomIntel()` in Scout.ts is the single source of truth
- Added `hostileDetails` field to RoomIntel for defense decisions
- `Memory.rooms` now only contains owned-room data (tasks, assignments, containerPlan)

**Files:** Multiple - types.d.ts, Scout.ts, remoteIntel.ts, ColonyManager.ts, utilitySpawning.ts, AWSExporter.ts, Console.ts, RemoteDefender.ts, main.ts, EconomyTracker.ts, RemoteSquadManager.ts, ColonyState.ts

---

### Remote Mining Targets Scattered Logic (Memory.colonies Registry)

**Status:** Fixed (Phase 2 Migration)

**Issue:** Remote mining target derivation was duplicated across ColonyManager.ts and utilitySpawning.ts, with logic re-run every tick.

**Root Cause:** No central registry for per-colony configuration. Remote targets derived on-the-fly from exits + intel every time, wasting CPU and making manual overrides impossible.

**Fix Applied:**

- Added `Memory.colonies[roomName]` registry with `ColonyMemory` interface
- `remoteRooms: string[]` - explicit list of remote mining targets
- `remoteRoomsLastSync: number` - timestamp of last auto-derivation
- Auto-initialized on first run from exits + intel filter
- Re-syncs every 500 ticks (logs additions/removals)
- Console commands for manual control:
  - `remotes()` - list all colonies' remote rooms
  - `addRemote(home, remote)` - add remote room
  - `removeRemote(home, remote)` - remove remote room
  - `syncRemotes(home?)` - force re-derivation
- Abandoned colony cleanup in MemoryManager

**Files:** types.d.ts, ColonyManager.ts, utilitySpawning.ts, Console.ts, AWSExporter.ts, MemoryManager.ts

---

### Builder Stuck on Border Tile

**Status:** Fixed

**Issue:** Builder stuck between E46N37 and E47N37 on the border trying to reach road builds in E47N37.

**Root Cause:** When a creep crosses a room border and is on the edge tile (x=0 or x=49) in the target room, `smartMoveTo()` didn't have special handling since the target room matched the creep's current room. This caused pathfinding issues at room edges.

**Fix Applied:** Added border handling in `smartMoveTo()`: when a creep is stuck on a border tile for 3+ ticks (even if target is in same room), force step off the border before continuing pathfinding.

**File:** `src/utils/movement.ts`

---

### Framework Evaluator Console Spam

**Status:** Fixed

**Issue:** Framework evaluators (spawning, construction, military) were logging to console every tick, flooding output with messages like:

```text
[spawning] E43N39: Spawn HARVESTER (2/2): 0.2...
[military] E44N42: Defend E44N42 (threat: LOW): 92.8
[construction] E47N41: Build link (0/2): 100
```

**Root Cause:** `BaseEvaluator.logEvaluation()` checked `if (Memory.debug)` which was always true if Memory.debug existed with any value.

**Fix Applied:** Changed to explicit opt-in via `Memory.debug.showEvaluations`:

```typescript
if (!Memory.debug?.showEvaluations) return;
```

**Files:** `src/framework/BaseEvaluator.ts`, `src/types.d.ts`

---

### Segment 92 Size Limit

**Status:** Fixed

**Issue:** Telemetry export to segment 92 exceeded 100KB limit.

**Root Cause:** `TelemetryManager` buffered up to 500 decisions, each ~350 bytes, totaling ~175KB.

**Fix Applied:**

- Reduced default maxDecisions from 500 to 200
- Added size-aware truncation (removes oldest decisions if over 90KB)
- Added `truncated` flag for transparency

**File:** `src/framework/Telemetry.ts`

---

### RESERVER Utility Returns NaN

**Status:** Fixed

**Issue:** RESERVER spawning utility returned NaN for some remote rooms, causing spawn evaluator to malfunction.

**Observed:** `[spawning] E43N39: Spawn RESERVER -> E42N39 (0/1): NaN`

**Root Cause:** Remote configs in `Memory.colonies[colony].remotes[room]` could have undefined `distance` or `sources` fields (e.g., configs created by older code or manual console commands). When `WorldState.captureRemotes()` built the remote snapshot, it passed `config.distance` directly without a default. In `SpawnEvaluator.evaluateRemoteRole()`, the calculation `1 - remote.distance * 0.15` produced NaN when distance was undefined.

**Fix Applied:**

Defense in depth - defaults at source AND guards at consumer:

1. WorldState.ts line 388-389: `distance: config.distance ?? 1` and `sources: config.sources ?? 2`
2. SpawnEvaluator.ts line 303: `const distance = remote.distance ?? 1`

**Files:** `src/framework/WorldState.ts`, `src/framework/evaluators/SpawnEvaluator.ts`

---

### WorldState CPU Usage Too High

**Status:** Fixed

**Issue:** `WorldState.capture()` consumed 8-17.5 CPU/tick - 12-25% of the entire CPU budget spent on state capture before any creep logic runs.

**Root Cause:** Multiple expensive operations every tick:

1. Triple `Object.values(Game.creeps).filter()` per remote room (45 iterations for 15 remotes)
2. Unused `room.find(FIND_MY_STRUCTURES)` result (line 117 never read)
3. `EconomyTracker.getMetrics()` creating new instance every tick
4. Full structure/creep snapshot arrays stored but only counts used
5. Duplicate `room.find()` calls in convertMilestones and captureTrafficHotspots

**Fix Applied:**

1. **Creep index cache** - Single `Object.values(Game.creeps)` at start, indexed by room+role+targetRoom
2. **Removed unused code** - Deleted `room.find(FIND_MY_STRUCTURES)` that was never used
3. **Tiered capture frequency** - Structures every 10 ticks, traffic every 50 ticks, threats every tick
4. **Minimal arrays** - Don't store full structure/site arrays, just counts
5. **Shared structure cache** - Pass cached structures to helper functions
6. **AWSExporter integration** - Uses WorldState cache instead of redundant room.find()

**Expected Improvement:** 17.5 CPU → < 5 CPU/tick

**Files:** `src/framework/WorldState.ts`, `src/utils/AWSExporter.ts`

---

### Remote Defender Not Spawning After Miners Flee

**Status:** Fixed

**Issue:** When hostiles appear in a remote mining room, miners flee home. Once all friendly creeps leave, we lose room visibility. Intel stops updating. After 200 ticks, `remoteDefenderUtility()` considered the scan "stale" and returned utility 0. No defender ever spawned. Miners sat at home indefinitely waiting for a defender that never came.

**Root Cause:** `remoteDefenderUtility()` only checked `lastScanned` age and `hostiles` count — both of which go stale when visibility is lost. It didn't use `intel.lastHostileSeen` which persists even without visibility.

Similarly, `getHostileCount()` returned 0 for stale scans even if hostiles were recently seen, causing miners to attempt returning prematurely and re-fleeing in an oscillation loop.

**Fix Applied:**

Two-path threat detection using `lastHostileSeen`:

1. **Fresh scan (lastScanned ≤ 200 ticks)**: Use live `intel.hostiles` count. If hostiles > 0, room is threatened. If 0, room is safe.
2. **Stale scan (lastScanned > 200 ticks)**: Check `intel.lastHostileSeen`. If hostiles were seen within 1500 ticks (invader lifespan) and we DON'T have fresh visibility confirming the room is clear, assume threat persists.

Changes:
- `remoteDefenderUtility()` - spawn defenders for stale threats
- `getHostileCount()` - return ≥1 for stale threats (keeps miners home)
- `findRoomNeedingDefender()` - send defenders to stale-threat rooms
- `findThreatenedRemoteRoom()` - same logic for squad management
- `threats()` console command - shows ASSUMED THREAT for stale-threat rooms

**Files:** `src/spawning/utilitySpawning.ts`, `src/utils/remoteIntel.ts`, `src/creeps/RemoteDefender.ts`, `src/utils/Console.ts`

---

## Limitations

### No Link/Terminal/Lab/Factory Support

**Status:** Not implemented

The bot currently has basic link support but doesn't utilize:
- Terminal (inter-room resource transfer)
- Labs (mineral processing)
- Factory (commodity production)

These are RCL 6-8 features that would improve late-game efficiency.

---

### No Combat Beyond Basic Defenders

**Status:** Limited

Combat capabilities:
- Basic melee defender for home room
- Ranged remote defender with kiting
- Tower-based defense

Missing:
- Squad coordination
- Siege operations
- Boosted combat creeps

---

### Source Keeper Rooms Not Supported

**Status:** By design

SK rooms have permanent hostile NPCs that require specialized combat creeps. Currently avoided in remote mining selection.

---

## Potential Issues

### Hauler Oscillation

**Risk:** Haulers targeting same container, then switching

**Mitigation:** Container assignment at spawn time via `Memory.creeps[name].targetContainer`

**Monitor:** Check for oscillating haulers via `moveStats()`

---

### Extension Fill Race

**Risk:** Multiple haulers trying to fill same extension

**Mitigation:** `findClosestByPath` naturally distributes, but not perfect

**Symptom:** Haulers standing near full extensions

---

### Remote Mining Profitability

**Risk:** Remote rooms too far to be profitable

**Mitigation:** Only mine within 2 rooms of home

**To Monitor:** Energy decay in remote containers, hauler utilization

---

## Debugging Tips

### Stuck Creeps
```javascript
moveStats()  // Shows stuck and oscillating creeps
```

### Task Assignment Issues
```javascript
tasks("W1N1")  // Shows task queue and assignments
```

### Spawning Problems
```javascript
creeps()     // Check current counts
spawn("ROLE") // Force spawn for testing
```

### Economy Issues
```javascript
energy()     // Check energy flow
economy()    // Detailed metrics
haulers()    // Hauler status
```

### Remote Mining Issues
```javascript
remote()              // Overall status
remoteAudit()         // Infrastructure check
intel("room")         // Room data
remotes()             // List remote rooms for all colonies
addRemote(home, room) // Add remote room to colony
removeRemote(home, room) // Remove remote room
syncRemotes(home?)    // Force re-derive remote targets
```
