# PROMPT: Fix Energy Acquisition & Creep Congestion

## Problem Statement

Multiple creeps independently calculate "closest energy source" → all pick same target → traffic jam.

**Observed behavior:**
- 3 builders all targeting same container
- Creeps bunched up, blocking each other
- Other containers/dropped energy ignored

**Affected roles:**
- Builder (`getEnergy()`)
- Upgrader (`getEnergy()`)
- Hauler (`collect()`)

---

## Root Cause

Current code pattern in all three roles:

```typescript
const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
  filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.energy > 50
});
```

Every creep runs this independently → same answer → congestion.

---

## Solution: Weighted Target Selection

Instead of "closest", use weighted scoring that penalizes crowded targets.

### Core Function: `findBestEnergySource()`

Create a shared utility function used by all roles:

**File:** `src/utils/EnergyUtils.ts`

```typescript
interface EnergySource {
  type: 'container' | 'storage' | 'dropped' | 'tombstone' | 'ruin';
  target: StructureContainer | StructureStorage | Resource | Tombstone | Ruin;
  energy: number;
  pos: RoomPosition;
}

interface ScoredSource extends EnergySource {
  score: number;  // Lower = better
}

/**
 * Find best energy source considering distance and congestion
 */
export function findBestEnergySource(creep: Creep, minEnergy: number = 50): EnergySource | null {
  const room = creep.room;
  const sources: EnergySource[] = [];
  
  // Containers
  const containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.energy >= minEnergy
  }) as StructureContainer[];
  
  for (const c of containers) {
    sources.push({
      type: 'container',
      target: c,
      energy: c.store.energy,
      pos: c.pos,
    });
  }
  
  // Storage (if exists and has energy)
  if (room.storage && room.storage.store.energy >= minEnergy) {
    sources.push({
      type: 'storage',
      target: room.storage,
      energy: room.storage.store.energy,
      pos: room.storage.pos,
    });
  }
  
  // Dropped resources
  const dropped = room.find(FIND_DROPPED_RESOURCES, {
    filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= minEnergy
  });
  
  for (const d of dropped) {
    sources.push({
      type: 'dropped',
      target: d,
      energy: d.amount,
      pos: d.pos,
    });
  }
  
  // Tombstones
  const tombstones = room.find(FIND_TOMBSTONES, {
    filter: t => t.store.energy >= minEnergy
  });
  
  for (const t of tombstones) {
    sources.push({
      type: 'tombstone',
      target: t,
      energy: t.store.energy,
      pos: t.pos,
    });
  }
  
  // Ruins
  const ruins = room.find(FIND_RUINS, {
    filter: r => r.store.energy >= minEnergy
  });
  
  for (const r of ruins) {
    sources.push({
      type: 'ruin',
      target: r,
      energy: r.store.energy,
      pos: r.pos,
    });
  }
  
  if (sources.length === 0) return null;
  
  // Score each source
  const scored: ScoredSource[] = sources.map(source => ({
    ...source,
    score: calculateSourceScore(creep, source),
  }));
  
  // Sort by score (lower = better)
  scored.sort((a, b) => a.score - b.score);
  
  return scored[0];
}

function calculateSourceScore(creep: Creep, source: EnergySource): number {
  let score = 0;
  
  // Base: path distance (approximated by range for speed)
  const distance = creep.pos.getRangeTo(source.pos);
  score += distance;
  
  // Penalty: creeps already at this location
  const creepsAtTarget = source.pos.findInRange(FIND_MY_CREEPS, 1).length;
  score += creepsAtTarget * 15;  // Heavy penalty for congestion
  
  // Penalty: creeps already targeting this (via memory)
  const creepsTargeting = countCreepsTargeting(source.target.id, creep.name);
  score += creepsTargeting * 10;
  
  // Bonus: more energy (prefer fuller sources)
  // Small bonus so distance still dominates
  score -= Math.min(source.energy / 100, 5);
  
  // Penalty: tile is blocked (creep standing on it)
  const blocked = source.pos.findInRange(FIND_MY_CREEPS, 0).length > 0;
  if (blocked) {
    score += 50;  // Heavy penalty, but not infinite (they might move)
  }
  
  return score;
}

function countCreepsTargeting(targetId: Id<any>, excludeCreep: string): number {
  let count = 0;
  for (const name in Game.creeps) {
    if (name === excludeCreep) continue;
    const creep = Game.creeps[name];
    if (creep.memory.energyTarget === targetId) {
      count++;
    }
  }
  return count;
}

/**
 * Withdraw or pickup energy from a source
 * Returns true if action taken (even if moving)
 */
export function acquireEnergy(creep: Creep, source: EnergySource): boolean {
  // Store target in memory for coordination
  creep.memory.energyTarget = source.target.id;
  
  if (source.type === 'dropped') {
    const result = creep.pickup(source.target as Resource);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(source.pos, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 5 });
    }
    return true;
  }
  
  // All others use withdraw
  const result = creep.withdraw(source.target as StructureContainer | StructureStorage | Tombstone | Ruin, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(source.pos, { visualizePathStyle: { stroke: '#ffaa00' }, reusePath: 5 });
  }
  
  return true;
}

/**
 * Clear energy target when done
 */
export function clearEnergyTarget(creep: Creep): void {
  delete creep.memory.energyTarget;
}
```

