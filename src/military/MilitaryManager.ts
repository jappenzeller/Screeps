/**
 * Military Manager - Coordinates offensive and defensive operations
 *
 * Phase 1: Controller Attack Campaign
 * - Attacks hostile room controllers to downgrade them
 * - Target: E44N39 (Bazsi1224, RCL 6)
 */

import * as DuoManager from "../combat/DuoManager";
import { ExpansionManager } from "../empire/ExpansionManager";

// ============================================
// Types
// ============================================

export type CampaignPhase =
  | "PLANNING"
  | "SCOUTING"
  | "ATTACKING"
  | "WAITING_SAFE_MODE"
  | "WAITING_COOLDOWN"
  | "TOWER_DRAINING"
  | "CLAIMING"
  | "SECURING"
  | "COMPLETE"
  | "ABORTED"
  | "PAUSED";

export interface CampaignStats {
  totalSpawned: number;
  totalLost: number;
  totalEnergySpent: number;
  rclDowngrades: number[];
  safeModeActivations: number;
  campaignStartTimer: number;
  campaignStartRCL: number;
}

export interface ControllerAttackState {
  controllerPos: { x: number; y: number };
  approachDirection: "south" | "west" | "east" | "north";
  lastAttackTick: number;
  attackCount: number;
  currentTargetRCL: number;
  currentTicksToDowngrade: number;
  estimatedTicksRemaining: number;
  estimatedCyclesRemaining: number;
  towerPositions: { x: number; y: number; lastEnergy: number }[];
  safeModeActive: boolean;
  safeModeEndsAt: number;
  upgradeBlockedUntil: number;
  defendersSeen: boolean;
  defendersLastSeen: number;
  towerDrainNeeded: boolean;
  stats: CampaignStats;
}

export interface CampaignState {
  id: string;
  type: "CONTROLLER_ATTACK" | "ROOM_ASSAULT" | "TOWER_DRAIN";
  targetRoom: string;
  homeRoom: string;
  supportRooms: string[];
  state: CampaignPhase;
  stateChangedAt: number;
  createdAt: number;
  targetOwner: string;
  controllerAttack?: ControllerAttackState;
}

export interface MilitaryMemory {
  campaigns: Record<string, CampaignState>;
  nextCampaignId: number;
  posture: "PEACEFUL" | "ALERT" | "OFFENSIVE";
}

// ============================================
// Constants
// ============================================

var SPAWN_TIME = 18; // 6 parts x 3 ticks each
var TRAVEL_TIME = 200; // Estimated 4 rooms at ~50 ticks each
var ATTACK_COOLDOWN = 1000; // Controller upgradeBlocked duration
var CLAIM_LIFESPAN = 600; // CLAIM creeps only live 600 ticks
var TOWER_DRAIN_MAX_DECOYS = 3; // Max concurrent decoys
var TOWER_DRAIN_ENERGY_THRESHOLD = 200; // Towers "drained" when below this combined
var ESCORT_DUO_ID_KEY = "escortDuoId";
var ESTIMATED_TRAVEL_TIME = 200;
var HOME_THREAT_PAUSE_THRESHOLD = 3; // Hostile combat parts to trigger pause
var MAX_MILITARY_SPAWN_PCT = 0.10; // Max 10% of spawn time for military

// ============================================
// Memory Access
// ============================================

export function getMilitaryMemory(): MilitaryMemory {
  if (!Memory.military) {
    Memory.military = {
      campaigns: {},
      nextCampaignId: 1,
      posture: "PEACEFUL",
    };
  }
  return Memory.military;
}

// ============================================
// Helper Functions
// ============================================

function transitionTo(campaign: CampaignState, newState: CampaignPhase): void {
  console.log("[Military] " + campaign.id + ": " + campaign.state + " -> " + newState);
  campaign.state = newState;
  campaign.stateChangedAt = Game.time;
}

function estimateCyclesRemaining(rcl: number, ticksToDowngrade: number): number {
  // Each attack removes 900 ticks (3 CLAIM parts x 300)
  // Plus 1000 ticks natural decay = 1900 effective per cycle
  var effectivePerCycle = 1900;
  return Math.ceil(ticksToDowngrade / effectivePerCycle);
}

function getAttackersForCampaign(campaignId: string): Creep[] {
  var result: Creep[] = [];
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if (creep.memory.role === "CONTROLLER_ATTACKER" &&
        (creep.memory as any).campaignId === campaignId) {
      result.push(creep);
    }
  }
  return result;
}

function getDecoysForCampaign(campaignId: string): Creep[] {
  var result: Creep[] = [];
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if (creep.memory.role === "DECOY" &&
        (creep.memory as any).campaignId === campaignId) {
      result.push(creep);
    }
  }
  return result;
}

// ============================================
// Home Defense Awareness
// ============================================

/**
 * Check if any of our colonies are under significant attack.
 * If so, pause non-critical campaigns to free spawn capacity.
 */
