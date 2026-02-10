/**
 * ConquestCoordinator — Manages the transition from attack to occupation
 *
 * Timeline after controller hits level 0:
 *
 * Tick 0:     Controller unclaimed. Enemy structures remain.
 *             → Send DEMOLISHER to destroy spawn, towers first
 *             → Send RECLAIM_BLOCKER to reserveController()
 *
 * Tick 50-200: DEMOLISHER arrives, starts dismantling.
 *              RECLAIM_BLOCKER arrives, reserves controller (blocks enemy).
 *              reserveController() holds it for 1 tick per CLAIM part per tick.
 *
 * Tick 200+:  Spawn and towers destroyed.
 *             → Trigger ExpansionManager to send CLAIMER.
 *             → CLAIMER claims controller (needs to be adjacent, 1 tick).
 *
 * Tick 300+:  Room claimed. Bootstrap begins.
 *             → DEMOLISHER continues clearing remaining structures.
 *             → Bootstrap builders construct our spawn.
 *
 * Key insight: reserveController() and claimController() are mutually
 * exclusive — you can't claim a reserved room. So the RECLAIM_BLOCKER
 * must stop reserving (or die) before our CLAIMER arrives.
 *
 * Strategy: RECLAIM_BLOCKER only reserves if enemy CLAIM creeps are present.
 * Otherwise, it sits adjacent and waits. If enemy appears, it reserves to block.
 */

export interface ConquestState {
  phase: "DEMOLISHING" | "BLOCKING" | "READY_TO_CLAIM" | "CLAIMING" | "BOOTSTRAPPING" | "DONE";
  phaseChangedAt: number;
  demolishersSent: number;
  demolishersAlive: number;
  blockerSent: boolean;
  blockerAlive: boolean;
  structuresRemaining: number;
  spawnsDestroyed: boolean;
  towersDestroyed: boolean;
  claimTriggered: boolean;
}

/**
 * Initialize conquest state on a campaign when entering CLAIMING phase.
 */
export function initConquestState(campaign: any): void {
  if (campaign.controllerAttack && campaign.controllerAttack.conquest) return; // Already initialized

  if (!campaign.controllerAttack) {
    campaign.controllerAttack = {};
  }

  campaign.controllerAttack.conquest = {
    phase: "DEMOLISHING",
    phaseChangedAt: Game.time,
    demolishersSent: 0,
    demolishersAlive: 0,
    blockerSent: false,
    blockerAlive: false,
    structuresRemaining: -1, // Unknown until we have vision
    spawnsDestroyed: false,
    towersDestroyed: false,
    claimTriggered: false,
  } as ConquestState;
}

/**
 * Run conquest coordination. Called during CLAIMING and SECURING phases.
 */
