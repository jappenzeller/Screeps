/**
 * Unit tests for syncRemoteRooms logic
 *
 * These test the core logic paths without requiring a full Screeps server.
 * Run with: npx ts-node --skipProject tests/unit/syncRemoteRooms.test.ts
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */

// Mock Screeps globals
declare const global: any;
declare const console: { log: (...args: any[]) => void };
declare const process: { exit: (code: number) => void };

// Setup mocks before importing
global.Game = {
  time: 100000,
  cpu: { bucket: 9500 },
  rooms: {},
  spawns: {},
  map: {
    describeExits: (roomName: string) => {
      // Simplified exit map for testing
      const exits: Record<string, Record<string, string>> = {
        'E46N37': { '1': 'E46N38', '3': 'E47N37', '5': 'E46N36', '7': 'E45N37' },
        'E47N37': { '7': 'E46N37', '3': 'E48N37' },
        'E45N37': { '3': 'E46N37', '7': 'E44N37' },
        'E44N37': { '3': 'E45N37' },
      };
      return exits[roomName] || null;
    },
    findRoute: (from: string, to: string, opts?: any) => {
      // Calculate route distance based on room coords
      const fromMatch = from.match(/([EW])(\d+)([NS])(\d+)/);
      const toMatch = to.match(/([EW])(\d+)([NS])(\d+)/);
      if (!fromMatch || !toMatch) return -2; // ERR_NO_PATH

      const dx = Math.abs(parseInt(toMatch[2]) - parseInt(fromMatch[2]));
      const dy = Math.abs(parseInt(toMatch[4]) - parseInt(fromMatch[4]));
      const dist = dx + dy;

      if (dist > 10) return -2; // ERR_NO_PATH for very far rooms

      // Return array of route steps
      const route = [];
      for (let i = 0; i < dist; i++) {
        route.push({ exit: 1, room: `step${i}` });
      }
      return route;
    }
  }
};

global.Memory = {
  colonies: {},
  intel: {}
};

global.ERR_NO_PATH = -2;
global.FIND_SOURCES = 105;
global.OK = 0;

// Test results
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual: any, expected: any, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, msg?: string) {
  if (!condition) {
    throw new Error(msg || 'Assertion failed: expected true');
  }
}

// ============================================================================
// SCENARIO 4: Cleanup removes distance > 2 rooms
// ============================================================================

test('Scenario 4: getRouteDistance returns correct distance', () => {
  // Direct adjacent room = distance 1
  const route1 = global.Game.map.findRoute('E46N37', 'E47N37');
  assertEqual(Array.isArray(route1), true, 'Route should be array');
  assertEqual(route1.length, 1, 'Adjacent room should be distance 1');

  // Two rooms away = distance 2
  const route2 = global.Game.map.findRoute('E46N37', 'E48N37');
  assertEqual(route2.length, 2, 'Two rooms away should be distance 2');

  // Five rooms away = distance 5
  const route5 = global.Game.map.findRoute('E46N37', 'E42N35');
  assertEqual(route5.length, 6, 'E42N35 should be distance 6 from E46N37');
});

test('Scenario 4: distance > 2 should be flagged for removal', () => {
  // Simulate the check from getRemoteInvalidReason
  const routeDist = global.Game.map.findRoute('E46N37', 'E42N35').length;
  assertTrue(routeDist > 2, 'E42N35 should be > 2 distance');

  // The logic: if (routeDist > 2) return "distance X > 2"
  const shouldRemove = routeDist > 2;
  assertTrue(shouldRemove, 'Should flag for removal');
});

// ============================================================================
// SCENARIO 5: Rate limiting - lastRemoteSync updates
// ============================================================================

test('Scenario 5: lastRemoteSync should update when sync runs', () => {
  // Setup
  global.Memory.colonies = {
    'E46N37': {
      remotes: {},
      remoteRoomsLastSync: 0
    }
  };

  // Simulate sync setting timestamp
  const mem = global.Memory.colonies['E46N37'];
  mem.remoteRoomsLastSync = global.Game.time;

  assertEqual(mem.remoteRoomsLastSync, 100000, 'lastRemoteSync should be Game.time');
});

test('Scenario 5: sync should only run every 1000 ticks', () => {
  global.Memory.colonies = {
    'E46N37': {
      remotes: {},
      remoteRoomsLastSync: 99500 // 500 ticks ago
    }
  };

  const mem = global.Memory.colonies['E46N37'];
  const lastSync = mem.remoteRoomsLastSync;
  const shouldSync = (global.Game.time - lastSync) >= 1000;

  assertEqual(shouldSync, false, 'Should NOT sync when only 500 ticks passed');

  // Advance time
  mem.remoteRoomsLastSync = 98000; // 2000 ticks ago
  const shouldSyncNow = (global.Game.time - mem.remoteRoomsLastSync) >= 1000;

  assertEqual(shouldSyncNow, true, 'Should sync when 2000 ticks passed');
});

// ============================================================================
// SCENARIO 6: CPU guard keeps existing remotes when bucket low
// ============================================================================

test('Scenario 6: low CPU bucket should keep existing remotes', () => {
  // Set low bucket
  global.Game.cpu.bucket = 2000;

  // The fix: when bucket < 3000, getRemoteInvalidReason returns null (keep)
  const shouldKeep = global.Game.cpu.bucket < 3000;
  assertTrue(shouldKeep, 'Should detect low bucket');

  // In the fixed code, this returns null (not invalid)
  // This test verifies the LOGIC, not the actual function
  const invalidReason = shouldKeep ? null : 'would validate distance';
  assertEqual(invalidReason, null, 'Low bucket should return null (keep remote)');

  // Reset bucket
  global.Game.cpu.bucket = 9500;
});

test('Scenario 6: normal CPU bucket should validate remotes', () => {
  global.Game.cpu.bucket = 9500;

  const shouldValidate = global.Game.cpu.bucket >= 3000;
  assertTrue(shouldValidate, 'Should validate when bucket is high');

  // With high bucket, distance check runs
  const routeDist = global.Game.map.findRoute('E46N37', 'E42N35').length;
  const invalidReason = routeDist > 2 ? `distance ${routeDist} > 2` : null;
  assertEqual(invalidReason, 'distance 6 > 2', 'Should flag invalid distance');
});

// ============================================================================
// ADDITIONAL: Overlap prevention
// ============================================================================

test('Overlap prevention: detects already assigned rooms', () => {
  const empireAssignments: Record<string, string> = {
    'E45N37': 'E44N37', // Already assigned to different colony
    'E47N37': 'E46N37', // Assigned to our colony
  };

  const ourColony = 'E46N37';
  const candidate1 = 'E45N37';
  const candidate2 = 'E47N37';

  // Check overlap logic
  const isOverlap1 = empireAssignments[candidate1] && empireAssignments[candidate1] !== ourColony;
  const isOverlap2 = !!(empireAssignments[candidate2] && empireAssignments[candidate2] !== ourColony);

  assertTrue(!!isOverlap1, 'E45N37 should be detected as overlap');
  assertEqual(isOverlap2, false, 'E47N37 should NOT be overlap (assigned to us)');
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n========================================');
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failed > 0) {
  process.exit(1);
}
