/**
 * DuoManager - Coordinator for combat duos (attacker + healer pairs)
 *
 * Manages the lifecycle of combat duos from spawning through engagement
 * to recycling. Handles state transitions and assignment management.
 *
 * State Machine:
 *   SPAWNING → RALLYING → ENGAGING → RETREATING → RECYCLING
 *
 * Transitions:
 *   SPAWNING → RALLYING: Both creeps exist and finished spawning
 *   RALLYING → ENGAGING: Hostiles detected AND both in target room
 *   ENGAGING → RETREATING: Healer dead OR attacker HP < 30% with net damage
 *   ENGAGING → RALLYING: All hostiles dead, assignment not complete
 *   RETREATING → RECYCLING: Reached safe room OR both dead
 */

import { COMBAT } from "./CombatConstants";
import { RangedAttackerMemory } from "./roles/RangedAttacker";
import { CombatHealerMemory } from "./roles/CombatHealer";

// ============================================
// Types
// ============================================

export type DuoState =
  | "SPAWNING"
  | "RALLYING"
  | "ENGAGING"
  | "RETREATING"
  | "RECYCLING";

export type AssignmentType =
  | "DEFEND_REMOTE"
  | "DEFEND_ROOM"
  | "CLEAR_INVADER_CORE"
  | "ATTACK_ROOM"
  | "PATROL";

export type AssignmentPriority = "CRITICAL" | "HIGH" | "NORMAL";

export interface DuoAssignment {
  type: AssignmentType;
  priority: AssignmentPriority;
  targetRoom: string;
  homeRoom: string;
  reason?: string;
}

export interface DuoStateData {
  id: string;
  state: DuoState;
  attackerId: Id<Creep> | null;
  attackerName: string | null;
  healerId: Id<Creep> | null;
  healerName: string | null;
  assignment: DuoAssignment;
  createdAt: number;
  stateChangedAt: number;
}

export interface SpawnRequest {
  role: "RANGED_ATTACKER" | "COMBAT_HEALER";
  duoId: string;
  priority: number;
  homeRoom: string;
  targetRoom: string;
}

// ============================================
// Memory Interface
// ============================================

interface CombatMemory {
  useDuos: boolean;
  duos: Record<string, DuoStateData>;
  nextDuoId: number;
}

function getCombatMemory(): CombatMemory {
  if (!Memory.combat) {
    Memory.combat = {
      useDuos: false,
      duos: {},
      nextDuoId: 1,
    };
  }
  return Memory.combat as CombatMemory;
}

// ============================================
// Duo Lifecycle
// ============================================

/**
 * Generate a unique duo ID.
 */
function generateDuoId(): string {
  var combat = getCombatMemory();
  var id = "duo_" + combat.nextDuoId;
  combat.nextDuoId++;
  return id;
}

/**
 * Create a new duo with the given assignment.
 */
export function createDuo(assignment: DuoAssignment): string {
  var combat = getCombatMemory();

  var duoId = generateDuoId();
  var duo: DuoStateData = {
    id: duoId,
    state: "SPAWNING",
    attackerId: null,
    attackerName: null,
    healerId: null,
    healerName: null,
    assignment: assignment,
    createdAt: Game.time,
    stateChangedAt: Game.time,
  };

  combat.duos[duoId] = duo;
  return duoId;
}

/**
 * Cancel and clean up a duo.
 */
export function cancelDuo(duoId: string): boolean {
  var combat = getCombatMemory();
  var duo = combat.duos[duoId];
  if (!duo) return false;

  // Clear creep assignments
  if (duo.attackerName && Game.creeps[duo.attackerName]) {
    var attacker = Game.creeps[duo.attackerName];
    delete (attacker.memory as RangedAttackerMemory).duoId;
    delete (attacker.memory as RangedAttackerMemory).partnerId;
  }

  if (duo.healerName && Game.creeps[duo.healerName]) {
    var healer = Game.creeps[duo.healerName];
    delete (healer.memory as CombatHealerMemory).duoId;
    delete (healer.memory as CombatHealerMemory).partnerId;
  }

  delete combat.duos[duoId];
  return true;
}

/**
 * Get all active duos.
 */
