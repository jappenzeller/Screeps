# Spawner Testing System

This document describes the comprehensive testing system for the utility-based spawner in `src/spawning/utilitySpawning.ts`.

## Overview

The spawner testing system consists of two complementary approaches:

1. **Monte Carlo Invariant Testing** - Tests single spawn decisions against invariant rules
2. **Economic Loop Simulation** - Tests colony survival over time

Both tests run the actual spawner code against mock Screeps environments.

## Location

All test files are in `tests/spawner/`:

```
tests/spawner/
├── package.json        # Test dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── invariants.ts       # Invariant definitions
├── stateGenerator.ts   # Random state generation
├── mockRoom.ts         # Screeps mock objects
├── runTests.ts         # Monte Carlo test runner
├── simulator.ts        # Economic loop simulator
└── simTests.ts         # Simulation test scenarios
```

## Running Tests

```bash
cd tests/spawner
npm install

# Monte Carlo tests (1,000 iterations - quick)
npm run test:quick

# Monte Carlo tests (10,000 iterations - full)
npm run test

# Economic loop simulation tests
npm run test:sim

# Run all tests
npm run test:all
```

---

## Monte Carlo Invariant Testing

### Purpose

Tests that the spawner never violates critical rules, regardless of colony state. Generates thousands of random colony states and verifies spawner decisions.

### How It Works

1. Generate random colony state (RCL, energy, creep counts, threats, etc.)
2. Call `getSpawnCandidate()` with mocked Room
3. Check result against all invariants
4. Report violations

### Invariants

#### Critical Invariants (Must Never Violate)

| ID | Name | Rule |
|----|------|------|
| INV-001 | `harvester-priority-zero` | If 0 harvesters and 200+ energy, MUST spawn harvester |
| INV-002 | `hauler-priority-after-harvester` | If harvesters exist but 0 haulers, spawn hauler before non-economy roles |
| INV-003 | `no-remote-without-economy` | Never spawn remote roles if home economy is dead |
| INV-004 | `no-defender-without-threat` | Never spawn defender if no threats |
| INV-005 | `no-builder-without-sites` | Never spawn builder if no construction sites |
| INV-006 | `body-affordable` | Body cost must not exceed available energy |
| INV-007 | `scout-lowest-priority` | Scout should have lowest priority among all roles |
| INV-008 | `remote-miner-rcl-gate` | Remote miner only at RCL 4+ |
| INV-009 | `remote-hauler-rcl-gate` | Remote hauler only at RCL 4+ |
| INV-010 | `reserver-rcl-gate` | Reserver only at RCL 4+ |

#### Warning Invariants (Suspicious but Not Critical)

| ID | Name | Rule |
|----|------|------|
| WARN-001 | `utility-reflects-priority` | Harvester utility should be high with 0 harvesters |
| WARN-002 | `utility-not-infinite` | Utility values should be reasonable (not overflow) |

### State Generation

The test generates states with bias towards interesting scenarios:

- **20% Emergency** - 0 harvesters, low energy
- **20% Recovery** - Few creeps, low energy
- **20% Combat** - Threats present
- **40% Normal** - Healthy colony operation

Plus specific edge cases:
- Exact energy thresholds (199 vs 200)
- Harvesters but no haulers
- Zero creeps with hostiles
- Low RCL attempting remote operations

### Example Output

```
=== TEST SUMMARY ===
Total tests: 10005
Passed: 10005
Failed: 0
Critical violations: 0
Warning violations: 0

✅ All tests passed!
```

### Adding New Invariants

Edit `invariants.ts`:

```typescript
export const CRITICAL_INVARIANTS: Record<string, Invariant> = {
  // ... existing invariants

  "my-new-rule": (state, candidate) => {
    // Return null if rule holds
    // Return error message string if violated
    if (someCondition && candidate?.role !== "EXPECTED_ROLE") {
      return `Expected EXPECTED_ROLE but got ${candidate?.role}`;
    }
    return null;
  },
};
```

---

## Economic Loop Simulation

### Purpose

Tests colony survival over time by simulating the economic loop:

```
HARVEST → SPAWN → AGE → CHECK SURVIVAL → REPEAT
```

