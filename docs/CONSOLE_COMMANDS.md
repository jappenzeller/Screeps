# Console Commands

All commands are available in the Screeps console via `global` object.

## Status Commands

### status()
Overview of all colonies.
```javascript
status()
// Shows: Room, RCL, Energy, Creeps, Construction Sites
```

### colony(roomName?)
Detailed ColonyManager status.
```javascript
colony()           // All rooms
colony("W1N1")     // Specific room
// Shows: Phase, Tasks, Workforce needs
```

### cpu()
CPU and bucket status.
```javascript
cpu()
// Shows: Used, Limit, Bucket
```

### rooms()
List all owned rooms.
```javascript
rooms()
// Shows: Room names with RCL
```

### energy()
Energy per room.
```javascript
energy()
// Shows: Available, Capacity, Storage
```

## Creep Commands

### creeps(role?)
List creeps.
```javascript
creeps()             // All creeps
creeps("HARVESTER")  // Specific role
// Shows: Name, Role, Room, TTL
```

### tasks(roomName?)
Show task assignments.
```javascript
tasks()              // All rooms
tasks("W1N1")        // Specific room
// Shows: Task type, Target, Assigned creep
```

### spawn(role, roomName?)
Force spawn a creep.
```javascript
spawn("HARVESTER")           // In first available room
spawn("BUILDER", "W1N1")     // In specific room
```

### spawnScores(roomName?)
Show utility scores for all spawn roles, sorted highest to lowest.
```javascript
spawnScores()            // First owned room
spawnScores("W1N1")      // Specific room
// Shows: Role, Utility score, Deficit (target - current + dying)
```

### kill(creepName)
Kill a specific creep.
```javascript
kill("harvester_12345")
```

## Construction Commands

### construction(roomName?)
Building status.
```javascript
construction()
construction("W1N1")
// Shows: Sites count, Types, Progress
```

### traffic(roomName)
Traffic heatmap stats.
```javascript
traffic("W1N1")
// Shows: High-traffic tiles, Visit counts
```

### showTraffic(enabled)
Toggle traffic visualization.
```javascript
showTraffic(true)   // Enable
showTraffic(false)  // Disable
```

### suggestRoads(roomName)
Get road suggestions based on traffic.
```javascript
suggestRoads("W1N1")
// Shows: Suggested road positions
```

## Remote Mining Commands

### remote()
Remote mining status for all rooms.
```javascript
remote()
// Shows: Remote rooms, Miners, Haulers, Reservers
```

### remoteAudit()
Infrastructure audit for remote rooms.
```javascript
remoteAudit()
// Shows: Missing containers, Reservation status
```

### intel(roomName)
Room intelligence data.
```javascript
intel("W1N2")
// Shows: Sources, Owner, Threats, Last scan
```

## Expansion Commands

### bootstrap.status()
Current bootstrap operation status.
```javascript
bootstrap.status()
// Shows: State, Target room, Progress
```

### bootstrap.queue(target, parent)
Queue room for expansion.
```javascript
bootstrap.queue("W1N2", "W1N1")
```

### bootstrap.cancel()
Cancel current bootstrap operation.
```javascript
bootstrap.cancel()
```

### expansion.status()
Empire expansion state.
```javascript
expansion.status()
// Shows: Active expansions, Auto-expand setting
```

### expansion.evaluate(roomName)
Score a room for expansion viability.
```javascript
expansion.evaluate("W1N2")
// Shows: Score breakdown
```

### expansion.expand(target, parent)
Start expansion to room.
```javascript
expansion.expand("W1N2", "W1N1")
```

### expansion.cancel(roomName)
Cancel expansion operation.
```javascript
expansion.cancel("W1N2")
```

### expansion.auto(enabled)
Toggle auto-expansion.
```javascript
expansion.auto(true)   // Enable
expansion.auto(false)  // Disable
```

### integration(roomName?)
Show integration diagnostics for colonies in INTEGRATING state.
```javascript
integration()            // All integrating colonies
integration("E44N37")    // Specific room
// Shows: RCL, creep counts, stall detection, spawn directives
```