---

## Update Creep Roles

### Builder.ts

**Replace `getEnergy()` function:**

```typescript
import { findBestEnergySource, acquireEnergy, clearEnergyTarget } from "../utils/EnergyUtils";

function getEnergy(creep: Creep): void {
  const source = findBestEnergySource(creep, 50);
  
  if (source) {
    acquireEnergy(creep, source);
    return;
  }
  
  // No energy available - clear target and wait near spawn
  clearEnergyTarget(creep);
  
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    creep.moveTo(spawn, { visualizePathStyle: { stroke: '#888888' } });
  }
  creep.say('💤');
}
```

**Add to state transition (when switching from building to gathering):**

```typescript
if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
  creep.memory.working = false;
  clearEnergyTarget(creep);  // Clear old target
  creep.say('🔄');
}
```

### Upgrader.ts

**Same pattern:**

```typescript
import { findBestEnergySource, acquireEnergy, clearEnergyTarget } from "../utils/EnergyUtils";

function getEnergy(creep: Creep): void {
  const source = findBestEnergySource(creep, 50);
  
  if (source) {
    acquireEnergy(creep, source);
    return;
  }
  
  // No energy - wait near controller
  clearEnergyTarget(creep);
  
  const controller = creep.room.controller;
  if (controller && creep.pos.getRangeTo(controller) > 3) {
    creep.moveTo(controller, { visualizePathStyle: { stroke: '#888888' } });
  }
  creep.say('💤');
}
```

### Hauler.ts

**Replace `collect()` function:**

```typescript
import { findBestEnergySource, acquireEnergy, clearEnergyTarget } from "../utils/EnergyUtils";

function collect(creep: Creep): void {
  // Haulers need more energy to be worth the trip
  const minEnergy = creep.store.getFreeCapacity() * 0.5;
  const source = findBestEnergySource(creep, minEnergy);
  
  if (source) {
    acquireEnergy(creep, source);
    return;
  }
  
  // Nothing to collect - move toward sources to wait for harvesters
  clearEnergyTarget(creep);
  
  const sourceStructure = creep.pos.findClosestByPath(FIND_SOURCES);
  if (sourceStructure) {
    creep.moveTo(sourceStructure, { visualizePathStyle: { stroke: '#888888' } });
  }
}
```

---

## Memory Schema Update

Add to CreepMemory interface:

```typescript
interface CreepMemory {
  role: string;
  working?: boolean;
  sourceId?: Id<Source>;
  energyTarget?: Id<StructureContainer | StructureStorage | Resource | Tombstone | Ruin>;
  // ... other fields
}
```

---

## Advanced: Container Assignment for Haulers