export function getAllDuos(): DuoStateData[] {
  var combat = getCombatMemory();
  var duos: DuoStateData[] = [];
  for (var id in combat.duos) {
    duos.push(combat.duos[id]);
  }
  return duos;
}

/**
 * Get a duo by ID.
 */
export function getDuo(duoId: string): DuoStateData | null {
  var combat = getCombatMemory();
  return combat.duos[duoId] || null;
}

/**
 * Get duos assigned to a specific room.
 */
export function getDuosForRoom(targetRoom: string): DuoStateData[] {
  return getAllDuos().filter(function(duo) {
    return duo.assignment.targetRoom === targetRoom;
  });
}

/**
 * Get duos from a specific home room.
 */
export function getDuosFromHome(homeRoom: string): DuoStateData[] {
  return getAllDuos().filter(function(duo) {
    return duo.assignment.homeRoom === homeRoom;
  });
}

// ============================================
// Creep Assignment
// ============================================

/**
 * Assign a creep to a duo slot.
 */
export function assignCreepToDuo(
  duoId: string,
  creepName: string,
  role: "attacker" | "healer"
): boolean {
  var combat = getCombatMemory();
  var duo = combat.duos[duoId];
  if (!duo) return false;

  var creep = Game.creeps[creepName];
  if (!creep) return false;

  if (role === "attacker") {
    duo.attackerName = creepName;
    duo.attackerId = creep.id;

    var attackerMem = creep.memory as RangedAttackerMemory;
    attackerMem.duoId = duoId;
    attackerMem.targetRoom = duo.assignment.targetRoom;

    // Link to healer if exists
    if (duo.healerId) {
      attackerMem.partnerId = duo.healerId;
    }
  } else {
    duo.healerName = creepName;
    duo.healerId = creep.id;

    var healerMem = creep.memory as CombatHealerMemory;
    healerMem.duoId = duoId;
    healerMem.targetRoom = duo.assignment.targetRoom;

    // Link to attacker if exists
    if (duo.attackerId) {
      healerMem.partnerId = duo.attackerId;
    }
  }

  // Cross-link if both exist
  if (duo.attackerId && duo.healerId) {
    var attacker = Game.getObjectById(duo.attackerId);
    var healer = Game.getObjectById(duo.healerId);

    if (attacker) {
      (attacker.memory as RangedAttackerMemory).partnerId = duo.healerId;
    }
    if (healer) {
      (healer.memory as CombatHealerMemory).partnerId = duo.attackerId;
    }
  }

  return true;
}

// ============================================
// State Transitions
// ============================================

/**
 * Get the attacker creep for a duo (if alive).
 */
function getAttacker(duo: DuoStateData): Creep | null {
  if (!duo.attackerId) return null;
  return Game.getObjectById(duo.attackerId);
}

/**
 * Get the healer creep for a duo (if alive).
 */
function getHealer(duo: DuoStateData): Creep | null {
  if (!duo.healerId) return null;
  return Game.getObjectById(duo.healerId);
}

/**
 * Check if room has hostiles.
 */
function roomHasHostiles(roomName: string): boolean {
  var room = Game.rooms[roomName];
  if (!room) return false; // No vision
  return room.find(FIND_HOSTILE_CREEPS).length > 0;
}

/**
 * Check if room has hostile structures worth attacking.
 * Only relevant for ATTACK_ROOM assignments.
 */
function roomHasHostileStructures(roomName: string): boolean {
  var room = Game.rooms[roomName];
  if (!room) return false;
  var structures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) {
      // Skip indestructible controller
      return s.structureType !== STRUCTURE_CONTROLLER;
    }
  });
  return structures.length > 0;
}

/**
 * Check if an assignment is complete.
 * For ATTACK_ROOM: complete when no hostile spawns remain.
 * For others: complete when no hostiles remain.
 */
function isAssignmentComplete(duo: DuoStateData): boolean {
  if (duo.assignment.type === "ATTACK_ROOM") {
    // Complete when no hostile spawns remain
    var room = Game.rooms[duo.assignment.targetRoom];
    if (!room) return false; // Can't verify, assume not done
    var hostileSpawns = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s) { return s.structureType === STRUCTURE_SPAWN; }
    });
    return hostileSpawns.length === 0;
  }
  // Other assignment types: complete when no hostiles
  return !roomHasHostiles(duo.assignment.targetRoom);
}

