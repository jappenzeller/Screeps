# Colony Phases

## Why Phases Matter

A colony's needs change dramatically as it develops:

- **Tick 1**: You have 1 creep. Priority = don't die.
- **Tick 1000**: You have 6 creeps. Priority = build infrastructure.
- **Tick 10000**: You have 20 creeps. Priority = optimize efficiency.
- **Under attack**: Drop everything, defend.

Static role-based logic can't adapt to these changes. Phase-based logic adjusts priorities dynamically.

---

## Phase Definitions

### BOOTSTRAP

**Condition**: Total workers < 3

**Characteristics**:
- Colony is extremely vulnerable
- Every creep is critical
- No infrastructure yet
- Energy income is minimal

**Priorities**:
1. Keep existing creeps alive
2. Spawn more workers
3. Get energy flowing
4. Nothing else matters

**Task Generation**:
```
HARVEST:       Priority 0  (must have energy income)
SUPPLY_SPAWN:  Priority 1  (must spawn more creeps)
UPGRADE:       Priority 2  (only if spawn is full)
BUILD:         DO NOT GENERATE (waste of resources)
REPAIR:        DO NOT GENERATE
```

**Spawning**:
- Spawn smallest viable worker: [WORK, CARRY, MOVE]
- Cost: 200 energy
- Don't wait for bigger bodies

**Exit Condition**: Total workers >= 3

---

### DEVELOPING

**Condition**: 
- Workers >= 3 
- AND (RCL < 4 OR storage energy < 5000)

**Characteristics**:
- Colony is growing but not stable
- Building key infrastructure
- Energy flow being established
- Need to reach RCL milestones

**Priorities**:
1. Maintain spawn energy
2. Keep harvesting
3. Build containers (enable hauler economy)
4. Build extensions (increase spawn capacity)
5. Upgrade to next RCL

**Task Generation**:
```
SUPPLY_SPAWN:  Priority 0  (spawning is still critical)
HARVEST:       Priority 1  (energy income)
SUPPLY_TOWER:  Priority 2  (if towers exist)
BUILD:         Priority 3  (infrastructure)
REPAIR:        Priority 4  (maintenance)
UPGRADE:       Priority 5  (progress)
```

**Spawning**:
- Scale worker bodies based on energy capacity
- Spawn haulers once containers exist
- Target: 4-6 workers, 2 haulers

**RCL Milestones in This Phase**:
- RCL 2: Containers, 5 extensions (550 capacity)
- RCL 3: Tower, 10 extensions (800 capacity)
- RCL 4: Storage, 20 extensions (1300 capacity)

**Exit Condition**: RCL >= 4 AND storage energy >= 5000

---

### STABLE

**Condition**:
- RCL >= 4
- Storage energy >= 5000
- No active threats

**Characteristics**:
- Established economy
- Reliable energy flow
- Infrastructure in place
- Can pursue long-term goals

**Priorities**:
1. Maintain systems
2. Continue building
3. Push RCL upgrades
4. Expand to remote rooms (RCL 4+)
5. Optimize efficiency

**Task Generation**:
```
SUPPLY_SPAWN:    Priority 0
HARVEST:         Priority 1
SUPPLY_TOWER:    Priority 2
BUILD:           Priority 3
REPAIR:          Priority 4
UPGRADE:         Priority 5
SUPPLY_STORAGE:  Priority 6  (buffer overflow)
```

**Spawning**:
- Full-size workers (maximize body parts)
- Specialized haulers
- Consider scouts for expansion
- Consider remote miners

**Exit Conditions**:
- → EMERGENCY if hostiles detected with significant DPS
- → DEVELOPING if storage drops below 1000 (economy failing)

---

### EMERGENCY

**Condition**:
- Hostile creeps present with ATTACK or RANGED_ATTACK parts
- OR critical structure under attack
- OR controller downgrade imminent (< 2000 ticks)

**Characteristics**:
- Colony survival threatened
- Normal operations suspended
- All resources directed to threat response

**Priorities**:
1. Neutralize threat
2. Keep towers supplied
3. Spawn defenders
4. Maintain minimum economy

**Task Generation**:
```
DEFEND:        Priority 0  (eliminate threat)
SUPPLY_TOWER:  Priority 1  (towers are force multipliers)
SUPPLY_SPAWN:  Priority 2  (need to spawn defenders)
HARVEST:       Priority 3  (minimum economy)
FLEE:          Auto-assigned to non-combat creeps near hostiles
```

**Spawning**:
- Defenders are top priority
- Spawn defenders up to hostile count
- Maintain 2 minimum workers for economy
- Pause all other spawning

**Exit Condition**: No hostiles with attack parts for 50+ ticks

---

## Phase Detection Logic