For haulers specifically, can assign them to specific containers:

```typescript
interface HaulerMemory extends CreepMemory {
  assignedContainer?: Id<StructureContainer>;
}

// In Spawner when creating hauler:
const containers = room.find(FIND_STRUCTURES, {
  filter: s => s.structureType === STRUCTURE_CONTAINER
}) as StructureContainer[];

// Find container with fewest assigned haulers
const containerAssignments = containers.map(c => ({
  container: c,
  assignedCount: Object.values(Game.creeps).filter(cr => 
    cr.memory.assignedContainer === c.id
  ).length,
}));

containerAssignments.sort((a, b) => a.assignedCount - b.assignedCount);
const assignedContainer = containerAssignments[0]?.container;

spawn.spawnCreep(body, name, {
  memory: {
    role: 'HAULER',
    assignedContainer: assignedContainer?.id,
  }
});

// In Hauler.collect():
function collect(creep: Creep): void {
  // Prefer assigned container if it has energy
  if (creep.memory.assignedContainer) {
    const assigned = Game.getObjectById(creep.memory.assignedContainer);
    if (assigned && assigned.store.energy > 100) {
      if (creep.withdraw(assigned, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(assigned, { visualizePathStyle: { stroke: '#ffaa00' } });
      }
      return;
    }
  }
  
  // Fallback to best available source
  const source = findBestEnergySource(creep, 50);
  if (source) {
    acquireEnergy(creep, source);
  }
}
```

---

## Traffic Management (Optional)

For severe congestion, add traffic management:

```typescript
// In creep movement, avoid tiles with stationary creeps
function smartMoveTo(creep: Creep, target: RoomPosition): void {
  const result = creep.moveTo(target, {
    visualizePathStyle: { stroke: '#ffffff' },
    reusePath: 5,
    costCallback: (roomName, costMatrix) => {
      const room = Game.rooms[roomName];
      if (!room) return costMatrix;
      
      // Add cost for tiles with creeps
      for (const c of room.find(FIND_MY_CREEPS)) {
        if (c.name === creep.name) continue;
        
        // Stationary creeps (same pos for 3+ ticks) are obstacles
        if (c.memory._stationaryCount && c.memory._stationaryCount >= 3) {
          costMatrix.set(c.pos.x, c.pos.y, 255);
        } else {
          // Moving creeps are soft obstacles
          costMatrix.set(c.pos.x, c.pos.y, 50);
        }
      }
      
      return costMatrix;
    },
  });
  
  // Track if this creep is stationary
  const lastPos = creep.memory._lastPos;
  if (lastPos && lastPos.x === creep.pos.x && lastPos.y === creep.pos.y) {
    creep.memory._stationaryCount = (creep.memory._stationaryCount || 0) + 1;
  } else {
    creep.memory._stationaryCount = 0;
  }
  creep.memory._lastPos = { x: creep.pos.x, y: creep.pos.y };
}
```

---

## Verification

After implementation, run:

```javascript
// Check energy targets are distributed
for(let n in Game.creeps){let c=Game.creeps[n];if(c.memory.energyTarget)console.log(n,c.memory.role,'->',c.memory.energyTarget.slice(-4))}
```

Should see different targets, not all same ID.

```javascript
// Check congestion at containers
Game.rooms['E46N37'].find(FIND_STRUCTURES).filter(s=>s.structureType=='container').forEach(c=>{let nearby=c.pos.findInRange(FIND_MY_CREEPS,1).length;console.log(c.pos.x+','+c.pos.y,'creeps nearby:',nearby)})
```

Should see creeps distributed, not all at one container.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/utils/EnergyUtils.ts` | CREATE |
| `src/creeps/Builder.ts` | MODIFY - use new getEnergy |
| `src/creeps/Upgrader.ts` | MODIFY - use new getEnergy |
| `src/creeps/Hauler.ts` | MODIFY - use new collect |
| `src/types.d.ts` | MODIFY - add energyTarget to CreepMemory |