function checkHomeDefense(): boolean {
  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
      filter: function(c: Creep) {
        // Only count real threats, not scouts
        return (c.getActiveBodyparts(ATTACK) +
                c.getActiveBodyparts(RANGED_ATTACK) +
                c.getActiveBodyparts(HEAL)) >= HOME_THREAT_PAUSE_THRESHOLD;
      }
    });

    if (hostiles.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Check if empire-wide spawn budget allows another military creep.
 */
function withinSpawnBudget(): boolean {
  var mem = getMilitaryMemory();
  var activeCampaigns = 0;
  for (var id in mem.campaigns) {
    var state = mem.campaigns[id].state;
    if (state === "ATTACKING" || state === "TOWER_DRAINING") {
      activeCampaigns++;
    }
  }

  // Each campaign uses ~1.8% spawn time (18 ticks per 1000)
  var totalSpawns = Object.keys(Game.spawns).length;
  if (totalSpawns === 0) return false;

  var totalCapacity = totalSpawns * 1000;
  var militaryUsage = activeCampaigns * 18;
  var militaryPct = militaryUsage / totalCapacity;

  return militaryPct < MAX_MILITARY_SPAWN_PCT;
}

// ============================================
// Main Run Function
// ============================================

export function run(): void {
  var mem = getMilitaryMemory();

  // Home defense check — log when under attack
  var homeUnderAttack = checkHomeDefense();
  if (homeUnderAttack && mem.posture === "OFFENSIVE") {
    if (Game.time % 100 === 0) {
      console.log("[Military] Home colony under attack — campaign spawning deprioritized");
    }
  }

  for (var id in mem.campaigns) {
    var campaign = mem.campaigns[id];

    switch (campaign.state) {
      case "PLANNING":
        runPlanning(campaign);
        break;
      case "SCOUTING":
        runScouting(campaign);
        break;
      case "ATTACKING":
        runAttacking(campaign);
        break;
      case "WAITING_SAFE_MODE":
        runWaitingSafeMode(campaign);
        break;
      case "WAITING_COOLDOWN":
        runWaitingCooldown(campaign);
        break;
      case "TOWER_DRAINING":
        runTowerDraining(campaign);
        break;
      case "CLAIMING":
        runClaiming(campaign);
        break;
      case "SECURING":
        runSecuring(campaign);
        break;
      case "PAUSED":
        // Do nothing while paused
        break;
      case "COMPLETE":
      case "ABORTED":
        // Cleanup completed/aborted campaigns after some time
        if (Game.time - campaign.stateChangedAt > 10000) {
          delete mem.campaigns[id];
        }
        break;
    }
  }
}

// ============================================
// Campaign CRUD
// ============================================

interface CreateCampaignParams {
  type: "CONTROLLER_ATTACK";
  homeRoom: string;
  targetRoom: string;
  supportRooms?: string[];
}

export function createCampaign(params: CreateCampaignParams): string {
  var mem = getMilitaryMemory();
  var id = "campaign_" + mem.nextCampaignId++;

  // Get target owner from intel if available
  var targetOwner = "unknown";
  var intel = Memory.intel && Memory.intel[params.targetRoom];
  if (intel && intel.owner) {
    targetOwner = intel.owner;
  }

  var campaign: CampaignState = {
    id: id,
    type: params.type,
    targetRoom: params.targetRoom,
    homeRoom: params.homeRoom,
    supportRooms: params.supportRooms || [],
    state: "PLANNING",
    stateChangedAt: Game.time,
    createdAt: Game.time,
    targetOwner: targetOwner,
  };

  if (params.type === "CONTROLLER_ATTACK") {
    campaign.controllerAttack = {
      controllerPos: { x: 0, y: 0 },
      approachDirection: "south",
      lastAttackTick: 0,
      attackCount: 0,
      currentTargetRCL: 0,
      currentTicksToDowngrade: 0,
      estimatedTicksRemaining: 0,
      estimatedCyclesRemaining: 0,
      towerPositions: [],
      safeModeActive: false,
      safeModeEndsAt: 0,
      upgradeBlockedUntil: 0,
      defendersSeen: false,
      defendersLastSeen: 0,
      towerDrainNeeded: false,
      stats: {
        totalSpawned: 0,
        totalLost: 0,
        totalEnergySpent: 0,
        rclDowngrades: [],
        safeModeActivations: 0,
        campaignStartTimer: 0,
        campaignStartRCL: 0,
      },
    };
  }

  mem.campaigns[id] = campaign;
  mem.posture = "OFFENSIVE";

  console.log("[Military] Created campaign " + id + " targeting " + params.targetRoom);
  return id;
}

export function abortCampaign(campaignId: string): string {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (!campaign) {
    return "Campaign not found: " + campaignId;
  }

  campaign.state = "ABORTED";
  campaign.stateChangedAt = Game.time;

  // Update posture if no active campaigns
  var hasActive = false;
  for (var id in mem.campaigns) {
    var c = mem.campaigns[id];
    if (c.state !== "COMPLETE" && c.state !== "ABORTED") {
      hasActive = true;
      break;
    }
  }
  if (!hasActive) {
    mem.posture = "PEACEFUL";
  }

  console.log("[Military] Aborted campaign " + campaignId);
  return "Campaign aborted";
}

export function pauseCampaign(campaignId: string): string {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (!campaign) {
    return "Campaign not found: " + campaignId;
  }

  if (campaign.state === "PAUSED") {
    return "Campaign already paused";
  }

  // Store previous state in memory for resume
  (campaign as any)._previousState = campaign.state;
  campaign.state = "PAUSED";
  campaign.stateChangedAt = Game.time;

  console.log("[Military] Paused campaign " + campaignId);
  return "Campaign paused";
}

export function resumeCampaign(campaignId: string): string {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (!campaign) {
    return "Campaign not found: " + campaignId;
  }

  if (campaign.state !== "PAUSED") {
    return "Campaign is not paused";
  }

  var previousState = (campaign as any)._previousState || "ATTACKING";
  delete (campaign as any)._previousState;
  campaign.state = previousState as CampaignPhase;
  campaign.stateChangedAt = Game.time;

  console.log("[Military] Resumed campaign " + campaignId);
  return "Campaign resumed to " + previousState;
}

// ============================================
// Phase Handlers
// ============================================

function runPlanning(campaign: CampaignState): void {
  // Validate home room can spawn CLAIM creeps
  var homeRoom = Game.rooms[campaign.homeRoom];
  if (!homeRoom) {
    console.log("[Military] Cannot plan: home room " + campaign.homeRoom + " not visible");
    return;
  }

  // Need 2100 energy for [CLAIM x3, MOVE x3]
  if (homeRoom.energyCapacityAvailable < 2100) {
    console.log("[Military] Cannot plan: " + campaign.homeRoom + " energy capacity too low (" +
      homeRoom.energyCapacityAvailable + " < 2100)");
    campaign.state = "ABORTED";
    campaign.stateChangedAt = Game.time;
    return;
  }

  // Validate route exists
  var route = Game.map.findRoute(campaign.homeRoom, campaign.targetRoom, {
    routeCallback: function(roomName) {
      // Avoid source keeper rooms
      var parsed = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
      if (parsed) {
        var x = parseInt(parsed[1]) % 10;
        var y = parseInt(parsed[2]) % 10;
        if ((x === 4 || x === 5 || x === 6) && (y === 4 || y === 5 || y === 6)) {
          return Infinity; // SK room
        }
      }
      return 1;
    }
  });

  if (route === ERR_NO_PATH) {
    console.log("[Military] Cannot plan: no valid route to " + campaign.targetRoom);
    campaign.state = "ABORTED";
    campaign.stateChangedAt = Game.time;
    return;
  }

  console.log("[Military] " + campaign.id + ": Planning complete. Route is " +
    (Array.isArray(route) ? route.length : 0) + " rooms. Moving to SCOUTING.");

  campaign.state = "SCOUTING";
  campaign.stateChangedAt = Game.time;
}

function runScouting(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  // Check if we have vision on target room
  var room = Game.rooms[campaign.targetRoom];

  if (!room) {
    // No vision - check if we have a scout heading there
    var scouts = Object.values(Game.creeps).filter(function(c) {
      return c.memory.role === "SCOUT" && c.memory.targetRoom === campaign.targetRoom;
    });

    if (scouts.length === 0) {
      // Request a scout - the spawning system will handle this via utility
      // For now, transition to ATTACKING and gather intel when creeps arrive
      console.log("[Military] " + campaign.id + ": No vision on " + campaign.targetRoom +
        ". Proceeding to ATTACKING to gather intel.");
      campaign.state = "ATTACKING";
      campaign.stateChangedAt = Game.time;
    }
    return;
  }

  // We have vision - gather intel
  var controller = room.controller;
  if (!controller) {
    console.log("[Military] " + campaign.id + ": Target room has no controller!");
    campaign.state = "ABORTED";
    campaign.stateChangedAt = Game.time;
    return;
  }

  // Check if already neutral
  if (!controller.owner) {
    console.log("[Military] " + campaign.id + ": Controller is already neutral. Moving to CLAIMING.");
    campaign.state = "CLAIMING";
    campaign.stateChangedAt = Game.time;
    return;
  }

  // Update attack state with current intel
  attack.controllerPos = { x: controller.pos.x, y: controller.pos.y };
  attack.currentTargetRCL = controller.level;
  attack.currentTicksToDowngrade = controller.ticksToDowngrade || 0;

  // Check safe mode
  if (controller.safeMode && controller.safeMode > 0) {
    attack.safeModeActive = true;
    attack.safeModeEndsAt = Game.time + controller.safeMode;
    console.log("[Military] " + campaign.id + ": Target has safe mode active for " +
      controller.safeMode + " ticks. Moving to WAITING_SAFE_MODE.");
    campaign.state = "WAITING_SAFE_MODE";
    campaign.stateChangedAt = Game.time;
    return;
  }

  // Gather tower intel
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];

  attack.towerPositions = [];
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    attack.towerPositions.push({
      x: tower.pos.x,
      y: tower.pos.y,
      lastEnergy: tower.store[RESOURCE_ENERGY]
    });
  }

  // Calculate tower damage at controller range
  var minTowerRange = 999;
  for (var j = 0; j < towers.length; j++) {
    var t = towers[j];
    var range = t.pos.getRangeTo(controller);
    if (range < minTowerRange) minTowerRange = range;
  }

  console.log("[Military] " + campaign.id + ": Scout complete. RCL " + controller.level +
    ", timer " + attack.currentTicksToDowngrade + ", " + towers.length + " towers (min range " +
    minTowerRange + "). Moving to ATTACKING.");

  campaign.state = "ATTACKING";
  campaign.stateChangedAt = Game.time;
}

