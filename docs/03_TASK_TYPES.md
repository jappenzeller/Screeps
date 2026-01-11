# Screeps Task System

## Overview

Tasks are discrete units of work assigned to creeps. Each task has:
- A **type** (what to do)
- A **target** (what to do it to)
- A **priority** (how urgent)
- An **assignment** (which creep is doing it)

---

## Task Types

### HARVEST

**Purpose**: Extract energy from a source.

**Target**: Source object

**Requirements**:
- Creep must have WORK parts
- Source must have energy remaining OR will regenerate soon

**Completion**: 
- When creep inventory is full
- When source is empty and won't regenerate for 50+ ticks

**Capacity Planning**:
- Each source regenerates 3000 energy every 300 ticks = 10 energy/tick max
- Each WORK part harvests 2 energy/tick
- Optimal: 5 WORK parts per source (saturates at 10 energy/tick)
- More than 5 WORK parts per source = wasted capacity

**Assignment Logic**:
- Count WORK parts already assigned to each source
- Assign new harvesters to under-saturated sources
- Never assign more than 6 WORK parts to a source (buffer for travel time)

---

### PICKUP

**Purpose**: Collect dropped resources from the ground.

**Target**: Resource object (dropped energy)

**Requirements**:
- Creep must have CARRY parts
- Creep must have free inventory space

**Completion**:
- When resource is fully picked up
- When creep inventory is full

**Priority Boost**:
- Dropped energy decays at 1/1000 per tick
- Large piles (>500) should be high priority
- Energy near sources = harvester overflow, medium priority
- Energy in random locations = creep death, high priority

---

### WITHDRAW

**Purpose**: Take energy from a structure.

**Target**: Container, Storage, Link, or Tombstone

**Requirements**:
- Creep must have CARRY parts
- Creep must have free inventory space
- Target must have energy

**Completion**:
- When creep inventory is full
- When target is empty

**Source Selection Priority**:
1. Tombstones (temporary, contain loot)
2. Containers near sources (harvester output)
3. Storage (main buffer)
4. Containers near controller (upgrader supply, only if oversupplied)

---

### SUPPLY_SPAWN

**Purpose**: Deliver energy to spawn or extensions.

**Target**: Spawn or Extension structure

**Requirements**:
- Creep must have CARRY parts
- Creep must have energy in inventory
- Target must have free capacity

**Completion**:
- When target is full
- When creep inventory is empty

**Priority**: HIGHEST for non-emergency tasks

**Why Critical**: Without spawn energy, no new creeps. Without new creeps, colony death spiral.

---

### SUPPLY_TOWER

**Purpose**: Deliver energy to towers.

**Target**: Tower structure

**Requirements**:
- Creep must have CARRY parts
- Creep must have energy
- Tower must have free capacity

**Completion**:
- When tower is full
- When creep inventory is empty

**Priority**: 
- EMERGENCY if hostiles present
- MEDIUM otherwise (towers auto-repair, auto-heal)

**Threshold**: Only create task if tower < 800 energy (leave buffer for combat)

---

### SUPPLY_STORAGE

**Purpose**: Deposit excess energy into storage.

**Target**: Storage structure

**Requirements**:
- Creep must have CARRY parts
- Creep must have energy
- Storage must have free capacity

**Completion**:
- When creep inventory is empty

**Priority**: LOWEST supply task

**When to Create**:
- Spawn/extensions are full
- Towers are adequately supplied (>500)
- No immediate build/upgrade needs

---

### UPGRADE

**Purpose**: Upgrade room controller to increase RCL.

**Target**: Room controller

**Requirements**:
- Creep must have WORK parts
- Creep must have CARRY parts (to hold energy)
- Creep must have energy in inventory

**Completion**:
- When creep inventory is empty
- Never "completes" in the sense of finishing - controller always accepts more

**Priority**:
- LOW in normal operations
- MEDIUM if controller downgrade timer < 10000
- HIGH if controller downgrade timer < 5000

**Capacity Planning**:
- Multiple upgraders can work simultaneously
- Each WORK part upgrades 1 energy/tick
- 15 WORK parts = 15 energy/tick = reasonable progression
- More than 15 WORK parts rarely needed except for push scenarios

---

### BUILD