```
function determinePhase(room):
    needs = assessNeeds(room)
    
    // Emergency check first
    if needs.hostileDPS > 0:
        return EMERGENCY
    
    if room.controller.ticksToDowngrade < 2000:
        return EMERGENCY
    
    // Bootstrap check
    if needs.totalWorkers < 3:
        return BOOTSTRAP
    
    // Developing vs Stable
    if room.controller.level < 4:
        return DEVELOPING
    
    if not room.storage:
        return DEVELOPING
    
    if room.storage.store[RESOURCE_ENERGY] < 5000:
        return DEVELOPING
    
    return STABLE
```

---

## Needs Assessment

Run once per tick to evaluate colony state:

```
interface ColonyNeeds {
    // Economy
    energyIncome: number;         // Current harvest rate (energy/tick)
    maxEnergyIncome: number;      // Theoretical max (sources × 10)
    harvestEfficiency: number;    // energyIncome / maxEnergyIncome
    
    energyInStorage: number;      // Storage + containers
    spawnEnergy: number;          // Current spawn + extensions
    spawnCapacity: number;        // Max spawn + extensions
    
    // Work demands
    constructionPending: number;  // Total construction site progress remaining
    repairNeeded: number;         // Total HP deficit on damaged structures
    upgradeNeeded: boolean;       // Controller needs attention
    
    // Threats
    hostileCount: number;         // Number of hostile creeps
    hostileDPS: number;           // Estimated damage per tick from hostiles
    
    // Workforce
    totalCreeps: number;
    totalWorkers: number;         // Creeps with WORK parts
    totalHaulers: number;         // Creeps with only CARRY (no WORK)
    idleCreeps: number;           // Creeps without tasks
}
```

### Calculating Energy Income

```
function calculateEnergyIncome(room):
    income = 0
    
    for source in room.find(FIND_SOURCES):
        assignedWorkParts = 0
        
        for creep in getCreepsAssignedToSource(source):
            assignedWorkParts += creep.getActiveBodyparts(WORK)
        
        // Each WORK harvests 2 energy/tick, max 10/tick per source
        sourceIncome = min(assignedWorkParts * 2, 10)
        income += sourceIncome
    
    return income
```

### Calculating Hostile DPS

```
function calculateHostileDPS(room):
    dps = 0
    
    for hostile in room.find(FIND_HOSTILE_CREEPS):
        attackParts = hostile.getActiveBodyparts(ATTACK)
        rangedParts = hostile.getActiveBodyparts(RANGED_ATTACK)
        
        dps += attackParts * 30      // ATTACK does 30 damage
        dps += rangedParts * 10      // RANGED_ATTACK does 10 damage (can be 4× with mass attack)
    
    return dps
```

---

## Phase Transitions

### BOOTSTRAP → DEVELOPING

**Trigger**: 3+ workers exist

**Actions on Transition**:
- Begin generating BUILD tasks for containers
- Scale up worker bodies
- Enable road planning

### DEVELOPING → STABLE

**Trigger**: RCL 4+ AND storage with 5000+ energy

**Actions on Transition**:
- Enable remote mining logic
- Increase upgrade task generation
- Consider link placement

### STABLE → EMERGENCY

**Trigger**: Hostile DPS > 0 OR downgrade imminent

**Actions on Transition**:
- Cancel all BUILD tasks
- Cancel all SUPPLY_STORAGE tasks
- Reduce UPGRADE tasks to minimum
- Generate DEFEND tasks
- Generate FLEE tasks for vulnerable creeps

### EMERGENCY → STABLE

**Trigger**: No hostile DPS for 50 ticks

**Actions on Transition**:
- Resume normal task generation
- Assess damage and generate REPAIR tasks
- Resume spawning normal creeps

### STABLE → DEVELOPING (Regression)

**Trigger**: Storage falls below 1000 energy

**Actions on Transition**:
- Economy is failing, return to growth focus
- Reduce upgrade tasks
- Increase harvest emphasis
- Investigate why economy collapsed

---

## Phase-Specific Spawn Tables

### BOOTSTRAP Spawn Priority

| Priority | Role | Body | Cost | Max Count |
|----------|------|------|------|-----------|
| 1 | Worker | [WORK, CARRY, MOVE] | 200 | 4 |

### DEVELOPING Spawn Priority

| Priority | Role | Body | Cost | Max Count |
|----------|------|------|------|-----------|
| 1 | Worker | Scale with capacity | 200-800 | 6 |
| 2 | Hauler | [CARRY×2, MOVE×2] | 300 | 2 |

### STABLE Spawn Priority

| Priority | Role | Body | Cost | Max Count |
|----------|------|------|------|-----------|
| 1 | Worker | Max size | 800+ | 8 |
| 2 | Hauler | Max size | 600+ | 4 |
| 3 | Upgrader | Specialized | varies | 3 |

### EMERGENCY Spawn Priority

| Priority | Role | Body | Cost | Max Count |
|----------|------|------|------|-----------|
| 1 | Defender | Combat body | varies | = hostile count |
| 2 | Worker | Minimum | 200 | 2 |
