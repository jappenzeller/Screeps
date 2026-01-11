# Screeps Energy Flow Model

## Why This Matters

Energy is the fundamental resource in Screeps. How energy flows through your colony determines whether creeps work efficiently or starve while others waste resources.

The current bug (harvesters upgrading while upgraders wait) is an **energy flow problem**:
- Energy enters the system (harvesters mine it)
- Energy exits the system (harvesters upgrade with it)
- Energy never reaches the buffer (no stockpile for other creeps)

---

## The Correct Energy Flow

```
                    ┌─────────────────────────────────────────────────┐
                    │                   SOURCES                        │
                    │            (regenerate 3000/300 ticks)           │
                    └─────────────────────────────────────────────────┘
                                          │
                                          │ HARVEST
                                          ▼
                    ┌─────────────────────────────────────────────────┐
                    │               SOURCE CONTAINERS                  │
                    │    (buffer near sources, filled by harvesters)   │
                    └─────────────────────────────────────────────────┘
                                          │
                                          │ HAUL (haulers move energy)
                                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                              CENTRAL BUFFER                                 │
│                                                                             │
│    ┌──────────────┐     ┌──────────────┐     ┌──────────────┐            │
│    │    SPAWN     │     │  EXTENSIONS  │     │   STORAGE    │            │
│    │  (critical)  │     │  (critical)  │     │  (overflow)  │            │
│    └──────────────┘     └──────────────┘     └──────────────┘            │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
                                          │
                         ┌────────────────┼────────────────┐
                         │                │                │
                         ▼                ▼                ▼
                    ┌─────────┐     ┌─────────┐     ┌─────────┐
                    │ TOWERS  │     │UPGRADERS│     │BUILDERS │
                    │(defense)│     │  (RCL)  │     │ (infra) │
                    └─────────┘     └─────────┘     └─────────┘
```

---

## Energy Producers vs Consumers

### Producers (Put Energy INTO System)

| Role | Action | Destination |
|------|--------|-------------|
| Harvester | Mines source | Container at source OR drop on ground |
| Hauler | Moves energy | Never produces, only transports |

**Critical Rule**: Harvesters should NEVER consume energy for work tasks. Their job is extraction only.

### Consumers (Take Energy OUT of System)

| Role | Action | Source |
|------|--------|--------|
| Upgrader | Upgrades controller | Container near controller, storage, or hauler delivery |
| Builder | Builds structures | Storage, containers, or hauler delivery |
| Tower | Attacks/heals/repairs | Hauler delivery |
| Spawn | Creates creeps | Hauler delivery |

### Transporters (Move Energy WITHIN System)

| Role | Action | From → To |
|------|--------|-----------|
| Hauler | Transports | Source containers → Spawn/Extensions/Storage |
| Hauler | Transports | Storage → Towers/Controller container |

---

## The Buffer Problem

### What Happens Without Buffers

```
Tick 1: Harvester mines 10 energy
Tick 2: Harvester walks to spawn
Tick 3: Harvester walks to spawn  
Tick 4: Harvester walks to spawn
Tick 5: Harvester deposits 10 energy
Tick 6: Harvester walks to source
Tick 7: Harvester walks to source
Tick 8: Harvester walks to source
Tick 9: Harvester mines 10 energy
...

Effective rate: 10 energy / 8 ticks = 1.25 energy/tick
Maximum possible: 10 energy/tick (5 WORK parts)
Efficiency: 12.5%
```

### What Happens With Buffers

```
Harvester A: Mines continuously, fills container (10 energy/tick)
Harvester B: Mines continuously, fills container (10 energy/tick)
Hauler:      Empties container, fills spawn (carries 100-300 energy per trip)

Effective rate: ~18-19 energy/tick (some loss to hauler travel)
Efficiency: 90%+
```

### The Container Requirement

Containers unlock at RCL 2. Before RCL 2:
- Harvesters must harvest AND deliver (mobile harvester pattern)
- This is inefficient but necessary

At RCL 2+:
- Place containers adjacent to sources
- Harvesters become "static miners" - sit on container, harvest, energy auto-deposits
- Haulers move energy from source containers to spawn/extensions

---

