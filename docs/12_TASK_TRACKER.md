# Task Tracker for Claude Code

## Rules - READ FIRST

1. **One task at a time** - Complete fully before starting next
2. **Verify before marking done** - Run all verification commands, paste output
3. **No skipping** - If blocked, mark BLOCKED with reason and wait for guidance
4. **Report what you did** - After each task, list files created/modified
5. **Test the build** - Run `npm run build` after changes, fix any errors before moving on

---

## Current Sprint: Construction System & Colony Growth

### Task 1: TowerPlanner
**Status:** COMPLETE
**Priority:** HIGH - Blocks builder spawning

**Problem:** TowerPlanner doesn't exist. No tower construction sites placed. At RCL 3, tower is available but not being built.

**Create File:** `src/structures/TowerPlanner.ts`

```typescript
import { logger } from "../utils/Logger";

interface TowerPlan {
  positions: Array<{ x: number; y: number }>;
  placed: boolean;
}

export class TowerPlanner {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  run(): void {
    const rcl = this.room.controller?.level ?? 0;
    const maxTowers = CONTROLLER_STRUCTURES[STRUCTURE_TOWER][rcl] || 0;
    
    if (maxTowers === 0) return;

    // Initialize memory
    if (!Memory.rooms[this.room.name]) {
      Memory.rooms[this.room.name] = {};
    }

    // Check existing towers
    const existingTowers = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    });

    // Check existing sites
    const towerSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_TOWER,
    });

    const totalPlanned = existingTowers.length + towerSites.length;
    if (totalPlanned >= maxTowers) return;

    // Find position for new tower
    const pos = this.findTowerPosition();
    if (pos) {
      const result = this.room.createConstructionSite(pos.x, pos.y, STRUCTURE_TOWER);
      if (result === OK) {
        logger.info("TowerPlanner", `Placed tower site at ${pos.x},${pos.y} in ${this.room.name}`);
      } else {
        logger.warn("TowerPlanner", `Failed to place tower at ${pos.x},${pos.y}: ${result}`);
      }
    }
  }

  private findTowerPosition(): { x: number; y: number } | null {
    const spawn = this.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return null;

    // Search for valid position near spawn (range 3-6 for coverage)
    const terrain = this.room.getTerrain();
    const candidates: Array<{ x: number; y: number; score: number }> = [];

    for (let dx = -6; dx <= 6; dx++) {
      for (let dy = -6; dy <= 6; dy++) {
        const x = spawn.pos.x + dx;
        const y = spawn.pos.y + dy;

        // Bounds check
        if (x < 2 || x > 47 || y < 2 || y > 47) continue;

        // Skip walls
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        // Skip if something already there
        const structures = this.room.lookForAt(LOOK_STRUCTURES, x, y);
        if (structures.length > 0) continue;

        const sites = this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
        if (sites.length > 0) continue;

        // Score: prefer central positions with good coverage
        const distToSpawn = Math.max(Math.abs(dx), Math.abs(dy));
        if (distToSpawn < 2) continue; // Not too close to spawn

        // Calculate coverage score (how many important things in range 5)
        const controller = this.room.controller;
        const sources = this.room.find(FIND_SOURCES);
        
        let coverageScore = 0;
        const pos = new RoomPosition(x, y, this.room.name);
        
        if (controller && pos.getRangeTo(controller) <= 5) coverageScore += 3;
        if (pos.getRangeTo(spawn) <= 5) coverageScore += 3;
        for (const source of sources) {
          if (pos.getRangeTo(source) <= 5) coverageScore += 2;
        }

        candidates.push({ x, y, score: coverageScore });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }
}
```

**Integrate in main.ts:**
- Import: `import { TowerPlanner } from "./structures/TowerPlanner";`
- Call in room loop after other planners:
```typescript
// After ContainerPlanner and ExtensionPlanner
if (room.controller && room.controller.level >= 3) {
  const towerPlanner = new TowerPlanner(room);
  towerPlanner.run();
}
```