/**
 * Check if both creeps are spawned and not spawning.
 */
function bothSpawned(duo: DuoStateData): boolean {
  var attacker = getAttacker(duo);
  var healer = getHealer(duo);

  if (!attacker || !healer) return false;

  // Check if either is currently spawning
  var spawns = Game.spawns;
  for (var name in spawns) {
    var spawn = spawns[name];
    if (spawn.spawning) {
      if (spawn.spawning.name === duo.attackerName) return false;
      if (spawn.spawning.name === duo.healerName) return false;
    }
  }

  return true;
}

/**
 * Check if both creeps are in the target room.
 */
function bothInTargetRoom(duo: DuoStateData): boolean {
  var attacker = getAttacker(duo);
  var healer = getHealer(duo);

  if (!attacker || !healer) return false;

  var targetRoom = duo.assignment.targetRoom;
  return attacker.room.name === targetRoom && healer.room.name === targetRoom;
}

/**
 * Check if duo should retreat.
 */
function shouldDuoRetreat(duo: DuoStateData): boolean {
  var attacker = getAttacker(duo);
  var healer = getHealer(duo);

  // Healer dead = must retreat
  if (!healer) return true;

  // Attacker dead = nothing to protect, retreat
  if (!attacker) return true;

  // Attacker critically wounded
  if (attacker.hits < attacker.hitsMax * 0.3) {
    // Check if taking net damage
    var room = attacker.room;
    var hostiles = room.find(FIND_HOSTILE_CREEPS);

    var incomingDPS = 0;
    for (var i = 0; i < hostiles.length; i++) {
      var range = attacker.pos.getRangeTo(hostiles[i]);
      if (range <= 1) {
        incomingDPS += hostiles[i].getActiveBodyparts(ATTACK) * 30;
      }
      if (range <= 3) {
        incomingDPS += hostiles[i].getActiveBodyparts(RANGED_ATTACK) * 10;
      }
    }

    var healingHPS = healer.getActiveBodyparts(HEAL) * COMBAT.HEAL_ADJACENT;
    var selfHeal = attacker.getActiveBodyparts(HEAL) * COMBAT.HEAL_ADJACENT;

    if (incomingDPS > healingHPS + selfHeal) {
      return true;
    }
  }

  return false;
}

/**
 * Check if duo is in safe room (home or other owned).
 */
function isInSafeRoom(duo: DuoStateData): boolean {
  var attacker = getAttacker(duo);
  var healer = getHealer(duo);

  // Check whichever is alive
  var creep = attacker || healer;
  if (!creep) return true; // Both dead, effectively "safe"

  var room = creep.room;

  // Home room is safe
  if (room.name === duo.assignment.homeRoom) return true;

  // Any owned room is safe
  if (room.controller && room.controller.my) return true;

  return false;
}

/**
 * Transition duo to a new state.
 */
function transitionTo(duo: DuoStateData, newState: DuoState): void {
  if (duo.state !== newState) {
    duo.state = newState;
    duo.stateChangedAt = Game.time;
  }
}

/**
 * Run state transition logic for a duo.
 */
function runStateTransitions(duo: DuoStateData): void {
  var attacker = getAttacker(duo);
  var healer = getHealer(duo);

  switch (duo.state) {
    case "SPAWNING":
      // Transition when both spawned
      if (bothSpawned(duo)) {
        transitionTo(duo, "RALLYING");
      }
      break;

    case "RALLYING":
      // Check for hostiles in target room
      if (bothInTargetRoom(duo)) {
        if (roomHasHostiles(duo.assignment.targetRoom)) {
          transitionTo(duo, "ENGAGING");
        } else if (duo.assignment.type === "ATTACK_ROOM" && roomHasHostileStructures(duo.assignment.targetRoom)) {
          // ATTACK_ROOM: engage even if only structures remain
          transitionTo(duo, "ENGAGING");
        }
      }
      break;

    case "ENGAGING":
      // Check retreat conditions
      if (shouldDuoRetreat(duo)) {
        transitionTo(duo, "RETREATING");
      }
      // Check if assignment is complete
      else if (isAssignmentComplete(duo)) {
        console.log("[DuoManager] Assignment complete for " + duo.id + ", recycling");
        transitionTo(duo, "RECYCLING");
      }
      // Check if hostiles cleared but structures remain (ATTACK_ROOM)
      else if (!roomHasHostiles(duo.assignment.targetRoom)) {
        if (duo.assignment.type === "ATTACK_ROOM" && roomHasHostileStructures(duo.assignment.targetRoom)) {
          // Still have structures to destroy, stay engaged
        } else {
          // Stay rallying in case more hostiles come
          transitionTo(duo, "RALLYING");
        }
      }
      break;

    case "RETREATING":
      // Reached safety or both dead
      if (isInSafeRoom(duo) || (!attacker && !healer)) {
        transitionTo(duo, "RECYCLING");
      }
      break;

    case "RECYCLING":
      // Terminal state - will be cleaned up
      break;
  }

  // Handle dead creeps
  if (duo.attackerId && !attacker) {
    duo.attackerId = null;
    duo.attackerName = null;
  }
  if (duo.healerId && !healer) {
    duo.healerId = null;
    duo.healerName = null;
  }
}

