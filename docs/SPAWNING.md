# Spawning System

## Overview

The bot uses **utility-based spawning** where each role has a utility function (0-100+) calculated from colony state. The highest utility role spawns next.

This replaces static priority lists with dynamic decision-making that adapts to colony needs.

## Core Algorithm

Each tick when spawn is free:

```
1. Calculate utility for ALL roles
2. Sort by utility (highest first)
3. For economy-aware waiting:
   - If economy has income AND best role unaffordable
   - Wait (don't spawn lower priority roles)
4. Otherwise spawn highest utility that's affordable
5. Emergency override: If economy dead, bootstrap only
```

**Key File:** `src/spawning/utilitySpawning.ts` (1506 lines)

## Utility Functions by Role

### Economy Roles (Home Room)

#### HARVESTER
```
Base: 100
Scales INVERSELY with income - fewer harvesters = higher utility
Near-infinite utility when income = 0 (forces spawn)
Considers: source saturation, energy income, dying creeps
```

#### HAULER
```
Base: 60
0 utility if no harvesters exist (nothing to haul)
+25 bonus if harvesters exist but 0 haulers (deadlock break)
Scales with container count, spawn fill needs
```

#### UPGRADER
```
Uses modular utility combining:
- Storage level factor
- Sustainability factor (harvesters exist)
- Energy rate factor
- Population factor
Result: 0-60 range typically
```

#### BUILDER
```
Base: 40
Scales with construction site count
+15 bonus for remote container urgency
+20 bonus if storage high and many sites
0 if no construction sites
```

#### DEFENDER
```
Base: 0 (no hostiles)
65 if hostiles present
Scales with threat level
```

### Remote Roles (RCL 4+ Only)

#### REMOTE_MINER
```
Base: 50
0 if RCL < 4
0 if home economy unstable (< 2 harvesters OR 0 haulers)
Scales with remote source availability
```

#### REMOTE_HAULER
```
Base: 55
+15 bonus for first hauler in each remote room
Critical for remote income capture
0 if no remote miners exist
```

#### RESERVER
```
Fixed: 45 when needed
0 if reservation timer > threshold
Protects remote sources from 50% decay
```

#### REMOTE_DEFENDER
```
Fixed: 65 when remote rooms have threats
0 otherwise
```

### Infrastructure Roles

#### LINK_FILLER
```
Fixed: 70
Only at RCL 5+ with links
Keeps storage link filled
```

#### MINERAL_HARVESTER
```
Fixed: 30
Only at RCL 6+ with extractor
```

#### SCOUT
```
Max: 15 (capped)
Never outbids economy roles
Spawns when intel outdated
```

### Expansion Roles

#### CLAIMER
```
Fixed: 50 when expansion target set
0 otherwise
```

#### BOOTSTRAP_BUILDER
```
Fixed: 80 (very high)
Only during active bootstrap
```

#### BOOTSTRAP_HAULER
```
Fixed: 75
Only during active bootstrap
```

## Economy-Aware Waiting

The spawner implements "smart waiting":

```typescript
if (economyHasIncome && !canAffordBestRole) {
  // Don't spawn lower priority role
  // Wait for energy to spawn high-priority role
  return null;
}
```

This prevents spawning scouts when builders are needed but unaffordable.

## Emergency Bootstrapping

If economy is completely dead (no harvesters producing):

```typescript
const ECONOMY_ROLES = ['HARVESTER', 'HAULER'];
// Only consider economy roles
// Spawn whatever is affordable
// Ignore utility ordering
```

## Body Scaling

Bodies scale with `energyCapacityAvailable`:

```typescript
// Example: Harvester body scaling
300 energy:  [WORK, WORK, CARRY, MOVE]
550 energy:  [WORK, WORK, WORK, WORK, WORK, MOVE]  // Saturates source
800 energy:  [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE]
```

**Key Files:**
- `src/spawning/bodyBuilder.ts` - Body construction
- `src/spawning/bodyConfig.ts` - Role templates

### Minimum Costs (ROLE_MIN_COST)

```typescript
HARVESTER: 200      // [WORK, CARRY, MOVE]
HAULER: 100         // [CARRY, MOVE]
UPGRADER: 200       // [WORK, CARRY, MOVE]
BUILDER: 200        // [WORK, CARRY, MOVE]
DEFENDER: 130       // [TOUGH, ATTACK, MOVE]
REMOTE_MINER: 200
REMOTE_HAULER: 100
RESERVER: 650       // [CLAIM, MOVE]
SCOUT: 50           // [MOVE]
```

## Body Part Costs

| Part | Cost | Effect |
|------|------|--------|
| MOVE | 50 | Movement speed |
| WORK | 100 | Harvest/build/repair/upgrade |
| CARRY | 50 | +50 carry capacity |
| ATTACK | 80 | 30 melee damage |
| RANGED_ATTACK | 150 | 10 ranged damage |
| HEAL | 250 | 12 heal/tick |
| TOUGH | 10 | +100 HP |
| CLAIM | 600 | Controller interaction |

## Movement Ratios

For smooth movement:
- **1:1 ratio** - 1 MOVE per non-MOVE part (plains every tick)
- **2:1 ratio** - 1 MOVE per 2 non-MOVE (roads every tick, plains every 2)

```typescript
// Good: moves every tick on plains
[WORK, CARRY, MOVE, MOVE]

// Good: moves every tick on roads
[WORK, WORK, CARRY, CARRY, MOVE, MOVE]

// Bad: barely moves
[WORK, WORK, WORK, WORK, MOVE]
```

## Renewal Logic

Creeps can self-renew when:
1. TTL < round_trip_to_spawn + buffer
2. Near spawn (range 1)
3. Spawn not busy
4. Body cost > threshold (don't renew small creeps)

Large creeps (500+ cost) get renewed; small ones die and get replaced with bigger versions when capacity increases.

## Spawn Priority Matrix

| Phase | Priority Order |
|-------|---------------|
| BOOTSTRAP | HARVESTER > HAULER > UPGRADER |
| DEVELOPING | HARVESTER > HAULER > BUILDER > UPGRADER |
| STABLE | HARVESTER > HAULER > REMOTE_* > BUILDER > UPGRADER |
| EMERGENCY | DEFENDER > HARVESTER > HAULER |

Note: This is emergent from utility functions, not hardcoded.

## Debugging Spawning

Console commands:
```javascript
spawn("HARVESTER")        // Force spawn
spawn("BUILDER", "W1N1")  // In specific room
creeps()                  // List all creeps
creeps("HAULER")          // List haulers
```

Check utility values in code by adding logging to `utilitySpawning.ts`.