function runAttacking(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  var room = Game.rooms[campaign.targetRoom];

  // Update intel if we have vision
  if (room && room.controller) {
    var controller = room.controller;

    // Check if controller is now neutral - victory!
    if (!controller.owner) {
      console.log("[Military] " + campaign.id + ": Controller downgraded to neutral! Moving to CLAIMING.");
      transitionTo(campaign, "CLAIMING");
      return;
    }

    // Update state
    attack.currentTargetRCL = controller.level;
    attack.currentTicksToDowngrade = controller.ticksToDowngrade || 0;

    // Check for safe mode
    if (controller.safeMode && controller.safeMode > 0) {
      attack.safeModeActive = true;
      attack.safeModeEndsAt = Game.time + controller.safeMode;
      console.log("[Military] " + campaign.id + ": Safe mode detected! Duration: " +
        controller.safeMode + " ticks.");
      transitionTo(campaign, "WAITING_SAFE_MODE");
      return;
    }

    // Update upgradeBlocked estimate
    if (controller.upgradeBlocked && controller.upgradeBlocked > 0) {
      attack.upgradeBlockedUntil = Game.time + controller.upgradeBlocked;
    }
  }

  // === Manage active CONTROLLER_ATTACKER creeps ===
  var attackers = getAttackersForCampaign(campaign.id);
  var hasUnspentAttacker = false;
  for (var i = 0; i < attackers.length; i++) {
    if (!(attackers[i].memory as any).attacked) {
      hasUnspentAttacker = true;
      break;
    }
  }

  // === Adaptation checks (every 50 ticks when we have vision) ===
  if (Game.time % 50 === 0 && room) {
    checkAdaptation(campaign, room);
  }

  // === If defenders detected recently, request escort ===
  if (attack.defendersSeen && Game.time - attack.defendersLastSeen < 3000) {
    if (!hasActiveEscort(campaign)) {
      requestDuoEscort(campaign);
    }
  }

  // The actual attack logic is handled by the ControllerAttacker creeps
  // Spawning is handled by utilitySpawning.ts based on campaign state
}