**Purpose**: Construct a structure from a construction site.

**Target**: Construction site

**Requirements**:
- Creep must have WORK parts
- Creep must have energy
- Construction site must exist

**Completion**:
- When construction site becomes a structure
- When creep inventory is empty (will need to refill)

**Priority by Structure Type**:
1. SPAWN (critical infrastructure)
2. EXTENSION (spawn capacity)
3. TOWER (defense)
4. CONTAINER (energy flow)
5. STORAGE (buffer)
6. ROAD (efficiency)
7. WALL/RAMPART (defense, but low priority initially)

**Capacity Planning**:
- Each WORK part builds 5 progress/tick
- Structures have varying build costs (road=300, extension=3000, etc.)
- Limit concurrent builders to 2-3 to avoid congestion

---

### REPAIR

**Purpose**: Restore hit points to a damaged structure.

**Target**: Damaged structure

**Requirements**:
- Creep must have WORK parts
- Creep must have energy
- Structure must be damaged (hits < hitsMax)

**Completion**:
- When structure is at acceptable health (varies by type)
- When creep inventory is empty

**Priority by Damage**:
- Critical (<25% health): HIGH
- Damaged (<50% health): MEDIUM
- Worn (<75% health): LOW

**Special Cases**:
- Walls/Ramparts: Don't repair to full (millions of HP). Set target threshold (10K, 100K, 1M based on RCL)
- Roads: Repair before they decay completely (lose construction cost)
- Containers: Repair regularly (they decay even in owned rooms)

---

### DEFEND

**Purpose**: Attack hostile creeps.

**Target**: Hostile creep

**Requirements**:
- Creep must have ATTACK or RANGED_ATTACK parts

**Completion**:
- When target is dead
- When target flees room

**Priority**: HIGHEST in emergency phase

**Target Selection**:
1. Healers (force multiplier for attackers)
2. Ranged attackers (damage from distance)
3. Melee attackers (direct threat)
4. Other hostiles (scouts, etc.)

Within each category, prefer:
- Lower HP targets (faster kills)
- Closer targets (less travel time)

---

### FLEE

**Purpose**: Escape from danger.

**Target**: Safe position (usually spawn area)

**Requirements**: None (any creep can flee)

**Completion**:
- When creep reaches safe area
- When threat is eliminated

**Trigger Conditions**:
- Creep HP < 50%
- Hostile with ATTACK in range 2
- Hostile with RANGED_ATTACK in range 4

---

### IDLE

**Purpose**: Wait productively when no tasks available.

**Target**: None

**Requirements**: None

**Behavior**:
- Move toward spawn (stay out of traffic)
- Don't block sources, controller, or chokepoints
- Say "💤" to indicate waiting

**Duration**: Until coordinator assigns a real task

---

## Task Lifecycle

```
┌──────────────┐
│   CREATED    │  Task generated by coordinator
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  UNASSIGNED  │  In queue, waiting for capable creep
└──────┬───────┘
       │ findCapableCreep()
       ▼
┌──────────────┐
│   ASSIGNED   │  Creep working on task
└──────┬───────┘
       │
       ├─────────────────┬─────────────────┐
       ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  COMPLETED   │  │  ABANDONED   │  │   EXPIRED    │
│ (success)    │  │ (target died)│  │ (timeout)    │
└──────────────┘  └──────────────┘  └──────────────┘
```

---

## Task Generation Rules

### Don't Over-Generate

Bad: Create 10 HARVEST tasks for 2 sources
Good: Create 2 HARVEST tasks, each assigned when previous completes

### Don't Under-Generate

Bad: Create 1 UPGRADE task, only 1 creep upgrades
Good: Create N UPGRADE tasks based on available workforce and energy

### Match Generation to Capacity

```
Available workers: 6
Source capacity: 2 sources × 1 task = 2 HARVEST tasks
Build capacity: 3 sites × 1 builder = 3 BUILD tasks  
Remaining: 1 worker → 1 UPGRADE task
```

### Expire Stale Tasks

Tasks should have TTL:
- HARVEST: 100 ticks (source might deplete)
- SUPPLY_*: 50 ticks (target might fill)
- BUILD: 200 ticks (site won't disappear)
- DEFEND: 20 ticks (combat is dynamic)
