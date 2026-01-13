# PROMPT: Critical Fixes for Colony Progression

## Current Situation

Colony is stuck at RCL 2 (13%) with:
- 5 extension sites placed (correct)
- Container being built at controller (wrong - wastes builder time)
- All creeps are small (150-300 energy) and should be replaced when extensions finish
- Spawner may be renewing small creeps (blocking bigger replacements)
- RoadPlanner previously placed 33 road sites before extensions

## Priority Order of Fixes

1. **ContainerPlanner** - Stop placing controller containers at RCL 2
2. **Spawner** - Add renewal suppression during capacity transitions
3. **RoadPlanner** - Gate behind extensions/RCL 3
4. **ExtensionPlanner** - New file to place extensions properly
5. **ConstructionCoordinator** - New file to enforce build priority

---

## Fix 1: ContainerPlanner.ts

**File:** `src/structures/ContainerPlanner.ts`

**Problem:** Places containers at controller, which is wrong at RCL 2. Controller containers are an RCL 5+ optimization.

**Required behavior:**
- RCL 1-4: Only place containers adjacent to sources
- RCL 5+: Can place container near controller IF storage exists
- One container per source maximum
- Don't place site if container or site already exists at that source

**Implementation:**

```typescript
export class ContainerPlanner {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  run(): void {
    const rcl = this.room.controller?.level || 0;
    
    // Place source containers (RCL 1+)
    this.placeSourceContainers();
    
    // Place controller container only at RCL 5+ with storage
    if (rcl >= 5 && this.room.storage) {
      this.placeControllerContainer();
    }
  }

  private placeSourceContainers(): void {
    const sources = this.room.find(FIND_SOURCES);
    
    for (const source of sources) {
      // Check if container already exists at this source
      const existingContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
      });
      if (existingContainer.length > 0) continue;
      
      // Check if construction site already exists
      const existingSite = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
      });
      if (existingSite.length > 0) continue;
      
      // Find best position adjacent to source
      const pos = this.findContainerPosition(source);
      if (pos) {
        this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
      }
    }
  }

  private placeControllerContainer(): void {
    const controller = this.room.controller;
    if (!controller) return;
    
    // Check if already exists within range 3 of controller
    const existing = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    });
    if (existing.length > 0) return;
    
    const existingSite = controller.pos.findInRange(FIND_CONSTRUCTION_SITES, 3, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    });
    if (existingSite.length > 0) return;
    
    // Find position in range 3 of controller (upgrader range)
    const pos = this.findControllerContainerPosition(controller);
    if (pos) {
      this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
    }
  }

  private findContainerPosition(source: Source): RoomPosition | null {
    // Find walkable tile adjacent to source, preferring tiles closer to spawn
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    const terrain = this.room.getTerrain();
    
    const candidates: { pos: RoomPosition; dist: number }[] = [];
    
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        
        const x = source.pos.x + dx;
        const y = source.pos.y + dy;
        
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        
        const pos = new RoomPosition(x, y, this.room.name);
        const dist = spawn ? pos.getRangeTo(spawn) : 0;
        candidates.push({ pos, dist });
      }
    }
    
    if (candidates.length === 0) return null;
    
    // Sort by distance to spawn (closer = better for haulers)
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates[0].pos;
  }

  private findControllerContainerPosition(controller: StructureController): RoomPosition | null {
    // Similar logic but for range 3 of controller
    // Prefer position also close to storage
    const storage = this.room.storage;
    const terrain = this.room.getTerrain();
    
    const candidates: { pos: RoomPosition; dist: number }[] = [];
    
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const range = Math.max(Math.abs(dx), Math.abs(dy));
        if (range > 3 || range < 2) continue; // Range 2-3 from controller
        
        const x = controller.pos.x + dx;
        const y = controller.pos.y + dy;
        
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        
        const pos = new RoomPosition(x, y, this.room.name);
        const dist = storage ? pos.getRangeTo(storage) : 0;
        candidates.push({ pos, dist });
      }
    }
    
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates[0].pos;
  }

  // Static helper used by Harvester to find source container
  static getSourceContainer(source: Source): StructureContainer | null {
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    }) as StructureContainer[];
    
    return containers.length > 0 ? containers[0] : null;
  }
}
```

