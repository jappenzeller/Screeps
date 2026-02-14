/**
 * Assertions - Check conditions against game state
 *
 * Provides assertion helpers for common test conditions:
 * - Room ownership and RCL
 * - Creep counts
 * - Structure existence
 * - Storage levels
 * - Bot survival
 */

import { Assertion, AssertionResult, GameState, RoomState } from "../types";

/**
 * Check an assertion against the current game state
 */
export function checkAssertion(assertion: Assertion, state: GameState): AssertionResult {
  switch (assertion.type) {
    case "room_owned_by":
      return checkRoomOwnedBy(assertion, state);

    case "room_rcl_above":
      return checkRoomRclAbove(assertion, state);

    case "room_rcl_below":
      return checkRoomRclBelow(assertion, state);

    case "creep_count_above":
      return checkCreepCountAbove(assertion, state);

    case "creep_count_below":
      return checkCreepCountBelow(assertion, state);

    case "structure_exists":
      return checkStructureExists(assertion, state);

    case "structure_destroyed":
      return checkStructureDestroyed(assertion, state);

    case "storage_above":
      return checkStorageAbove(assertion, state);

    case "storage_below":
      return checkStorageBelow(assertion, state);

    case "no_hostile_creeps":
      return checkNoHostileCreeps(assertion, state);

    case "no_hostile_structures":
      return checkNoHostileStructures(assertion, state);

    case "bot_survived":
      return checkBotSurvived(assertion, state);

    case "custom":
      if (assertion.customFn) {
        return assertion.customFn(state);
      }
      return {
        passed: false,
        message: "Custom assertion missing customFn",
      };

    default:
      return {
        passed: false,
        message: `Unknown assertion type: ${assertion.type}`,
      };
  }
}

// ============================================
// Room Ownership Assertions
// ============================================

function checkRoomOwnedBy(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: assertion.target,
    };
  }

  const passed = room.owner === assertion.target;
  return {
    passed,
    message: passed
      ? `Room ${assertion.room} is owned by ${assertion.target}`
      : `Room ${assertion.room} is owned by ${room.owner || "nobody"}, expected ${assertion.target}`,
    actual: room.owner,
    expected: assertion.target,
  };
}

function checkRoomRclAbove(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: `> ${assertion.value}`,
    };
  }

  const passed = (room.rcl || 0) > (assertion.value || 0);
  return {
    passed,
    message: passed
      ? `Room ${assertion.room} RCL ${room.rcl} > ${assertion.value}`
      : `Room ${assertion.room} RCL ${room.rcl} is not > ${assertion.value}`,
    actual: room.rcl,
    expected: `> ${assertion.value}`,
  };
}

function checkRoomRclBelow(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: `< ${assertion.value}`,
    };
  }

  const passed = (room.rcl || 0) < (assertion.value || Infinity);
  return {
    passed,
    message: passed
      ? `Room ${assertion.room} RCL ${room.rcl} < ${assertion.value}`
      : `Room ${assertion.room} RCL ${room.rcl} is not < ${assertion.value}`,
    actual: room.rcl,
    expected: `< ${assertion.value}`,
  };
}

// ============================================
// Creep Count Assertions
// ============================================

function checkCreepCountAbove(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: `> ${assertion.value}`,
    };
  }

  // Filter by owner if target is specified
  let creeps = room.creeps;
  if (assertion.target) {
    creeps = creeps.filter((c) => c.owner === assertion.target);
  }

  const count = creeps.length;
  const passed = count > (assertion.value || 0);

  const ownerDesc = assertion.target ? ` owned by ${assertion.target}` : "";
  return {
    passed,
    message: passed
      ? `Room ${assertion.room} has ${count} creeps${ownerDesc} (> ${assertion.value})`
      : `Room ${assertion.room} has ${count} creeps${ownerDesc}, expected > ${assertion.value}`,
    actual: count,
    expected: `> ${assertion.value}`,
  };
}

