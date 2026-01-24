# Screeps Economic Loop Simulator

Tests spawner logic by simulating colony evolution over time. Unlike Monte Carlo testing (single decision verification), this runs the actual spawner across hundreds of ticks to answer: **"Does the colony survive?"**

## Setup

```bash
cd simulator
npm install
```

## Usage

```bash
# Run all scenarios
npm test

# Run with detailed output
npm test -- --verbose

# Run specific scenario
npm test -- --scenario "Full wipe"
```

## How It Works

Each tick simulates:

1. **Harvesting**: Harvesters generate energy based on WORK parts
2. **Remote Operations**: Remote haulers travel and bring back energy
3. **Spawning**: Run actual spawner logic, progress spawn timer
4. **Renewal**: Creeps at spawn with low TTL get renewed
5. **Aging**: All creeps lose 1 TTL, dead creeps removed

## Test Scenarios

| Scenario | Tests |
|----------|-------|
| Full wipe recovery | Can colony bootstrap from 0 creeps? |
| Zero harvesters | Does spawner prioritize economy? |
| Zero haulers | Does spawner recognize hauler need? |
| Cascading failure | Can colony survive creeps dying in sequence? |
| Builder vs harvester | Does economy take priority over building? |
| Scout priority | Is scout correctly lowest priority? |
| Remote mining | Do remote miners spawn when economy is stable? |
| Renewal | Are creeps renewed when at spawn? |

## Adding Scenarios

Edit `src/scenarios.ts`:

```typescript
{
  name: 'My scenario',
  description: 'What this tests',
  config: {
    rcl: 5,
    energyCapacity: 1800,
    sources: 2,
    hasSourceContainers: true,
    remoteRooms: [],
    initialEnergy: 500,
    initialStored: 0,
    constructionSites: 0,
    initialCreeps: [
      { role: 'HAULER', ttl: 500, body: ['carry','carry','move','move'], position: 'home' },
    ],
  },
  maxTicks: 1000,
  expectedSurvival: true,
  validate: (result) => {
    // Custom validation
    const firstSpawn = result.events.find(e => e.type === 'SPAWN_START');
    if (firstSpawn?.role !== 'HARVESTER') {
      return { passed: false, reason: 'Wrong spawn priority' };
    }
    return { passed: true };
  },
},
```

## Injecting Failures

Test mid-game failures by injecting state changes:

```typescript
{
  name: 'Invader attack',
  config: healthyColony(),
  injections: [
    { 
      tick: 300, 
      action: (state) => ({
        ...state,
        creeps: state.creeps.filter(c => c.role !== 'HARVESTER'),
      })
    },
  ],
  maxTicks: 1000,
  expectedSurvival: true,
},
```

## Syncing Spawner Logic

The simulator includes a copy of the spawning logic in `src/spawner.ts`. When you change the game code, update this file to match. Key functions:

- `getSpawnCandidate()` - Main decision function
- `calculateUtility()` - Role utility calculations  
- `buildBody()` - Body part generation

## Output Example

```
============================================================
SCREEPS ECONOMIC LOOP SIMULATOR
============================================================

Running 12 scenarios...

🏠 Full wipe with 200 energy... ✅ PASSED
🏠 Scout should not spawn before economy... ❌ FAILED
   Reason: Spawned SCOUT with 0 harvesters - this is the bug!

============================================================
FAILURE DETAILS: Scout should not spawn before economy
============================================================
Event timeline:
  [   1] 🔨 SPAWN_START    SCOUT utility=5.0, cost=50
  [   4] ✅ SPAWN_COMPLETE  SCOUT body=1 parts
  [   5] 🔨 SPAWN_START    SCOUT utility=5.0, cost=50
  ...
  [ 156] 💀 WIPE
```

## Limitations

- **No pathfinding**: Assumes instant movement within rooms
- **Simplified hauling**: Energy flows perfectly when haulers exist  
- **No combat**: Use injections to simulate attacks
- **No construction**: Buildings exist or don't, no build progress

For full simulation, use a Screeps private server.
