# Strategic Layer Design

## Problem Statement

The current system operates purely reactively at tick-level:

```
CURRENT (Broken):
  Tick N:
    Harvester A: "spawn full → upgrade controller"  ← WRONG
    Harvester B: "spawn full → upgrade controller"  ← WRONG
    Upgrader A: "no energy → wait"
    Upgrader B: "no energy → wait"
  
  Result: 4 creeps "working" but 0 strategic progress
          Energy burned by wrong creeps, specialists starve
```

**What's missing:** No layer that asks "what do we need to accomplish?" before asking "what should this creep do?"

---

## Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     STRATEGIC LAYER                             │
│  "What are our goals and how do we measure progress?"           │
│                                                                 │
│  • RCL 3 needs 45,000 upgrade work. ETA: 2.5 hours             │
│  • Energy income: 20/tick. Allocation: 40% upgrade, 30% spawn  │
│  • Target population: 10 creeps. Current: 8. Gap: 2            │
│  • Priority: Extensions > Containers > Roads                    │
│                                                                 │
│  Runs: Every 100 ticks (recalculates goals + allocations)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      TACTICAL LAYER                             │
│  "How do we allocate resources to meet strategic goals?"        │
│                                                                 │
│  • Assign 2 harvesters to sources (saturate income)            │
│  • Assign 3 haulers to move energy (prevent drops)             │
│  • Assign 2 upgraders (meets 40% allocation)                   │
│  • Assign 1 builder to extensions (top construction priority)  │
│  • Spawn queue: [HAULER, UPGRADER] (fill gaps)                 │
│                                                                 │
│  Runs: Every tick (task generation + assignment)                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     EXECUTION LAYER                             │
│  "What action does this creep take right now?"                  │
│                                                                 │
│  • Harvester_1: harvest(source_A)                              │
│  • Hauler_3: withdraw(container_A) → transfer(spawn)           │
│  • Upgrader_1: withdraw(container_B) → upgrade(controller)     │
│  • Builder_1: withdraw(spawn) → build(extension_site)          │
│                                                                 │
│  Runs: Every tick per creep (execute assigned task)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Strategic Layer Components

### 1. Goal Tracker

Tracks progress toward measurable objectives.

```typescript
interface StrategicGoal {
  id: string;
  type: GoalType;
  target: number;
  current: number;
  priority: number;
  deadline?: number;  // Game.time when this should be done
  
  // Calculated fields
  remaining: number;
  progressRate: number;  // units per tick (rolling average)
  eta: number;           // ticks until completion at current rate
}

enum GoalType {
  RCL_UPGRADE = 'RCL_UPGRADE',
  BUILD_STRUCTURE = 'BUILD_STRUCTURE',
  POPULATION_TARGET = 'POPULATION_TARGET',
  ENERGY_RESERVE = 'ENERGY_RESERVE',
  DEFENSE_LEVEL = 'DEFENSE_LEVEL',
}

// Example goals at RCL 2:
const goals: StrategicGoal[] = [
  {
    id: 'rcl3',
    type: GoalType.RCL_UPGRADE,
    target: 45000,      // controller.progressTotal
    current: 5850,      // controller.progress (13%)
    priority: 2,
    remaining: 39150,
    progressRate: 2.5,  // upgrade energy per tick (rolling avg)
    eta: 15660,         // ~4.3 hours at current rate
  },
  {
    id: 'extensions_rcl2',
    type: GoalType.BUILD_STRUCTURE,
    target: 5,
    current: 0,
    priority: 1,        // Higher priority than RCL
    remaining: 5,
    progressRate: 0,    // Not building any!
    eta: Infinity,
  },
  {
    id: 'population',
    type: GoalType.POPULATION_TARGET,
    target: 10,
    current: 8,
    priority: 1,
    remaining: 2,
    progressRate: 0.001, // spawns per tick
    eta: 2000,
  },
];
```

### 2. Energy Budget

Determines how to allocate energy income across competing needs.

