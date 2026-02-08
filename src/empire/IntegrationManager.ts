/**
 * IntegrationManager - Active colony integration for expansion system
 *
 * Diagnoses why newly-expanded colonies are stalled and issues spawn directives
 * to bypass utility scoring when the colony is stuck in a deadlock.
 *
 * Called from ExpansionManager during INTEGRATING state.
 */

import { EmpireExpansionState } from "./EmpireMemory";
import { getUtilityScores } from "../spawning/utilitySpawning";

// How often to run diagnostics (ticks)
var DIAGNOSTIC_INTERVAL = 10;

// Stall detection thresholds
var STALL_THRESHOLD = 100;       // Ticks before issuing directives (user spec: >100)
var WARNING_TIMEOUT = 2000;      // Ticks in INTEGRATING before warning
var CRITICAL_TIMEOUT = 5000;     // Ticks before requesting parent backup
var FAILURE_TIMEOUT = 10000;     // Ticks before failing expansion

// Spawn directive priority (higher than any utility score)
var DIRECTIVE_PRIORITY = 200;

/**
 * Run diagnostics on an integrating colony
 */
export function diagnoseColony(room: Room, state: EmpireExpansionState): ColonyDiagnostic {
  var controller = room.controller;
  var rcl = controller ? controller.level : 0;

  // Find structures
  var spawns = room.find(FIND_MY_SPAWNS);
  var hasSpawn = spawns.length > 0;

  var sourceContainers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        s.pos.findInRange(FIND_SOURCES, 1).length > 0;
    }
  });
  var hasSourceContainers = sourceContainers.length > 0;

  var hasStorage = room.storage !== undefined;

  var controllerContainers = controller ? controller.pos.findInRange(FIND_STRUCTURES, 3, {
    filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; }
  }) : [];
  var hasControllerContainer = controllerContainers.length > 0;

  var controllerLinks = controller ? controller.pos.findInRange(FIND_MY_STRUCTURES, 4, {
    filter: function(s) { return s.structureType === STRUCTURE_LINK; }
  }) : [];
  var hasControllerLink = controllerLinks.length > 0;

  // Count creeps by role
  var creeps = Object.values(Game.creeps).filter(function(c) {
    return c.memory.room === room.name;
  });

  var harvesters = 0;
  var haulers = 0;
  var upgraders = 0;
  var builders = 0;
  var pioneers = 0;

  for (var i = 0; i < creeps.length; i++) {
    var role = creeps[i].memory.role;
    if (role === "HARVESTER") harvesters++;
    else if (role === "HAULER") haulers++;
    else if (role === "UPGRADER") upgraders++;
    else if (role === "BUILDER") builders++;
    else if (role === "PIONEER") pioneers++;
  }

  // Economy state
  var energyAvailable = room.energyAvailable;
  var energyCapacity = room.energyCapacityAvailable;

  // Check if spawn is idle
  var spawnIdle = hasSpawn && spawns.every(function(s) { return !s.spawning; });

  // Controller state
  var controllerProgress = controller ? controller.progress : 0;
  var controllerDowngradeTimer = controller ? controller.ticksToDowngrade : 0;

  // Time in INTEGRATING state
  var ticksInState = Game.time - state.stateChangedAt;

  // Identify missing roles
  var missingRoles: string[] = [];
  if (harvesters === 0 && hasSourceContainers) missingRoles.push("HARVESTER");
  if (haulers === 0 && harvesters > 0) missingRoles.push("HAULER");
  if (upgraders === 0) missingRoles.push("UPGRADER");
  if (builders === 0 && room.find(FIND_CONSTRUCTION_SITES).length > 0) missingRoles.push("BUILDER");

  // Determine stall reason
  var stalledReason: string | null = null;
  if (spawnIdle && energyAvailable >= 200) {
    // Spawn is idle with energy - why isn't it spawning?
    var scores = getUtilityScores(room);
    var allZero = scores.every(function(s) { return s.utility <= 0; });

    if (allZero) {
      // All scores zero could mean:
      // 1. True deadlock - missing essential roles (needs intervention)
      // 2. Fully staffed - all roles at target (NOT a deadlock)
      // Only flag as deadlock if essential roles are missing
      var hasEssentialRoles = harvesters > 0 && haulers > 0 && (upgraders > 0 || pioneers > 0);
      if (!hasEssentialRoles) {
        stalledReason = "All utility scores zero - missing essential roles";
      }
      // If has essential roles, NOT a deadlock - just fully staffed
    } else if ((upgraders === 0 && pioneers === 0) && controllerDowngradeTimer < 15000) {
      stalledReason = "No upgrader/pioneer, controller at risk";
    } else if ((upgraders === 0 && pioneers === 0) && hasSpawn) {
      stalledReason = "No upgrader/pioneer, spawn idle";
    }
  }

  return {
    roomName: room.name,
    rcl: rcl,
    hasSpawn: hasSpawn,
    hasSourceContainers: hasSourceContainers,
    hasStorage: hasStorage,
    hasControllerContainer: hasControllerContainer,
    hasControllerLink: hasControllerLink,
    harvesters: harvesters,
    haulers: haulers,
    upgraders: upgraders,
    builders: builders,
    pioneers: pioneers,
    energyAvailable: energyAvailable,
    energyCapacity: energyCapacity,
    spawnIdle: spawnIdle,
    controllerProgress: controllerProgress,
    controllerDowngradeTimer: controllerDowngradeTimer,
    ticksInState: ticksInState,
    missingRoles: missingRoles,
    stalledReason: stalledReason,
  };
}

