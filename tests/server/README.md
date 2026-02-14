# Screeps Private Server Test Infrastructure

Integration tests for the Screeps bot using a local private server.

## Current Status

**Working:**
- Server infrastructure compiles and runs
- Native modules (isolated-vm, @screeps/driver) build successfully
- Server starts and executes ticks
- Bot code deploys and executes correctly
- WorldBuilder creates rooms with terrain, sources, structures
- ScenarioRunner properly configures room ownership after bot deployment
- Economic Recovery scenario: **PASSING**

**Scenarios:**

| Scenario          | Status  | Notes                            |
|-------------------|---------|----------------------------------|
| Economic Recovery | ✅ Pass | Bot bootstraps from zero creeps  |
| Invader Defense   | ❌ Fail | Bot lacks remote defense logic   |

## Requirements

The `screeps-server-mockup` package requires native compilation:

- **Node.js 18+**
- **Python 3** with global node-gyp (see workaround below)
- **Windows**: Visual Studio Build Tools (C++ workload)
- **Linux**: build-essential
- **macOS**: Xcode Command Line Tools

### Windows Setup (Tested Workaround)

The bundled node-gyp in screeps packages is old and requires Python 2. Here's how to work around it:

1. Install latest node-gyp globally:
   ```bash
   npm install -g node-gyp@latest
   ```

2. Install dependencies without running scripts:
   ```bash
   cd tests/server
   npm install --ignore-scripts
   ```

3. Install and build isolated-vm v5 manually:
   ```bash
   npm install isolated-vm@5 --ignore-scripts
   cd node_modules/isolated-vm
   node-gyp rebuild --release
   cd ../..
   ```

4. Remove nested isolated-vm and build driver:
   ```bash
   rm -rf node_modules/@screeps/driver/node_modules/isolated-vm
   cd node_modules/@screeps/driver/native
   node-gyp rebuild
   cd ..
   npm run build
   cd ../../..
   ```

5. Verify server works:
   ```bash
   node -e "const {ScreepsServer}=require('screeps-server-mockup'); const s=new ScreepsServer(); s.start().then(()=>{console.log('OK');s.stop();process.exit(0);})"
   ```

## Usage

Run all scenarios:
```bash
npm test
```

Run a specific scenario:
```bash
npm run test:scenario -- "Economic Recovery"
```

Run scenarios in quick mode (reduced tick limits):
```bash
npm run test:quick
```

Run with verbose output:
```bash
npx ts-node src/index.ts --all --verbose
```

## CLI Options

```
--all, -a              Run all scenarios
--scenario, -s <name>  Run specific scenario by name
--category, -c <cat>   Run scenarios in category (economic, combat)
--verbose, -v          Enable verbose output
--bail, -b             Stop on first failure
--quick, -q            Reduce tick limits for faster runs
--output, -o <file>    Write results to JSON file
--help, -h             Show help
```

## Writing Scenarios

Scenarios are defined in `scenarios/` directory. Each scenario is a TypeScript file that exports a `ScenarioConfig` object.

Example:
```typescript
import { ScenarioConfig } from "../src/types";
import { botSurvived, creepCountAbove } from "../src/scenarios/Assertions";

export const myScenario: ScenarioConfig = {
  name: "My Test Scenario",
  description: "Tests something specific",
  category: "economic",

  rooms: [
    {
      name: "W0N1",
      owner: "TestBot",
      rcl: 5,
      // ... room configuration
    },
  ],

  bot: {
    username: "TestBot",
    room: "W0N1",
    rcl: 5,
  },

  tickLimit: 500,
  checkInterval: 50,

  assertions: [
    botSurvived("W0N1", "TestBot"),
    creepCountAbove("W0N1", 3, "TestBot", "end"),
  ],
};
```

## Available Assertions

- `botSurvived(room, username)` - Bot has creeps or spawns
- `creepCountAbove(room, count, owner, timing)` - Creep count check
- `storageAbove(room, energy, timing)` - Storage energy check
- `rclBelow(room, level, timing)` - RCL check
- `custom(fn, timing, description)` - Custom assertion function

## Project Structure

```
tests/server/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── types.ts           # TypeScript interfaces
│   ├── constants.ts       # Screeps constants
│   ├── server/
│   │   ├── ServerController.ts  # Server wrapper
│   │   └── WorldBuilder.ts      # Room builder
│   ├── deployment/
│   │   ├── BotDeployer.ts       # Bot code deployment
│   │   └── HostileBotGenerator.ts
│   ├── scenarios/
│   │   ├── ScenarioRunner.ts    # Test runner
│   │   └── Assertions.ts        # Assertion helpers
│   └── utils/
│       └── scenarioHelpers.ts   # Utility functions
├── scenarios/             # Test scenarios
│   ├── economic-recovery.ts
│   └── invader-defense.ts
└── results/               # Test output (gitignored)
```

## Troubleshooting

### node-gyp errors during install

The `@screeps/driver` package requires native compilation. Follow the Windows Setup
section above which uses global node-gyp with Python 3. Ensure you have:

- Python 3.x with global node-gyp@latest
- C++ build tools for your platform

### Tests hang

The private server may take time to initialize. If tests hang:
1. Check if another server instance is running
2. Try increasing timeout in CLI
3. Check for port conflicts (default: 21025)

### Bot code errors

If the bot crashes during tests:
1. Check console output with `--verbose`
2. Verify the main bot builds successfully: `npm run build` from project root
3. Check for memory serialization issues