```typescript
interface EnergyBudget {
  // Income
  incomePerTick: number;        // Actual current harvest rate
  maxIncomePerTick: number;     // Theoretical max (sources × 10)
  harvestEfficiency: number;    // income / maxIncome
  
  // Allocations (percentages, must sum to 100)
  allocations: {
    spawning: number;    // Maintain/grow population
    upgrading: number;   // RCL progress
    building: number;    // Construction
    repair: number;      // Maintenance
    reserve: number;     // Buffer in storage/containers
  };
  
  // Translated to energy/tick
  budgetPerTick: {
    spawning: number;
    upgrading: number;
    building: number;
    repair: number;
    reserve: number;
  };
}

// Budget calculation based on phase
function calculateBudget(phase: ColonyPhase, income: number): EnergyBudget {
  const allocations = PHASE_ALLOCATIONS[phase];
  
  return {
    incomePerTick: income,
    maxIncomePerTick: sources.length * 10,
    harvestEfficiency: income / (sources.length * 10),
    allocations,
    budgetPerTick: {
      spawning: income * allocations.spawning / 100,
      upgrading: income * allocations.upgrading / 100,
      building: income * allocations.building / 100,
      repair: income * allocations.repair / 100,
      reserve: income * allocations.reserve / 100,
    },
  };
}

const PHASE_ALLOCATIONS: Record<ColonyPhase, EnergyBudget['allocations']> = {
  BOOTSTRAP: {
    spawning: 80,   // Almost everything to growing population
    upgrading: 10,  // Minimum to prevent downgrade
    building: 10,   // Only critical structures
    repair: 0,
    reserve: 0,
  },
  DEVELOPING: {
    spawning: 40,   // Still growing
    upgrading: 25,  // Push RCL
    building: 25,   // Extensions, containers
    repair: 5,
    reserve: 5,
  },
  STABLE: {
    spawning: 20,   // Maintenance only
    upgrading: 40,  // Primary focus
    building: 15,
    repair: 10,
    reserve: 15,
  },
  EMERGENCY: {
    spawning: 60,   // Replace losses
    upgrading: 5,   // Minimum
    building: 0,
    repair: 30,     // Fix damage
    reserve: 5,
  },
};
```

### 3. Workforce Planner

Translates energy budget into creep requirements.

```typescript
interface WorkforceRequirements {
  // Required WORK parts by activity
  harvestWorkParts: number;     // To saturate sources
  upgradeWorkParts: number;     // To spend upgrade budget
  buildWorkParts: number;       // To spend build budget
  
  // Required CARRY throughput
  carryThroughput: number;      // Energy movement per tick needed
  
  // Translated to creep counts (based on current body templates)
  targetCreeps: {
    HARVESTER: number;
    HAULER: number;
    UPGRADER: number;
    BUILDER: number;
  };
  
  // Current vs target
  gaps: {
    HARVESTER: number;  // negative = over, positive = under
    HAULER: number;
    UPGRADER: number;
    BUILDER: number;
  };
}

function calculateWorkforce(budget: EnergyBudget, room: Room): WorkforceRequirements {
  const sources = room.find(FIND_SOURCES);
  
  // Harvest: need 5 WORK parts per source to saturate (2 energy/tick/WORK)
  const harvestWorkParts = sources.length * 5;
  
  // Upgrade: each WORK part upgrades 1 energy/tick
  // If budget is 5 energy/tick for upgrading, need 5 WORK parts
  const upgradeWorkParts = Math.ceil(budget.budgetPerTick.upgrading);
  
  // Build: each WORK part builds 5 energy/tick worth of progress
  const buildWorkParts = Math.ceil(budget.budgetPerTick.building / 5);
  
  // Hauling: need to move (income) energy per tick
  // Each CARRY part moves 50 energy, round trip time ~20 ticks avg
  // Throughput per CARRY = 50 / 20 = 2.5 energy/tick
  const carryThroughput = budget.incomePerTick;
  const carryPartsNeeded = Math.ceil(carryThroughput / 2.5);
  
  // Translate to creeps based on body sizes
  const avgWorkPerHarvester = 2;  // Depends on energy capacity
  const avgWorkPerUpgrader = 2;
  const avgWorkPerBuilder = 1;
  const avgCarryPerHauler = 4;
  
  const targetCreeps = {
    HARVESTER: Math.ceil(harvestWorkParts / avgWorkPerHarvester),
    HAULER: Math.ceil(carryPartsNeeded / avgCarryPerHauler),
    UPGRADER: Math.ceil(upgradeWorkParts / avgWorkPerUpgrader),
    BUILDER: Math.ceil(buildWorkParts / avgWorkPerBuilder),
  };
  
  // Calculate gaps
  const current = countCreepsByRole(room);
  const gaps = {
    HARVESTER: targetCreeps.HARVESTER - current.HARVESTER,
    HAULER: targetCreeps.HAULER - current.HAULER,
    UPGRADER: targetCreeps.UPGRADER - current.UPGRADER,
    BUILDER: targetCreeps.BUILDER - current.BUILDER,
  };
  
  return {
    harvestWorkParts,
    upgradeWorkParts,
    buildWorkParts,
    carryThroughput,
    targetCreeps,
    gaps,
  };
}
```