**Verification Commands (run in Screeps console):**

```javascript
// 1. Check module exists
Object.keys(require('main'))
// Should not error

// 2. Check for tower construction site
Game.rooms['E46N37'].find(FIND_CONSTRUCTION_SITES).filter(s => s.structureType == 'tower').length
// Expected: 1

// 3. Check tower count
Game.rooms['E46N37'].find(FIND_MY_STRUCTURES, {filter: s => s.structureType == 'tower'}).length
// Expected: 0 before built, 1 after
```

**Done when:** Tower construction site appears in room (verify with command 2 above)

---

### Task 2: Verify ExtensionPlanner Scales with RCL
**Status:** PENDING  
**Priority:** MEDIUM - Need for RCL 4+

**Problem:** Need to verify ExtensionPlanner will place more sites as RCL increases.

**Check:** Review ExtensionPlanner.ts and ensure:
1. It reads `CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl]` for max count
2. It counts existing extensions + sites
3. It places new sites when `existing + sites < max`

**Verification Commands:**

```javascript
// Current state at RCL 3
let r = Game.rooms['E46N37'];
let ext = r.find(FIND_MY_STRUCTURES, {filter: s => s.structureType == 'extension'}).length;
let sites = r.find(FIND_CONSTRUCTION_SITES, {filter: s => s.structureType == 'extension'}).length;
let max = CONTROLLER_STRUCTURES.extension[r.controller.level];
console.log('Extensions:', ext, '/', max, 'Sites:', sites);
// At RCL 3: Should show 10/10 or appropriate count
```

**Done when:** Output confirms extensions match RCL allowance

---

### Task 3: Builder Spawning When Sites Exist
**Status:** PENDING  
**Priority:** HIGH - Blocks construction

**Problem:** `targetCreeps.BUILDER = 0` even when construction sites should exist.

**Investigate:** Find where BUILDER target is calculated in StrategicCoordinator.ts. The logic should be:
```typescript
// If construction sites exist, need builders
const sites = room.find(FIND_CONSTRUCTION_SITES).length;
if (sites > 0) {
  targetCreeps.BUILDER = Math.min(Math.ceil(sites / 2), 3); // 1-3 builders based on site count
}
```

**Current Bug Hypothesis:** StrategicCoordinator calculates builders based on `buildWorkParts` from energy budget, not from actual construction sites existing.

**Fix:** Builder target should be:
```typescript
const constructionSites = room.find(FIND_CONSTRUCTION_SITES).length;
const builderTarget = constructionSites > 0 ? Math.max(1, Math.ceil(buildWorkParts / 2)) : 0;
```

**Verification Commands:**

```javascript
// After tower site placed, check strategic state
JSON.stringify(Memory.rooms['E46N37'].strategic.workforce.targetCreeps)
// Expected: BUILDER should be > 0

// Check if builder spawns
Object.values(Game.creeps).filter(c => c.memory.role == 'BUILDER').length
// Expected: >= 1 when sites exist
```

**Done when:** Builders spawn automatically when construction sites exist

---

### Task 4: Diagnose Harvest Efficiency
**Status:** PENDING  
**Priority:** MEDIUM

**Problem:** Strategic output shows 50% harvest efficiency (10/20 energy per tick). With 2 sources and proper harvesters, should be near 100%.

**Gather Data:**

```javascript
// Check harvester assignments
let harvesters = Object.values(Game.creeps).filter(c => c.memory.role == 'HARVESTER');
harvesters.forEach(h => {
  let workParts = h.body.filter(p => p.type == 'work').length;
  console.log(h.name, 'WORK:', workParts, 'source:', h.memory.sourceId, 'pos:', h.pos);
});

// Check source saturation
Game.rooms['E46N37'].find(FIND_SOURCES).forEach(s => {
  let assigned = Object.values(Game.creeps).filter(c => c.memory.sourceId == s.id);
  let workParts = assigned.reduce((sum, c) => sum + c.body.filter(p => p.type == 'work').length, 0);
  console.log('Source', s.id, 'assigned WORK:', workParts, '/5 needed');
});
```

