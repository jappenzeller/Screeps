# Spawning Logic

## Core Principle

Spawning is the most consequential decision in Screeps. A wrong spawn wastes:
- 200-2000+ energy
- 3 ticks of spawn time per body part
- An entire creep lifetime of potential work

The goal: Spawn the RIGHT creep at the RIGHT time with the RIGHT body.

---

## Body Part Costs

| Part | Cost | Effect |
|------|------|--------|
| MOVE | 50 | +1 fatigue reduction per tick |
| WORK | 100 | Harvest 2/tick, Build 5/tick, Repair 100/tick, Upgrade 1/tick |
| CARRY | 50 | +50 carry capacity |
| ATTACK | 80 | 30 damage/tick melee |
| RANGED_ATTACK | 150 | 10 damage/tick at range 3 |
| HEAL | 250 | 12 HP/tick adjacent, 4 HP/tick ranged |
| TOUGH | 10 | +100 HP |
| CLAIM | 600 | Reserve/claim controllers |

---

## Fatigue and Movement

**Fatigue Rule**: 
- Each non-MOVE part generates 2 fatigue on plains, 10 on swamp
- Each MOVE part removes 2 fatigue per tick
- Creep can only move when fatigue = 0

**1:1 Ratio** (plains movement every tick):
```
[WORK, CARRY, MOVE, MOVE] = 2 non-move parts, 2 MOVE parts
Fatigue generated: 4
Fatigue removed: 4
Result: Moves every tick on plains
```

**2:1 Ratio** (plains movement every tick on roads):
```
[WORK, WORK, CARRY, CARRY, MOVE, MOVE] = 4 non-move parts, 2 MOVE parts
Fatigue generated on road: 2 (roads halve fatigue)
Fatigue removed: 4
Result: Moves every tick on roads, every other tick on plains
```

---

## Body Templates

### Worker (General Purpose)

Can harvest, build, repair, upgrade, and carry.

**Minimum** (200 energy):
```
[WORK, CARRY, MOVE]
```

**Standard** (400 energy):
```
[WORK, WORK, CARRY, CARRY, MOVE, MOVE]
```

**Large** (800 energy):
```
[WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
```

**Scaling Pattern**: [WORK, CARRY, MOVE] repeated
- Cost per unit: 200 energy
- Max useful: ~16 units (limited by 50 body part max and diminishing returns)

### Hauler (Transport Only)

Carries energy, cannot work.

**Minimum** (300 energy):
```
[CARRY, CARRY, CARRY, CARRY, MOVE, MOVE]
```

**Standard** (600 energy):
```
[CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
```

**Scaling Pattern**: [CARRY, CARRY, MOVE] repeated
- Cost per unit: 150 energy
- Moves every tick on roads with 2:1 ratio

### Static Miner (Harvester)

Sits on container, maximizes WORK parts.

**Optimal** (550 energy):
```
[WORK, WORK, WORK, WORK, WORK, MOVE]
```

5 WORK = 10 energy/tick = saturates source
1 MOVE = can reach container

**With Container Repair** (750 energy):
```
[WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE]
```

CARRY allows repairing container without separate creep.

### Defender (Combat)

**Basic Melee** (260 energy):
```
[TOUGH, ATTACK, ATTACK, MOVE, MOVE]
```

**Ranged** (400 energy):
```
[RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE]
```

**Scaling**: Add ATTACK+MOVE or RANGED_ATTACK+MOVE pairs

### Upgrader (Specialized)

If using controller container/link, optimize for WORK over CARRY.

**Balanced** (550 energy):
```
[WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE]
```

**Work-Heavy** (800 energy):
```
[WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE]
```

---

## Spawn Priority by Phase

### BOOTSTRAP Phase

**Decision Tree**:
```
if (workers == 0):
    spawn [WORK, CARRY, MOVE]  // Absolute minimum
else if (workers < 3):
    spawn [WORK, CARRY, MOVE]  // Keep it simple
```

Don't wait for larger bodies. Get creeps on the field.

### DEVELOPING Phase

**Decision Tree**:
```
if (workers < 4):
    spawn scaled worker
else if (containers exist AND haulers < 2):
    spawn hauler
else if (workers < 6):
    spawn scaled worker
```

### STABLE Phase

**Decision Tree**:
```
if (workers < 4):
    spawn large worker (critical mass)
else if (haulers < 3):
    spawn large hauler
else if (workers < 8):
    spawn large worker
else if (remoteMiners needed):
    spawn remote miner
```