/**
 * Generate spawn directives based on diagnostic
 *
 * IMPORTANT: This is the core fix - directives based purely on role counts,
 * not infrastructure. Fresh INTEGRATING colonies may not have containers.
 */
function generateDirectives(room: Room, diag: ColonyDiagnostic): SpawnDirective[] {
  var directives: SpawnDirective[] = [];

  // Don't generate directives if spawn is busy
  if (!diag.spawnIdle) {
    return directives;
  }

  // Don't generate directives if no energy to spawn anything
  if (diag.energyAvailable < 200) {
    return directives;
  }

  var rcl = room.controller ? room.controller.level : 0;
  var sites = room.find(FIND_CONSTRUCTION_SITES);

  // Priority order: harvester > hauler > upgrader > builder
  // NO infrastructure gates - just check role counts

  // Priority 1: No harvester - economy is completely dead
  if (diag.harvesters === 0) {
    directives.push({
      source: "INTEGRATION_MANAGER",
      roomName: diag.roomName,
      role: "HARVESTER",
      priority: DIRECTIVE_PRIORITY,
      reason: "INTEGRATING: no harvester, economy dead",
      maxActive: 2,
    });
    console.log("[Integration] " + diag.roomName + " generating HARVESTER directive");
    return directives;
  }

  // Priority 2: No hauler but harvesters exist - energy stranded
  if (diag.haulers === 0 && diag.harvesters > 0) {
    directives.push({
      source: "INTEGRATION_MANAGER",
      roomName: diag.roomName,
      role: "HAULER",
      priority: DIRECTIVE_PRIORITY,
      reason: "INTEGRATING: no hauler, energy stranded",
      maxActive: 2,
    });
    console.log("[Integration] " + diag.roomName + " generating HAULER directive");
    return directives;
  }

  // Priority 3: No upgrader - RCL stuck
  // Check if colony has controller infrastructure (container, link, or storage)
  // If not, spawn PIONEER instead - it's self-sufficient and can harvest directly
  if (diag.upgraders === 0 && diag.pioneers === 0) {
    var hasControllerInfra = diag.hasControllerContainer || diag.hasControllerLink || diag.hasStorage;

    if (hasControllerInfra) {
      // Normal upgrader directive - infrastructure exists for collection
      directives.push({
        source: "INTEGRATION_MANAGER",
        roomName: diag.roomName,
        role: "UPGRADER",
        priority: DIRECTIVE_PRIORITY,
        reason: "INTEGRATING: no upgrader, RCL stuck at " + rcl,
        body: [WORK, CARRY, MOVE],  // Minimal body that can fetch and upgrade
        maxActive: 1,
      });
      console.log("[Integration] " + diag.roomName + " generating UPGRADER directive");
    } else {
      // No controller infrastructure - spawn pioneer instead
      // Pioneers are self-sufficient and can harvest directly
      directives.push({
        source: "INTEGRATION_MANAGER",
        roomName: diag.roomName,
        role: "PIONEER",
        priority: DIRECTIVE_PRIORITY,
        reason: "INTEGRATING: no upgrader and no controller infra, spawning pioneer",
        maxActive: 1,
      });
      console.log("[Integration] " + diag.roomName + " generating PIONEER directive (no controller infra)");
    }
    return directives;
  }

  // Priority 4: No builder but construction sites exist
  if (diag.builders === 0 && sites.length > 0) {
    directives.push({
      source: "INTEGRATION_MANAGER",
      roomName: diag.roomName,
      role: "BUILDER",
      priority: DIRECTIVE_PRIORITY,
      reason: "INTEGRATING: no builder, " + sites.length + " construction sites pending",
      maxActive: 1,
    });
    console.log("[Integration] " + diag.roomName + " generating BUILDER directive");
    return directives;
  }

  return directives;
}