---

## Fix 2: Spawner.ts - Renewal Suppression

**File:** `src/core/Spawner.ts`

**Problem:** Renews small creeps even when extensions are building and bigger creeps will be possible soon.

**Add this interface and function:**

```typescript
interface CapacityTransition {
  inTransition: boolean;
  currentCapacity: number;
  futureCapacity: number;
  shouldSuppressRenewal: boolean;
}

function detectCapacityTransition(room: Room): CapacityTransition {
  const currentCapacity = room.energyCapacityAvailable;
  
  const extensionSites = room.find(FIND_CONSTRUCTION_SITES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION
  });
  
  const futureCapacity = currentCapacity + (extensionSites.length * 50);
  const inTransition = extensionSites.length > 0;
  
  // Suppress renewal if capacity increasing by 30%+
  const capacityIncrease = futureCapacity / currentCapacity;
  const shouldSuppressRenewal = inTransition && capacityIncrease >= 1.3;
  
  return {
    inTransition,
    currentCapacity,
    futureCapacity,
    shouldSuppressRenewal,
  };
}
```

**Modify `tryRenewCreeps` method:**

```typescript
private tryRenewCreeps(spawn: StructureSpawn, state: ColonyState): boolean {
  const transition = detectCapacityTransition(spawn.room);
  
  // Find dying creeps near spawn
  const dyingCreeps = Object.values(Game.creeps).filter(c =>
    c.room.name === spawn.room.name &&
    c.ticksToLive !== undefined &&
    c.ticksToLive < 300 &&
    c.pos.isNearTo(spawn)
  );
  
  for (const creep of dyingCreeps) {
    // Calculate creep's energy cost
    const creepCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
    
    // Skip renewal if creep is small and bigger capacity coming
    if (transition.shouldSuppressRenewal) {
      const valueThreshold = transition.futureCapacity * 0.7;
      if (creepCost < valueThreshold) {
        // Don't renew - let it die and spawn bigger replacement
        continue;
      }
    }
    
    const result = spawn.renewCreep(creep);
    if (result === OK) {
      return true;
    }
  }
  
  return false;
}
```

---

## Fix 3: RoadPlanner.ts - Gate Check

**File:** `src/core/RoadPlanner.ts`

**Problem:** Places roads before extensions are built, wasting builder time.

**Add gate check at start of `run()` method:**

```typescript
run(): void {
  const rcl = this.room.controller?.level || 0;
  
  // Don't build roads until RCL 3
  if (rcl < 3) return;
  
  // Don't build roads until extensions are done
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl];
  const builtExtensions = this.room.find(FIND_MY_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION
  }).length;
  
  if (builtExtensions < maxExtensions) return;
  
  // Limit concurrent road sites
  const roadSites = this.room.find(FIND_CONSTRUCTION_SITES, {
    filter: s => s.structureType === STRUCTURE_ROAD
  }).length;
  
  if (roadSites >= 5) return;
  
  // ... rest of existing road planning logic
}
```

---

## Fix 4: ExtensionPlanner.ts (NEW FILE)

**File:** `src/structures/ExtensionPlanner.ts`

**Purpose:** Place extensions in efficient cluster near spawn.