### EMERGENCY Phase

**Decision Tree**:
```
if (defenders < hostileCount):
    spawn defender
else if (workers < 2):
    spawn minimum worker  // Economy can't die
// No other spawning during emergency
```

---

## Body Scaling Algorithm

```
function buildScaledBody(template, maxEnergy):
    body = []
    cost = 0
    
    while true:
        // Try to add one unit of the template
        unitCost = sum(BODYPART_COST[part] for part in template)
        
        if cost + unitCost > maxEnergy:
            break
        
        if body.length + template.length > 50:
            break
        
        body.extend(template)
        cost += unitCost
    
    // Sort: TOUGH first, then WORK/ATTACK, then CARRY, then MOVE
    // This optimizes for damage absorption pattern
    return sortBodyParts(body)
```

### Why Body Part Order Matters

Damage is applied to body parts in order. If MOVE parts are destroyed first, creep becomes immobile. Optimal order:

1. **TOUGH** - Absorbs damage cheaply
2. **WORK/ATTACK/RANGED_ATTACK** - Primary function
3. **CARRY** - Lose capacity, not function
4. **HEAL** - Keep healing as long as possible
5. **MOVE** - Mobility preserved longest

---

## Spawn Timing

### Energy Threshold

Don't spawn immediately when you have minimum energy. Wait for optimal body.

```
function shouldSpawnNow(spawn, bodyTemplate, phase):
    bodyCost = calculateBodyCost(bodyTemplate)
    currentEnergy = spawn.room.energyAvailable
    maxEnergy = spawn.room.energyCapacityAvailable
    
    // BOOTSTRAP: Spawn immediately if we can
    if phase == BOOTSTRAP:
        return currentEnergy >= bodyCost
    
    // Otherwise, wait for 80%+ capacity OR critical need
    if currentEnergy >= maxEnergy * 0.8:
        return true
    
    if currentEnergy >= bodyCost AND (workers < 2 OR emergency):
        return true
    
    return false
```

### Spawn Queue

When multiple spawns needed, maintain priority queue:

```
spawnQueue = [
    { body: defender, priority: 0 },
    { body: worker, priority: 1 },
    { body: hauler, priority: 2 },
]

// Process highest priority first
spawnQueue.sort(by priority)
nextSpawn = spawnQueue[0]
```

---

## Renewing vs Replacing

### Renewal Math

`renewCreep()` cost: `ceil(creepCost / 2.5 / body.length)` energy per tick

**Break-even Analysis**:
- New creep: Full cost, 3 ticks/part spawn time
- Renewed creep: Partial cost, no spawn time

Renewal is better when:
- Creep body is expensive (>500 energy)
- Spawn is busy
- Creep is near spawn anyway

Replacement is better when:
- Creep body is cheap
- You want to upgrade the body
- Creep is far from spawn

### Renewal Trigger

```
function shouldRenew(creep, spawn):
    if spawn.spawning:
        return false
    
    if creep.ticksToLive > 300:
        return false
    
    if creep.pos.getRangeTo(spawn) > 1:
        return false
    
    bodyCost = calculateBodyCost(creep.body)
    
    // Only renew expensive creeps
    if bodyCost < 400:
        return false
    
    return true
```

---

## Spawn Names

Use descriptive names for debugging:

```
function generateCreepName(role, roomName):
    return `${role}_${roomName}_${Game.time % 10000}`
    
// Examples:
// WORKER_E46N37_4532
// HAULER_E46N37_4533
// DEFENDER_E46N37_4534
```

---

## Common Mistakes

### 1. Waiting Too Long for Big Bodies

**Wrong**: Wait for 800 energy when you have 200 energy and 1 creep
**Right**: Spawn small creep immediately, upgrade later

### 2. Spawning Haulers Before Containers

**Wrong**: Spawn haulers to move energy before containers exist
**Right**: Use workers for everything until containers built

### 3. Too Many of One Type

**Wrong**: 6 harvesters on 2 sources (most are idle)
**Right**: 2-3 harvesters, rest are haulers/upgraders

### 4. Ignoring Move Parts

**Wrong**: [WORK, WORK, WORK, WORK, WORK, CARRY] - moves once every 5 ticks
**Right**: [WORK, WORK, WORK, CARRY, MOVE, MOVE] - moves every tick

### 5. Spawning During Emergency

**Wrong**: Continue spawning workers while under attack
**Right**: Spawn only defenders until threat eliminated
