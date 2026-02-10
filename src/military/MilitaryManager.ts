/**
 * Military Manager - Coordinates offensive and defensive operations
 *
 * Phase 1: Controller Attack Campaign
 * - Attacks hostile room controllers to downgrade them
 * - Target: E44N39 (Bazsi1224, RCL 6)
 */

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

export interface ControllerAttackState {
  controllerPos: { x: number; y: number };
  approachDirection: "south" | "west" | "east" | "north";
  lastAttackTick: number;
  attackCount: number;
  currentTargetRCL: number;
  currentTicksToDowngrade: number;
  estimatedTicksRemaining: number;
  towerPositions: { x: number; y: number; lastEnergy: number }[];
  safeModeActive: boolean;
  safeModeEndsAt: number;
  upgradeBlockedUntil: number;
  defendersSeen: boolean;
  defendersLastSeen: number;
  towerDrainNeeded: boolean;
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
// Main Run Function
// ============================================

export function run(): void {
  var mem = getMilitaryMemory();

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
      towerPositions: [],
      safeModeActive: false,
      safeModeEndsAt: 0,
      upgradeBlockedUntil: 0,
      defendersSeen: false,
      defendersLastSeen: 0,
      towerDrainNeeded: false,
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
      campaign.state = "CLAIMING";
      campaign.stateChangedAt = Game.time;
      return;
    }

    // Check if controller level dropped
    if (controller.level < attack.currentTargetRCL) {
      console.log("[Military] " + campaign.id + ": MILESTONE - RCL dropped from " +
        attack.currentTargetRCL + " to " + controller.level + "!");
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
      campaign.state = "WAITING_SAFE_MODE";
      campaign.stateChangedAt = Game.time;
      return;
    }

    // Update upgradeBlocked estimate
    if (controller.upgradeBlocked && controller.upgradeBlocked > 0) {
      attack.upgradeBlockedUntil = Game.time + controller.upgradeBlocked;
    }

    // Check for defenders
    checkAdaptation(campaign);
  }

  // The actual attack logic is handled by the ControllerAttacker creeps
  // Spawning is handled by utilitySpawning.ts based on campaign state
}

function runWaitingSafeMode(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

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
  // Tower drain operation - spawn decoys to waste tower energy
  // For now, just log and stay in this state
  // Actual decoy spawning handled by utility functions
}

function runClaiming(campaign: CampaignState): void {
  // Check if we have a claimer heading to target
  var claimers = Object.values(Game.creeps).filter(function(c) {
    return c.memory.role === "CLAIMER" && c.memory.targetRoom === campaign.targetRoom;
  });

  // Check if room is now ours
  var room = Game.rooms[campaign.targetRoom];
  if (room && room.controller && room.controller.my) {
    console.log("[Military] " + campaign.id + ": Room " + campaign.targetRoom + " claimed! Moving to SECURING.");
    campaign.state = "SECURING";
    campaign.stateChangedAt = Game.time;
    return;
  }

  if (claimers.length === 0) {
    // Request claimer through expansion system or direct spawn
    // For now, log that we need one
    if (Game.time % 50 === 0) {
      console.log("[Military] " + campaign.id + ": Waiting for CLAIMER to claim " + campaign.targetRoom);
    }
  }
}

function runSecuring(campaign: CampaignState): void {
  // Room is claimed, bootstrap it
  var room = Game.rooms[campaign.targetRoom];

  if (!room || !room.controller || !room.controller.my) {
    console.log("[Military] " + campaign.id + ": Lost control of " + campaign.targetRoom + "!");
    campaign.state = "CLAIMING";
    campaign.stateChangedAt = Game.time;
    return;
  }

  // Check if room has a spawn (self-sustaining)
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length > 0) {
    console.log("[Military] " + campaign.id + ": " + campaign.targetRoom + " has spawn. Campaign COMPLETE!");
    campaign.state = "COMPLETE";
    campaign.stateChangedAt = Game.time;

    // Update posture
    var mem = getMilitaryMemory();
    var hasActive = false;
    for (var id in mem.campaigns) {
      var c = mem.campaigns[id];
      if (c.id !== campaign.id && c.state !== "COMPLETE" && c.state !== "ABORTED") {
        hasActive = true;
        break;
      }
    }
    if (!hasActive) {
      mem.posture = "PEACEFUL";
    }
    return;
  }

  // Otherwise, expansion system should be handling bootstrap
  if (Game.time % 100 === 0) {
    console.log("[Military] " + campaign.id + ": Securing " + campaign.targetRoom + " (waiting for spawn)");
  }
}

// ============================================
// Adaptation
// ============================================

function checkAdaptation(campaign: CampaignState): void {
  var attack = campaign.controllerAttack;
  if (!attack) return;

  var room = Game.rooms[campaign.targetRoom];
  if (!room) return;

  var controller = room.controller;
  if (!controller) return;

  // Check for combat creeps near controller
  var hostileDefenders = controller.pos.findInRange(FIND_HOSTILE_CREEPS, 5, {
    filter: function(c) {
      return c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0;
    }
  });

  if (hostileDefenders.length > 0) {
    attack.defendersSeen = true;
    attack.defendersLastSeen = Game.time;
    // TODO: Send duo escort with next CLAIM creep
  }

  // Check if towers are actively being refilled
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];

  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
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
 * Record a successful attack
 */
export function recordAttack(campaignId: string): void {
  var mem = getMilitaryMemory();
  var campaign = mem.campaigns[campaignId];

  if (campaign && campaign.controllerAttack) {
    campaign.controllerAttack.lastAttackTick = Game.time;
    campaign.controllerAttack.attackCount++;
  }
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
    }

    // Count active creeps for this campaign
    var attackers = Object.values(Game.creeps).filter(function(c) {
      return c.memory.role === "CONTROLLER_ATTACKER" && (c.memory as any).campaignId === id;
    });
    if (attackers.length > 0) {
      lines.push("  CLAIM creeps: " + attackers.length);
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