function runWaitingSafeMode(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  // Track safe mode activation (only on first tick of this state)
  if (Game.time === campaign.stateChangedAt) {
    attack.stats.safeModeActivations++;
    console.log("[Military] Safe mode #" + attack.stats.safeModeActivations +
      " activated in " + campaign.targetRoom);
  }

  var room = Game.rooms[campaign.targetRoom];

  // If we have vision, check if safe mode ended
  if (room && room.controller) {
    if (!room.controller.safeMode || room.controller.safeMode === 0) {
      attack.safeModeActive = false;
      console.log("[Military] " + campaign.id + ": Safe mode ended. Resuming attacks.");
      campaign.state = "ATTACKING";
      campaign.stateChangedAt = Game.time;
      return;
    }
    // Update end estimate
    attack.safeModeEndsAt = Game.time + room.controller.safeMode;
  }

  // If no vision, estimate from last known data
  if (Game.time > attack.safeModeEndsAt) {
    console.log("[Military] " + campaign.id + ": Safe mode should have expired. Checking with scout.");
    campaign.state = "SCOUTING";
    campaign.stateChangedAt = Game.time;
  }
}

function runWaitingCooldown(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  // Check if cooldown expired
  if (Game.time >= attack.upgradeBlockedUntil) {
    campaign.state = "ATTACKING";
    campaign.stateChangedAt = Game.time;
  }
}

function runTowerDraining(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  var room = Game.rooms[campaign.targetRoom];

  // Check if towers are drained
  if (room) {
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s: Structure) { return s.structureType === STRUCTURE_TOWER; }
    }) as StructureTower[];

    var totalTowerEnergy = 0;
    for (var i = 0; i < towers.length; i++) {
      totalTowerEnergy += towers[i].store[RESOURCE_ENERGY];
    }

    if (totalTowerEnergy < TOWER_DRAIN_ENERGY_THRESHOLD) {
      console.log("[Military] Towers drained in " + campaign.targetRoom +
        " (total energy: " + totalTowerEnergy + "). Resuming attack.");
      attack.towerDrainNeeded = false;
      transitionTo(campaign, "ATTACKING");
      return;
    }

    // Log progress every 100 ticks
    if (Game.time % 100 === 0) {
      console.log("[Military] Tower drain in progress — " + campaign.targetRoom +
        " tower energy: " + totalTowerEnergy);
    }
  }

  // Decoy spawning is handled by getSpawnRequests — nothing else to do here
}

function runClaiming(campaign: CampaignState): void {
  var room = Game.rooms[campaign.targetRoom];

  // Check if room is already ours
  if (room && room.controller && room.controller.my) {
    console.log("[Military] *** " + campaign.targetRoom + " CLAIMED! ***");
    console.log("[Military] Campaign " + campaign.id + " entering SECURING phase.");

    // Attempt to hand off to ExpansionManager
    initiateExpansionHandoff(campaign);
    transitionTo(campaign, "SECURING");
    return;
  }

  // Check if controller is neutral (our goal)
  if (room && room.controller && !room.controller.owner) {
    // Controller is down — need to send a CLAIMER
    var claimers: Creep[] = [];
    for (var name in Game.creeps) {
      var creep = Game.creeps[name];
      if (creep.memory.role === "CLAIMER" &&
          creep.memory.targetRoom === campaign.targetRoom) {
        claimers.push(creep);
      }
    }

    if (claimers.length === 0) {
      // No claimer — we need to trigger expansion system
      var alreadyExpanding = false;
      if (Memory.empire && Memory.empire.expansion && Memory.empire.expansion.active) {
        if ((Memory.empire.expansion.active as any)[campaign.targetRoom]) {
          alreadyExpanding = true;
        }
      }

      if (!alreadyExpanding) {
        var parentRoom = selectBestParentForClaim(campaign.targetRoom);
        if (parentRoom) {
          console.log("[Military] Controller DOWN in " + campaign.targetRoom +
            " — triggering expansion from " + parentRoom);
          initiateExpansionHandoff(campaign);
        } else {
          console.log("[Military] No suitable parent room found for " + campaign.targetRoom +
            " — manually run: expansion.expand('" + campaign.targetRoom + "', '<parentRoom>')");
        }
      } else {
        if (Game.time % 200 === 0) {
          console.log("[Military] Waiting for expansion system to claim " + campaign.targetRoom);
        }
      }
    } else {
      if (Game.time % 100 === 0) {
        console.log("[Military] CLAIMER en route to " + campaign.targetRoom +
          " — TTL: " + (claimers[0].ticksToLive || "?"));
      }
    }
  } else if (!room) {
    if (Game.time % 200 === 0) {
      console.log("[Military] No vision on " + campaign.targetRoom + " in CLAIMING state");
    }
  }
}

