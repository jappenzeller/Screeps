# Construction System

## Overview

Structure placement is handled by:
- **placeStructures.ts** - Main placement coordinator
- **ConstructionCoordinator** - Priority gating
- **Specialized planners** - ContainerPlanner, ExtensionPlanner, etc.

## One Structure Per Tick

To avoid CPU spikes, only **one structure** is placed per tick. The system cycles through priorities until something is placed or nothing is needed.

## Priority Order

```
1. SPAWN         (if need additional spawns)
2. CONTAINER     (at sources first, then controller)
3. EXTENSION     (energy capacity)
4. TOWER         (defense)
5. STORAGE       (RCL 4)
6. LINK          (RCL 5+)
7. EXTRACTOR     (RCL 6)
8. ROAD          (after core structures)
9. RAMPART/WALL  (defense, last priority)
```

## Structure Placement

### Containers (ContainerPlanner.ts)

**At Sources:**
- 1 container per source
- Adjacent to source (range 1)
- Closer to spawn preferred (shorter hauler trips)

**At Controller:**
- Only at RCL 5+ with storage
- Range 2-3 from controller
- Enables efficient upgrading

### Extensions (ExtensionPlanner.ts)

**Placement Strategy:**
- Cluster near spawn (easier to fill)
- Checkerboard pattern (walkable paths)
- Avoid blocking spawn exits
- Range 2-6 from spawn

**Extension Counts:**

| RCL | Extensions | Energy Capacity |
|-----|------------|-----------------|
| 2 | 5 | 550 |
| 3 | 10 | 800 |
| 4 | 20 | 1,300 |
| 5 | 30 | 1,800 |
| 6 | 40 | 2,300 |
| 7 | 50 | 5,600* |
| 8 | 60 | 12,900* |

*Extensions hold 100 energy at RCL 7+, 50 before

### Storage

**Placement:**
- 3-6 tiles from spawn
- On main traffic path
- Central to hauler routes

**Unlocks at:** RCL 4

### Links (LinkManager.ts)

Two link types:
1. **Controller Link** - Near controller for upgraders
2. **Storage Link** - Near storage for hauler chain

**Placement:**
- Controller link: Range 2-4 from controller
- Storage link: On hauler traffic path

**Unlocks at:** RCL 5

### Towers (TowerPlanner.ts)

**Placement:**
- 2-5 tiles from spawn (protect core)
- Centered in base (minimize range penalty)

**Unlocks at:** RCL 3

### Roads (RoadPlanner.ts, SmartRoadPlanner.ts)

**Priority Paths:**
1. Spawn → Sources
2. Spawn → Controller
3. High-traffic areas (from heatmap)

**Gating:**
- Only after extensions complete
- RCL 3+ preferred
- Limited concurrent sites (5 max)

## ConstructionCoordinator

Gates what can be built based on:
- RCL requirements
- Higher-priority structures incomplete
- Concurrent site limits

```typescript
canPlaceSites(structureType): boolean {
  // Check RCL
  if (rcl < structureMinRCL) return false;

  // Check higher priorities complete
  for (higherPriority of PRIORITIES) {
    if (!isComplete(higherPriority)) return false;
  }

  // Check concurrent limit
  return currentSites < maxConcurrent;
}
```

### Priority Configuration

```typescript
const PRIORITIES = [
  { type: STRUCTURE_SPAWN, priority: 0, minRCL: 1, maxSites: 1 },
  { type: STRUCTURE_CONTAINER, priority: 1, minRCL: 1, maxSites: 2 },
  { type: STRUCTURE_EXTENSION, priority: 2, minRCL: 2, maxSites: 5 },
  { type: STRUCTURE_TOWER, priority: 3, minRCL: 3, maxSites: 1 },
  { type: STRUCTURE_STORAGE, priority: 4, minRCL: 4, maxSites: 1 },
  { type: STRUCTURE_ROAD, priority: 5, minRCL: 3, maxSites: 5,
    condition: extensionsComplete },
];
```

## Builder Behavior

### BUILD Task Assignment

ColonyManager generates BUILD tasks when:
- Construction sites exist
- Energy available
- Not in EMERGENCY phase

### Builder Logic

1. Get BUILD task from ColonyManager
2. Find energy (container > storage > harvest)
3. Move to construction site
4. Build until empty
5. Repeat

### Max Builders

Limited to 2-3 to avoid:
- CPU overhead
- Traffic congestion
- Energy starvation

## Traffic-Aware Roads

SmartRoadPlanner analyzes traffic heatmap:

```typescript
// High traffic tiles get road suggestions
const threshold = averageTraffic * 2;
const candidates = Object.entries(heatmap)
  .filter(([_, count]) => count > threshold)
  .map(([pos, _]) => pos);
```

Roads reduce fatigue, speeding up creep movement on high-traffic paths.

## Structure Limits by RCL

| Structure | RCL 1 | RCL 2 | RCL 3 | RCL 4 | RCL 5 | RCL 6 | RCL 7 | RCL 8 |
|-----------|-------|-------|-------|-------|-------|-------|-------|-------|
| Spawn | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 3 |
| Extension | 0 | 5 | 10 | 20 | 30 | 40 | 50 | 60 |
| Tower | 0 | 0 | 1 | 1 | 2 | 2 | 3 | 6 |
| Storage | 0 | 0 | 0 | 1 | 1 | 1 | 1 | 1 |
| Link | 0 | 0 | 0 | 0 | 2 | 3 | 4 | 6 |
| Extractor | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| Terminal | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| Lab | 0 | 0 | 0 | 0 | 0 | 3 | 6 | 10 |
| Container | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| Road | ∞ | ∞ | ∞ | ∞ | ∞ | ∞ | ∞ | ∞ |

## Console Commands

```javascript
construction()           // Building status
construction("W1N1")     // Room-specific
traffic("W1N1")          // Traffic heatmap
suggestRoads("W1N1")     // Road suggestions
```

## Common Issues

### Extensions Not Building
**Cause:** Container incomplete (higher priority)
**Fix:** Ensure containers at sources exist

### Roads Before Extensions
**Cause:** ConstructionCoordinator not gating properly
**Fix:** Check `canPlaceSites(STRUCTURE_ROAD)` condition

### Too Many Sites
**Cause:** Multiple planners placing simultaneously
**Fix:** One structure per tick enforcement

### Builder Stuck
**Cause:** Path blocked by construction
**Fix:** Builder should path around, check stuck detection