### 4. Construction Priority Queue

Strategic ordering of what to build.

```typescript
interface ConstructionGoal {
  structureType: StructureConstant;
  count: number;           // How many to build
  built: number;           // Currently built
  queued: number;          // Construction sites placed
  priority: number;        // Lower = more important
  blocksProgress: boolean; // Does this block other goals?
}

function getConstructionPriorities(room: Room): ConstructionGoal[] {
  const rcl = room.controller.level;
  const priorities: ConstructionGoal[] = [];
  
  // Containers at sources (blocks economy)
  const sources = room.find(FIND_SOURCES);
  const containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER
  });
  priorities.push({
    structureType: STRUCTURE_CONTAINER,
    count: sources.length,
    built: containers.length,
    queued: countSites(room, STRUCTURE_CONTAINER),
    priority: 1,
    blocksProgress: true,  // Blocks hauler economy
  });
  
  // Extensions (blocks spawning capacity)
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl];
  const extensions = countStructures(room, STRUCTURE_EXTENSION);
  priorities.push({
    structureType: STRUCTURE_EXTENSION,
    count: maxExtensions,
    built: extensions,
    queued: countSites(room, STRUCTURE_EXTENSION),
    priority: 2,
    blocksProgress: true,  // Blocks bigger creeps
  });
  
  // Tower at RCL 3+ (blocks defense)
  if (rcl >= 3) {
    const maxTowers = CONTROLLER_STRUCTURES[STRUCTURE_TOWER][rcl];
    priorities.push({
      structureType: STRUCTURE_TOWER,
      count: maxTowers,
      built: countStructures(room, STRUCTURE_TOWER),
      queued: countSites(room, STRUCTURE_TOWER),
      priority: 3,
      blocksProgress: true,
    });
  }
  
  // Storage at RCL 4+
  if (rcl >= 4) {
    priorities.push({
      structureType: STRUCTURE_STORAGE,
      count: 1,
      built: room.storage ? 1 : 0,
      queued: countSites(room, STRUCTURE_STORAGE),
      priority: 4,
      blocksProgress: true,
    });
  }
  
  // Roads (doesn't block anything, low priority)
  priorities.push({
    structureType: STRUCTURE_ROAD,
    count: Infinity,  // Always more roads possible
    built: countStructures(room, STRUCTURE_ROAD),
    queued: countSites(room, STRUCTURE_ROAD),
    priority: 10,
    blocksProgress: false,
  });
  
  return priorities.sort((a, b) => a.priority - b.priority);
}

// Key insight: don't place low-priority sites until high-priority complete
function canPlaceConstructionSite(room: Room, type: StructureConstant): boolean {
  const priorities = getConstructionPriorities(room);
  const targetPriority = priorities.find(p => p.structureType === type);
  
  if (!targetPriority) return false;
  
  // Check all higher priority items
  for (const goal of priorities) {
    if (goal.priority >= targetPriority.priority) break;
    
    // If a blocking goal is incomplete, can't build lower priority
    if (goal.blocksProgress && (goal.built + goal.queued) < goal.count) {
      return false;
    }
  }
  
  return true;
}
```

---

## Strategic Coordinator

Runs every 100 ticks to recalculate strategic state.