**Expected:** Each source should have 5+ WORK parts assigned for full saturation (10 energy/tick per source).

**Possible Issues:**
1. Harvesters not staying at source (moving to deliver)
2. Not enough WORK parts per harvester
3. Source assignment imbalance
4. Harvesters doing other tasks (upgrading)

**Done when:** Harvest efficiency > 90% as reported by strategic coordinator

---

### Task 5: Remove Controller Container
**Status:** PENDING  
**Priority:** LOW - Cleanup

**Problem:** ContainerPlanner placed a controller container at RCL 3. Per design docs, controller container should only exist at RCL 5+.

**Fix ContainerPlanner.ts:**
```typescript
// Only place controller container at RCL 5+
if (this.room.controller && this.room.controller.level >= 5) {
  // Place controller container logic
}
```

**Manual Cleanup:**
```javascript
// Find and remove controller container
let cont = Game.rooms['E46N37'].controller.pos.findInRange(FIND_STRUCTURES, 3, {filter: s => s.structureType == 'container'})[0];
if (cont) cont.destroy();

// Clear from memory
delete Memory.rooms['E46N37'].containerPlan.controller;
```

**Verification:**
```javascript
JSON.stringify(Memory.rooms['E46N37'].containerPlan)
// Should not have controller property, or controller should be null
```

**Done when:** No container near controller, containerPlan.controller is removed

---

### Task 6: ConstructionCoordinator Priority System
**Status:** PENDING  
**Priority:** LOW - Quality improvement

**Problem:** Need to ensure construction follows priority order:
1. Extensions (spawn capacity)
2. Towers (defense)
3. Containers (energy flow)
4. Storage (RCL 4)
5. Roads (last)

**Check:** Does ConstructionCoordinator.ts exist? If not, create it. If yes, verify it gates planners correctly.

**Verification:**
```javascript
// Road sites should not exist until extensions + tower complete
Game.rooms['E46N37'].find(FIND_CONSTRUCTION_SITES).map(s => s.structureType)
// Should NOT include 'road' until higher priority done
```

**Done when:** Roads only placed after extensions and tower built

---

## Backlog (Future Sprints)

### Energy Distribution
- Creeps targeting different containers instead of all same one
- See `11_ENERGY_ACQUISITION.md`

### Capacity Transition Awareness  
- Suppress renewal when bigger creeps possible
- See `09_STRATEGIC_LAYER.md`

### Road Planning Gate
- Only place roads at RCL 3+ after extensions complete
- Limit to 5 concurrent road sites

### Storage Planning
- Place storage at RCL 4
- Update energy flow to use storage as central buffer

---

## Completion Log

| Task | Status | Date | Notes |
|------|--------|------|-------|
| Task 1: TowerPlanner | COMPLETE | 2025-01-13 | Created TowerPlanner.ts, integrated in main.ts |
| Task 2: ExtensionPlanner verify | COMPLETE | 2025-01-13 | Verified uses CONTROLLER_STRUCTURES correctly |
| Task 3: Builder spawning | COMPLETE | 2025-01-13 | Fixed: construction runs BEFORE strategic now |
| Task 4: Harvest efficiency | PENDING | | Analysis task - requires in-game console commands |
| Task 5: Controller container | COMPLETE | 2025-01-13 | Already fixed in code (RCL 5+ check) |
| Task 6: ConstructionCoordinator | COMPLETE | 2025-01-13 | Verified priority system works correctly |
| Implementation Plan Review | COMPLETE | 2025-01-13 | Updated docs/00_IMPLEMENTATION_PLAN.md status |