/**
 * Run integration manager for a colony in INTEGRATING state
 * Returns: { complete: boolean, failed: boolean, failReason?: string }
 */
export function runIntegration(
  room: Room,
  state: EmpireExpansionState
): { complete: boolean; failed: boolean; failReason?: string } {
  // Initialize integration state if needed
  if (!state.integration) {
    state.integration = {
      diagnostics: {
        lastCheck: 0,
        stalledSince: null,
        stalledReason: null,
        interventions: 0,
      },
      directives: [],
    };
  }

  var intState = state.integration;
  var ticksInState = Game.time - state.stateChangedAt;

  // Check for timeout failure
  if (ticksInState > FAILURE_TIMEOUT) {
    return {
      complete: false,
      failed: true,
      failReason: "Integration timeout after " + ticksInState + " ticks",
    };
  }

  // Log warnings at thresholds
  if (ticksInState === WARNING_TIMEOUT) {
    console.log("[Integration] WARNING: " + room.name + " still integrating after " + WARNING_TIMEOUT + " ticks");
  }
  if (ticksInState === CRITICAL_TIMEOUT) {
    console.log("[Integration] CRITICAL: " + room.name + " still integrating after " + CRITICAL_TIMEOUT + " ticks");
    // Could request parent backup here in future
  }

  // Run diagnostics every N ticks
  if (Game.time - intState.diagnostics.lastCheck >= DIAGNOSTIC_INTERVAL) {
    intState.diagnostics.lastCheck = Game.time;

    var diag = diagnoseColony(room, state);

    // Check for self-sufficiency (exit INTEGRATING)
    if (isSelfSufficient(room, diag)) {
      return { complete: true, failed: false };
    }

    // Clear stale directives - if the role now exists, remove the directive
    // This must happen BEFORE we check for new stalls
    if (intState.directives && intState.directives.length > 0) {
      var roomName = state.roomName;
      intState.directives = intState.directives.filter(function(d) {
        var count = Object.values(Game.creeps).filter(function(c) {
          return c.memory.room === roomName && c.memory.role === d.role;
        }).length;
        var keep = count < d.maxActive;
        if (!keep) {
          console.log("[Integration] " + roomName + " directive fulfilled: " + d.role + " (now have " + count + ")");
        }
        return keep;
      });
    }

    // Track stall state
    if (diag.stalledReason) {
      if (!intState.diagnostics.stalledSince) {
        intState.diagnostics.stalledSince = Game.time;
        intState.diagnostics.stalledReason = diag.stalledReason;
        console.log("[Integration] " + room.name + " stall detected: " + diag.stalledReason);
      }

      // Check if stalled long enough to intervene
      var stalledFor = Game.time - intState.diagnostics.stalledSince;
      if (stalledFor >= STALL_THRESHOLD) {
        // Generate directives only if we don't already have active ones
        if (intState.directives.length === 0) {
          var newDirectives = generateDirectives(room, diag);
          if (newDirectives.length > 0) {
            intState.directives = newDirectives;
            intState.diagnostics.interventions++;
            console.log("[Integration] " + room.name + " intervention #" + intState.diagnostics.interventions +
              ": " + newDirectives[0].role + " - " + newDirectives[0].reason);
          }
        }
      } else {
        // Log progress toward intervention
        if (stalledFor > 0 && stalledFor % 50 === 0) {
          console.log("[Integration] " + room.name + " stalled for " + stalledFor + "/" + STALL_THRESHOLD + " ticks");
        }
      }
    } else {
      // Not stalled anymore
      if (intState.diagnostics.stalledSince) {
        console.log("[Integration] " + room.name + " stall resolved after " +
          (Game.time - intState.diagnostics.stalledSince) + " ticks");
        intState.diagnostics.stalledSince = null;
        intState.diagnostics.stalledReason = null;
      }
      // DON'T clear directives here - keep them until the role spawns
      // The directive cleanup above handles removing fulfilled directives
    }
  }

  return { complete: false, failed: false };
}

/**
 * Check if colony is self-sufficient (exit criteria for INTEGRATING)
 */
function isSelfSufficient(room: Room, diag: ColonyDiagnostic): boolean {
  // Must be RCL 2+
  if (diag.rcl < 2) return false;

  // Must have the core triangle
  if (diag.harvesters === 0) return false;
  if (diag.haulers === 0) return false;
  if (diag.upgraders === 0) return false;

  // Must have energy flow
  // Either source containers exist OR harvesters exist (mobile mode works)
  var hasEnergyFlow = diag.hasSourceContainers || diag.harvesters > 0;
  if (!hasEnergyFlow) return false;

  // Controller must not be in danger
  if (diag.controllerDowngradeTimer < 5000) return false;

  return true;
}