/**
 * Initiate handoff to ExpansionManager for newly conquered room.
 */
function initiateExpansionHandoff(campaign: CampaignState): void {
  var parentRoom = selectBestParentForClaim(campaign.targetRoom);
  if (!parentRoom) {
    console.log("[Military] No parent room found for expansion handoff");
    return;
  }

  // Use existing expansion system
  try {
    var manager = new ExpansionManager();
    var success = manager.startExpansion(campaign.targetRoom, parentRoom);
    if (success) {
      console.log("[Military] ExpansionManager.startExpansion() succeeded for " +
        campaign.targetRoom);
    } else {
      console.log("[Military] ExpansionManager.startExpansion() returned false — " +
        "check expansion readiness. Try manually: expansion.expand('" +
        campaign.targetRoom + "', '" + parentRoom + "')");
    }
  } catch (e) {
    console.log("[Military] Error starting expansion: " + e +
      " — try manually: expansion.expand('" + campaign.targetRoom + "', '" + parentRoom + "')");
  }
}

/**
 * Select best parent room for claiming a conquered target.
 * Prefers: closest, highest RCL, with energy reserves.
 */
function selectBestParentForClaim(targetRoom: string): string | null {
  var best: string | null = null;
  var bestScore = -Infinity;

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    if (room.controller.level < 4) continue; // Need CLAIM parts

    var route = Game.map.findRoute(roomName, targetRoom);
    if (route === ERR_NO_PATH || !Array.isArray(route)) continue;

    var distance = route.length;
    if (distance > 10) continue; // Too far

    // Score: prioritize close distance, high RCL, and energy reserves
    var score = 100 - (distance * 15) + (room.controller.level * 10);
    if (room.storage) {
      score += Math.min(30, room.storage.store[RESOURCE_ENERGY] / 10000);
    }

    if (score > bestScore) {
      bestScore = score;
      best = roomName;
    }
  }

  return best;
}

function runSecuring(campaign: CampaignState): void {
  var room = Game.rooms[campaign.targetRoom];

  // Check if the room is owned and has a spawn
  if (room && room.controller && room.controller.my) {
    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length > 0) {
      // Spawn built — colony is bootstrapped
      completeCampaign(campaign);
      return;
    }

    // Check expansion state
    if (Memory.empire && Memory.empire.expansion && Memory.empire.expansion.active) {
      var expansion = (Memory.empire.expansion.active as any)[campaign.targetRoom];
      if (expansion) {
        if (Game.time % 500 === 0) {
          console.log("[Military] Securing " + campaign.targetRoom +
            " — expansion state: " + expansion.state +
            " (ticks in state: " + (Game.time - expansion.stateChangedAt) + ")");
        }

        // If expansion completes, we're done
        if (expansion.state === "COMPLETE" || expansion.state === "INTEGRATING") {
          completeCampaign(campaign);
          return;
        }
      }
    }
  } else if (room && room.controller && !room.controller.my) {
    // Lost the claim somehow — go back to CLAIMING
    console.log("[Military] Lost claim on " + campaign.targetRoom + " — reverting to CLAIMING");
    transitionTo(campaign, "CLAIMING");
  }

  // Timeout: if securing takes too long, just complete
  if (Game.time - campaign.stateChangedAt > 20000) {
    console.log("[Military] Securing timeout for " + campaign.targetRoom + " — marking complete");
    completeCampaign(campaign);
  }
}

function completeCampaign(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) {
    transitionTo(campaign, "COMPLETE");
    return;
  }

  var duration = Game.time - campaign.createdAt;
  var hours = (duration / 3600 * 3).toFixed(1);
  var stats = attack.stats;

  console.log("╔══════════════════════════════════════════╗");
  console.log("║  CAMPAIGN COMPLETE: " + campaign.targetRoom.padEnd(20) + "║");
  console.log("╠══════════════════════════════════════════╣");
  console.log("║  Target:    " + campaign.targetOwner.padEnd(28) + "║");
  console.log("║  Duration:  " + (duration + " ticks (~" + hours + "h)").padEnd(28) + "║");
  console.log("║  Attacks:   " + (attack.attackCount + "").padEnd(28) + "║");
  console.log("║  Spawned:   " + (stats.totalSpawned + "").padEnd(28) + "║");
  console.log("║  Losses:    " + (stats.totalLost + "").padEnd(28) + "║");
  console.log("║  Energy:    " + (stats.totalEnergySpent + "").padEnd(28) + "║");
  console.log("║  RCL drops: " + (stats.rclDowngrades.length + "").padEnd(28) + "║");
  console.log("║  Safe modes:" + (stats.safeModeActivations + "").padEnd(28) + "║");
  console.log("╚══════════════════════════════════════════╝");

  // Store completion data
  (campaign as any).completedAt = Game.time;
  (campaign as any).completionStats = {
    duration: duration,
    attacks: attack.attackCount,
    spawned: stats.totalSpawned,
    losses: stats.totalLost,
    energySpent: stats.totalEnergySpent,
    rclDowngrades: stats.rclDowngrades.length,
    safeModes: stats.safeModeActivations,
  };

  transitionTo(campaign, "COMPLETE");

  // Check if all campaigns done
  var mem = getMilitaryMemory();
  var anyActive = false;
  for (var id in mem.campaigns) {
    var c = mem.campaigns[id];
    if (c.state !== "COMPLETE" && c.state !== "ABORTED") {
      anyActive = true;
      break;
    }
  }
  if (!anyActive) {
    mem.posture = "PEACEFUL";
    console.log("[Military] All campaigns complete — posture set to PEACEFUL");
  }
}