## Military Commands

### military.status()

Show all campaigns and military posture.

```javascript
military.status()
// Shows: Active campaigns, Target rooms, Progress
```

### military.attack(targetRoom, options?)

Launch a controller attack campaign.

```javascript
military.attack("E44N39")
military.attack("E44N39", { type: "CONTROLLER_ATTACK" })
// Creates campaign and auto-selects best approach based on simulation
```

### military.simulate(targetRoom)

Run tactical simulation for a target room.

```javascript
military.simulate("E44N39")
// Shows: All 16 strategies (4 directions × 4 wave sizes)
// Predicts survival rates, costs, and recommended approach
```

### military.simApproach(targetRoom, approachRoom, waveSize?)

Test a specific approach strategy.

```javascript
military.simApproach("E44N39", "E45N39")       // Solo (default)
military.simApproach("E44N39", "E45N39", 4)    // 4-creep wave
// Shows: Path details, tower damage per tick, survival rate
```

### military.towerDamage(roomName, x, y)

Calculate tower damage at a specific position.

```javascript
military.towerDamage("E44N39", 25, 25)
// Shows: Total DPS from all towers at that position
```

### military.roomIntel(roomName)

Show cached intel for a room.

```javascript
military.roomIntel("E44N39")
// Shows: Controller, Towers, Owner, RCL
```

### military.abort(campaignId)

Abort an active campaign.

```javascript
military.abort("campaign_1")
```

## Defense Commands

### threats()

Show threat status for owned and remote rooms.
```javascript
threats()
// === Owned Rooms ===
// E43N39: Safe
// E44N42: 2 hostiles
//   Invader: A5 R0 H0
//
// === Remote Rooms ===
// E46N38: CLEAR (scan 45 ticks ago, no hostiles)
// E47N37: ASSUMED THREAT (scan 350 ticks ago, hostiles last seen 350 ticks ago, no visibility)
// E47N38: ACTIVE THREAT (scan 12 ticks ago, 2 hostiles)
```

### anomalies()

Show creeps that runtime invariant checks have flagged. These are measured on live
behaviour rather than inferred from code, and each finding is a lead worth chasing.

```javascript
anomalies()
// === Runtime Anomalies ===
// STUCK E43N39 HAULER HAULER_77300113
//       state=DELIVERING energy=800 stuck=100 seen=12 ticks ago
// FLAP  E47N41 UPGRADER UPGRADER_77301204
//       state=COLLECTING energy=0 flaps=7 seen=3 ticks ago
```

- **STUCK** — carried energy *and* state both unchanged for 100+ ticks. The creep is
  waiting on a source that will never arrive. Creeps that are travelling, or standing on
  a source (static miners), are excluded.
- **FLAP** — state cycling faster than the work could complete, which usually means two
  steps are undoing each other.

Findings also ride to AWS in segment 90, so the advisor correlates them against metrics.

### ramparts(roomName?)

Show rampart coverage of critical structures (spawns, towers, storage, terminal).
```javascript
ramparts()           // All owned rooms
ramparts("W1N1")     // Specific room
// === Rampart Coverage ===
// E46N37 (RCL 7): 6/2500 ramparts, 3 sites
//   spawn: 2/2 protected
//   tower: 3/3 protected
//   storage: 1/1 protected
//   terminal: 0/1 protected
//   weakest rampart: 4200 hits
```

### safemode(roomName?)
Safe mode status.
```javascript
safemode()           // Check status
safemode("W1N1")     // Activate in room
```

### defenders()
List defender creeps.
```javascript
defenders()
// Shows: Name, Room, HP, Target
```

## Debug Commands

### moveStats()
Movement statistics.
```javascript
moveStats()
// Shows: Stuck creeps, Oscillating creeps
```

### memory(path?)
Inspect memory.
```javascript
memory()                    // Top-level
memory("rooms.W1N1")        // Specific path
```

### clearMemory(path)
Clear memory at path.
```javascript
clearMemory("rooms.W1N1.tasks")
```