export function runConquest(campaign: any): void {
  var conquest = campaign.controllerAttack && campaign.controllerAttack.conquest as ConquestState;
  if (!conquest) {
    initConquestState(campaign);
    conquest = campaign.controllerAttack.conquest as ConquestState;
  }

  var room = Game.rooms[campaign.targetRoom];
  if (!room) return; // No vision

  // Update structure counts
  var hostileStructures = room.find(FIND_STRUCTURES, {
    filter: function(s: Structure) {
      if ((s as OwnedStructure).my) return false;
      if (s.structureType === STRUCTURE_CONTROLLER) return false;
      return true;
    }
  });
  conquest.structuresRemaining = hostileStructures.length;

  // Check specific structure types
  var hostileSpawns = hostileStructures.filter(function(s: Structure) {
    return s.structureType === STRUCTURE_SPAWN;
  });
  var hostileTowers = hostileStructures.filter(function(s: Structure) {
    return s.structureType === STRUCTURE_TOWER;
  });
  conquest.spawnsDestroyed = hostileSpawns.length === 0;
  conquest.towersDestroyed = hostileTowers.length === 0;

  // Count our demolishers
  var demolishers = 0;
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if ((creep.memory as any).role === "DEMOLISHER" &&
        (creep.memory as any).campaignId === campaign.id) {
      demolishers++;
    }
  }
  conquest.demolishersAlive = demolishers;

  // Count reclaim blockers
  var blockers = 0;
  for (var bname in Game.creeps) {
    var bcreep = Game.creeps[bname];
    if ((bcreep.memory as any).role === "RECLAIM_BLOCKER" &&
        (bcreep.memory as any).campaignId === campaign.id) {
      blockers++;
    }
  }
  conquest.blockerAlive = blockers > 0;

  // --- Phase logic ---
  switch (conquest.phase) {
    case "DEMOLISHING":
      // Wait until spawns and towers are down
      if (conquest.spawnsDestroyed && conquest.towersDestroyed) {
        console.log("[Conquest] " + campaign.targetRoom +
          ": Spawns and towers cleared. Ready to claim.");
        conquest.phase = "READY_TO_CLAIM";
        conquest.phaseChangedAt = Game.time;
      }
      break;

    case "BLOCKING":
      // Blocking is reactive — only if enemy CLAIM creeps detected
      // Falls through to READY_TO_CLAIM when threat passes
      var enemyClaimers = room.find(FIND_HOSTILE_CREEPS, {
        filter: function(c: Creep) { return c.getActiveBodyparts(CLAIM) > 0; }
      });
      if (enemyClaimers.length === 0) {
        conquest.phase = "READY_TO_CLAIM";
        conquest.phaseChangedAt = Game.time;
      }
      break;

    case "READY_TO_CLAIM":
      // Check if enemy CLAIM creeps are trying to reclaim
      var reclaiming = room.find(FIND_HOSTILE_CREEPS, {
        filter: function(c: Creep) { return c.getActiveBodyparts(CLAIM) > 0; }
      });
      if (reclaiming.length > 0) {
        console.log("[Conquest] ALERT: Enemy CLAIM creep in " + campaign.targetRoom +
          "! Activating reclaim block.");
        conquest.phase = "BLOCKING";
        conquest.phaseChangedAt = Game.time;
        break;
      }

      // Trigger expansion claim if not already done
      if (!conquest.claimTriggered) {
        // The MilitaryManager.runClaiming() handles the actual expansion trigger
        // Just flag it here
        conquest.claimTriggered = true;
        console.log("[Conquest] " + campaign.targetRoom +
          ": Signaling MilitaryManager to trigger claim.");
      }
      break;

    case "CLAIMING":
      // Room claimed → start bootstrap
      if (room.controller && room.controller.my) {
        conquest.phase = "BOOTSTRAPPING";
        conquest.phaseChangedAt = Game.time;
        console.log("[Conquest] " + campaign.targetRoom + ": Claimed! Entering bootstrap.");
      }
      break;

    case "BOOTSTRAPPING":
      // Wait for spawn to be built
      var ourSpawns = room.find(FIND_MY_SPAWNS);
      if (ourSpawns.length > 0) {
        conquest.phase = "DONE";
        conquest.phaseChangedAt = Game.time;
        console.log("[Conquest] " + campaign.targetRoom + ": Spawn built. Conquest complete!");
      }

      // Demolishers continue clearing remaining structures while bootstrap runs
      break;

    case "DONE":
      // Nothing to do
      break;
  }

  // Log progress periodically
  if (Game.time % 200 === 0 && conquest.phase !== "DONE") {
    console.log("[Conquest] " + campaign.targetRoom +
      " — phase: " + conquest.phase +
      ", structures left: " + conquest.structuresRemaining +
      ", demolishers: " + conquest.demolishersAlive +
      ", spawns clear: " + conquest.spawnsDestroyed +
      ", towers clear: " + conquest.towersDestroyed);
  }
}

/**
 * Get spawn requests for conquest operations.
 * Called by MilitaryManager.getSpawnRequests() during CLAIMING/SECURING phases.
 */
export function getSpawnRequests(campaign: any, roomName: string): any[] {
  var conquest = campaign.controllerAttack && campaign.controllerAttack.conquest as ConquestState;
  if (!conquest) return [];
  if (conquest.phase === "DONE") return [];

  var requests: any[] = [];

  // --- Demolisher requests ---
  // Send 1-2 demolishers during DEMOLISHING phase
  var maxDemolishers = 2;
  if (conquest.demolishersAlive < maxDemolishers && conquest.phase === "DEMOLISHING") {
    // Check if this colony can contribute
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) return requests;
    if (room.energyCapacityAvailable < 800) return requests;

    var route = Game.map.findRoute(roomName, campaign.targetRoom);
    if (route === ERR_NO_PATH || !Array.isArray(route)) return requests;
    if (route.length > 6) return requests;

    requests.push({
      role: "DEMOLISHER",
      homeRoom: roomName,
      targetRoom: campaign.targetRoom,
      campaignId: campaign.id,
      priority: 55, // Above remote mining, below home economy
    });
  }

  // --- Reclaim blocker request ---
  // Only during BLOCKING phase when enemy CLAIM creeps detected
  if (conquest.phase === "BLOCKING" && !conquest.blockerAlive) {
    var bRoom = Game.rooms[roomName];
    if (!bRoom || !bRoom.controller || !bRoom.controller.my) return requests;
    if (bRoom.energyCapacityAvailable < 700) return requests; // Need CLAIM part

    var bRoute = Game.map.findRoute(roomName, campaign.targetRoom);
    if (bRoute === ERR_NO_PATH || !Array.isArray(bRoute)) return requests;
    if (bRoute.length > 6) return requests;

    requests.push({
      role: "RECLAIM_BLOCKER",
      homeRoom: roomName,
      targetRoom: campaign.targetRoom,
      campaignId: campaign.id,
      priority: 70, // High — blocking reclaim is critical
    });
  }

  return requests;
}