// ============================================
// Spawn Requests
// ============================================

/**
 * Get spawn requests for all duos.
 * Returns requests for missing creeps in SPAWNING state.
 */
export function getSpawnRequests(): SpawnRequest[] {
  var combat = getCombatMemory();
  var requests: SpawnRequest[] = [];

  if (!combat.useDuos) return requests;

  for (var id in combat.duos) {
    var duo = combat.duos[id];

    // Only request spawns in SPAWNING state
    if (duo.state !== "SPAWNING") continue;

    var priorityNum = getPriorityNumber(duo.assignment.priority);

    // Request attacker if missing
    if (!duo.attackerName) {
      requests.push({
        role: "RANGED_ATTACKER",
        duoId: duo.id,
        priority: priorityNum + 2, // Attacker spawns first (higher priority)
        homeRoom: duo.assignment.homeRoom,
        targetRoom: duo.assignment.targetRoom,
      });
    }

    // Request healer if missing
    if (!duo.healerName) {
      requests.push({
        role: "COMBAT_HEALER",
        duoId: duo.id,
        priority: priorityNum,
        homeRoom: duo.assignment.homeRoom,
        targetRoom: duo.assignment.targetRoom,
      });
    }
  }

  return requests;
}

/**
 * Convert priority to number.
 */
function getPriorityNumber(priority: AssignmentPriority): number {
  switch (priority) {
    case "CRITICAL": return 95;
    case "HIGH": return 75;
    case "NORMAL": return 55;
    default: return 55;
  }
}

// ============================================
// Economic Guards
// ============================================

/**
 * Check if a room can afford to spawn combat creeps.
 */
export function canAffordCombat(
  roomName: string,
  priority: AssignmentPriority
): boolean {
  var room = Game.rooms[roomName];
  if (!room) return false;

  // Get thresholds based on priority
  var minStorage: number;
  var minHarvesters: number;
  var minHaulers: number;

  switch (priority) {
    case "CRITICAL":
      minStorage = 5000;
      minHarvesters = 1;
      minHaulers = 1;
      break;
    case "HIGH":
      minStorage = 20000;
      minHarvesters = 2;
      minHaulers = 1;
      break;
    case "NORMAL":
    default:
      minStorage = 50000;
      minHarvesters = 2;
      minHaulers = 2;
      break;
  }

  // Check storage energy
  if (room.storage) {
    var stored = room.storage.store[RESOURCE_ENERGY] || 0;
    if (stored < minStorage) return false;
  } else {
    // No storage - only allow critical
    if (priority !== "CRITICAL") return false;
  }

  // Count harvesters and haulers
  var harvesters = 0;
  var haulers = 0;

  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if (creep.memory.room !== roomName) continue;

    if (creep.memory.role === "HARVESTER" || creep.memory.role === "REMOTE_MINER") {
      harvesters++;
    }
    if (creep.memory.role === "HAULER" || creep.memory.role === "REMOTE_HAULER") {
      haulers++;
    }
  }

  if (harvesters < minHarvesters) return false;
  if (haulers < minHaulers) return false;

  return true;
}

// ============================================
// Cleanup
// ============================================

/**
 * Clean up finished or stale duos.
 */