```typescript
// src/core/StrategicCoordinator.ts

interface StrategicState {
  phase: ColonyPhase;
  goals: StrategicGoal[];
  budget: EnergyBudget;
  workforce: WorkforceRequirements;
  constructionQueue: ConstructionGoal[];
  
  // Diagnostics
  bottleneck: Bottleneck | null;
  recommendations: string[];
}

enum Bottleneck {
  ENERGY_INCOME = 'ENERGY_INCOME',       // Not harvesting enough
  ENERGY_TRANSPORT = 'ENERGY_TRANSPORT', // Energy stuck at sources
  SPAWN_CAPACITY = 'SPAWN_CAPACITY',     // Can't spawn fast enough
  POPULATION = 'POPULATION',             // Too few creeps
  CONSTRUCTION = 'CONSTRUCTION',         // Missing key structures
  CPU = 'CPU',                           // CPU limited
}

class StrategicCoordinator {
  private room: Room;
  private state: StrategicState;
  
  constructor(room: Room) {
    this.room = room;
  }
  
  // Run every 100 ticks
  run(): StrategicState {
    // 1. Determine phase
    const phase = this.determinePhase();
    
    // 2. Calculate energy budget
    const income = this.measureEnergyIncome();
    const budget = calculateBudget(phase, income);
    
    // 3. Determine workforce requirements
    const workforce = calculateWorkforce(budget, this.room);
    
    // 4. Get construction priorities
    const constructionQueue = getConstructionPriorities(this.room);
    
    // 5. Update goals
    const goals = this.updateGoals(budget, workforce, constructionQueue);
    
    // 6. Identify bottleneck
    const bottleneck = this.identifyBottleneck(budget, workforce, constructionQueue);
    
    // 7. Generate recommendations
    const recommendations = this.generateRecommendations(bottleneck, workforce, constructionQueue);
    
    this.state = {
      phase,
      goals,
      budget,
      workforce,
      constructionQueue,
      bottleneck,
      recommendations,
    };
    
    // Store in memory for tactical layer
    Memory.colonies = Memory.colonies || {};
    Memory.colonies[this.room.name] = Memory.colonies[this.room.name] || {};
    Memory.colonies[this.room.name].strategic = this.state;
    
    // Log strategic summary
    this.logSummary();
    
    return this.state;
  }
  
  private measureEnergyIncome(): number {
    // Use rolling average from stats history
    const stats = Memory.statsHistory || [];
    if (stats.length < 10) return 10; // Default assumption
    
    const recent = stats.slice(-10);
    const totalHarvested = recent.reduce((sum, s) => sum + s.energyHarvested, 0);
    return totalHarvested / recent.length;
  }
  
  private identifyBottleneck(
    budget: EnergyBudget,
    workforce: WorkforceRequirements,
    constructionQueue: ConstructionGoal[]
  ): Bottleneck | null {
    // Check harvest efficiency
    if (budget.harvestEfficiency < 0.5) {
      return Bottleneck.ENERGY_INCOME;
    }
    
    // Check for energy stuck at sources (transport problem)
    const droppedEnergy = this.room.find(FIND_DROPPED_RESOURCES)
      .filter(r => r.resourceType === RESOURCE_ENERGY)
      .reduce((sum, r) => sum + r.amount, 0);
    const containerEnergy = this.room.find(FIND_STRUCTURES)
      .filter(s => s.structureType === STRUCTURE_CONTAINER)
      .reduce((sum, c) => sum + (c as StructureContainer).store.energy, 0);
    
    if (droppedEnergy > 500 || containerEnergy > 1000) {
      return Bottleneck.ENERGY_TRANSPORT;
    }
    
    // Check construction blockers
    const topConstruction = constructionQueue[0];
    if (topConstruction && topConstruction.blocksProgress && 
        topConstruction.built < topConstruction.count) {
      return Bottleneck.CONSTRUCTION;
    }
    
    // Check population gaps
    const totalGap = Object.values(workforce.gaps).reduce((sum, g) => sum + Math.max(0, g), 0);
    if (totalGap >= 3) {
      return Bottleneck.POPULATION;
    }
    
    // Check spawn capacity (spawn always busy but can't keep up)
    const spawns = this.room.find(FIND_MY_SPAWNS);
    const busySpawns = spawns.filter(s => s.spawning).length;
    if (busySpawns === spawns.length && totalGap > 0) {
      return Bottleneck.SPAWN_CAPACITY;
    }
    
    // Check CPU
    if (Game.cpu.bucket < 5000) {
      return Bottleneck.CPU;
    }
    
    return null;
  }
  
  private generateRecommendations(
    bottleneck: Bottleneck | null,
    workforce: WorkforceRequirements,
    constructionQueue: ConstructionGoal[]
  ): string[] {
    const recs: string[] = [];
    
    switch (bottleneck) {
      case Bottleneck.ENERGY_INCOME:
        recs.push(`Increase harvesters: need ${workforce.harvestWorkParts} WORK parts at sources`);
        recs.push(`Current harvest efficiency: ${(this.state?.budget.harvestEfficiency * 100).toFixed(0)}%`);
        break;
        
      case Bottleneck.ENERGY_TRANSPORT:
        recs.push(`Energy stuck at sources - add haulers`);
        recs.push(`Need ${workforce.carryThroughput.toFixed(1)} carry throughput/tick`);
        break;
        
      case Bottleneck.CONSTRUCTION:
        const blocking = constructionQueue.find(c => c.blocksProgress && c.built < c.count);
        if (blocking) {
          recs.push(`Build ${blocking.structureType} (${blocking.built}/${blocking.count})`);
          recs.push(`This blocks further progress`);
        }
        break;
        
      case Bottleneck.POPULATION:
        const gaps = workforce.gaps;
        for (const [role, gap] of Object.entries(gaps)) {
          if (gap > 0) {
            recs.push(`Need ${gap} more ${role}`);
          }
        }
        break;
        
      case Bottleneck.SPAWN_CAPACITY:
        recs.push(`Spawn at capacity - build more spawns or spawn larger creeps`);
        break;
        
      case Bottleneck.CPU:
        recs.push(`CPU bucket low (${Game.cpu.bucket}) - reduce creep count or optimize code`);
        break;
    }
    
    return recs;
  }
  
  private logSummary(): void {
    const s = this.state;
    console.log(`=== Strategic Summary [${this.room.name}] ===`);
    console.log(`Phase: ${s.phase}`);
    console.log(`Income: ${s.budget.incomePerTick.toFixed(1)}/tick (${(s.budget.harvestEfficiency * 100).toFixed(0)}% efficiency)`);
    console.log(`Bottleneck: ${s.bottleneck || 'none'}`);
    
    if (s.recommendations.length > 0) {
      console.log(`Recommendations:`);
      s.recommendations.forEach(r => console.log(`  - ${r}`));
    }
    
    console.log(`Workforce gaps: H:${s.workforce.gaps.HARVESTER} U:${s.workforce.gaps.HAULER} Up:${s.workforce.gaps.UPGRADER} B:${s.workforce.gaps.BUILDER}`);
  }
}
```

