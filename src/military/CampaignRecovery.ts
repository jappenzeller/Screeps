/**
 * CampaignRecovery — Validate and repair campaign state after resets
 *
 * Screeps global resets clear all runtime state. Campaign data survives
 * in Memory, but:
 * - Creep object IDs may be stale (creeps died during deploy)
 * - Campaign may have advanced while code was being deployed
 * - Timer estimates may be outdated
 *
 * Run once after global reset, then periodically for health checks.
 */

var lastRecoveryTick = 0;
var RECOVERY_INTERVAL = 500; // Check every 500 ticks

/**
 * Run recovery checks. Call from MilitaryManager.run().
 */
export function runRecovery(): void {
  // Only run periodically
  if (Game.time - lastRecoveryTick < RECOVERY_INTERVAL) return;
  lastRecoveryTick = Game.time;

  var militaryMem = (Memory as any).military;
  if (!militaryMem || !militaryMem.campaigns) return;

  for (var id in militaryMem.campaigns) {
    var campaign = militaryMem.campaigns[id];
    validateCampaign(campaign);
  }
}

/**
 * Full validation on global reset. Call once from main.ts init block.
 */
export function runFullRecovery(): void {
  var militaryMem = (Memory as any).military;
  if (!militaryMem || !militaryMem.campaigns) return;

  console.log("[CampaignRecovery] Global reset detected — validating all campaigns");
  var totalCampaigns = 0;
  var fixedIssues = 0;

  for (var id in militaryMem.campaigns) {
    totalCampaigns++;
    fixedIssues += validateCampaign(militaryMem.campaigns[id]);
  }

  if (totalCampaigns > 0) {
    console.log("[CampaignRecovery] Validated " + totalCampaigns +
      " campaigns, fixed " + fixedIssues + " issues");
  }
}

/**
 * Validate a single campaign. Returns number of issues fixed.
 */
function validateCampaign(campaign: any): number {
  var fixes = 0;

  // Skip completed/aborted
  if (campaign.state === "COMPLETE" || campaign.state === "ABORTED") return 0;

  // --- 1. Validate target room still exists and is correct ---
  // (rooms don't disappear, but ownership might change mid-deploy)
  var room = Game.rooms[campaign.targetRoom];
  if (room && room.controller) {
    var attack = campaign.controllerAttack;

    // Update real-time values if we have vision
    if (attack && room.controller.owner) {
      var actualRCL = room.controller.level;
      var actualTimer = room.controller.ticksToDowngrade || 0;

      if (actualRCL !== attack.currentTargetRCL) {
        console.log("[CampaignRecovery] " + campaign.targetRoom +
          ": RCL changed " + attack.currentTargetRCL + " → " + actualRCL);
        attack.currentTargetRCL = actualRCL;
        fixes++;
      }

      attack.currentTicksToDowngrade = actualTimer;
    }

    // Check if controller already fell (we might have missed it)
    if (!room.controller.owner && campaign.state === "ATTACKING") {
      console.log("[CampaignRecovery] " + campaign.targetRoom +
        ": Controller is NEUTRAL but campaign still ATTACKING! Transitioning to CLAIMING.");
      campaign.state = "CLAIMING";
      campaign.stateChangedAt = Game.time;
      fixes++;
    }

    // Check if room is already ours
    if (room.controller.my && (campaign.state === "ATTACKING" || campaign.state === "CLAIMING")) {
      console.log("[CampaignRecovery] " + campaign.targetRoom +
        ": Room is already OURS! Transitioning to SECURING.");
      campaign.state = "SECURING";
      campaign.stateChangedAt = Game.time;
      fixes++;
    }
  }

  // --- 2. Validate safe mode state ---
  if (room && room.controller && room.controller.safeMode) {
    if (campaign.state === "ATTACKING") {
      console.log("[CampaignRecovery] " + campaign.targetRoom +
        ": Safe mode active but campaign in ATTACKING. Transitioning to WAITING_SAFE_MODE.");
      campaign.state = "WAITING_SAFE_MODE";
      campaign.stateChangedAt = Game.time;
      var attack2 = campaign.controllerAttack;
      if (attack2) {
        attack2.safeModeActive = true;
        attack2.safeModeEndTick = Game.time + room.controller.safeMode;
      }
      fixes++;
    }
  }

  // --- 3. Validate upgradeBlocked timer ---
  if (room && room.controller && room.controller.upgradeBlocked) {
    var attackState = campaign.controllerAttack;
    if (attackState) {
      attackState.upgradeBlockedUntil = Game.time + room.controller.upgradeBlocked;
    }
  }

  // --- 4. Validate creep counts ---
  // Count creeps assigned to this campaign
  var assignedCreeps = 0;
  for (var name in Game.creeps) {
    var creep = Game.creeps[name];
    if ((creep.memory as any).campaignId === campaign.id) {
      assignedCreeps++;
    }
  }

  // If campaign thinks it's TOWER_DRAINING but no decoys exist and no
  // tower drain flag, reset to ATTACKING
  if (campaign.state === "TOWER_DRAINING") {
    var decoys = 0;
    for (var dname in Game.creeps) {
      if ((Game.creeps[dname].memory as any).role === "DECOY" &&
          (Game.creeps[dname].memory as any).campaignId === campaign.id) {
        decoys++;
      }
    }
    // If no decoys and towers are actually empty/gone, return to ATTACKING
    if (room) {
      var towers = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function(s: Structure) { return s.structureType === STRUCTURE_TOWER; }
      }) as StructureTower[];
      var totalTowerEnergy = 0;
      for (var ti = 0; ti < towers.length; ti++) {
        totalTowerEnergy += towers[ti].store[RESOURCE_ENERGY];
      }
      if (towers.length === 0 || totalTowerEnergy < 100) {
        console.log("[CampaignRecovery] " + campaign.targetRoom +
          ": Towers empty/destroyed, returning to ATTACKING from TOWER_DRAINING.");
        campaign.state = "ATTACKING";
        campaign.stateChangedAt = Game.time;
        fixes++;
      }
    }
  }

  // --- 5. Initialize missing stats ---
  if (campaign.controllerAttack && !campaign.controllerAttack.stats) {
    console.log("[CampaignRecovery] " + campaign.targetRoom +
      ": Initializing missing stats block");
    campaign.controllerAttack.stats = {
      totalSpawned: 0,
      totalLost: 0,
      totalEnergySpent: 0,
      rclDowngrades: [],
      safeModeActivations: 0,
      campaignStartTimer: 0,
      campaignStartRCL: campaign.controllerAttack.currentTargetRCL || 6,
    };
    fixes++;
  }

  // --- 6. Initialize missing counterIntel ---
  if (campaign.controllerAttack && !campaign.controllerAttack.counterIntel) {
    campaign.controllerAttack.counterIntel = {
      snapshots: [],
      alerts: [],
      lastSnapshotTick: 0,
      baselineTimer: 0,
      expectedDecayRate: 1900,
    };
    // Not counted as a fix — just initialization
  }

  // --- 7. Stale campaign detection ---
  var timeSinceStateChange = Game.time - campaign.stateChangedAt;
  if (timeSinceStateChange > 50000 && campaign.state === "SCOUTING") {
    console.log("[CampaignRecovery] " + campaign.targetRoom +
      ": Stuck in SCOUTING for " + timeSinceStateChange + " ticks. Forcing to ATTACKING.");
    campaign.state = "ATTACKING";
    campaign.stateChangedAt = Game.time;
    fixes++;
  }

  return fixes;
}