function checkCreepCountBelow(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: `< ${assertion.value}`,
    };
  }

  // Filter by owner if target is specified
  let creeps = room.creeps;
  if (assertion.target) {
    creeps = creeps.filter((c) => c.owner === assertion.target);
  }

  const count = creeps.length;
  const passed = count < (assertion.value || Infinity);

  const ownerDesc = assertion.target ? ` owned by ${assertion.target}` : "";
  return {
    passed,
    message: passed
      ? `Room ${assertion.room} has ${count} creeps${ownerDesc} (< ${assertion.value})`
      : `Room ${assertion.room} has ${count} creeps${ownerDesc}, expected < ${assertion.value}`,
    actual: count,
    expected: `< ${assertion.value}`,
  };
}

// ============================================
// Structure Assertions
// ============================================

function checkStructureExists(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: assertion.target,
    };
  }

  const structure = room.structures.find((s) => s.type === assertion.target);
  const passed = structure !== undefined;

  return {
    passed,
    message: passed
      ? `Room ${assertion.room} has structure ${assertion.target}`
      : `Room ${assertion.room} does not have structure ${assertion.target}`,
    actual: structure ? "exists" : "not found",
    expected: assertion.target,
  };
}

function checkStructureDestroyed(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: true, // Room not existing means structure is definitely destroyed
      message: `Room ${assertion.room} not found (structure considered destroyed)`,
      actual: null,
      expected: "destroyed",
    };
  }

  const structure = room.structures.find((s) => s.type === assertion.target);
  const passed = structure === undefined;

  return {
    passed,
    message: passed
      ? `Room ${assertion.room} structure ${assertion.target} is destroyed`
      : `Room ${assertion.room} structure ${assertion.target} still exists`,
    actual: structure ? "exists" : "destroyed",
    expected: "destroyed",
  };
}

// ============================================
// Storage Assertions
// ============================================

function checkStorageAbove(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: `> ${assertion.value}`,
    };
  }

  const storage = room.structures.find((s) => s.type === "storage");
  if (!storage) {
    return {
      passed: false,
      message: `Room ${assertion.room} has no storage`,
      actual: null,
      expected: `> ${assertion.value}`,
    };
  }

  const energy = storage.store?.energy || 0;
  const passed = energy > (assertion.value || 0);

  return {
    passed,
    message: passed
      ? `Room ${assertion.room} storage has ${energy} energy (> ${assertion.value})`
      : `Room ${assertion.room} storage has ${energy} energy, expected > ${assertion.value}`,
    actual: energy,
    expected: `> ${assertion.value}`,
  };
}

function checkStorageBelow(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: null,
      expected: `< ${assertion.value}`,
    };
  }

  const storage = room.structures.find((s) => s.type === "storage");
  if (!storage) {
    return {
      passed: true, // No storage means energy is 0, which is below any positive value
      message: `Room ${assertion.room} has no storage (considered 0 energy)`,
      actual: 0,
      expected: `< ${assertion.value}`,
    };
  }

  const energy = storage.store?.energy || 0;
  const passed = energy < (assertion.value || Infinity);

  return {
    passed,
    message: passed
      ? `Room ${assertion.room} storage has ${energy} energy (< ${assertion.value})`
      : `Room ${assertion.room} storage has ${energy} energy, expected < ${assertion.value}`,
    actual: energy,
    expected: `< ${assertion.value}`,
  };
}

// ============================================
// Hostile Detection Assertions
// ============================================

function checkNoHostileCreeps(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: true, // No room means no hostiles
      message: `Room ${assertion.room} not found (no hostiles by default)`,
      actual: 0,
      expected: 0,
    };
  }

  // Hostiles are creeps not owned by our bot
  const ourBot = assertion.target;
  const hostiles = room.creeps.filter(
    (c) => c.owner !== ourBot && c.owner !== "Source Keeper" && c.owner !== "Invader"
  );
  const passed = hostiles.length === 0;

  return {
    passed,
    message: passed
      ? `Room ${assertion.room} has no hostile creeps`
      : `Room ${assertion.room} has ${hostiles.length} hostile creeps`,
    actual: hostiles.length,
    expected: 0,
  };
}

