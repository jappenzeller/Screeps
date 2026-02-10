/**
 * AntiDowngrade — Protect own controllers from attackController()
 *
 * Detection:
 * - Enemy CLAIM creeps in owned rooms
 * - upgradeBlocked timer appearing on our controller
 * - ticksToDowngrade dropping unexpectedly
 *
 * Response:
 * - Alert via console
 * - Prioritize upgrader spawning for the affected room
 * - Tag the room for increased defense attention
 *
 * Run every 10 ticks for all owned rooms.
 */

export interface DowngradeAlert {
  roomName: string;
  detectedAt: number;
  attackerOwner: string;
  currentTimer: number;
  upgradeBlocked: number;
  severity: "DETECTED" | "ACTIVE" | "CRITICAL";
}

/**
 * Check all owned rooms for controller attack attempts.
 * Returns alerts for any rooms under attack.
 */
export function checkAntiDowngrade(): DowngradeAlert[] {
  var alerts: DowngradeAlert[] = [];

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var controller = room.controller;

    // --- Detection 1: CLAIM creeps in the room ---
    var claimHostiles = room.find(FIND_HOSTILE_CREEPS, {
      filter: function(c: Creep) {
        return c.getActiveBodyparts(CLAIM) > 0;
      }
    });

    if (claimHostiles.length > 0) {
      var owner = claimHostiles[0].owner.username;
      var severity: DowngradeAlert["severity"] = "DETECTED";

      // If upgradeBlocked is active, they already attacked
      if (controller.upgradeBlocked && controller.upgradeBlocked > 0) {
        severity = "ACTIVE";
      }

      alerts.push({
        roomName: roomName,
        detectedAt: Game.time,
        attackerOwner: owner,
        currentTimer: controller.ticksToDowngrade || 0,
        upgradeBlocked: controller.upgradeBlocked || 0,
        severity: severity,
      });

      console.log("[AntiDowngrade] " + severity + ": CLAIM creep from " + owner +
        " in " + roomName + "! Timer: " + (controller.ticksToDowngrade || 0) +
        ", upgradeBlocked: " + (controller.upgradeBlocked || 0));
    }

    // --- Detection 2: upgradeBlocked without known cause ---
    // If upgradeBlocked > 0 and we didn't see a CLAIM creep, it happened while we had no vision
    // (shouldn't happen in owned room, but check anyway)
    if (controller.upgradeBlocked && controller.upgradeBlocked > 0 && claimHostiles.length === 0) {
      // Store in memory for tracking
      if (!Memory.military) Memory.military = {} as any;
      var mil = Memory.military as any;
      if (!mil.antiDowngrade) mil.antiDowngrade = {};
      if (!mil.antiDowngrade[roomName]) {
        mil.antiDowngrade[roomName] = {
          firstDetected: Game.time,
          lastUpgradeBlocked: controller.upgradeBlocked,
        };
        console.log("[AntiDowngrade] WARNING: " + roomName +
          " has upgradeBlocked=" + controller.upgradeBlocked + " with no visible attacker!");
      }
    }
  }

  // --- Store alerts for spawning system to read ---
  if (alerts.length > 0) {
    if (!Memory.military) Memory.military = {} as any;
    (Memory.military as any).activeDowngradeAlerts = alerts;
  } else {
    if (Memory.military) {
      delete (Memory.military as any).activeDowngradeAlerts;
    }
  }

  return alerts;
}

/**
 * Check if a specific room is under controller attack.
 * Used by spawning system to boost upgrader priority.
 */
export function isUnderControllerAttack(roomName: string): boolean {
  var mil = Memory.military as any;
  if (!mil || !mil.activeDowngradeAlerts) return false;

  for (var i = 0; i < mil.activeDowngradeAlerts.length; i++) {
    if (mil.activeDowngradeAlerts[i].roomName === roomName) {
      return true;
    }
  }
  return false;
}

/**
 * Get the recommended defense response for a room under attack.
 */
export function getDefenseResponse(roomName: string): {
  boostUpgraders: boolean;
  spawnGuards: boolean;
  activateSafeMode: boolean;
} {
  var room = Game.rooms[roomName];
  if (!room || !room.controller) {
    return { boostUpgraders: false, spawnGuards: false, activateSafeMode: false };
  }

  var controller = room.controller;
  var timer = controller.ticksToDowngrade || 0;

  // Determine severity based on how much timer has been drained
  var maxTimer = getMaxTimer(controller.level);
  var pctRemaining = timer / maxTimer;

  return {
    // Always boost upgraders when under attack — counteract the drain
    boostUpgraders: true,
    // Spawn guards if we see CLAIM creeps (kill them before they reach controller)
    spawnGuards: true,
    // Safe mode only if timer drops below 25% — last resort
    activateSafeMode: pctRemaining < 0.25,
  };
}

function getMaxTimer(rcl: number): number {
  var timers: Record<number, number> = {
    1: 20000, 2: 10000, 3: 20000, 4: 40000,
    5: 80000, 6: 120000, 7: 150000, 8: 200000,
  };
  return timers[rcl] || 20000;
}