function cleanupDuos(): void {
  var combat = getCombatMemory();

  for (var id in combat.duos) {
    var duo = combat.duos[id];

    // Clean up recycling duos
    if (duo.state === "RECYCLING") {
      cancelDuo(id);
      continue;
    }

    // Clean up stale spawning duos (stuck for too long)
    if (duo.state === "SPAWNING") {
      var age = Game.time - duo.createdAt;
      if (age > 1500) { // 1500 ticks = 50 minutes, something is wrong
        console.log("[DuoManager] Cleaning up stale duo: " + id);
        cancelDuo(id);
        continue;
      }
    }

    // Clean up duos that have been engaged too long without result
    if (duo.state === "ENGAGING" || duo.state === "RALLYING") {
      var stateAge = Game.time - duo.stateChangedAt;
      if (stateAge > COMBAT.SQUAD_TIMEOUT_TICKS) {
        console.log("[DuoManager] Duo " + id + " timed out, recycling");
        transitionTo(duo, "RECYCLING");
      }
    }

    // Both creeps dead in non-spawning state = recycle
    var attacker = getAttacker(duo);
    var healer = getHealer(duo);
    if (!attacker && !healer && duo.state !== "SPAWNING") {
      transitionTo(duo, "RECYCLING");
    }
  }
}

// ============================================
// Main Run
// ============================================

/**
 * Run the DuoManager for all active duos.
 * Should be called once per tick from main loop.
 */
export function run(): void {
  var combat = getCombatMemory();

  if (!combat.useDuos) return;

  // Run state transitions for each duo
  for (var id in combat.duos) {
    var duo = combat.duos[id];
    runStateTransitions(duo);
  }

  // Cleanup every 10 ticks
  if (Game.time % 10 === 0) {
    cleanupDuos();
  }
}

// ============================================
// Debug / Console Commands
// ============================================

/**
 * Get status summary for all duos.
 */
export function status(): string {
  var combat = getCombatMemory();
  var lines: string[] = [];

  lines.push("=== DuoManager Status ===");
  lines.push("Feature enabled: " + combat.useDuos);

  var duoCount = Object.keys(combat.duos).length;
  lines.push("Active duos: " + duoCount);

  if (duoCount === 0) {
    lines.push("  (none)");
  } else {
    for (var id in combat.duos) {
      var duo = combat.duos[id];
      var attacker = getAttacker(duo);
      var healer = getHealer(duo);

      var attackerStatus = attacker
        ? attacker.name + " HP:" + Math.round((attacker.hits / attacker.hitsMax) * 100) + "%"
        : "(dead)";
      var healerStatus = healer
        ? healer.name + " HP:" + Math.round((healer.hits / healer.hitsMax) * 100) + "%"
        : "(dead)";

      lines.push("");
      lines.push("  " + duo.id + " [" + duo.state + "]");
      lines.push("    Target: " + duo.assignment.targetRoom + " (" + duo.assignment.type + ")");
      lines.push("    Attacker: " + attackerStatus);
      lines.push("    Healer: " + healerStatus);
      lines.push("    Age: " + (Game.time - duo.createdAt) + " ticks");
    }
  }

  return lines.join("\n");
}

/**
 * Toggle the duo system on/off.
 */
export function toggle(): boolean {
  var combat = getCombatMemory();
  combat.useDuos = !combat.useDuos;
  console.log("[DuoManager] Duo system " + (combat.useDuos ? "ENABLED" : "DISABLED"));
  return combat.useDuos;
}

/**
 * Force spawn a duo for a room.
 */
export function spawnDuo(
  homeRoom: string,
  targetRoom: string,
  type?: AssignmentType,
  priority?: AssignmentPriority
): string {
  var assignment: DuoAssignment = {
    type: type || "DEFEND_REMOTE",
    priority: priority || "HIGH",
    targetRoom: targetRoom,
    homeRoom: homeRoom,
    reason: "Manual spawn",
  };

  // Enable duos if not already
  var combat = getCombatMemory();
  if (!combat.useDuos) {
    combat.useDuos = true;
    console.log("[DuoManager] Enabled duo system");
  }

  var duoId = createDuo(assignment);
  console.log("[DuoManager] Created duo " + duoId + " for " + targetRoom);
  return duoId;
}
