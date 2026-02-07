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

## Defense Commands

### threats(roomName?)
Show hostile creeps.
```javascript
threats()            // All rooms
threats("W1N1")      // Specific room
// Shows: Hostile name, DPS, Heal power
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

## Quick Reference

| Category | Command | Purpose |
|----------|---------|---------|
| Status | `status()` | Overview |
| Status | `colony()` | ColonyManager |
| Status | `cpu()` | CPU stats |
| Creeps | `creeps()` | List creeps |
| Creeps | `tasks()` | Task queue |
| Creeps | `spawn("ROLE")` | Force spawn |
| Construction | `construction()` | Build status |
| Construction | `traffic("room")` | Heatmap |
| Remote | `remote()` | Mining status |
| Remote | `intel("room")` | Room data |
| Expansion | `bootstrap.status()` | Bootstrap |
| Expansion | `expansion.status()` | Empire |
| Defense | `threats()` | Hostiles |
| Defense | `safemode()` | Safe mode |
| Debug | `moveStats()` | Movement |
| AWS | `segmentSize()` | Size breakdown |
| AWS | `advisor()` | API info |