// ============================================
// Adaptation Detection
// ============================================

/**
 * Monitor conditions and auto-escalate when needed.
 * Called every 50 ticks during ATTACKING phase.
 */
function checkAdaptation(campaign: CampaignState, room: Room): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  var controller = room.controller;
  if (!controller) return;

  var stats = attack.stats;

  // --- RCL downgrade milestone ---
  if (controller.owner && controller.level < attack.currentTargetRCL) {
    var newRCL = controller.level;
    console.log("[Military] *** " + campaign.targetRoom + " DOWNGRADED to RCL " + newRCL + "! ***");
    console.log("[Military] Previous: RCL " + attack.currentTargetRCL + " → New: RCL " + newRCL);
    attack.currentTargetRCL = newRCL;
    stats.rclDowngrades.push(Game.time);
    attack.estimatedCyclesRemaining = estimateCyclesRemaining(newRCL, controller.ticksToDowngrade || 0);
    console.log("[Military] Est remaining: " + attack.estimatedCyclesRemaining + " cycles");

    // At RCL 2, towers are destroyed (towers require RCL 3)
    if (newRCL <= 2 && attack.towerDrainNeeded) {
      attack.towerDrainNeeded = false;
      console.log("[Military] RCL dropped to " + newRCL + " — towers should be destroyed, clearing drain flag");
    }
  }

  // --- Defender detection ---
  var hostileDefenders = controller.pos.findInRange(FIND_HOSTILE_CREEPS, 8, {
    filter: function(c: Creep) {
      return c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0;
    }
  });

  if (hostileDefenders.length > 0) {
    attack.defendersSeen = true;
    attack.defendersLastSeen = Game.time;
    (attack as any).defenderSightings = ((attack as any).defenderSightings || 0) + 1;
  }

  // --- Tower refill detection ---
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s: Structure) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];

  var totalTowerEnergy = 0;
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    totalTowerEnergy += tower.store[RESOURCE_ENERGY];

    var towerState = null;
    for (var j = 0; j < attack.towerPositions.length; j++) {
      var t = attack.towerPositions[j];
      if (t.x === tower.pos.x && t.y === tower.pos.y) {
        towerState = t;
        break;
      }
    }

    if (towerState) {
      if (tower.store[RESOURCE_ENERGY] > towerState.lastEnergy + 100) {
        attack.towerDrainNeeded = true;
      }
      towerState.lastEnergy = tower.store[RESOURCE_ENERGY];
    }
  }

  // --- Auto tower drain escalation ---
  // If 3+ creeps have died without attacking, towers are likely killing them
  if (stats.totalLost >= 3 && !attack.towerDrainNeeded) {
    var lossRate = stats.totalLost / Math.max(1, stats.totalSpawned);
    if (lossRate > 0.3) {
      // More than 30% loss rate — auto-escalate
      if (towers.length > 0) {
        console.log("[Military] AUTO-ESCALATION: " + (lossRate * 100).toFixed(0) +
          "% creep loss rate, " + towers.length + " towers detected → starting tower drain");
        attack.towerDrainNeeded = true;
        transitionTo(campaign, "TOWER_DRAINING");
        return;
      }
    }
  }

  // --- Defender detection auto-escort ---
  if (attack.defendersSeen && Game.time - attack.defendersLastSeen < 1500) {
    if (!hasActiveEscort(campaign)) {
      var defenderSightings = (attack as any).defenderSightings || 0;
      if (defenderSightings >= 2) {
        requestDuoEscort(campaign);
      }
    }
  }

  // --- Stall detection ---
  if (attack.lastAttackTick > 0 &&
      Game.time - attack.lastAttackTick > 3000 &&
      campaign.state === "ATTACKING") {
    console.log("[Military] Campaign " + campaign.id + " stalled — no attack in 3000 ticks." +
      " Losses: " + stats.totalLost + ", spawned: " + stats.totalSpawned);

    // If high loss rate + stalled, something is very wrong
    if (stats.totalLost > 5 && stats.totalSpawned > 0 &&
        stats.totalLost / stats.totalSpawned > 0.5) {
      console.log("[Military] CRITICAL: >50% loss rate and stalled. Consider military.abort() or military.escort().");
    }
  }
}

// ============================================
// Duo Escort Escalation
// ============================================

/**
 * Request a duo escort for the campaign.
 * Uses existing DuoManager to create an ATTACK_ROOM duo targeting the enemy room.
 */
function requestDuoEscort(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  // Check if we already have a duo for this campaign
  if ((attack as any)[ESCORT_DUO_ID_KEY]) {
    if (hasActiveEscort(campaign)) {
      return; // Duo still active
    }
  }

  // Find best colony to spawn from (closest with duo capacity)
  var bestRoom: string | null = null;
  var bestDistance = Infinity;

  for (var roomName in Game.rooms) {
    var room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    // Need enough energy for a duo (attacker + healer ~2300+ each)
    if (room.energyCapacityAvailable < 2300) continue;

    var route = Game.map.findRoute(roomName, campaign.targetRoom);
    if (route === ERR_NO_PATH || !Array.isArray(route)) continue;

    if (route.length < bestDistance) {
      bestDistance = route.length;
      bestRoom = roomName;
    }
  }

  if (!bestRoom) {
    console.log("[Military] Cannot spawn escort duo — no colony with sufficient energy capacity");
    return;
  }

  // Create duo via DuoManager
  var duoId = DuoManager.spawnDuo(
    bestRoom,
    campaign.targetRoom,
    "ATTACK_ROOM",
    "HIGH"
  );

  (attack as any)[ESCORT_DUO_ID_KEY] = duoId;
  console.log("[Military] Requested escort duo " + duoId + " from " + bestRoom +
    " for campaign " + campaign.id);
}