---

## Integration with Tactical Layer

The tactical layer reads strategic state and generates tasks accordingly.

```typescript
// In TaskCoordinator.ts

class TaskCoordinator {
  run(): void {
    // Read strategic state (updated every 100 ticks)
    const strategic = Memory.colonies?.[this.roomName]?.strategic;
    
    if (!strategic) {
      // No strategic state yet, run basic logic
      this.runBasicLogic();
      return;
    }
    
    // Generate tasks based on workforce requirements
    this.generateTasksFromStrategy(strategic);
  }
  
  private generateTasksFromStrategy(strategic: StrategicState): void {
    const { workforce, budget, constructionQueue } = strategic;
    
    // 1. Always generate HARVEST tasks for income
    this.generateHarvestTasks(workforce.harvestWorkParts);
    
    // 2. Generate SUPPLY tasks based on spawn needs
    if (this.room.energyAvailable < this.room.energyCapacityAvailable) {
      this.generateSupplySpawnTasks();
    }
    
    // 3. Generate UPGRADE tasks based on budget allocation
    const upgradeSlots = Math.ceil(budget.budgetPerTick.upgrading / 2);
    this.generateUpgradeTasks(upgradeSlots);
    
    // 4. Generate BUILD tasks only for top-priority construction
    const topConstruction = constructionQueue.find(c => 
      c.blocksProgress && (c.built + c.queued) < c.count
    );
    if (topConstruction) {
      this.generateBuildTasks(topConstruction.structureType, 2); // max 2 builders
    }
    
    // 5. Generate HAUL tasks to prevent energy buildup
    this.generateHaulTasks(workforce.carryThroughput);
  }
}
```

---

## Memory Schema

