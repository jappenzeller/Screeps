# Remote Mining

## Overview

Remote mining extracts energy from adjacent rooms that you don't own. It requires:
- **Remote Miners** - Harvest in remote room
- **Remote Haulers** - Transport energy home
- **Reservers** - Maintain reservation (prevents 50% source decay)
- **Remote Defenders** - Protect from invaders

Unlocks at **RCL 4** when home economy is stable.

## Room Selection

Adjacent rooms are evaluated via `ColonyManager.getRemoteMiningTargets()`:

**Valid remote rooms:**
- Have sources
- Not owned by another player
- Not source keeper rooms (SK)
- Not highway rooms
- Within 2 rooms of home (travel time matters)

**Stored in:** `Memory.rooms[home].remoteTargets`

## Creep Roles

### REMOTE_MINER

**Purpose:** Harvest sources in remote room

**Behavior:**
1. Travel to assigned remote room
2. Find assigned source
3. Harvest continuously
4. Transfer to container (if exists) or drop

**Body (typical):**
```typescript
[WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE]  // 5W for saturation
```

**Memory:**
```typescript
{
  role: "REMOTE_MINER",
  room: "W1N1",           // Home room
  targetRoom: "W1N2",     // Remote room
  sourceId: "..."         // Assigned source
}
```

### REMOTE_HAULER

**Purpose:** Transport energy from remote containers to home

**Behavior:**
1. Travel to remote room
2. Collect from container/ground
3. Return home
4. Deliver to spawn/storage
5. Repeat

**Body scaling:**
```typescript
// Scales with distance - longer routes need bigger bodies
[CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE]
```

**Key consideration:** First hauler per remote room gets +15 utility bonus to ensure energy doesn't decay.

### RESERVER

**Purpose:** Maintain room reservation

Without reservation:
- Sources regenerate 1,500 energy (50% of normal)
- Invader cores can spawn

With reservation:
- Sources regenerate 3,000 energy (full)
- Timer resets to 5,000 ticks per CLAIM action

**Body:**
```typescript
[CLAIM, CLAIM, MOVE, MOVE]  // 2 CLAIM = +2 ticks/tick
```

**Spawn trigger:** Reservation timer < 1,000 ticks

### REMOTE_DEFENDER

**Purpose:** Protect remote miners from invaders

**Behavior:**
- Ranged + melee hybrid
- Kites hostiles at range 3
- Self-heals
- Retreats when low HP

**Body:**
```typescript
[TOUGH, TOUGH, MOVE, MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK, HEAL, MOVE]
```

**Spawn trigger:** Hostiles detected in remote room (utility 65)

## Infrastructure

### Remote Containers

Placed at each remote source via `RemoteContainerPlanner`:
- 1 container per source
- Adjacent to source (range 1)
- Built by home room builders traveling to remote

### Remote Roads

Optional but improve efficiency:
- Reduces travel fatigue
- Enables 2:1 body ratio
- Built via `SmartRoadPlanner` traffic analysis

## Threat Management

### Invaders

NPCs that spawn in unowned rooms:
- Attack miners/haulers
- Source keeper rooms have permanent invaders

**Defense:**
1. Detect via `Memory.rooms[remote].threats`
2. Spawn REMOTE_DEFENDER (utility 65)
3. Defender handles combat
4. Resume mining when clear

### Source Keepers

Rooms with "Source Keeper" hostiles:
- Permanently hostile
- Kill miners quickly
- Require specialized combat creeps

**Current approach:** Avoid SK rooms (too costly)

## Economic Analysis

### Profitability Formula

```
profit = (energy_per_trip - hauler_upkeep) × trips_per_lifetime
```

**Variables:**
- `energy_per_trip`: Hauler carry capacity
- `hauler_upkeep`: Spawn cost / lifetime ticks
- `trips_per_lifetime`: Based on round-trip time

### Distance Impact

| Distance | Round Trip | Trips/Lifetime | Effective Rate |
|----------|------------|----------------|----------------|
| 1 room | ~50 ticks | 30 | High |
| 2 rooms | ~100 ticks | 15 | Medium |
| 3+ rooms | ~150+ ticks | 10 | Low (often unprofitable) |

Rule of thumb: Only mine rooms within 2 rooms of home.

## Memory Structure

```typescript
Memory.rooms[homeRoom] = {
  remoteTargets: ["W1N2", "W2N1"],  // Adjacent mining rooms
  remoteMiners: {
    "W1N2": {
      [sourceId]: minerName
    }
  }
}

Memory.intel[remoteRoom] = {
  sources: [{id, pos}],
  hasKeepers: boolean,
  threats: [{id, dps}],
  lastScanned: number
}
```

## Spawning Conditions

Remote roles only spawn when:

```typescript
rcl >= 4 AND
harvesters >= 2 AND
haulers >= 1 AND
energyIncome > 0
```

This prevents remote operations from crippling home economy.

## Console Commands

```javascript
remote()              // Remote mining status
remoteAudit()         // Infrastructure audit
threats()             // Hostile analysis
intel("W1N2")         // Room intel
```

## Common Issues

### Remote Miners Dying
**Cause:** Invaders spawning
**Fix:** Check REMOTE_DEFENDER spawning, verify threat detection

### Energy Decaying on Ground
**Cause:** Not enough remote haulers
**Fix:** First hauler gets +15 utility bonus; may need manual adjustment

### Source Decay (1500 instead of 3000)
**Cause:** No reserver or reservation expired
**Fix:** Check RESERVER spawning, verify utility calculation