/**
 * Check if escort duo is alive and active.
 */
function hasActiveEscort(campaign: CampaignState): boolean {
  var attack = campaign.controllerAttack;
  if (!attack) return false;

  var duoId = (attack as any)[ESCORT_DUO_ID_KEY];
  if (!duoId) return false;

  var duo = DuoManager.getDuo(duoId);
  if (!duo) return false;
  if (duo.state === "RECYCLING") return false;

  return true;
}

// ============================================
// Utility Helpers for Spawning
// ============================================

/**
 * Check if we need to spawn a CONTROLLER_ATTACKER for any active campaign
 */
export function needsControllerAttacker(homeRoom: string): { needed: boolean; campaignId: string | null } {
  var mem = getMilitaryMemory();

  for (var id in mem.campaigns) {
    var campaign = mem.campaigns[id];

    // Check if this room should contribute
    if (campaign.homeRoom !== homeRoom && campaign.supportRooms.indexOf(homeRoom) === -1) {
      continue;
    }

    // Only spawn during ATTACKING phase
    if (campaign.state !== "ATTACKING") continue;

    var attack = campaign.controllerAttack;
    if (!attack) continue;

    // Check if there's already an attacker in pipeline
    var existingAttackers = Object.values(Game.creeps).filter(function(c) {
      return c.memory.role === "CONTROLLER_ATTACKER" &&
        (c.memory as any).campaignId === id &&
        !(c.memory as any).attacked;
    });

    if (existingAttackers.length > 0) continue; // One already in pipeline

    // Time to spawn?
    var timeSinceLastAttack = Game.time - attack.lastAttackTick;
    var spawnWindow = ATTACK_COOLDOWN - TRAVEL_TIME - SPAWN_TIME;

    if (timeSinceLastAttack >= spawnWindow || attack.lastAttackTick === 0) {
      return { needed: true, campaignId: id };
    }
  }

  return { needed: false, campaignId: null };
}

/**
 * Get campaign by ID
 */
export function getCampaign(campaignId: string): CampaignState | null {
  var mem = getMilitaryMemory();
  return mem.campaigns[campaignId] || null;
}

/**
 * Record a successful attack with RCL and timer info
 */
export function recordAttack(campaignId: string, rcl?: number, ticksToDowngrade?: number): void {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (campaign && campaign.controllerAttack) {
    var attack = campaign.controllerAttack;

    // Capture starting conditions on first attack
    if (attack.attackCount === 0 && rcl && ticksToDowngrade) {
      attack.stats.campaignStartTimer = ticksToDowngrade + (3 * 300); // Add back what we just removed
      attack.stats.campaignStartRCL = rcl;
    }

    attack.lastAttackTick = Game.time;
    attack.attackCount++;

    if (rcl !== undefined) {
      attack.currentTargetRCL = rcl;
    }
    if (ticksToDowngrade !== undefined) {
      attack.currentTicksToDowngrade = ticksToDowngrade;
      attack.estimatedCyclesRemaining = estimateCyclesRemaining(rcl || attack.currentTargetRCL, ticksToDowngrade);
    }
    attack.upgradeBlockedUntil = Game.time + ATTACK_COOLDOWN;

    console.log("[Military] Attack #" + attack.attackCount + " on " + campaign.targetRoom +
      " — RCL " + (rcl || "?") + ", timer: " + (ticksToDowngrade || "?") +
      ", est " + attack.estimatedCyclesRemaining + " cycles remaining");
  }
}

/**
 * Called when a CONTROLLER_ATTACKER dies without having attacked.
 * Detected via memory cleanup in main.ts.
 */
export function reportCreepLost(campaignId: string): void {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];
  if (!campaign || !campaign.controllerAttack) return;

  campaign.controllerAttack.stats.totalLost++;

  var stats = campaign.controllerAttack.stats;
  console.log("[Military] CONTROLLER_ATTACKER lost en route (campaign " + campaignId +
    ") — total losses: " + stats.totalLost + "/" + stats.totalSpawned);
}

// ============================================
// Console Commands
// ============================================

export function status(): string {
  var mem = getMilitaryMemory();
  var lines: string[] = [];

  lines.push("=== Military Manager ===");
  lines.push("Posture: " + mem.posture);

  var campaignIds = Object.keys(mem.campaigns);
  lines.push("Active Campaigns: " + campaignIds.length);

  for (var i = 0; i < campaignIds.length; i++) {
    var id = campaignIds[i];
    var campaign = mem.campaigns[id];
    var attack = campaign.controllerAttack;

    lines.push("");
    lines.push("[" + id + "] " + campaign.type + " -> " + campaign.targetRoom);
    lines.push("  State: " + campaign.state + " (since tick " + campaign.stateChangedAt + ")");
    lines.push("  Owner: " + campaign.targetOwner);
    lines.push("  Home: " + campaign.homeRoom);

    if (attack) {
      lines.push("  Target RCL: " + attack.currentTargetRCL);
      lines.push("  Timer: " + attack.currentTicksToDowngrade);
      lines.push("  Attacks landed: " + attack.attackCount);

      if (attack.lastAttackTick > 0) {
        var ticksSinceLast = Game.time - attack.lastAttackTick;
        var nextIn = ATTACK_COOLDOWN - ticksSinceLast;
        lines.push("  Next attack in: ~" + Math.max(0, nextIn) + " ticks");
      }

      if (attack.safeModeActive) {
        var remaining = attack.safeModeEndsAt - Game.time;
        lines.push("  SAFE MODE ACTIVE: " + remaining + " ticks remaining");
      }

      if (attack.defendersSeen) {
        lines.push("  Defenders: seen at tick " + attack.defendersLastSeen);
      }

      if (attack.towerDrainNeeded) {
        lines.push("  Tower drain: NEEDED");
      }

      // Show escort duo status
      var duoId = (attack as any)[ESCORT_DUO_ID_KEY];
      if (duoId) {
        lines.push("  Escort duo: " + duoId + (hasActiveEscort(campaign) ? " (active)" : " (inactive)"));
      }

      // Show total spawned vs attacks for death tracking
      var totalSpawned = (attack as any).totalSpawned || 0;
      if (totalSpawned > 0) {
        lines.push("  Spawned/Attacks: " + totalSpawned + "/" + attack.attackCount);
      }
    }

    // Count active creeps for this campaign
    var attackers = getAttackersForCampaign(id);
    if (attackers.length > 0) {
      lines.push("  CLAIM creeps: " + attackers.length);
    }

    var decoys = getDecoysForCampaign(id);
    if (decoys.length > 0) {
      lines.push("  Decoys: " + decoys.length);
    }
  }

  return lines.join("\n");
}

