# Economy System

## Energy Flow

```
SOURCES (3000 energy / 300 ticks = 10/tick max)
    │
    ▼ HARVEST (static miners)
SOURCE CONTAINERS
    │
    ▼ HAUL (dedicated haulers)
SPAWN/EXTENSIONS ──────▶ SPAWNING
    │
    ▼ OVERFLOW
STORAGE ─────────────────▶ BUFFER
    │
    ├──▶ TOWERS (defense, repair)
    ├──▶ UPGRADERS (controller)
    └──▶ BUILDERS (construction)
```

## Static Mining

At RCL 2+, harvesters become **static miners**:

1. Container placed adjacent to source
2. Harvester moves to container, stays put
3. Harvests continuously into container
4. Haulers collect from container

**Benefits:**
- Harvester never walks (max efficiency)
- 5 WORK parts saturate source (10 energy/tick)
- Predictable energy collection points

**Harvester body at 550 energy:**
```typescript
[WORK, WORK, WORK, WORK, WORK, MOVE]  // 5W = saturates source
```

## Hauler Coordination

### Container Assignment

Each hauler has a primary container to prevent oscillation:

```typescript
Memory.creeps[name].targetContainer = containerId;
```

Assignment happens at spawn time based on which container has fewest haulers.

### Hauler Behavior

```
1. If empty: Go to assigned container (or find best source)
2. If full: Deliver to spawn > extensions > towers > storage
3. Repeat
```

**Key considerations:**
- Fill completely before delivering (not 50%)
- Prioritize spawn/extensions (enables more spawning)
- Fall back to storage if spawn full

### Hauler Counts

Typically 1-2 haulers per source. More if:
- Long distance from source to spawn
- Multiple delivery targets (storage, towers)
- Large bodies with high carry capacity

## Storage Management

Storage unlocks at RCL 4 (500,000 capacity).

**Storage serves as:**
1. Buffer for excess energy
2. Source for upgraders/builders
3. Emergency reserve

**Healthy storage levels:**
- < 5,000: Economy struggling (DEVELOPING phase)
- 5,000 - 50,000: Normal operations
- 50,000+: Increase upgrader activity

## Energy Priorities

```
1. SPAWN/EXTENSIONS (enables spawning)
2. TOWERS (defense)
3. UPGRADERS (RCL progress)
4. BUILDERS (infrastructure)
5. STORAGE (buffer)
```

Haulers follow this priority automatically via delivery target selection.

## Economy Metrics (EconomyTracker)

Tracked for utility spawning decisions:

```typescript
{
  harvestIncome: number;      // Energy/tick from harvesters
  storageLevel: number;       // Current storage amount
  consumptionRate: number;    // Energy used per tick
  trendDirection: string;     // 'increasing' | 'stable' | 'decreasing'
}
```

## Income Calculation

```
Max income per source: 10 energy/tick
  (Each WORK part harvests 2/tick, 5 WORK = 10/tick)

2 sources = 20 energy/tick max
  = 1,200 energy/minute
  = 72,000 energy/hour
```

Actual income depends on:
- Harvester WORK parts assigned
- Harvester uptime (renewal, death)
- Travel time if not static

## Economic Stability Checks

Before spawning remote roles, check home economy:

```typescript
// Economy is stable if:
harvesters >= 2 AND haulers >= 1 AND energyIncome > 0
```

Remote mining is disabled until home economy is self-sufficient.

## Emergency Recovery

If all harvesters die:

1. Emergency phase triggers
2. Utility spawning boots only ECONOMY_ROLES
3. Spawn smallest affordable harvester
4. Rebuild economy from scratch

Recovery time depends on:
- Energy in storage
- Spawn capacity (extensions)
- Distance to sources

## Energy-Related Console Commands

```javascript
energy()                  // Energy per room
economy()                 // Detailed metrics
storage()                 // Storage levels
haulers()                 // Hauler status
```

## Common Issues

### Hauler Deadlock
**Symptom:** Harvesters mining but energy not reaching spawn
**Cause:** Zero haulers (all died, not spawned)
**Fix:** Utility spawning gives haulers +25 bonus when harvesters exist but no haulers

### Energy Decay
**Symptom:** Dropped energy on ground
**Cause:** Container full, haulers not keeping up
**Fix:** Spawn more haulers OR larger hauler bodies

### Spawn Starvation
**Symptom:** Spawn not getting filled despite energy in containers
**Cause:** Haulers delivering to wrong targets
**Fix:** Check hauler delivery priority (spawn > extensions > towers > storage)
