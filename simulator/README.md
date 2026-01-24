# Screeps Economic Loop Simulator

Tests spawner logic by simulating colony evolution over time.

## Setup

```bash
cd simulator
npm install
npm test
```

## Files

- `src/index.ts` - Main entry point, test runner
- `src/simulator.ts` - Core simulation loop  
- `src/spawner.ts` - Copy of spawning logic (keep in sync with game code)
- `src/scenarios.ts` - Test scenarios
- `src/types.ts` - TypeScript interfaces
- `src/constants.ts` - Screeps constants

## Usage

```bash
npm test                           # Run all scenarios
npm test -- --verbose              # Detailed output
npm test -- --scenario "Full wipe" # Run specific scenario
```