/**
 * Get active directive for a room (called by spawning system)
 */
export function getActiveDirective(roomName: string): SpawnDirective | null {
  var exp = Memory.empire && Memory.empire.expansion;
  if (!exp) return null;

  var state = exp.active[roomName];
  if (!state) return null;
  if (state.state !== "INTEGRATING") return null;
  if (!state.integration) return null;

  var directives = state.integration.directives;
  if (!directives || directives.length === 0) return null;

  return directives[0];
}

/**
 * Get raw integration data for programmatic access
 */
export function getIntegrationData(roomName: string): {
  roomName: string;
  ticksInState: number;
  rcl: number;
  spawnIdle: boolean;
  harvesters: number;
  haulers: number;
  upgraders: number;
  builders: number;
  pioneers: number;
  stalledReason: string | null;
  stalledSince: number | null;
  interventions: number;
  directives: SpawnDirective[];
} | null {
  var room = Game.rooms[roomName];
  if (!room) return null;

  var exp = Memory.empire && Memory.empire.expansion;
  if (!exp) return null;

  var state = exp.active[roomName];
  if (!state) return null;
  if (state.state !== "INTEGRATING") return null;

  var diag = diagnoseColony(room, state);
  var intState = state.integration;

  return {
    roomName: roomName,
    ticksInState: diag.ticksInState,
    rcl: diag.rcl,
    spawnIdle: diag.spawnIdle,
    harvesters: diag.harvesters,
    haulers: diag.haulers,
    upgraders: diag.upgraders,
    builders: diag.builders,
    pioneers: diag.pioneers,
    stalledReason: diag.stalledReason,
    stalledSince: intState ? intState.diagnostics.stalledSince : null,
    interventions: intState ? intState.diagnostics.interventions : 0,
    directives: intState ? intState.directives : [],
  };
}

/**
 * Get diagnostic status for console display
 */
export function getIntegrationStatus(roomName: string): string {
  var room = Game.rooms[roomName];
  if (!room) return "Room not visible: " + roomName;

  var exp = Memory.empire && Memory.empire.expansion;
  if (!exp) return "Empire not initialized";

  var state = exp.active[roomName];
  if (!state) return "Not an active expansion: " + roomName;
  if (state.state !== "INTEGRATING") return "State is " + state.state + ", not INTEGRATING";

  var diag = diagnoseColony(room, state);
  var intState = state.integration;

  var lines: string[] = [];
  lines.push("=== Integration Status: " + roomName + " ===");
  lines.push("State: INTEGRATING (" + diag.ticksInState + " ticks)");
  lines.push("RCL: " + diag.rcl);
  lines.push("Spawn: " + (diag.spawnIdle ? "idle" : "busy"));
  lines.push("Creeps: H:" + diag.harvesters + " HL:" + diag.haulers + " U:" + diag.upgraders + " B:" + diag.builders + " P:" + diag.pioneers);
  lines.push("Infrastructure: containers=" + diag.hasSourceContainers + " storage=" + diag.hasStorage +
    " ctrlContainer=" + diag.hasControllerContainer + " ctrlLink=" + diag.hasControllerLink);
  lines.push("Controller: progress=" + diag.controllerProgress + " downgrade=" + diag.controllerDowngradeTimer);

  if (diag.stalledReason) {
    lines.push("Diagnostic: STALLED - " + diag.stalledReason);
  } else {
    lines.push("Diagnostic: OK");
  }

  if (intState) {
    if (intState.diagnostics.stalledSince) {
      var stalledFor = Game.time - intState.diagnostics.stalledSince;
      lines.push("Stalled since: tick " + intState.diagnostics.stalledSince + " (" + stalledFor + " ticks ago)");
    }
    lines.push("Interventions: " + intState.diagnostics.interventions);

    if (intState.directives.length > 0) {
      lines.push("Active directives:");
      for (var i = 0; i < intState.directives.length; i++) {
        var d = intState.directives[i];
        lines.push("  >>> " + d.role + " (priority " + d.priority + ") - \"" + d.reason + "\"");
      }
    }
  }

  // Show utility scores for debugging
  var scores = getUtilityScores(room);
  var nonZero = scores.filter(function(s) { return s.utility > 0; });
  if (nonZero.length === 0) {
    lines.push("Utility scores: ALL ZERO");
  } else {
    lines.push("Utility scores: " + nonZero.length + " non-zero");
    for (var j = 0; j < Math.min(3, nonZero.length); j++) {
      lines.push("  " + nonZero[j].role + ": " + nonZero[j].utility.toFixed(1));
    }
  }

  return lines.join("\n");
}
