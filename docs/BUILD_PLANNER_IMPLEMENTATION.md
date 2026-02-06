# Build Planner & Empire Systems — Implementation Guide

> **Purpose**: This document is the single source of truth for all remaining implementation work. Claude Code should read this before starting any task in these systems. Each phase is independently deployable. Do not skip verification steps.

---

## How To Use This Document

1. Before starting work on any system listed here, read the relevant phase
2. Follow the file locations and integration points exactly
3. Every change must pass the verification checklist before moving to the next step
4. All code fixes are prompt files — do not just explain, implement
5. No optional chaining in game code (Screeps console doesn't support it)
6. Commit and push after every deploy. Update relevant docs.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    EMPIRE MANAGER (future)                       │
│  Strategic priorities, cross-colony allocation                   │
└──────────┬──────────┬──────────┬──────────┬─────────────────────┘
           │          │          │          │
           ▼          ▼          ▼          ▼
    ┌──────────┐┌──────────┐┌──────────┐┌──────────┐
    │ Expansion││ Military ││   Tech   ││ Economy  │
    │ Manager  ││ Manager  ││ Manager  ││ Manager  │
    └──────────┘└──────────┘└──────────┘└──────────┘
           │          │          │          │
           ▼          ▼          ▼          ▼
    ┌─────────────────────────────────────────────────────────────┐
    │              COLONY MANAGER (per room)                       │
    │  Tasks, spawning, phase detection                            │
    │                                                              │
    │  ┌────────────┐ ┌────────────┐ ┌────────────┐               │
    │  │  Blueprint  │ │ Structure  │ │    Link    │               │
    │  │   System    │→│  Planners  │→│  Manager   │               │
    │  └────────────┘ └────────────┘ └────────────┘               │
    │  ┌────────────┐ ┌────────────┐ ┌────────────┐               │
    │  │  Terminal   │ │    Lab     │ │   Market   │               │
    │  │  Manager   │ │  Manager   │ │  Manager   │               │
    │  └────────────┘ └────────────┘ └────────────┘               │
    └─────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  AWS PIPELINE: Segment 90 → Lambda → DynamoDB → EventBridge │
    │  → Step Functions → Claude Analysis → Learning Loop          │
    └─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Fix Critical Build Planner Gaps

**Goal**: Existing colonies place terminals, source links, and labs correctly at RCL 6+.
**Priority**: IMMEDIATE — these are broken right now.
**Dependencies**: None. Entirely within existing placeStructures.ts and ConstructionCoordinator.ts.

### 1A: Terminal Planner

**Problem**: Terminal has no placement logic. Falls through to generic spiral-out-from-spawn in `findBuildPosition()`. Terminal should be range 1 from storage for efficient hauler operations and future inter-colony transfers.

**File**: `src/structures/placeStructures.ts`

**Implementation**:
```typescript
// Add to findBuildPosition(), before the generic spiral-out fallback:

if (type === STRUCTURE_TERMINAL) {
  return findTerminalPosition(room, terrain);
}
```

```typescript
function findTerminalPosition(
  room: Room,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  const storage = room.storage;
  if (!storage) return null;

  const candidates: Array<{ x: number; y: number; score: number }> = [];

  // Terminal must be adjacent to storage (range 1)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = storage.pos.x + dx;
      const y = storage.pos.y + dy;

      if (!isValidBuildPos(room, x, y, terrain)) continue;

      let score = 0;

      // Prefer plain terrain
      if (terrain.get(x, y) === 0) score += 2;

      // Prefer tiles also near spawn (central location)
      const spawn = room.find(FIND_MY_SPAWNS)[0];
      if (spawn) {
        const spawnDist = Math.max(Math.abs(x - spawn.pos.x), Math.abs(y - spawn.pos.y));
        score += Math.max(0, 10 - spawnDist); // closer to spawn = better
      }

      // Bonus for being on a road (existing infrastructure)
      const hasRoad = room.lookForAt(LOOK_STRUCTURES, x, y)
        .some(function(s) { return s.structureType === STRUCTURE_ROAD; });
      if (hasRoad) score += 1;

      candidates.push({ x, y, score });
    }
  }

  candidates.sort(function(a, b) { return b.score - a.score; });
  return candidates[0] || null;
}
```

**Also update**: `ConstructionCoordinator.ts` — terminal is already in CONSTRUCTION_PRIORITIES at priority 5, minRCL 6. Verify it's not blocked by the priority gating (links at priority 4 should complete first).

**Also update**: `placeStructures()` function — add `STRUCTURE_TERMINAL` to the structures array, after `STRUCTURE_LINK` and before `STRUCTURE_EXTRACTOR`.

### 1B: Source Link Placement (3rd+ Links)

**Problem**: `findLinkPosition()` handles controller link (#1) and storage link (#2), then falls back to `findNearSpawnPosition()` for #3+. Source links should be placed within range 2 of sources so harvesters can deposit directly into the link network. LinkManager already categorizes source links correctly — it's purely placement that's broken.

**File**: `src/structures/placeStructures.ts`

**Implementation**: Add source link logic after the storage link check in `findLinkPosition()`:

```typescript
// After the storage link section, before the fallback:

// Third+ priority: Source links (near sources for direct harvester deposit)
const sources = room.find(FIND_SOURCES);
for (const source of sources) {
  // Check if this source already has a link nearby
  const sourceHasLink = existingLinks.some(function(l) {
    return l.pos.getRangeTo(source) <= 2;
  });
  // Also check construction sites
  const sourceHasLinkSite = room.find(FIND_CONSTRUCTION_SITES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_LINK && s.pos.getRangeTo(source) <= 2;
    }
  }).length > 0;

  if (!sourceHasLink && !sourceHasLinkSite) {
    return findSourceLinkPosition(room, source, terrain);
  }
}
```

```typescript
function findSourceLinkPosition(
  room: Room,
  source: Source,
  terrain: RoomTerrain
): { x: number; y: number } | null {
  const candidates: Array<{ x: number; y: number; score: number }> = [];

  // Search range 1-2 from source
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const range = Math.max(Math.abs(dx), Math.abs(dy));
      if (range === 0 || range > 2) continue;

      const x = source.pos.x + dx;
      const y = source.pos.y + dy;

      if (!isValidBuildPos(room, x, y, terrain)) continue;

      let score = 0;

      // Prefer range 1 (adjacent to source — harvester can reach without moving)
      if (range === 1) score += 5;

      // Prefer tiles adjacent to the source container (harvester stands there)
      var containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; }
      });
      for (var i = 0; i < containers.length; i++) {
        var pos = new RoomPosition(x, y, room.name);
        if (pos.isNearTo(containers[i])) {
          score += 10; // Adjacent to container = harvester can transfer without moving
        }
      }

      // Prefer plain terrain
      if (terrain.get(x, y) === 0) score += 1;

      candidates.push({ x, y, score });
    }
  }

  candidates.sort(function(a, b) { return b.score - a.score; });
  return candidates[0] || null;
}
```

**Harvester integration**: `src/creeps/Harvester.ts` already checks for source links within range 2:
```typescript
const sourceLink = source.pos.findInRange(FIND_MY_STRUCTURES, 2, {
  filter: (s) => s.structureType === STRUCTURE_LINK,
})[0] as StructureLink | undefined;
```
This should work automatically once source links are placed correctly.

### 1C: Lab Planner

**Problem**: Labs unlock at RCL 6 (3 labs), RCL 7 (6 labs), RCL 8 (10 labs). No planner exists. All labs in a reaction group must be within range 2 of each other. Need 2 input labs + 1 output lab minimum.

**File**: New file `src/structures/LabPlanner.ts`

**Implementation approach**:
1. Find a cluster area near storage (range 3-8) with enough open tiles
2. Place labs in a diamond/compact pattern where all are within range 2
3. Store lab positions in memory for future expansion at RCL 7/8

```typescript
// Lab cluster patterns (relative positions, all within range 2 of each other)
// 3-lab triangle:
//   L . L
//   . L .
const LAB_PATTERNS_3 = [
  [{ dx: 0, dy: 0 }, { dx: 2, dy: 0 }, { dx: 1, dy: 1 }],
  [{ dx: 0, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 2 }],
];

// 6-lab cluster (RCL 7):
// . L L .
// L L L .
// . L . .
const LAB_PATTERNS_6 = [
  // ... expand from 3-lab base
];

// 10-lab cluster (RCL 8):
// Cross/diamond shape, all within range 2
```

**Key constraints**:
- All labs in a group must be `pos.getRangeTo(otherLab) <= 2`
- Place near storage (terminal will also be near storage after 1A)
- Don't block existing roads or paths
- Score candidate positions by: open space, proximity to storage, terrain quality

**Integration**: Add `STRUCTURE_LAB` to `placeStructures()` structures array and add a `findLabPosition()` function. For initial implementation, place one lab at a time using the pattern as a guide, storing the anchor position in `Memory.colonies[room].labAnchor`.

**Also update**: Add `STRUCTURE_LAB` handling in `findBuildPosition()`.

### 1D: Update Priority List in placeStructures()

**Current** structures array is missing terminal and lab:
```typescript
const structures: BuildableStructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_LINK,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_ROAD,
];
```

**Target**:
```typescript
const structures: BuildableStructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_LINK,
  STRUCTURE_TERMINAL,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_LAB,
  STRUCTURE_ROAD,
];
```

### Phase 1 Verification

- [ ] Terminal places adjacent to storage (range 1), not random spiral position
- [ ] 3rd link places within range 2 of a source, not near spawn
- [ ] 4th link (RCL 7) places at the other source
- [ ] Labs place in a cluster where all are within range 2
- [ ] Existing colonies don't break (backward compatible)
- [ ] Console command: `construction()` shows correct placement for all types
- [ ] No CPU regression (benchmark with `cpu()` before/after)

---

## Phase 2: Blueprint System

**Goal**: Pre-compute all structure positions at claim time. Store as blueprint in memory. Planners read from blueprint instead of computing positions live.
**Priority**: HIGH — prevents RCL 2 extensions from blocking RCL 6 lab positions.
**Dependencies**: Phase 1 (planners must exist before blueprint can orchestrate them).

### 2A: Blueprint Data Structure

**File**: New file `src/core/BlueprintSystem.ts`

```typescript
interface Blueprint {
  anchor: { x: number; y: number };  // Spawn position (origin)
  generated: number;                   // Game.time when generated
  rcl: number;                         // RCL at generation time
  structures: {
    [K in BuildableStructureConstant]?: Array<{ x: number; y: number }>;
  };
  reserved: Array<{ x: number; y: number }>;  // Tiles reserved for future structures
}
```

**Memory location**: `Memory.colonies[roomName].blueprint`

### 2B: Blueprint Generator

Run once at room claim time (or on-demand via console command). Computes positions for ALL structures through RCL 8:

1. Start from spawn position (already calculated by SpawnPlacementCalculator)
2. Place storage (range 3-6 from spawn, central)
3. Place terminal (adjacent to storage)
4. Place lab cluster anchor (near storage, enough open space for 10 labs)
5. Place all 60 extension positions (checkerboard, path-aware)
6. Place link positions (controller, storage, 2x source)
7. Place tower positions (2-5 from spawn, up to 6)
8. Place additional spawn positions (RCL 7/8)
9. Place factory, observer, power spawn, nuker
10. Calculate rampart perimeter over critical structures
11. Mark all future positions as reserved tiles

**Key principle**: Extensions get placed first because there are 60 of them and they consume the most space. Everything else works around the extension layout.

### 2C: Planner Integration

Modify `placeStructures()` to check blueprint first:
```typescript
function findBuildPosition(room, near, type): { x: number; y: number } | null {
  // Check blueprint first
  const blueprint = Memory.colonies && Memory.colonies[room.name]
    && Memory.colonies[room.name].blueprint;
  if (blueprint && blueprint.structures[type]) {
    const positions = blueprint.structures[type];
    // Find first unbuilt position
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      if (isValidBuildPos(room, pos.x, pos.y, room.getTerrain())) {
        return pos;
      }
    }
  }

  // Fall through to existing planners if no blueprint
  // ... existing code ...
}
```

### 2D: Reserved Tile Protection

Modify `isValidBuildPos()` to check reserved tiles:
```typescript
function isValidBuildPos(room, x, y, terrain): boolean {
  // ... existing checks ...

  // Check if tile is reserved for a future structure
  var blueprint = Memory.colonies && Memory.colonies[room.name]
    && Memory.colonies[room.name].blueprint;
  if (blueprint && blueprint.reserved) {
    for (var i = 0; i < blueprint.reserved.length; i++) {
      if (blueprint.reserved[i].x === x && blueprint.reserved[i].y === y) {
        return false;  // Reserved for future use
      }
    }
  }

  return true;
}
```

### 2E: Console Commands

```typescript
global.blueprint = function(roomName?: string) { /* show blueprint status */ };
global.regenBlueprint = function(roomName: string) { /* regenerate blueprint */ };
global.showBlueprint = function(roomName: string) { /* visual overlay of planned positions */ };
```

### Phase 2 Verification

- [ ] Blueprint generates for existing colonies via console command
- [ ] Blueprint generates automatically for newly claimed rooms
- [ ] Reserved tiles prevent roads/containers from being placed on future structure positions
- [ ] `showBlueprint()` renders visual overlay showing all planned positions
- [ ] Existing structures are respected (blueprint adapts to what's already built)
- [ ] Blueprint survives memory serialization (no object references)

---

## Phase 3: Terminal Operations & Inter-Colony Economy

**Goal**: Terminals transfer energy and minerals between colonies. Market integration for buying/selling.
**Priority**: HIGH — required for multi-colony viability.
**Dependencies**: Phase 1A (terminal placement).

### 3A: Terminal Manager

**File**: New file `src/structures/TerminalManager.ts`

**Responsibilities**:
- Maintain minimum energy reserve in terminal (configurable, ~20K default)
- Transfer excess energy to colonies that need it
- Transfer minerals to colonies with labs
- Buy/sell on market when profitable

```typescript
interface TerminalConfig {
  minEnergy: number;           // Keep this much in terminal
  maxEnergy: number;           // Don't exceed this (waste of space)
  energyShareThreshold: number; // Only share if storage has this much
  mineralShareEnabled: boolean;
}
```

**Integration points**:
- Main loop: Run after link manager, every 10 ticks (terminal has 10-tick cooldown)
- ColonyManager: Add SUPPLY_TERMINAL task type for haulers to fill terminal
- AWSExporter: Export terminal state (resources, cooldown)

### 3B: Empire Resource Allocator

**File**: New file `src/empire/ResourceAllocator.ts`

Cross-colony resource balancing:
1. Each colony reports: energy surplus/deficit, mineral inventory, needs
2. Allocator calculates optimal transfers
3. Terminal manager executes transfers

**Decision logic**:
- Colony below 50K storage energy = energy deficit
- Colony above 200K storage energy = energy surplus
- Transfer cost: 10% energy overhead per terminal.send()
- Only transfer if net benefit > 0

### 3C: Hauler Terminal Integration

Haulers need to know when to fill terminal vs storage:
- Terminal below minEnergy → SUPPLY_TERMINAL task generated
- Terminal above maxEnergy → hauler withdraws from terminal to storage
- Add to ColonyManager task generation

### Phase 3 Verification

- [ ] Terminal maintains configurable energy reserve
- [ ] Energy flows from surplus to deficit colonies automatically
- [ ] Haulers fill terminal when below minimum
- [ ] Terminal doesn't over-fill (respects maxEnergy)
- [ ] transfer costs are accounted for in surplus/deficit calculations
- [ ] Console command: `terminal()` shows terminal state across all colonies

---

## Phase 4: Lab System & Mineral Processing

**Goal**: Produce mineral compounds for boosting creeps.
**Priority**: MEDIUM — significant power increase but not blocking.
**Dependencies**: Phase 1C (lab placement), Phase 3 (terminal for mineral transfers).

### 4A: Lab Manager

**File**: New file `src/structures/LabManager.ts`

**Core concepts**:
- 2 input labs + 1+ output labs per reaction
- Input labs are loaded with reagents by haulers
- Output lab runs reaction every 5 ticks (LAB_COOLDOWN = 10, but reactions take 5)
- Output products are withdrawn by haulers to terminal/storage

**State machine**:
```
IDLE → LOADING → REACTING → UNLOADING → IDLE
```

**Reaction selection**: Score available reactions by:
1. Do we have both reagents (in terminal/storage)?
2. Is the product useful (needed for boosts we actually use)?
3. Is there demand from military or economy?

### 4B: Mineral Harvester Integration

`src/creeps/MineralHarvester.ts` already exists but needs lab awareness:
- Deliver minerals to terminal (for transfer) or storage (for local use)
- Only harvest when terminal/storage has capacity
- Stop harvesting when mineral type is oversupplied

### 4C: Boost Manager

**File**: New file `src/structures/BoostManager.ts`

Pre-spawn boost preparation:
1. Before spawning a combat/economy creep that benefits from boosts
2. Load appropriate compound into a lab near spawn
3. After spawn, creep moves to lab and calls `lab.boostCreep(creep)`
4. Then proceeds with normal role

**Useful boosts** (prioritized):
- `XGHO2` — +300% tough (defense)
- `XUH2O` — +300% attack
- `XLHO2` — +300% heal
- `XKH2O` — +150% carry (haulers)
- `XLH2O` — +100% repair

### Phase 4 Verification

- [ ] Labs run reactions when reagents available
- [ ] Haulers load input labs and unload output labs
- [ ] Mineral harvester delivers to terminal
- [ ] Boost manager loads labs before combat creep spawn
- [ ] Console command: `labs()` shows reaction state, reagent levels
- [ ] No CPU spike from lab management (< 0.5 CPU/tick)

---

## Phase 5: Layout Simulation & Testing

**Goal**: Validate base layouts before committing. Extend Monte Carlo testing to layout evaluation.
**Priority**: MEDIUM — prevents bad layouts, but existing colonies are already built.
**Dependencies**: Phase 2 (blueprint system to generate candidate layouts).

### 5A: Pathfinding Cost Analyzer

**File**: New file `tests/layout/pathCostAnalyzer.ts`

Given a blueprint + terrain, calculate:
- Average path distance: spawn → each source
- Average path distance: storage → controller
- Extension fill loop distance (hauler visits all extensions)
- Bottleneck detection: tiles with only 1 walkable neighbor

### 5B: Layout Scorer

Score a layout by weighted criteria:
```typescript
interface LayoutScore {
  spawnToSourceAvg: number;      // Lower = better
  storageToControllerDist: number;
  extensionFillTime: number;     // Ticks for 1 hauler to fill all
  bottleneckCount: number;       // 1-wide corridors
  compactness: number;           // How tight is the base footprint
  rampartPerimeter: number;      // Tiles needing rampart coverage
  total: number;                 // Weighted composite
}
```

### 5C: Monte Carlo Layout Tester

Generate N candidate blueprints → score each → pick winner:
1. For each candidate, randomize extension placement order
2. Run pathfinding simulation for 1000 virtual ticks
3. Measure throughput: energy delivered to controller per tick
4. Pick layout with highest throughput

**Integration**: Run at claim time before committing blueprint. Store top 3 candidates, let user pick via console or auto-select best.

### Phase 5 Verification

- [ ] Layout scorer produces consistent scores for same layout
- [ ] Monte Carlo generates meaningfully different layouts
- [ ] Best-scored layout is measurably better than worst
- [ ] Bottleneck detection flags known problem areas
- [ ] Runs in < 5 seconds for 100 candidates (acceptable for claim-time one-shot)

---

## Phase 6: Event-Driven AI Advisor Pipeline

**Goal**: Transform AI advisor from scheduled polling to reactive event-driven system with learning.
**Priority**: MEDIUM — current system works but generates stale/duplicate recommendations.
**Dependencies**: None for AWS work. Phase 3 for terminal metrics.
**Reference**: See `event_driven_advisor_architecture.md` for full design.

### 6A: DynamoDB Streams + EventBridge

**AWS Changes** (CloudFormation):
1. Enable DynamoDB Streams on snapshots table
2. Create EventBridge bus: `screeps-advisor-events`
3. Stream processor Lambda: reads DynamoDB stream → publishes events to EventBridge

**Event types**:
- `colony.snapshot.new` — new snapshot arrived
- `colony.energy.crash` — energy dropped >50% between snapshots
- `colony.spawner.stall` — no spawns for extended period
- `colony.rcl.up` — RCL increased
- `colony.threat.detected` — hostiles appeared

### 6B: Analysis Step Function

Replace scheduled hourly analysis with event-triggered workflow:

```
Fetch Context → Compare Baseline → Detect Patterns → Filter Stale → Has New? → Call Claude → Filter Dupes → Store
```

**Trigger**: EventBridge rule matching `colony.snapshot.new` events.

**Key improvement**: Only call Claude when NEW patterns are detected. If nothing changed since last analysis, skip entirely. This reduces Claude API costs significantly.

### 6C: Recommendation Lifecycle

```
PENDING → IMPLEMENTED | STALE | REJECTED
```

- **PENDING**: New recommendation, not yet acted on
- **IMPLEMENTED**: Metrics improved after recommendation (auto-detected)
- **STALE**: Underlying condition resolved without implementation
- **REJECTED**: User marked as not useful

**TTL**: Recommendations expire after 2 hours if still PENDING.

### 6D: Outcome Evaluator (Learning Loop)

Triggered by each new snapshot:
1. Load PENDING recommendations for this room
2. For each: compare current metrics against recommendation's expected outcome
3. If metrics improved → mark IMPLEMENTED, boost pattern confidence
4. If issue resolved naturally → mark STALE, slight confidence reduction
5. If metrics worsened → no change, recommendation still relevant

**Pattern confidence**: Stored in DynamoDB `pattern-confidence` table. Patterns with <30% success rate are suppressed (not sent to Claude).

### Phase 6 Verification

- [ ] Events fire when snapshots arrive
- [ ] Step Function only invokes Claude when new patterns detected
- [ ] Duplicate recommendations are filtered
- [ ] Stale recommendations auto-expire
- [ ] Outcome evaluator correctly identifies IMPLEMENTED vs STALE
- [ ] Claude API cost drops by >50% compared to hourly polling
- [ ] Console command: `advisor()` shows recommendation state

---

## Phase 7: Military System

**Goal**: Squad-based combat beyond basic defenders.
**Priority**: LOW — gated behind RCL 7+ for economic viability.
**Dependencies**: Phase 4 (boosts for combat effectiveness).
**Reference**: See `empire-architecture.md` Module 3: Military Manager.

### 7A: Threat Assessment

**File**: New file `src/combat/ThreatAssessor.ts`

Score incoming threats:
- Body part analysis (ATTACK, RANGED_ATTACK, HEAL, TOUGH parts)
- Boosted detection (boosted parts = 4x multiplier)
- Count and composition
- Proximity to critical structures

### 7B: Squad System

**File**: New file `src/combat/SquadManager.ts`

Squad types:
- **Patrol**: 1 ranged + 1 healer, defends remote rooms
- **Strike**: 2 attack + 1 healer, clears invader cores
- **Siege**: 2 ranged + 2 healer, sustained damage for player conflicts

Squad state machine: `FORMING → RALLYING → ENGAGED → RETREATING → DISBANDED`

### 7C: Safe Mode Automation

Existing `AutoSafeMode.ts` — extend with:
- Pre-emptive safe mode when threat assessment exceeds defense capacity
- Coordinate with military manager (don't safe-mode if reinforcements incoming)

### Phase 7 Verification

- [ ] Threat assessment correctly scores boosted vs unboosted attackers
- [ ] Squads form, rally at a point, and engage together
- [ ] Squads retreat when healer is dead or outnumbered
- [ ] Safe mode triggers appropriately
- [ ] No spawner starvation from military creep production

---

## Phase 8: Late-Game Structures

**Goal**: RCL 7-8 structure support.
**Priority**: LOW — only relevant at high RCL.
**Dependencies**: Phase 2 (blueprint has positions), Phase 4 (labs for factory input).

### 8A: Additional Spawns (RCL 7/8)

Add to blueprint generator:
- 2nd spawn: 4-6 tiles from first spawn, near extensions, not blocking paths
- 3rd spawn: Opposite side of base from 2nd

### 8B: Factory

**File**: New file `src/structures/FactoryManager.ts`
- Place near storage/terminal
- Produces commodities from mineral compounds
- Factory level determines available recipes

### 8C: Observer

**File**: Add to existing intel/scouting system
- Place anywhere (no positional requirement)
- Use for remote room visibility (replace manual scouting)

### 8D: Power Spawn + Nuker

- Power Spawn: Near storage, processes power for GPL
- Nuker: Anywhere in base, loads with energy + ghodium over time

### Phase 8 Verification

- [ ] 2nd spawn places in a useful location (near extensions)
- [ ] Factory produces when resources available
- [ ] Observer provides vision to expansion candidates
- [ ] Blueprint includes positions for all RCL 8 structures

---

## Execution Order & Dependencies

```
Phase 1 (Fix planners)        — NO DEPENDENCIES, do first
  ├─ 1A: Terminal planner
  ├─ 1B: Source link placement
  ├─ 1C: Lab planner
  └─ 1D: Priority list update

Phase 2 (Blueprint system)    — depends on Phase 1
  ├─ 2A-2C: Core blueprint
  └─ 2D-2E: Reserved tiles + console

Phase 3 (Terminal operations)  — depends on Phase 1A
  ├─ 3A: Terminal manager
  ├─ 3B: Resource allocator
  └─ 3C: Hauler integration

Phase 4 (Labs)                — depends on Phase 1C + Phase 3
Phase 5 (Simulation)          — depends on Phase 2
Phase 6 (AI advisor)          — independent (AWS only)
Phase 7 (Military)            — depends on Phase 4
Phase 8 (Late-game)           — depends on Phase 2
```

Phases 1, 3, and 6 can run in parallel.
Phases 5 and 8 are lowest priority and can be deferred.

---

## File Index

### New Files to Create

| File | Phase | Purpose |
|------|-------|---------|
| `src/structures/LabPlanner.ts` | 1C | Lab cluster position finding |
| `src/core/BlueprintSystem.ts` | 2 | Blueprint generation and storage |
| `src/structures/TerminalManager.ts` | 3A | Terminal operations and logistics |
| `src/empire/ResourceAllocator.ts` | 3B | Cross-colony resource balancing |
| `src/structures/LabManager.ts` | 4A | Lab reactions and state machine |
| `src/structures/BoostManager.ts` | 4C | Pre-spawn boost preparation |
| `src/combat/ThreatAssessor.ts` | 7A | Hostile threat scoring |
| `src/combat/SquadManager.ts` | 7B | Squad formation and coordination |
| `src/structures/FactoryManager.ts` | 8B | Factory commodity production |
| `tests/layout/pathCostAnalyzer.ts` | 5A | Layout path cost calculation |
| `tests/layout/layoutScorer.ts` | 5B | Blueprint quality scoring |

### Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `src/structures/placeStructures.ts` | 1A-1D | Add terminal, source link, lab placement |
| `src/core/ConstructionCoordinator.ts` | 1D | Verify priority gating for new types |
| `src/main.ts` | 3A, 4A | Wire terminal manager, lab manager into loop |
| `src/core/ColonyManager.ts` | 3C, 4A | Add SUPPLY_TERMINAL task, lab tasks |
| `src/spawning/spawnCreeps.ts` | 4C | Boost-aware spawning |
| `src/creeps/Hauler.ts` | 3C, 4A | Terminal + lab filling logic |
| `src/utils/AWSExporter.ts` | 3A | Export terminal/lab state |
| `src/utils/Console.ts` | All | New console commands per phase |
| `docs/CONSTRUCTION.md` | 1 | Document new planners |
| `docs/ARCHITECTURE.md` | 2-4 | Update system descriptions |
| `CLAUDE.md` | All | Update "Current State" section |

### AWS Files (Phase 6)

| File | Purpose |
|------|---------|
| `aws/cloudformation/template.yaml` | Add DynamoDB Streams, EventBridge, Step Functions |
| `aws/lambda/stream-processor/index.ts` | DynamoDB Stream → EventBridge events |
| `aws/lambda/pattern-detector/index.ts` | Step Function: detect patterns |
| `aws/lambda/outcome-evaluator/index.ts` | Step Function: evaluate recommendations |

---

## Console Commands (Add All)

```typescript
// Phase 1
global.construction = function(roomName?) { /* existing + new types */ };
global.blueprint = function(roomName?) { /* blueprint status */ };
global.showBlueprint = function(roomName) { /* visual overlay */ };
global.regenBlueprint = function(roomName) { /* regenerate */ };

// Phase 3
global.terminal = function(roomName?) { /* terminal state all colonies */ };
global.resources = function() { /* empire-wide resource inventory */ };
global.transfer = function(from, to, resource, amount) { /* manual transfer */ };

// Phase 4
global.labs = function(roomName?) { /* lab state, reactions, reagents */ };
global.reactions = function() { /* available reactions and profitability */ };
global.boosts = function(roomName?) { /* boost inventory and demand */ };

// Phase 7
global.military = function() { /* squad status, threat levels */ };
global.squad = function(type, target) { /* manual squad creation */ };
global.threat = function(roomName?) { /* threat assessment */ };
```

---

## Testing Strategy

### Unit Tests (Offline)
- Blueprint generator: given terrain + source positions → valid blueprint
- Layout scorer: consistent scores, better layouts score higher
- Terminal allocator: surplus/deficit calculation correctness
- Lab reaction selection: picks best available reaction

### Monte Carlo Tests (Existing Framework)
- Extend `tests/spawner/` with layout and economy scenarios
- Add invariant: "terminal manager never drains storage below 10K"
- Add invariant: "lab manager never loads wrong reagent combination"

### In-Game Verification
- Console commands for every system
- Visual overlays for blueprints and planned positions
- AWS dashboard for advisor metrics

---

## Principles (Reiterated)

1. **Simple working code > complex broken code** — start with the minimum viable implementation for each phase, then iterate
2. **One structure per tick** — never break this rule in placeStructures
3. **No optional chaining** in game code — Screeps console doesn't support it
4. **Root cause over symptoms** — if something's broken, trace it to the source
5. **Test before deploy** — sim first, then main
6. **Commit after every deploy** — GitHub must match what's running
7. **Update docs with code** — if you changed it, document it