```typescript
import { logger } from "../utils/Logger";

export class ExtensionPlanner {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  run(): void {
    const rcl = this.room.controller?.level || 0;
    if (rcl < 2) return; // Extensions unlock at RCL 2
    
    const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl];
    
    // Count existing + sites
    const builtExtensions = this.room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_EXTENSION
    }).length;
    
    const extensionSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: s => s.structureType === STRUCTURE_EXTENSION
    }).length;
    
    const totalPlanned = builtExtensions + extensionSites;
    
    if (totalPlanned >= maxExtensions) return; // All planned
    
    // Find spawn
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return;
    
    // Place extensions near spawn
    const needed = maxExtensions - totalPlanned;
    const positions = this.findExtensionPositions(spawn.pos, needed);
    
    for (const pos of positions) {
      const result = this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_EXTENSION);
      if (result === OK) {
        logger.info("ExtensionPlanner", `Placed extension site at ${pos.x},${pos.y}`);
      }
    }
  }

  private findExtensionPositions(spawnPos: RoomPosition, count: number): RoomPosition[] {
    const positions: RoomPosition[] = [];
    const terrain = this.room.getTerrain();
    
    // Get existing structures and sites to avoid
    const occupied = new Set<string>();
    
    this.room.find(FIND_STRUCTURES).forEach(s => {
      occupied.add(`${s.pos.x},${s.pos.y}`);
    });
    
    this.room.find(FIND_CONSTRUCTION_SITES).forEach(s => {
      occupied.add(`${s.pos.x},${s.pos.y}`);
    });
    
    // Search in expanding rings around spawn
    for (let range = 2; range <= 6 && positions.length < count; range++) {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          if (positions.length >= count) break;
          
          // Only check tiles at exactly this range (ring, not filled circle)
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (dist !== range) continue;
          
          const x = spawnPos.x + dx;
          const y = spawnPos.y + dy;
          
          // Bounds check
          if (x < 2 || x > 47 || y < 2 || y > 47) continue;
          
          // Terrain check
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
          
          // Occupied check
          if (occupied.has(`${x},${y}`)) continue;
          
          // Don't block spawn exits (tiles adjacent to spawn)
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;
          
          // Prefer checkerboard pattern for easier pathfinding
          if ((x + y) % 2 === 0) {
            positions.push(new RoomPosition(x, y, this.room.name));
            occupied.add(`${x},${y}`);
          }
        }
      }
      
      // Second pass for non-checkerboard if needed
      if (positions.length < count) {
        for (let dx = -range; dx <= range; dx++) {
          for (let dy = -range; dy <= range; dy++) {
            if (positions.length >= count) break;
            
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            if (dist !== range) continue;
            
            const x = spawnPos.x + dx;
            const y = spawnPos.y + dy;
            
            if (x < 2 || x > 47 || y < 2 || y > 47) continue;
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            if (occupied.has(`${x},${y}`)) continue;
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;
            
            positions.push(new RoomPosition(x, y, this.room.name));
            occupied.add(`${x},${y}`);
          }
        }
      }
    }
    
    return positions;
  }
}
```

---

## Fix 5: ConstructionCoordinator.ts (NEW FILE)

**File:** `src/core/ConstructionCoordinator.ts`

**Purpose:** Central gatekeeper that enforces construction priority.