This catches issues that single-decision tests miss:
- Cascading failures (harvester dies → no energy → can't replace)
- Timing issues (does replacement finish before death?)
- Resource starvation over time
- Recovery viability

### How It Works

Each tick simulates:

1. **Energy Generation** - Harvesters generate energy based on WORK parts
2. **Spawn Progress** - If spawning, decrement timer; when done, add creep
3. **Spawn Decision** - If not spawning, call actual `getSpawnCandidate()`
4. **Age Creeps** - All creeps lose 1 TTL
5. **Remove Dead** - Creeps with TTL ≤ 0 die
6. **Check Survival** - Colony alive if creeps exist or spawning

### Simplifications

The simulator intentionally omits:
- Pathfinding / travel time
- Hauler logistics (energy flows instantly)
- Combat damage
- Construction / upgrading
- Storage limits
- Remote mining complexity

These are acceptable because we're testing spawner decision quality, not full game simulation.

### Test Scenarios

| Scenario | Description | Expected |
|----------|-------------|----------|
| Recovery from zero harvesters | Haulers exist but no harvesters | Survive |
| Recovery from zero haulers | Harvesters exist but no haulers | Survive |
| Full wipe with 200 energy | Zero creeps, minimal energy | Survive |
| Full wipe with 300 energy | Zero creeps, can afford full harvester | Survive |
| Cascading failure - dying harvesters | Harvesters TTL < 100 | Survive |
| Cascading failure - all dying | All creeps TTL < 120 | Survive |
| RCL 1 bootstrap | Fresh start at RCL 1 | Survive |
| RCL 2 recovery | One dying harvester | Survive |
| Stable economy (1500 ticks) | Full creep lifetime | Survive |
| Invader attack | All harvesters killed at tick 300 | Survive |
| Energy drain | Energy drops to 100 at tick 200 | Survive |
| Single source | Only one energy source | Survive |
| High RCL empty | RCL 8 with zero creeps | Survive |

### Event Injection

Tests can inject mid-simulation events:

```typescript
{
  name: "Invader attack kills all harvesters",
  config: { /* ... */ },
  expectedSurvival: true,
  maxTicks: 1000,
  injections: [
    (state, tick, events) => {
      if (tick === 300) {
        events.push({ tick, type: "INJECTION", details: "Invaders!" });
        return {
          ...state,
          creeps: state.creeps.filter(c => c.role !== "HARVESTER"),
          counts: { ...state.counts, HARVESTER: 0 },
        };
      }
      return state;
    },
  ],
}
```

### Example Output

```
Running Economic Loop Simulation Tests

============================================================

Testing: Recovery from zero harvesters... ✅ PASSED
    Colony has haulers but no harvesters - should spawn harvester first
    Final: 9 creeps, peak: 10, min: 2

Testing: Full wipe recovery with 200 energy... ✅ PASSED
    Zero creeps, minimal energy - must bootstrap from nothing
    Final: 9 creeps, peak: 9, min: 0

Testing: Invader attack kills all harvesters... ✅ PASSED
    After 300 ticks, all harvesters die - colony must recover
    Final: 7 creeps, peak: 10, min: 4

============================================================

Summary: 13 passed, 0 failed out of 13 tests
```

### Adding New Scenarios

Edit `simTests.ts`:

```typescript
const TEST_CASES: TestCase[] = [
  // ... existing tests

  {
    name: "My new scenario",
    description: "What this tests",
    config: {
      rcl: 5,
      energyCapacity: 1800,
      sources: 2,
      remoteRooms: [],
      initialEnergy: 500,
      initialStored: 0,
      initialCreeps: [
        createCreep("HARVESTER", STANDARD_BODIES.HARVESTER_MEDIUM, 1000),
      ],
    },
    expectedSurvival: true,
    maxTicks: 1000,
  },
];
```

---

## Bugs Found by Testing

### Bug: Hauler Minimum Cost

**Found by:** Monte Carlo tests

**Issue:** `buildBody()` had `if (energy < 200) return []` but haulers only cost 100 energy.

**Symptom:** With 100-199 energy and 0 haulers, spawner returned null instead of spawning minimal hauler.

**Fix:** Added `ROLE_MIN_COST` constant with role-specific minimum costs.

---

## CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Run Spawner Tests
  run: |
    cd tests/spawner
    npm install
    npm run test:all
```

The tests exit with code 1 on failure, making them suitable for CI gates.

---

## Architecture Notes

### Mock System

The tests create mock Screeps objects that satisfy the spawner's requirements:

- `Game.creeps` - Creep objects with memory and body parts
- `Game.spawns` - Spawn owner info
- `Game.map` - Room exits for remote mining
- `Game.time` - Current tick
- `Memory.rooms` - Room intel for remote operations
- `Room` object with `find()`, `energyAvailable`, etc.

### Type Safety

The test tsconfig uses `transpileOnly: true` to skip type checking on source imports, since the project's `types.d.ts` augments Screeps types that aren't available in the test environment.

### Spawner Integration

Tests import and call the actual `getSpawnCandidate()` function - no mocking of spawner logic. This ensures tests validate real behavior.