```typescript
interface ColonyMemory {
  strategic: {
    phase: ColonyPhase;
    lastUpdated: number;
    
    budget: {
      incomePerTick: number;
      allocations: Record<string, number>;
    };
    
    workforce: {
      targets: Record<Role, number>;
      gaps: Record<Role, number>;
    };
    
    bottleneck: Bottleneck | null;
    
    goals: Array<{
      id: string;
      type: GoalType;
      progress: number;
      eta: number;
    }>;
  };
  
  // Existing tactical state
  phase: ColonyPhase;
  tasks: Task[];
  needs: ColonyNeeds;
}
```

---

## Diagnostic Console Commands

```javascript
// View strategic state
JSON.stringify(Memory.colonies?.E46N37?.strategic, null, 2)

// Manual strategic recalc
new StrategicCoordinator(Game.rooms.E46N37).run()

// View bottleneck
Memory.colonies?.E46N37?.strategic?.bottleneck

// View workforce gaps
Memory.colonies?.E46N37?.strategic?.workforce?.gaps

// View construction priorities
Memory.colonies?.E46N37?.strategic?.constructionQueue
```

---

## Capacity Transition Awareness

When extensions are under construction, the colony is in a "capacity transition" state. Smart decisions during this period significantly impact growth rate.

### The Problem

```
Current state:
  energyCapacity: 300
  extensions under construction: 5
  futureCapacity: 550

Dumb behavior:
  - Spawn 300-energy creeps now (small, weak)
  - Renew dying 300-energy creeps (keeps them alive longer)
  - Result: Stuck with small creeps for 3000+ more ticks

Smart behavior:
  - Wait for extensions if population is stable
  - Let small creeps die naturally
  - Spawn 550-energy creeps once extensions done
  - Result: Bigger workforce 50% sooner
```

### Capacity Transition Detector

```typescript
interface CapacityTransition {
  inTransition: boolean;
  currentCapacity: number;
  futureCapacity: number;
  extensionsBuilding: number;
  estimatedTicksToCompletion: number;
  shouldSuppressRenewal: boolean;
  shouldDelaySpawning: boolean;
}

function detectCapacityTransition(room: Room): CapacityTransition {
  const currentCapacity = room.energyCapacityAvailable;
  
  // Count extension sites
  const extensionSites = room.find(FIND_CONSTRUCTION_SITES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION
  });
  
  const extensionsBuilding = extensionSites.length;
  const futureCapacity = currentCapacity + (extensionsBuilding * 50);
  
  // Estimate completion time based on build progress rate
  const totalRemaining = extensionSites.reduce((sum, s) => 
    sum + (s.progressTotal - s.progress), 0);
  const buildRate = measureBuildRate(room); // WORK parts * 5 per tick
  const estimatedTicksToCompletion = buildRate > 0 ? totalRemaining / buildRate : Infinity;
  
  const inTransition = extensionsBuilding > 0;
  
  // Suppress renewal if capacity increasing significantly
  const capacityIncrease = futureCapacity / currentCapacity;
  const shouldSuppressRenewal = inTransition && capacityIncrease >= 1.3; // 30%+ increase
  
  // Delay non-critical spawning if extensions almost done
  const shouldDelaySpawning = inTransition && estimatedTicksToCompletion < 500;
  
  return {
    inTransition,
    currentCapacity,
    futureCapacity,
    extensionsBuilding,
    estimatedTicksToCompletion,
    shouldSuppressRenewal,
    shouldDelaySpawning,
  };
}
```

### Renewal Suppression

Don't renew creeps that will be replaced by better ones.