```typescript
interface ConstructionPriority {
  structureType: BuildableStructureConstant;
  priority: number;
  minRCL: number;
  maxConcurrentSites: number;
  condition?: (room: Room) => boolean;
}

const PRIORITIES: ConstructionPriority[] = [
  { structureType: STRUCTURE_SPAWN, priority: 0, minRCL: 1, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_CONTAINER, priority: 1, minRCL: 1, maxConcurrentSites: 2 },
  { structureType: STRUCTURE_EXTENSION, priority: 2, minRCL: 2, maxConcurrentSites: 5 },
  { structureType: STRUCTURE_TOWER, priority: 3, minRCL: 3, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_STORAGE, priority: 4, minRCL: 4, maxConcurrentSites: 1 },
  { 
    structureType: STRUCTURE_ROAD, 
    priority: 5, 
    minRCL: 3, 
    maxConcurrentSites: 5,
    condition: (room) => {
      // Only allow roads after extensions are done
      const rcl = room.controller?.level || 0;
      const maxExt = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl];
      const builtExt = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_EXTENSION
      }).length;
      return builtExt >= maxExt;
    }
  },
  { structureType: STRUCTURE_LINK, priority: 4, minRCL: 5, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_TERMINAL, priority: 5, minRCL: 6, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_LAB, priority: 6, minRCL: 6, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_RAMPART, priority: 7, minRCL: 3, maxConcurrentSites: 5 },
  { structureType: STRUCTURE_WALL, priority: 7, minRCL: 3, maxConcurrentSites: 5 },
];

export class ConstructionCoordinator {
  private room: Room;
  private rcl: number;

  constructor(room: Room) {
    this.room = room;
    this.rcl = room.controller?.level || 0;
  }

  canPlaceSites(structureType: BuildableStructureConstant): boolean {
    const priority = PRIORITIES.find(p => p.structureType === structureType);
    if (!priority) return false;
    
    // Check RCL requirement
    if (this.rcl < priority.minRCL) return false;
    
    // Check custom condition
    if (priority.condition && !priority.condition(this.room)) return false;
    
    // Check if higher priority structures are incomplete
    for (const higherPriority of PRIORITIES) {
      if (higherPriority.priority >= priority.priority) break;
      if (this.rcl < higherPriority.minRCL) continue;
      if (higherPriority.condition && !higherPriority.condition(this.room)) continue;
      
      if (!this.isComplete(higherPriority.structureType)) {
        return false;
      }
    }
    
    // Check concurrent site limit
    const currentSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: s => s.structureType === structureType
    }).length;
    
    return currentSites < priority.maxConcurrentSites;
  }

  private isComplete(structureType: BuildableStructureConstant): boolean {
    // Special case: containers just need to exist at sources
    if (structureType === STRUCTURE_CONTAINER) {
      const sources = this.room.find(FIND_SOURCES);
      for (const source of sources) {
        const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: s => s.structureType === STRUCTURE_CONTAINER
        });
        const site = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
          filter: s => s.structureType === STRUCTURE_CONTAINER
        });
        if (container.length === 0 && site.length === 0) {
          return false; // Missing container at this source
        }
      }
      return true;
    }
    
    // Standard check: built + sites >= max for RCL
    const max = CONTROLLER_STRUCTURES[structureType]?.[this.rcl] || 0;
    if (max === 0) return true; // Not available at this RCL
    
    const built = this.room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === structureType
    }).length;
    
    const sites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: s => s.structureType === structureType
    }).length;
    
    return (built + sites) >= max;
  }

  // Get list of what should be built, in priority order
  getConstructionQueue(): BuildableStructureConstant[] {
    const queue: BuildableStructureConstant[] = [];
    
    for (const priority of PRIORITIES) {
      if (this.rcl < priority.minRCL) continue;
      if (priority.condition && !priority.condition(this.room)) continue;
      
      if (!this.isComplete(priority.structureType)) {
        queue.push(priority.structureType);
      }
    }
    
    return queue;
  }
}
```

---

## Fix 6: Update main.ts

**File:** `src/main.ts`

**Add imports:**

```typescript
import { ExtensionPlanner } from "./structures/ExtensionPlanner";
import { ConstructionCoordinator } from "./core/ConstructionCoordinator";
```

**Replace construction planning section:**

```typescript
// Construction planning (every 20 ticks)
if (Game.time % 20 === 0) {
  const coordinator = new ConstructionCoordinator(room);
  
  // Run planners in priority order, but only if allowed
  if (coordinator.canPlaceSites(STRUCTURE_CONTAINER)) {
    const containerPlanner = new ContainerPlanner(room);
    containerPlanner.run();
  }
  
  if (coordinator.canPlaceSites(STRUCTURE_EXTENSION)) {
    const extensionPlanner = new ExtensionPlanner(room);
    extensionPlanner.run();
  }
  
  // Roads only after extensions complete
  if (coordinator.canPlaceSites(STRUCTURE_ROAD)) {
    const roadPlanner = new RoadPlanner(room);
    roadPlanner.run();
  }
}
```

---

## Immediate Console Fix

While waiting for code deployment, run these to fix current state:

**Remove controller container site:**
```javascript
Game.rooms['E46N37'].find(FIND_CONSTRUCTION_SITES).filter(s=>s.structureType=='container'&&s.pos.getRangeTo(Game.rooms['E46N37'].controller)<5).forEach(s=>s.remove())
```

**Disable renewal temporarily:**
```javascript
Memory.disableRenewal=true
```

---

## Verification Checklist

After deployment:

- [ ] No container sites placed near controller at RCL < 5
- [ ] Extensions placed in cluster near spawn
- [ ] Roads not placed until extensions complete
- [ ] Small creeps not renewed when extensions building
- [ ] Bigger creeps spawned once 550 capacity available
- [ ] Construction queue shows correct priority order

**Console check:**
```javascript
new ConstructionCoordinator(Game.rooms['E46N37']).getConstructionQueue()
```

Should return: `['container', 'extension']` at RCL 2 (or empty if both done)
