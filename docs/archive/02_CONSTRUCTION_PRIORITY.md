# PROMPT: Fix Construction Priority System

## Problem Statement

The colony is stuck at RCL 2 with 300/300 energy (no extensions built) while builders waste energy on 33 road construction sites. Extensions are never placed, containers are incomplete, and roads are prioritized over critical infrastructure.

**Current broken priority:**
```
Roads (33 sites) → Nothing else
```

**Required priority:**
```
Containers at sources → Extensions → Tower (RCL3) → Storage (RCL4) → Roads
```

## Tasks

### 1. Create ExtensionPlanner

**File:** `src/structures/ExtensionPlanner.ts`

Place extensions in a cluster near spawn. Extensions unlock larger creeps and faster spawning.

**Requirements:**
- Run every 20 ticks (like ContainerPlanner)
- Only place sites if fewer than max extensions exist + are under construction
- Place in walkable tiles within 3-5 range of spawn
- Avoid blocking spawn exit or source paths
- Pattern: cluster or flag pattern near spawn

**Extension counts by RCL:**
| RCL | Extensions | Total Capacity |
|-----|------------|----------------|
| 2   | 5          | 550            |
| 3   | 10         | 800            |
| 4   | 20         | 1300           |
| 5   | 30         | 1800           |
| 6   | 40         | 2300           |
| 7   | 50         | 5600           |
| 8   | 60         | 12900          |

**Placement algorithm:**
```
1. Get spawn position
2. Get existing extensions + extension construction sites
3. If count < max for RCL:
   a. Find walkable tiles in range 2-5 of spawn
   b. Exclude tiles adjacent to sources, controller
   c. Exclude tiles that would block paths
   d. Sort by distance to spawn (closer = better)
   e. Place construction site at best position
   f. Limit to 1-2 new sites per run (avoid spam)
```

### 2. Fix RoadPlanner

**File:** `src/core/RoadPlanner.ts`

**Current behavior:** Places roads from spawn to sources immediately.

**Required behavior:**
- Do NOT run until RCL >= 3
- OR only run after all extensions are built
- Limit to 5 road sites at a time (not 33)
- Priority: spawn→source paths first, then spawn→controller

**Add gate check at start of run():**
```typescript
run(): void {
  // Don't build roads until economy is established
  if (this.room.controller.level < 3) return;
  
  // Don't build roads if extensions aren't done
  const extensionCount = this.room.find(FIND_MY_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION
  }).length;
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][this.room.controller.level];
  if (extensionCount < maxExtensions) return;
  
  // Limit concurrent road sites
  const roadSites = this.room.find(FIND_CONSTRUCTION_SITES, {
    filter: s => s.structureType === STRUCTURE_ROAD
  }).length;
  if (roadSites >= 5) return;
  
  // ... rest of road planning
}
```

### 3. Fix ContainerPlanner

**File:** `src/structures/ContainerPlanner.ts`

**Issue:** Only one container site exists, but room has 2 sources.

**Verify:**
- Places container at EACH source (not just closest)
- Container position is adjacent to source, on a walkable tile
- Tracks per-source placement status (not global `placed` flag)

### 4. Create ConstructionCoordinator

**File:** `src/core/ConstructionCoordinator.ts` (new)

Centralized construction priority management.