## Priority Rules

### Spawn/Extensions Are ALWAYS Priority 1

If spawn/extensions aren't full, ALL available energy goes there first. Without spawn energy, you can't make new creeps. Without new creeps, colony dies.

### Storage Is a Buffer, Not a Goal

Don't fill storage just to fill it. Storage absorbs overflow when:
- Spawn/extensions are full
- Towers are full
- No construction sites
- Upgraders are at max capacity

### Upgrading Is the Lowest Priority Work

Controller downgrade timer is 20,000 ticks. That's a LOT of time. Upgrading should only happen when:
- Spawn is full
- Economy is stable
- No urgent construction

Exception: If downgrade timer < 5000, bump upgrade priority.

---

## Energy Flow by Colony Phase

### BOOTSTRAP (0-2 workers)

```
Source → Harvester → Spawn (direct delivery)
                  ↘ Drop on ground (if spawn full, waiting for haulers)
```

No containers yet. Harvesters do both jobs. Priority is getting more creeps.

### EARLY (RCL 2-3, containers exist)

```
Source → Container → Hauler → Spawn/Extensions
                           ↘ Dropped for Upgraders/Builders to pickup
```

Haulers now exist. Energy flows through containers. Upgraders/builders can harvest as fallback.

### DEVELOPING (RCL 4-5, storage exists)

```
Source → Container → Hauler → Spawn/Extensions
                           ↘ Storage (buffer)
                           ↘ Towers
                           
Storage → Hauler → Controller Container → Upgraders
                ↘ Construction sites (builder pickup)
```

Two-stage flow: Source→Storage, Storage→Consumers.

### STABLE (RCL 6+, links exist)

```
Source → Container → Link → Storage Link → Storage
                                        ↘ Central distribution

Storage → Hauler → Spawn/Extensions/Towers
        ↘ Link → Controller Link → Upgraders
```

Links enable instant energy transfer. Minimal hauler movement.

---

## Anti-Patterns to Avoid

### 1. Harvesters Upgrading

**Wrong**: Harvester delivers to spawn, spawn full, harvester upgrades.

**Why it's wrong**: Energy disappears from system. Other creeps starve.

**Correct**: Harvester drops energy near source. Hauler collects it.

### 2. Upgraders Harvesting

**Wrong**: Upgrader needs energy, no storage nearby, upgrader walks to source and harvests.

**Why it's wrong**: Upgrader blocks source, wastes time walking, reduces harvest rate.

**Correct**: Upgrader waits at controller. Hauler delivers energy. Or upgrader withdraws from controller container.

### 3. Builders Waiting at Spawn

**Wrong**: Builder needs energy, waits at spawn for hauler to deliver.

**Why it's wrong**: Builder is idle. No mechanism ensures hauler prioritizes builder.

**Correct**: Builder withdraws from nearest container/storage. If none available, builder should be reassigned to upgrade (productive waiting).

### 4. Everyone Harvesting

**Wrong**: Colony has 6 creeps, all harvesting from 2 sources.

**Why it's wrong**: Sources only support ~5 WORK parts each. Extra creeps block each other.

**Correct**: Calculate source saturation. 2 sources × 5 WORK = 10 WORK parts max. Excess creeps should haul/build/upgrade.

---

## Metrics to Track

```typescript
interface EnergyMetrics {
  // Income
  harvestRate: number;        // Energy mined per tick
  maxHarvestRate: number;     // Theoretical max (sources × 10)
  harvestEfficiency: number;  // harvestRate / maxHarvestRate
  
  // Storage
  spawnEnergy: number;        // Current spawn + extensions
  spawnCapacity: number;      // Max spawn + extensions
  storageEnergy: number;      // Current storage
  containerEnergy: number;    // Sum of all containers
  
  // Flow
  energySpentOnSpawn: number; // Energy used for spawning
  energySpentOnUpgrade: number;
  energySpentOnBuild: number;
  energyDropped: number;      // Wasted (decayed)
}
```

If `energyDropped > 0`, you need more haulers.
If `harvestEfficiency < 80%`, you have harvester/pathing problems.
If `spawnEnergy < spawnCapacity` frequently, energy flow is broken.
