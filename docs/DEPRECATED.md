# Deprecated Documentation

This folder contains archived documentation that is no longer accurate or relevant to the current codebase. These files are preserved for historical reference only.

## Archived Files

| File | Original Purpose | Why Deprecated |
|------|-----------------|----------------|
| `00_IMPLEMENTATION_PLAN.md` | Phase-based implementation roadmap | Phases completed; current system uses ColonyManager |
| `01_ARCHITECTURE.md` | TaskCoordinator design proposal | TaskCoordinator never built; ColonyManager serves this purpose |
| `01_TASK_COORDINATOR.md` | Implementation prompt for TaskCoordinator | Was a prompt, not documentation |
| `02_CONSTRUCTION_PRIORITY.md` | Construction priority fix prompt | Fix implemented via ConstructionCoordinator |
| `02_ENERGY_FLOW.md` | Energy flow model | Concepts valid but references non-existent task system |
| `03_TASK_TYPES.md` | TaskType enum specification | TaskType enum doesn't exist; ColonyManager uses different types |
| `04_CREEP_STATES.md` | CreepState machine design | Different state machine implemented |
| `05_COLONY_PHASES.md` | Colony phase definitions | Phase concepts still valid but implementation details wrong |
| `06_SPAWNING.md` | Static spawn priority | Replaced by utility-based spawning system |
| `07_CURRENT_BUGS.md` | Bug catalog | All bugs fixed or no longer applicable |
| `08_AWS_AI_ADVISOR.md` | AWS advisor architecture | Architecture changed; see AWS_ADVISOR.md |
| `10_CRITICAL_FIXES.md` | Fix implementation prompts | Fixes have been implemented |
| `11_ENERGY_ACQUISITION.md` | Energy acquisition fix prompt | Different approach taken in current implementation |

## Using Archived Docs

These files may still contain useful concepts:
- `02_ENERGY_FLOW.md` - Energy flow diagrams are conceptually correct
- `05_COLONY_PHASES.md` - Phase concepts (BOOTSTRAP, DEVELOPING, STABLE, EMERGENCY) are still used
- `06_SPAWNING.md` - Body part costs and fatigue calculations still accurate

## Current Documentation

See the main [README.md](./README.md) for current, accurate documentation.