```typescript
interface ConstructionPriority {
  structureType: StructureConstant;
  priority: number;  // lower = build first
  minRCL: number;
  maxConcurrentSites: number;
}

const CONSTRUCTION_PRIORITIES: ConstructionPriority[] = [
  { structureType: STRUCTURE_SPAWN,     priority: 0, minRCL: 1, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_CONTAINER, priority: 1, minRCL: 1, maxConcurrentSites: 2 },
  { structureType: STRUCTURE_EXTENSION, priority: 2, minRCL: 2, maxConcurrentSites: 3 },
  { structureType: STRUCTURE_TOWER,     priority: 3, minRCL: 3, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_STORAGE,   priority: 4, minRCL: 4, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_ROAD,      priority: 5, minRCL: 3, maxConcurrentSites: 5 },
  { structureType: STRUCTURE_WALL,      priority: 6, minRCL: 3, maxConcurrentSites: 3 },
  { structureType: STRUCTURE_RAMPART,   priority: 6, minRCL: 3, maxConcurrentSites: 3 },
  { structureType: STRUCTURE_LINK,      priority: 4, minRCL: 5, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_TERMINAL,  priority: 5, minRCL: 6, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_LAB,       priority: 6, minRCL: 6, maxConcurrentSites: 1 },
];

class ConstructionCoordinator {
  // Returns whether a structure type is allowed to place new sites
  canPlaceSites(structureType: StructureConstant): boolean {
    const priority = CONSTRUCTION_PRIORITIES.find(p => p.structureType === structureType);
    if (!priority) return false;
    
    // Check RCL requirement
    if (this.room.controller.level < priority.minRCL) return false;
    
    // Check if higher priority structures are incomplete
    for (const higherPriority of CONSTRUCTION_PRIORITIES) {
      if (higherPriority.priority >= priority.priority) break;
      if (this.room.controller.level < higherPriority.minRCL) continue;
      
      if (!this.isStructureTypeComplete(higherPriority.structureType)) {
        return false;  // Higher priority not done yet
      }
    }
    
    // Check concurrent site limit
    const currentSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: s => s.structureType === structureType
    }).length;
    
    return currentSites < priority.maxConcurrentSites;
  }
  
  private isStructureTypeComplete(structureType: StructureConstant): boolean {
    const existing = this.room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === structureType
    }).length;
    const sites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: s => s.structureType === structureType
    }).length;
    const max = CONTROLLER_STRUCTURES[structureType][this.room.controller.level];
    
    return (existing + sites) >= max;
  }
}
```

### 5. Update main.ts

Integrate new planners:

```typescript
// In room processing loop:

// Construction planning (every 20 ticks)
if (Game.time % 20 === 0) {
  const coordinator = new ConstructionCoordinator(room);
  
  // Always run container planner first
  if (coordinator.canPlaceSites(STRUCTURE_CONTAINER)) {
    new ContainerPlanner(room).run();
  }
  
  // Then extensions
  if (coordinator.canPlaceSites(STRUCTURE_EXTENSION)) {
    new ExtensionPlanner(room).run();
  }
  
  // Tower at RCL 3
  if (coordinator.canPlaceSites(STRUCTURE_TOWER)) {
    new TowerPlanner(room).run();
  }
  
  // Roads only after economy structures done
  if (coordinator.canPlaceSites(STRUCTURE_ROAD)) {
    new RoadPlanner(room).run();
  }
}
```

## Immediate Console Commands

Until code is fixed, run these manually:

**Clear all road sites:**
```javascript
Game.rooms['E46N37'].find(FIND_CONSTRUCTION_SITES).filter(s=>s.structureType=='road').forEach(s=>s.remove())
```

**Place 5 extensions near spawn (adjust coordinates as needed):**
```javascript
let r=Game.rooms['E46N37'];let sp=r.find(FIND_MY_SPAWNS)[0].pos;[[sp.x-2,sp.y+1],[sp.x-1,sp.y+1],[sp.x+1,sp.y+1],[sp.x+2,sp.y+1],[sp.x,sp.y+2]].forEach(p=>r.createConstructionSite(p[0],p[1],STRUCTURE_EXTENSION))
```

## Success Criteria

- [ ] Extensions placed before roads
- [ ] All 5 extensions built at RCL 2
- [ ] Energy capacity reaches 550
- [ ] Containers at both sources
- [ ] Road sites limited to 5 max
- [ ] Roads only placed after RCL 3 or extensions complete
- [ ] Larger creeps spawning (300+ energy bodies)

## Files to Modify/Create

| File | Action |
|------|--------|
| `src/structures/ExtensionPlanner.ts` | CREATE |
| `src/core/ConstructionCoordinator.ts` | CREATE |
| `src/core/RoadPlanner.ts` | MODIFY - add RCL/extension gate |
| `src/structures/ContainerPlanner.ts` | MODIFY - fix multi-source |
| `src/main.ts` | MODIFY - integrate coordinator |