## AWS Commands

### awsExport()
AWS export status.
```javascript
awsExport()
// Shows: Segment size, Last export tick
```

### segmentSize()
Detailed segment 90 size breakdown.
```javascript
segmentSize()
// Shows: Total size, Section breakdown, Shedding status
// Sections: colonies, intel, diagnostics, empire, global
// Warns if approaching 100KB limit
```

### advisor()
Show AI Advisor API endpoints.
```javascript
advisor()
// Shows: API URLs
```

### fetchAdvisor(roomName)
Show cached AI recommendations.
```javascript
fetchAdvisor("W1N1")
// Shows: Recommendations from AWS
```

## AWS Directive Commands

### directives()
Show current directive payload from AWS (segment 95).
```javascript
directives()
// Shows: Version, Game tick, Staleness, Pending directives
```

### directives.toggle()
Enable/disable the AWS directive system.
```javascript
directives.toggle()
// Toggles Memory.settings.useDirectives
```

### directives.status()
Show directive execution history.
```javascript
directives.status()
// Shows: Directive ID, Status, Execution time, Result
```

### directives.clear()
Clear all directive state (for debugging).
```javascript
directives.clear()
```

### directives.fallback()
Force fallback to local logic (disable directives).
```javascript
directives.fallback()
```

### spawnQueue()
Show spawn directives queued by AWS.
```javascript
spawnQueue()
// Shows: Priority, Role, Colony, Reason, Age
```

## Debug Flag Commands

### Memory.debug Configuration
Debug flags control verbose logging. All are opt-in.

```javascript
// Show framework evaluator scoring per tick (spawning/construction/military)
Memory.debug = { showEvaluations: true }

// Show traffic heatmap visualization
Memory.debug = { showTraffic: true }

// Disable all debug output
Memory.debug = {}
// or
delete Memory.debug
```

## Pathfinding Debug Commands

### analyzeRoute(fromRoom, toRoom)

Analyze routes between two rooms, showing both direct and safe paths.

```javascript
analyzeRoute("E46N37", "E44N37")
// Shows: Direct route, Safe route, SK room detection
// If no safe route, suggests waypoints
```

### checkSK(roomName)

Check if a room is a Source Keeper room.

```javascript
checkSK("E45N36")
// Shows: Whether room is SK, coordinate calculation
```

## Quick Reference

| Category | Command | Purpose |
|----------|---------|---------|
| Status | `status()` | Overview |
| Status | `colony()` | ColonyManager |
| Status | `cpu()` | CPU stats |
| Creeps | `creeps()` | List creeps |
| Creeps | `tasks()` | Task queue |
| Creeps | `spawn("ROLE")` | Force spawn |
| Creeps | `spawnScores()` | Utility scores |
| Construction | `construction()` | Build status |
| Construction | `traffic("room")` | Heatmap |
| Remote | `remote()` | Mining status |
| Remote | `intel("room")` | Room data |
| Expansion | `bootstrap.status()` | Bootstrap |
| Expansion | `expansion.status()` | Empire |
| Expansion | `integration()` | Integration diagnostics |
| Defense | `threats()` | Hostiles |
| Defense | `anomalies()` | Stuck/flapping creeps |
| Defense | `ramparts()` | Rampart coverage |
| Defense | `safemode()` | Safe mode |
| Military | `military.status()` | Campaign status |
| Military | `military.attack("room")` | Launch attack |
| Military | `military.simulate("room")` | Pre-attack simulation |
| Debug | `moveStats()` | Movement |
| Debug | `analyzeRoute(from, to)` | Route analysis |
| Debug | `checkSK("room")` | SK room check |
| Debug | `Memory.debug.showEvaluations` | Evaluator logs |
| AWS | `segmentSize()` | Size breakdown |
| AWS | `advisor()` | API info |
| AWS | `directives()` | Directive payload |
| AWS | `directives.toggle()` | Enable/disable |
| AWS | `spawnQueue()` | Spawn directives |