```typescript
function shouldRenewCreep(creep: Creep, transition: CapacityTransition): boolean {
  // Always renew if not in transition
  if (!transition.inTransition) return true;
  
  // Never suppress renewal for critical roles during emergencies
  if (Memory.colonies[creep.room.name]?.phase === 'EMERGENCY') return true;
  
  // Calculate creep's energy cost
  const creepCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
  
  // If creep is less than 70% of future capacity, let it die
  const valueThreshold = transition.futureCapacity * 0.7;
  if (creepCost < valueThreshold) {
    // Exception: don't let population drop too low
    const roleCount = countCreepsByRole(creep.room)[creep.memory.role];
    const minForRole = MIN_CREEPS_BY_ROLE[creep.memory.role] || 1;
    
    if (roleCount <= minForRole) {
      // Check if replacement will spawn in time
      const ttl = creep.ticksToLive || 0;
      const spawnTime = estimateSpawnTime(creep.room);
      
      if (ttl < spawnTime + 50) {
        // Need to renew to prevent gap, but only extend minimally
        return true;
      }
    }
    
    return false; // Let it die, spawn bigger replacement
  }
  
  return true; // Creep is valuable enough to keep
}

// Modify Spawner.tryRenewCreeps()
private tryRenewCreeps(spawn: StructureSpawn, state: ColonyState): boolean {
  const transition = detectCapacityTransition(spawn.room);
  
  // Find dying creeps
  const dyingCreeps = Object.values(Game.creeps).filter(c =>
    c.room.name === spawn.room.name &&
    c.ticksToLive !== undefined &&
    c.ticksToLive < 300 &&
    c.pos.isNearTo(spawn)
  );
  
  for (const creep of dyingCreeps) {
    // Check if renewal makes strategic sense
    if (!shouldRenewCreep(creep, transition)) {
      continue; // Skip this creep, let it die
    }
    
    const result = spawn.renewCreep(creep);
    if (result === OK) {
      return true; // Renewed one creep
    }
  }
  
  return false;
}
```

### Spawn Timing Optimization

Optionally delay spawning non-critical creeps to get bigger bodies.

```typescript
interface SpawnDecision {
  shouldSpawn: boolean;
  reason: string;
  waitTicks?: number;
}

function evaluateSpawnTiming(
  role: Role,
  room: Room,
  transition: CapacityTransition
): SpawnDecision {
  // Critical roles always spawn immediately
  const criticalRoles: Role[] = ['HARVESTER', 'HAULER'];
  if (criticalRoles.includes(role)) {
    return { shouldSpawn: true, reason: 'critical role' };
  }
  
  // Not in transition, spawn normally
  if (!transition.inTransition) {
    return { shouldSpawn: true, reason: 'no transition' };
  }
  
  // Check current population
  const currentCount = countCreepsByRole(room)[role] || 0;
  const minCount = MIN_CREEPS_BY_ROLE[role] || 1;
  
  // If below minimum, must spawn now
  if (currentCount < minCount) {
    return { shouldSpawn: true, reason: 'below minimum' };
  }
  
  // If extensions almost done, wait for bigger body
  if (transition.estimatedTicksToCompletion < 300) {
    const currentBody = getBodyForRole(role, transition.currentCapacity);
    const futureBody = getBodyForRole(role, transition.futureCapacity);
    
    // Only wait if future body is significantly better
    if (futureBody.length > currentBody.length * 1.3) {
      return {
        shouldSpawn: false,
        reason: 'waiting for extensions',
        waitTicks: transition.estimatedTicksToCompletion,
      };
    }
  }
  
  return { shouldSpawn: true, reason: 'no benefit to waiting' };
}
```

### Replacement Scheduling

Track when small creeps will die and schedule bigger replacements.

```typescript
interface ReplacementSchedule {
  creepName: string;
  role: Role;
  deathTick: number;       // When creep will die
  currentBodyCost: number;
  replacementBodyCost: number;
  spawnByTick: number;     // When to start spawning replacement
}

function buildReplacementSchedule(room: Room, transition: CapacityTransition): ReplacementSchedule[] {
  const schedule: ReplacementSchedule[] = [];
  
  for (const creep of Object.values(Game.creeps)) {
    if (creep.room.name !== room.name) continue;
    if (!creep.ticksToLive) continue;
    
    const deathTick = Game.time + creep.ticksToLive;
    const currentBodyCost = creep.body.reduce((sum, p) => sum + BODYPART_COST[p.type], 0);
    
    // Calculate replacement body based on expected capacity at death time
    const capacityAtDeath = transition.estimatedTicksToCompletion < creep.ticksToLive
      ? transition.futureCapacity
      : transition.currentCapacity;
    
    const replacementBody = getBodyForRole(creep.memory.role, capacityAtDeath);
    const replacementBodyCost = replacementBody.reduce((sum, p) => sum + BODYPART_COST[p], 0);
    const spawnTime = replacementBody.length * CREEP_SPAWN_TIME;
    
    schedule.push({
      creepName: creep.name,
      role: creep.memory.role,
      deathTick,
      currentBodyCost,
      replacementBodyCost,
      spawnByTick: deathTick - spawnTime - 20, // 20 tick buffer
    });
  }
  
  return schedule.sort((a, b) => a.spawnByTick - b.spawnByTick);
}

// Use in strategic coordinator
function logReplacementSchedule(room: Room): void {
  const transition = detectCapacityTransition(room);
  const schedule = buildReplacementSchedule(room, transition);
  
  console.log(`=== Replacement Schedule [${room.name}] ===`);
  console.log(`Capacity: ${transition.currentCapacity} → ${transition.futureCapacity}`);
  console.log(`Extensions done in: ${transition.estimatedTicksToCompletion} ticks`);
  
  for (const entry of schedule.slice(0, 5)) {
    const upgrade = entry.replacementBodyCost > entry.currentBodyCost;
    console.log(
      `  ${entry.creepName} (${entry.role}): dies T+${entry.deathTick - Game.time}, ` +
      `replace at T+${entry.spawnByTick - Game.time}, ` +
      `${entry.currentBodyCost} → ${entry.replacementBodyCost} energy ${upgrade ? '⬆️' : ''}`
    );
  }
}
```

