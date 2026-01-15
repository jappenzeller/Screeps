# Screeps Bot Implementation Plan

## Philosophy

**Simple working code beats complex broken code.**

Each phase must produce a colony that runs better than the previous phase. No phase is complete until verified working in-game. Do not advance to the next phase until the current phase is stable.

---

## Phase 0: Clean Slate
**Goal:** Remove broken systems, establish minimal working baseline

### 0.1 Audit Current State
Before changing anything, document what exists:
```javascript
// Run in console and report results
console.log('RCL:', Game.rooms['E46N37'].controller.level);
console.log('Energy Cap:', Game.rooms['E46N37'].energyCapacityAvailable);
console.log('Creeps:', Object.keys(Game.creeps).length);
console.log('Sites:', Game.rooms['E46N37'].find(FIND_CONSTRUCTION_SITES).length);
Object.values(Game.creeps).forEach(c => console.log(c.name, c.memory.role));
```

### 0.2 Identify What Works
Keep:
- Basic creep roles that function (harvest, deliver, upgrade)
- Memory structure
- Logger

Remove or disable:
- Any planner that doesn't produce working results
- StrategicCoordinator (observes but doesn't help)
- Complex systems that add overhead without value

### 0.3 Minimal main.ts
```typescript
// main.ts should be simple
export const loop = () => {
  cleanupMemory();
  
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    
    runRoom(room);
  }
  
  runCreeps();
};

function runRoom(room: Room): void {
  // 1. Place construction sites (simple, direct)
  placeStructures(room);
  
  // 2. Spawn creeps
  spawnCreeps(room);
  
  // 3. Run towers
  runTowers(room);
}

function runCreeps(): void {
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    runCreep(creep);
  }
}
```

### Verification
- Colony continues running
- No console errors
- Creeps still harvest/deliver/upgrade

---

## Phase 1: Reliable Foundation
**Goal:** Colony progresses RCL 1→8 without intervention

### 1.1 Structure Placement (Simple)
One file, one function, no classes:

```typescript
// src/structures/placeStructures.ts

export function placeStructures(room: Room): void {
  const rcl = room.controller?.level ?? 0;
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return;

  // Only run every 10 ticks (performance)
  if (Game.time % 10 !== 0) return;

  // Count what exists
  const count = (type: BuildableStructureConstant) => ({
    built: room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === type }).length,
    sites: room.find(FIND_CONSTRUCTION_SITES, { filter: s => s.structureType === type }).length,
    max: CONTROLLER_STRUCTURES[type][rcl] || 0
  });

  // Priority order - place what's missing
  const structures: BuildableStructureConstant[] = [
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_CONTAINER,
    STRUCTURE_ROAD
  ];

  for (const type of structures) {
    const { built, sites, max } = count(type);
    if (built + sites < max) {
      const placed = placeOne(room, spawn.pos, type);
      if (placed) return; // One per tick, avoid CPU spike
    }
  }
}

function placeOne(room: Room, near: RoomPosition, type: BuildableStructureConstant): boolean {
  const pos = findBuildPosition(room, near, type);
  if (pos) {
    const result = room.createConstructionSite(pos.x, pos.y, type);
    return result === OK;
  }
  return false;
}

function findBuildPosition(room: Room, near: RoomPosition, type: BuildableStructureConstant): {x: number, y: number} | null {
  const terrain = room.getTerrain();
  
  // Container: near sources
  if (type === STRUCTURE_CONTAINER) {
    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      // Check if source already has container
      const hasContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
      }).length > 0;
      const hasSite = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
      }).length > 0;
      
      if (!hasContainer && !hasSite) {
        // Find adjacent walkable tile
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const x = source.pos.x + dx;
            const y = source.pos.y + dy;
            if (isValidBuildPos(room, x, y, terrain)) {
              return { x, y };
            }
          }
        }
      }
    }
    return null;
  }
  
  // Everything else: spiral out from spawn
  for (let radius = 2; radius <= 10; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue; // Only edge of square
        
        const x = near.x + dx;
        const y = near.y + dy;
        
        if (!isValidBuildPos(room, x, y, terrain)) continue;
        
        // Extensions: checkerboard pattern
        if (type === STRUCTURE_EXTENSION) {
          if ((x + y) % 2 !== 0) continue;
        }
        
        return { x, y };
      }
    }
  }
  
  return null;
}

function isValidBuildPos(room: Room, x: number, y: number, terrain: RoomTerrain): boolean {
  if (x < 2 || x > 47 || y < 2 || y > 47) return false;
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  
  const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
  if (structures.length > 0) return false;
  
  const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  if (sites.length > 0) return false;
  
  return true;
}
```

### 1.2 Spawning (Simple)
One file, predictable creep counts:

```typescript
// src/spawning/spawnCreeps.ts

interface CreepTarget {
  role: string;
  body: BodyPartConstant[];
  count: number;
}

export function spawnCreeps(room: Room): void {
  const spawn = room.find(FIND_MY_SPAWNS).find(s => !s.spawning);
  if (!spawn) return;

  const rcl = room.controller?.level ?? 1;
  const energy = room.energyCapacityAvailable;
  const creeps = Object.values(Game.creeps).filter(c => c.memory.room === room.name);
  
  // Count by role
  const countRole = (role: string) => creeps.filter(c => c.memory.role === role).length;

  // Define what we need based on RCL
  const targets = getTargets(rcl, energy, room);

  // Spawn first thing that's under target
  for (const target of targets) {
    if (countRole(target.role) < target.count) {
      const name = `${target.role}_${Game.time}`;
      const result = spawn.spawnCreep(target.body, name, {
        memory: { role: target.role, room: room.name }
      });
      if (result === OK) {
        console.log(`Spawning ${target.role} in ${room.name}`);
      }
      return; // One spawn attempt per tick
    }
  }
}

function getTargets(rcl: number, energy: number, room: Room): CreepTarget[] {
  const targets: CreepTarget[] = [];
  
  // Scale body to available energy
  const workerBody = scaleBody([WORK, CARRY, MOVE], energy);
  const haulerBody = scaleBody([CARRY, CARRY, MOVE], energy);
  const harvesterBody = scaleBody([WORK, WORK, CARRY, MOVE], energy, 6); // Cap at 6 WORK
  
  // Harvesters: 1 per source
  const sourceCount = room.find(FIND_SOURCES).length;
  targets.push({ role: 'HARVESTER', body: harvesterBody, count: sourceCount });
  
  // Haulers: need them once containers exist
  const containers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
  if (containers.length > 0) {
    targets.push({ role: 'HAULER', body: haulerBody, count: 2 });
  }
  
  // Upgraders
  targets.push({ role: 'UPGRADER', body: workerBody, count: rcl < 4 ? 2 : 3 });
  
  // Builders: only when construction sites exist
  const sites = room.find(FIND_CONSTRUCTION_SITES).length;
  if (sites > 0) {
    targets.push({ role: 'BUILDER', body: workerBody, count: Math.min(2, Math.ceil(sites / 3)) });
  }
  
  return targets;
}

function scaleBody(unit: BodyPartConstant[], energy: number, maxUnits: number = 10): BodyPartConstant[] {
  const unitCost = unit.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  const units = Math.min(maxUnits, Math.floor(energy / unitCost));
  
  const body: BodyPartConstant[] = [];
  for (let i = 0; i < units; i++) {
    body.push(...unit);
  }
  return body.length > 0 ? body : unit; // At least one unit
}
```

### 1.3 Creep Behavior (Simple)
Keep existing role files but fix the bugs:

**Harvester fixes:**
- Never upgrade controller
- Deposit to container > storage > spawn > drop

**Builder fixes:**
- Get energy from container/storage first
- Only harvest as last resort

**Hauler fixes:**
- Fill to 100% before delivering (not 50%)
- Prioritize spawn/extensions > towers > storage

### 1.4 Verification
```javascript
// Run every few minutes during testing
let r = Game.rooms['E46N37'];
let rcl = r.controller.level;
let progress = Math.floor(r.controller.progress / r.controller.progressTotal * 100);
console.log(`RCL ${rcl} (${progress}%)`);
console.log('Energy:', r.energyAvailable, '/', r.energyCapacityAvailable);
console.log('Sites:', r.find(FIND_CONSTRUCTION_SITES).length);
console.log('Creeps:', Object.keys(Game.creeps).length);

// Structure counts
['extension','tower','container','storage'].forEach(t => {
  let built = r.find(FIND_MY_STRUCTURES, {filter: s => s.structureType == t}).length;
  let max = CONTROLLER_STRUCTURES[t][rcl];
  if (max > 0) console.log(t + ':', built, '/', max);
});
```

### Phase 1 Complete When:
- [ ] Colony progresses from current RCL to next RCL without manual intervention
- [ ] All available extensions built
- [ ] Tower built and functioning (attacks hostiles, repairs)
- [ ] Containers at sources
- [ ] Storage at RCL 4
- [ ] Creeps spawn automatically as needed
- [ ] No console errors

---

## Phase 2: Metrics & Visibility
**Goal:** Understand what's happening without guessing

### 2.1 Colony Stats
Track metrics every N ticks:

```typescript
// src/utils/Stats.ts

export function recordStats(room: Room): void {
  if (Game.time % 100 !== 0) return; // Every 100 ticks
  
  if (!Memory.stats) Memory.stats = {};
  if (!Memory.stats[room.name]) Memory.stats[room.name] = { history: [] };
  
  const stats = Memory.stats[room.name];
  const snapshot = {
    tick: Game.time,
    rcl: room.controller?.level,
    progress: room.controller?.progress,
    energy: room.energyAvailable,
    energyCap: room.energyCapacityAvailable,
    creeps: Object.values(Game.creeps).filter(c => c.memory.room === room.name).length,
    sites: room.find(FIND_CONSTRUCTION_SITES).length
  };
  
  stats.history.push(snapshot);
  
  // Keep last 100 snapshots
  if (stats.history.length > 100) {
    stats.history.shift();
  }
  
  // Calculate rates
  if (stats.history.length >= 2) {
    const prev = stats.history[stats.history.length - 2];
    const tickDelta = snapshot.tick - prev.tick;
    const progressDelta = snapshot.progress - prev.progress;
    
    stats.progressPerTick = progressDelta / tickDelta;
    stats.ticksToNextRcl = (room.controller.progressTotal - snapshot.progress) / stats.progressPerTick;
    stats.etaHours = stats.ticksToNextRcl / 3600; // ~1 tick/sec
  }
  
  // Log summary
  console.log(`[${room.name}] RCL ${snapshot.rcl} | ETA: ${stats.etaHours?.toFixed(1)}h | Creeps: ${snapshot.creeps}`);
}
```

### 2.2 Console Commands
```typescript
// src/utils/Console.ts

global.status = () => { /* existing status */ };

global.eta = () => {
  for (const roomName in Memory.stats) {
    const s = Memory.stats[roomName];
    console.log(`${roomName}: ${s.etaHours?.toFixed(1)} hours to next RCL`);
  }
};

global.efficiency = () => {
  const room = Game.rooms['E46N37']; // or parameterize
  const sources = room.find(FIND_SOURCES);
  const harvesters = Object.values(Game.creeps).filter(c => c.memory.role === 'HARVESTER');
  
  let totalWork = 0;
  for (const h of harvesters) {
    totalWork += h.body.filter(p => p.type === WORK).length;
  }
  
  const maxIncome = sources.length * 10; // 10 energy/tick/source
  const actualIncome = Math.min(totalWork * 2, maxIncome);
  
  console.log(`Harvest: ${actualIncome}/${maxIncome} energy/tick (${Math.floor(actualIncome/maxIncome*100)}%)`);
  console.log(`WORK parts: ${totalWork}, Sources: ${sources.length}`);
};
```

### Phase 2 Complete When:
- [ ] Stats recording works
- [ ] Can see ETA to next RCL
- [ ] Can diagnose issues with console commands
- [ ] Progress rate is reasonable (< 24h per RCL at low levels)

---

## Phase 3: Task-Based Architecture
**Goal:** Replace role-based decisions with centralized task assignment

### 3.1 Task System Core
Only implement AFTER Phase 1 and 2 are stable.

```typescript
// src/core/TaskManager.ts

interface Task {
  id: string;
  type: 'HARVEST' | 'DELIVER' | 'BUILD' | 'UPGRADE' | 'REPAIR';
  targetId: string;
  assignedCreep: string | null;
  priority: number;
  createdAt: number;
}

export class TaskManager {
  private room: Room;
  
  constructor(room: Room) {
    this.room = room;
  }
  
  run(): void {
    this.generateTasks();
    this.assignTasks();
  }
  
  private generateTasks(): void {
    const tasks = this.getTasks();
    
    // HARVEST: one per source, always needed
    for (const source of this.room.find(FIND_SOURCES)) {
      if (!tasks.some(t => t.type === 'HARVEST' && t.targetId === source.id)) {
        this.createTask('HARVEST', source.id, 1);
      }
    }
    
    // DELIVER: when spawn/extensions need energy
    if (this.room.energyAvailable < this.room.energyCapacityAvailable) {
      const existing = tasks.filter(t => t.type === 'DELIVER').length;
      if (existing < 2) {
        this.createTask('DELIVER', this.room.name, 2);
      }
    }
    
    // BUILD: when construction sites exist
    for (const site of this.room.find(FIND_CONSTRUCTION_SITES)) {
      if (!tasks.some(t => t.type === 'BUILD' && t.targetId === site.id)) {
        this.createTask('BUILD', site.id, 3);
      }
    }
    
    // UPGRADE: always have one
    const upgradeCount = tasks.filter(t => t.type === 'UPGRADE').length;
    if (upgradeCount < 2) {
      this.createTask('UPGRADE', this.room.controller!.id, 5);
    }
  }
  
  private assignTasks(): void {
    const tasks = this.getTasks().filter(t => !t.assignedCreep).sort((a, b) => a.priority - b.priority);
    const idleCreeps = Object.values(Game.creeps).filter(c => 
      c.memory.room === this.room.name && !c.memory.taskId
    );
    
    for (const task of tasks) {
      const capable = idleCreeps.filter(c => this.canDoTask(c, task));
      if (capable.length > 0) {
        // Assign closest creep
        const target = Game.getObjectById(task.targetId);
        if (target) {
          capable.sort((a, b) => a.pos.getRangeTo(target) - b.pos.getRangeTo(target));
          this.assignTask(task, capable[0]);
        }
      }
    }
  }
  
  private canDoTask(creep: Creep, task: Task): boolean {
    const hasWork = creep.body.some(p => p.type === WORK);
    const hasCarry = creep.body.some(p => p.type === CARRY);
    
    switch (task.type) {
      case 'HARVEST': return hasWork;
      case 'BUILD': 
      case 'UPGRADE': 
      case 'REPAIR': return hasWork && hasCarry;
      case 'DELIVER': return hasCarry;
      default: return false;
    }
  }
  
  // ... createTask, assignTask, getTasks using Memory
}
```

### 3.2 Creep Executor
Creeps execute tasks instead of following role scripts:

```typescript
// src/core/CreepExecutor.ts

export function executeCreep(creep: Creep): void {
  const taskId = creep.memory.taskId;
  if (!taskId) {
    // Idle - move toward spawn, wait
    const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (spawn && creep.pos.getRangeTo(spawn) > 5) {
      creep.moveTo(spawn);
    }
    creep.say('💤');
    return;
  }
  
  const task = getTask(creep.memory.room, taskId);
  if (!task) {
    creep.memory.taskId = undefined;
    return;
  }
  
  // Execute based on task type
  switch (task.type) {
    case 'HARVEST':
      executeHarvest(creep, task);
      break;
    case 'DELIVER':
      executeDeliver(creep, task);
      break;
    case 'BUILD':
      executeBuild(creep, task);
      break;
    case 'UPGRADE':
      executeUpgrade(creep, task);
      break;
  }
}

function executeHarvest(creep: Creep, task: Task): void {
  const source = Game.getObjectById(task.targetId as Id<Source>);
  if (!source) {
    completeTask(task);
    return;
  }
  
  if (creep.store.getFreeCapacity() === 0) {
    // Full - deposit to container or drop
    const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    })[0];
    
    if (container) {
      if (creep.transfer(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container);
      }
    } else {
      creep.drop(RESOURCE_ENERGY);
    }
  } else {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      creep.moveTo(source);
    }
  }
}

// ... similar for other task types
```

### Phase 3 Complete When:
- [ ] Tasks generated correctly
- [ ] Creeps assigned to tasks
- [ ] Creeps complete tasks and get new ones
- [ ] Colony performs same or better than role-based
- [ ] Old role files can be removed

---

## Phase 4: Strategic Layer
**Goal:** Long-term planning and optimization

### 4.1 Energy Budget
Only add after task system works:

```typescript
// src/strategy/EnergyBudget.ts

export function calculateBudget(room: Room): EnergyBudget {
  const income = calculateIncome(room);
  const rcl = room.controller?.level ?? 1;
  
  // Allocate income by priority
  let remaining = income;
  
  // 1. Spawning (must maintain creeps)
  const spawning = Math.min(remaining * 0.4, getSpawningNeed(room));
  remaining -= spawning;
  
  // 2. Building (if sites exist)
  const building = room.find(FIND_CONSTRUCTION_SITES).length > 0 
    ? Math.min(remaining * 0.3, 10)
    : 0;
  remaining -= building;
  
  // 3. Upgrading (remainder)
  const upgrading = remaining;
  
  return { income, spawning, building, upgrading };
}
```

### 4.2 Workforce Planning
Translate budget to creep counts:

```typescript
export function calculateWorkforce(budget: EnergyBudget, room: Room): WorkforceTarget {
  // Harvesters: enough WORK to saturate sources
  const sources = room.find(FIND_SOURCES).length;
  const harvesters = sources; // 1 per source with enough WORK
  
  // Haulers: enough CARRY to move harvested energy
  const haulers = sources; // 1 per source
  
  // Builders: based on build budget
  const builders = budget.building > 0 ? Math.ceil(budget.building / 5) : 0;
  
  // Upgraders: based on upgrade budget
  const upgraders = Math.ceil(budget.upgrading / 2);
  
  return { harvesters, haulers, builders, upgraders };
}
```

### Phase 4 Complete When:
- [ ] Budget calculated correctly
- [ ] Workforce matches budget
- [ ] Colony optimizes for current goals
- [ ] Can shift priorities (e.g., focus upgrade vs build)

---

## Phase 5: Learning & AWS Integration
**Goal:** AI observes and improves the bot

### 5.1 Data Export
Send stats to AWS for analysis:
- Per-tick metrics
- Events (deaths, spawns, attacks)
- Strategic state

### 5.2 Pattern Detection
AWS Lambda identifies issues:
- Stuck RCL progression
- Energy waste
- Inefficient creep ratios

### 5.3 Recommendation Engine
Claude API generates code changes:
- "Increase hauler count"
- "Harvesters spending too much time moving"

### Phase 5 Complete When:
- [ ] Data flows to AWS
- [ ] Patterns detected accurately
- [ ] Recommendations are actionable
- [ ] Some recommendations auto-applied

---

## Phase 6: Multi-Room Expansion
**Goal:** Claim and develop additional rooms

### 6.1 Scouting
### 6.2 Claiming
### 6.3 Remote Mining
### 6.4 Inter-room Coordination

---

## Current Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Clean Slate | SKIPPED | Codebase functional, audit not needed |
| Phase 1: Foundation | MOSTLY COMPLETE | Planners work, spawning dynamic, creep roles fixed |
| Phase 2: Metrics | PARTIAL | StatsCollector exists, console commands work |
| Phase 3: Task System | SKIPPED | Role-based system works, task system is optional refactor |
| Phase 4: Strategic | ACTIVE | StrategicCoordinator with energy budgets, bottleneck detection |
| Phase 5: Learning | NOT STARTED | AWS design exists in docs |
| Phase 6: Multi-room | NOT STARTED | |

### Phase 1 Details (Updated 2025-01-13)
**Complete:**
- ContainerPlanner - places containers at sources
- ExtensionPlanner - scales with RCL, checkerboard pattern
- TowerPlanner - places towers near spawn at RCL 3+
- ConstructionCoordinator - gates planners by priority
- Spawner - uses strategic targets for workforce
- Harvesters - static mining mode when container exists
- Haulers - collect from containers, deliver to spawn/extensions
- Builders - spawn when construction sites exist
- Upgraders - dynamic count (+2 when no construction)

**Remaining:**
- Storage placement at RCL 4
- Road planning (gated, needs implementation)
- Tower management (attack/heal/repair logic)

## Next Action

**Complete Phase 1 remaining items:**
1. Add StoragePlanner for RCL 4
2. Implement RoadPlanner (spawn→sources, spawn→controller)
3. Add TowerManager for defense and repairs

Then verify Phase 2 metrics are useful before considering Phase 5 AWS integration.
