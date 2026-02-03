# Screeps Bot Documentation

## Overview

This is a TypeScript Screeps bot targeting the official MMO server (shard0). It features:
- **Utility-based spawning** that dynamically prioritizes creep types
- **ColonyManager** task coordination for work distribution
- **Remote mining** with dedicated infrastructure
- **Empire expansion** with automated room claiming
- **AWS monitoring** with AI-powered recommendations

## Quick Reference

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Core systems and game loop |
| [SPAWNING.md](./SPAWNING.md) | Utility-based spawn priority |
| [ECONOMY.md](./ECONOMY.md) | Energy flow and hauler coordination |
| [REMOTE_MINING.md](./REMOTE_MINING.md) | Remote room operations |
| [EXPANSION.md](./EXPANSION.md) | Claiming new rooms |
| [MOVEMENT.md](./MOVEMENT.md) | Pathfinding and stuck detection |
| [DEFENSE.md](./DEFENSE.md) | Tower management and defenders |
| [CONSTRUCTION.md](./CONSTRUCTION.md) | Structure placement |
| [AWS_ADVISOR.md](./AWS_ADVISOR.md) | External monitoring system |
| [CONSOLE_COMMANDS.md](./CONSOLE_COMMANDS.md) | Debug commands |
| [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) | Current bugs and limitations |
| [CONVENTIONS.md](./CONVENTIONS.md) | Code style and patterns |

## Creep Roles (15 Types)

### Economy Roles (Home Room)
- **HARVESTER** - Mines sources, static miner at containers
- **HAULER** - Moves energy from containers to spawn/storage
- **UPGRADER** - Upgrades room controller
- **BUILDER** - Constructs structures
- **DEFENDER** - Melee attacker for home room threats

### Remote Mining Roles
- **REMOTE_MINER** - Harvests in remote rooms
- **REMOTE_HAULER** - Transports remote energy home
- **RESERVER** - Maintains room reservation
- **REMOTE_DEFENDER** - Ranged defender for remote rooms

### Infrastructure Roles
- **LINK_FILLER** - Keeps storage link filled
- **MINERAL_HARVESTER** - Extracts minerals (RCL 6+)
- **SCOUT** - Explores and gathers intel

### Expansion Roles
- **CLAIMER** - Claims new rooms
- **BOOTSTRAP_BUILDER** - Builds spawn in new rooms
- **BOOTSTRAP_HAULER** - Ferries energy to new rooms

## File Structure

```
src/
├── main.ts                 # Game loop entry point
├── config.ts               # Constants and tuning
├── types.d.ts              # Type extensions
├── core/
│   ├── ColonyManager.ts    # Task generation (849 lines)
│   ├── ColonyState.ts      # Cached room state
│   ├── EconomyTracker.ts   # Energy metrics
│   └── ConstructionCoordinator.ts
├── spawning/
│   ├── utilitySpawning.ts  # Spawn priority (1506 lines)
│   ├── bodyBuilder.ts      # Body scaling
│   └── bodyConfig.ts       # Role templates
├── creeps/                 # 15 role implementations
├── structures/             # Tower, link, container managers
├── expansion/              # Bootstrap and expansion systems
└── utils/
    ├── Console.ts          # 30+ debug commands
    ├── AWSExporter.ts      # AWS data export
    ├── movement.ts         # smartMoveTo, stuck detection
    └── Logger.ts           # Logging system
```

## Key Concepts

### Colony Phases
- **BOOTSTRAP** (RCL 1-2) - Basic economy, spawn workers
- **DEVELOPING** (RCL 3-4) - Infrastructure, storage
- **STABLE** (RCL 5+) - Full operations, remote mining
- **EMERGENCY** - Under attack or no harvesters

### Task System
ColonyManager generates tasks stored in `Memory.rooms[name].tasks[]`:
- HARVEST, SUPPLY_SPAWN, SUPPLY_TOWER, BUILD, UPGRADE, HAUL, DEFEND

Creeps request tasks via `ColonyManager.getAvailableTask(creep)`.

### Utility Spawning
Each role has a utility function (0-100+) based on colony needs:
- Harvester: Critical when income low (can approach infinity)
- Hauler: Critical when harvesters exist but no haulers
- Remote roles: Only spawn when home economy stable

See [SPAWNING.md](./SPAWNING.md) for details.

## Console Commands

Quick status: `status()`, `colony()`, `cpu()`
Creeps: `creeps()`, `tasks()`, `spawn("ROLE")`
Debug: `traffic("W1N1")`, `threats()`, `energy()`

See [CONSOLE_COMMANDS.md](./CONSOLE_COMMANDS.md) for full list.

## AWS Integration

External monitoring at `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com`

Data exported to memory segment 90 every 20 ticks:
- Colony metrics (energy, creeps, construction)
- Economy metrics (harvest rate, storage, consumption)
- Traffic data for road planning

See [AWS_ADVISOR.md](./AWS_ADVISOR.md) for details.

## Development

```bash
# Build
npm run build

# Deploy to simulation
npm run push:sim

# Deploy to MMO
npm run push

# Run tests
cd tests/spawner && npm run test:all
```

## Deprecated Docs

Old documentation moved to `docs/archive/`. See [DEPRECATED.md](./DEPRECATED.md) for index.