function checkNoHostileStructures(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: true,
      message: `Room ${assertion.room} not found (no hostile structures by default)`,
      actual: 0,
      expected: 0,
    };
  }

  const ourBot = assertion.target;
  const hostileStructures = room.structures.filter(
    (s) =>
      s.owner !== null &&
      s.owner !== ourBot &&
      ["spawn", "tower", "extension", "storage", "terminal"].includes(s.type)
  );
  const passed = hostileStructures.length === 0;

  return {
    passed,
    message: passed
      ? `Room ${assertion.room} has no hostile structures`
      : `Room ${assertion.room} has ${hostileStructures.length} hostile structures`,
    actual: hostileStructures.length,
    expected: 0,
  };
}

// ============================================
// Bot Survival Assertions
// ============================================

function checkBotSurvived(assertion: Assertion, state: GameState): AssertionResult {
  const room = state.rooms.get(assertion.room || "");
  if (!room) {
    return {
      passed: false,
      message: `Room ${assertion.room} not found`,
      actual: "room not found",
      expected: "bot alive",
    };
  }

  const botUsername = assertion.target;

  // Check for creeps or spawns owned by the bot
  const botCreeps = room.creeps.filter((c) => c.owner === botUsername);
  const botSpawns = room.structures.filter((s) => s.type === "spawn" && s.owner === botUsername);

  const passed = botCreeps.length > 0 || botSpawns.length > 0;

  return {
    passed,
    message: passed
      ? `Bot ${botUsername} survived (${botCreeps.length} creeps, ${botSpawns.length} spawns)`
      : `Bot ${botUsername} did not survive (no creeps or spawns)`,
    actual: { creeps: botCreeps.length, spawns: botSpawns.length },
    expected: "creeps > 0 or spawns > 0",
  };
}

// ============================================
// Assertion Builder Helpers
// ============================================

/**
 * Create a "bot survived" assertion
 */
export function botSurvived(room: string, botUsername: string, description?: string): Assertion {
  return {
    type: "bot_survived",
    room,
    target: botUsername,
    timing: "end",
    description: description || `Bot ${botUsername} must survive`,
  };
}

/**
 * Create a "creep count above" assertion
 */
export function creepCountAbove(
  room: string,
  count: number,
  owner?: string,
  timing: "end" | "continuous" | "after_tick" = "end",
  description?: string
): Assertion {
  return {
    type: "creep_count_above",
    room,
    target: owner,
    value: count,
    timing,
    description: description || `Room ${room} must have > ${count} creeps`,
  };
}

/**
 * Create a "storage above" assertion
 */
export function storageAbove(
  room: string,
  energy: number,
  timing: "end" | "continuous" | "after_tick" = "end",
  description?: string
): Assertion {
  return {
    type: "storage_above",
    room,
    value: energy,
    timing,
    description: description || `Room ${room} storage must have > ${energy} energy`,
  };
}

/**
 * Create a "room RCL below" assertion
 */
export function rclBelow(
  room: string,
  level: number,
  timing: "end" | "continuous" | "after_tick" = "end",
  description?: string
): Assertion {
  return {
    type: "room_rcl_below",
    room,
    value: level,
    timing,
    description: description || `Room ${room} RCL must be < ${level}`,
  };
}

/**
 * Create a custom assertion
 */
export function custom(
  fn: (state: GameState) => AssertionResult,
  timing: "end" | "continuous" | "after_tick" = "end",
  description?: string
): Assertion {
  return {
    type: "custom",
    timing,
    description,
    customFn: fn,
  };
}