### Integration with Strategic State

```typescript
interface StrategicState {
  // ... existing fields ...
  
  capacityTransition: CapacityTransition;
  replacementSchedule: ReplacementSchedule[];
}

// Add to StrategicCoordinator.run()
run(): StrategicState {
  // ... existing code ...
  
  // 7. Check capacity transition
  const capacityTransition = detectCapacityTransition(this.room);
  
  // 8. Build replacement schedule
  const replacementSchedule = buildReplacementSchedule(this.room, capacityTransition);
  
  // 9. Add transition-specific recommendations
  if (capacityTransition.shouldSuppressRenewal) {
    recommendations.push(
      `Suppressing renewal: ${capacityTransition.currentCapacity} → ${capacityTransition.futureCapacity} capacity incoming`
    );
  }
  
  this.state = {
    // ... existing fields ...
    capacityTransition,
    replacementSchedule,
  };
  
  return this.state;
}
```

### Console Commands for Monitoring

```javascript
// View capacity transition state
let r=Game.rooms['E46N37'];let ext=r.find(FIND_CONSTRUCTION_SITES).filter(s=>s.structureType=='extension');console.log('Current:',r.energyCapacityAvailable,'Future:',r.energyCapacityAvailable+ext.length*50,'Extensions:',ext.length)

// View creep values vs future capacity
let future=Game.rooms['E46N37'].energyCapacityAvailable+Game.rooms['E46N37'].find(FIND_CONSTRUCTION_SITES).filter(s=>s.structureType=='extension').length*50;for(let n in Game.creeps){let c=Game.creeps[n];let cost=c.body.length*50;console.log(n,cost,'/',future,cost<future*0.7?'REPLACE':'KEEP')}

// View replacement schedule (simple)
for(let n in Game.creeps){let c=Game.creeps[n];if(c.ticksToLive)console.log(n,c.memory.role,'dies in',c.ticksToLive,'ticks')}
```

---

## Implementation Order

1. **StrategicCoordinator** - Core class, runs every 100 ticks
2. **EnergyBudget calculator** - Income measurement + allocation
3. **WorkforceRequirements calculator** - Translate budget to creep needs
4. **Bottleneck identifier** - Diagnose what's blocking progress
5. **CapacityTransition detector** - Track extension building, suppress renewal
6. **ReplacementSchedule builder** - Plan when to spawn bigger creeps
7. **Integration with Spawner** - Renewal suppression, spawn timing
8. **Integration with TaskCoordinator** - Use strategic state for task generation

---

## Expected Behavior After Implementation

```
Tick 72665000:
  === Strategic Summary [E46N37] ===
  Phase: DEVELOPING
  Income: 18.5/tick (92% efficiency)
  Bottleneck: CONSTRUCTION
  Recommendations:
    - Build extension (0/5)
    - This blocks further progress
  Workforce gaps: H:0 U:0 Up:1 B:0

Tick 72665100: (extensions built)
  === Strategic Summary [E46N37] ===
  Phase: DEVELOPING
  Income: 19.2/tick (96% efficiency)
  Bottleneck: none
  Workforce gaps: H:0 U:0 Up:0 B:0
  
  RCL 3 ETA: 2.1 hours (was 4.3 hours before extensions)
```
