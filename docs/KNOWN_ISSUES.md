# Known Issues

## Active Issues

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
