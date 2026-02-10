/**
 * CampaignChain — Evaluate and suggest next campaign targets
 *
 * After a campaign completes, scans neighboring rooms owned by
 * the same player (or other hostile players) and ranks them.
 *
 * Does NOT auto-launch — presents options via console for manual decision.
 */

export interface CampaignTarget {
  roomName: string;
  owner: string;
  rcl: number;
  distance: number;          // Rooms from nearest owned colony
  estimatedCycles: number;
  estimatedHours: number;
  towers: number;
  safeModes: number;
  terminalPresent: boolean;
  threatLevel: "LOW" | "MEDIUM" | "HIGH";
  reason: string;
}

/**
 * Evaluate potential next targets after a campaign.
 * Searches rooms within 3 tiles of all owned colonies for hostile controllers.
 */
export function evaluateTargets(): CampaignTarget[] {
  var targets: CampaignTarget[] = [];
  var checked: Record<string, boolean> = {};

  // Scan intel for hostile-owned rooms near our colonies
  var intel = Memory.intel || {};
  for (var roomName in intel) {
    var ri = intel[roomName];
    if (!ri.owner) continue;
    if (checked[roomName]) continue;
    checked[roomName] = true;

    // Skip our own rooms
    var isOurs = false;
    for (var ownedName in Game.rooms) {
      var ownedRoom = Game.rooms[ownedName];
      if (ownedRoom && ownedRoom.controller && ownedRoom.controller.my &&
          ownedName === roomName) {
        isOurs = true;
        break;
      }
    }
    if (isOurs) continue;

    // Find distance from nearest owned colony
    var minDist = Infinity;
    for (var colName in Game.rooms) {
      var col = Game.rooms[colName];
      if (!col || !col.controller || !col.controller.my) continue;

      var route = Game.map.findRoute(colName, roomName);
      if (route !== ERR_NO_PATH && Array.isArray(route)) {
        if (route.length < minDist) {
          minDist = route.length;
        }
      }
    }

    // Only consider rooms within CLAIM creep range
    if (minDist > 7 || minDist === Infinity) continue;

    // CLAIM lifespan check: 50 ticks/room, 600 tick lifespan, need ~150 slack
    if (minDist * 50 > 450) continue;

    var rcl = ri.ownerRcl || 1;
    var towers = (ri.hostileStructures && ri.hostileStructures.towers) ? ri.hostileStructures.towers : 0;
    var hasTerminal = (ri.hostileStructures && ri.hostileStructures.hasTerminal) ? true : false;

    // Estimate downgrade cycles (simplified)
    var timerEstimate = getDowngradeTimer(rcl);
    var cyclesPerLevel = Math.ceil(timerEstimate / 1900); // 1900 effective per cycle
    var totalCycles = cyclesPerLevel; // Just current level as rough estimate
    var estHours = (totalCycles * 1000 / 3600) * 3;

    // Threat assessment
    var threat: CampaignTarget["threatLevel"] = "LOW";
    if (towers >= 2 || rcl >= 7) threat = "HIGH";
    else if (towers >= 1 || rcl >= 5 || hasTerminal) threat = "MEDIUM";

    // Determine reason/value
    var reason = "Hostile " + ri.owner + " RCL " + rcl;
    if (minDist <= 3) reason += ", close to our territory";
    if (rcl <= 3) reason += ", easy target";
    if (towers === 0) reason += ", no towers";

    targets.push({
      roomName: roomName,
      owner: ri.owner,
      rcl: rcl,
      distance: minDist,
      estimatedCycles: totalCycles,
      estimatedHours: Math.round(estHours * 10) / 10,
      towers: towers,
      safeModes: 0, // Can't know without vision
      terminalPresent: hasTerminal,
      threatLevel: threat,
      reason: reason,
    });
  }

  // Sort: lowest threat first, then by distance, then by RCL
  targets.sort(function(a, b) {
    var threatOrder: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    var threatDiff = threatOrder[a.threatLevel] - threatOrder[b.threatLevel];
    if (threatDiff !== 0) return threatDiff;
    var distDiff = a.distance - b.distance;
    if (distDiff !== 0) return distDiff;
    return a.rcl - b.rcl;
  });

  return targets;
}

function getDowngradeTimer(rcl: number): number {
  var timers: Record<number, number> = {
    1: 20000, 2: 10000, 3: 20000, 4: 40000,
    5: 80000, 6: 120000, 7: 150000, 8: 200000,
  };
  return timers[rcl] || 20000;
}

/**
 * Display targets in a formatted table.
 */
export function displayTargets(targets: CampaignTarget[]): string {
  var lines: string[] = [];
  lines.push("=== Potential Campaign Targets ===");

  if (targets.length === 0) {
    lines.push("  No hostile rooms within strike range.");
    return lines.join("\n");
  }

  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var icon = t.threatLevel === "LOW" ? "●" : t.threatLevel === "MEDIUM" ? "▲" : "◆";
    lines.push("");
    lines.push(icon + " " + t.roomName + " — " + t.owner + " RCL " + t.rcl +
      " [" + t.threatLevel + "]");
    lines.push("  Distance: " + t.distance + " rooms | Towers: " + t.towers +
      " | Terminal: " + (t.terminalPresent ? "yes" : "no"));
    lines.push("  Est: ~" + t.estimatedCycles + " cycles / ~" + t.estimatedHours + " hours");
    lines.push("  " + t.reason);
    lines.push("  → military.attack('" + t.roomName + "')");
  }

  return lines.join("\n");
}