export function attackProgress(campaignId: string): string {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (!campaign) {
    return "Campaign not found: " + campaignId;
  }

  var attack = campaign.controllerAttack;
  if (!attack) {
    return "Not a controller attack campaign";
  }

  var lines: string[] = [];
  lines.push("=== Attack Progress: " + campaignId + " ===");
  lines.push("Target: " + campaign.targetRoom + " (" + campaign.targetOwner + ")");
  lines.push("State: " + campaign.state);
  lines.push("RCL: " + attack.currentTargetRCL);
  lines.push("Timer: " + attack.currentTicksToDowngrade);
  lines.push("Attacks: " + attack.attackCount);

  // Estimate remaining
  // Each attack removes 900 ticks (3 CLAIM parts x 300)
  // Plus 1000 ticks natural decay = 1900 effective per cycle
  if (attack.currentTicksToDowngrade > 0) {
    var effectivePerCycle = 1900;
    var cyclesRemaining = Math.ceil(attack.currentTicksToDowngrade / effectivePerCycle);
    lines.push("Estimated cycles remaining: " + cyclesRemaining);
    lines.push("Estimated ticks: " + (cyclesRemaining * ATTACK_COOLDOWN));
    lines.push("Estimated hours: " + ((cyclesRemaining * ATTACK_COOLDOWN) / 3600 * 3).toFixed(1));
  }

  return lines.join("\n");
}

export function startTowerDrain(campaignId: string): string {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (!campaign) {
    return "Campaign not found: " + campaignId;
  }

  campaign.state = "TOWER_DRAINING";
  campaign.stateChangedAt = Game.time;

  return "Started tower drain for " + campaignId;
}

// ============================================
// Spawn Request System
// ============================================

export interface MilitarySpawnRequest {
  role: "CONTROLLER_ATTACKER" | "DECOY";
  campaignId: string;
  targetRoom: string;
  priority: number;
}

/**
 * Get spawn requests for all active campaigns.
 * Called by spawning system to determine what military creeps to spawn.
 */
export function getSpawnRequests(homeRoom: string): MilitarySpawnRequest[] {
  var mem = getMilitaryMemory();
  var requests: MilitarySpawnRequest[] = [];

  // Multi-campaign budget check
  if (!withinSpawnBudget()) return requests;

  // Check if home is under attack — reduce priority if so
  var underAttack = checkHomeDefense();
  var attackPenalty = underAttack ? 30 : 0;

  for (var id in mem.campaigns) {
    var campaign = mem.campaigns[id];

    // Check if this room should contribute
    if (campaign.homeRoom !== homeRoom && campaign.supportRooms.indexOf(homeRoom) === -1) {
      continue;
    }

    var attack = campaign.controllerAttack;

    // === ATTACKING phase: spawn CONTROLLER_ATTACKERs ===
    if (campaign.state === "ATTACKING" && attack) {
      // Check if there's already an attacker in pipeline
      var existingAttackers = getAttackersForCampaign(id).filter(function(c) {
        return !(c.memory as any).attacked;
      });

      if (existingAttackers.length === 0) {
        // Check timing
        var timeSinceLastAttack = Game.time - attack.lastAttackTick;
        var spawnWindow = ATTACK_COOLDOWN - TRAVEL_TIME - SPAWN_TIME;

        if (timeSinceLastAttack >= spawnWindow || attack.lastAttackTick === 0) {
          requests.push({
            role: "CONTROLLER_ATTACKER",
            campaignId: id,
            targetRoom: campaign.targetRoom,
            priority: 100 - attackPenalty
          });
        }
      }
    }

    // === TOWER_DRAINING phase: spawn DECOYs ===
    if (campaign.state === "TOWER_DRAINING" && attack) {
      var decoys = getDecoysForCampaign(id);
      var aliveDecoys = decoys.filter(function(c) {
        return c.ticksToLive && c.ticksToLive > 50;
      });

      if (aliveDecoys.length < TOWER_DRAIN_MAX_DECOYS) {
        requests.push({
          role: "DECOY",
          campaignId: id,
          targetRoom: campaign.targetRoom,
          priority: 80
        });
      }
    }
  }

  return requests;
}

/**
 * Report that a military creep was spawned.
 * Used to track total spawned and energy spent.
 */
export function reportSpawned(campaignId: string, energyCost: number): void {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (!campaign || !campaign.controllerAttack) return;

  campaign.controllerAttack.stats.totalSpawned++;
  campaign.controllerAttack.stats.totalEnergySpent += energyCost;
}
