/**
 * CounterIntel — Detect enemy responses to our campaigns
 *
 * Tracks changes in the target room between scans:
 * - Controller timer velocity (is enemy upgrading to counter us?)
 * - Tower energy trends (refilling from storage/terminal?)
 * - Terminal activity (receiving ally shipments?)
 * - New structures (walls around controller, new towers?)
 * - Defender spawning patterns
 *
 * Run every 50 ticks during active campaigns.
 */

// ============================================
// Types
// ============================================

export interface IntelSnapshot {
  tick: number;
  rcl: number;
  ticksToDowngrade: number;
  upgradeBlocked: number;
  safeModeAvailable: number;
  safeModeCooldown: number;
  towerCount: number;
  towerEnergy: number[];          // Per-tower energy levels
  terminalEnergy: number;
  storageEnergy: number;
  hostileCreepCount: number;
  combatCreepCount: number;       // Creeps with ATTACK/RANGED/HEAL
  spawnCount: number;
  wallCount: number;              // Constructed walls + ramparts near controller
  spawning: boolean;              // Is an enemy spawn actively spawning?
}

export interface IntelAlert {
  tick: number;
  severity: "INFO" | "WARNING" | "CRITICAL";
  type: string;
  message: string;
}

interface CounterIntelState {
  snapshots: IntelSnapshot[];     // Rolling window, max 20
  alerts: IntelAlert[];           // Rolling window, max 50
  lastSnapshotTick: number;
  baselineTimer: number;          // Expected timer value based on our attack rate
  expectedDecayRate: number;      // Expected ticks removed per cycle (1900 for 3-CLAIM)
}

// ============================================
// Constants
// ============================================

var SNAPSHOT_INTERVAL = 50;       // Ticks between snapshots
var MAX_SNAPSHOTS = 20;
var MAX_ALERTS = 50;
var CONTROLLER_WALL_RANGE = 5;    // Check for walls within this range of controller

// ============================================
// Core Functions
// ============================================

/**
 * Take a snapshot of the target room's current state.
 * Only works when we have vision.
 */
export function takeSnapshot(room: Room): IntelSnapshot | null {
  var controller = room.controller;
  if (!controller) return null;

  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s: Structure) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];

  var towerEnergy: number[] = [];
  for (var i = 0; i < towers.length; i++) {
    towerEnergy.push(towers[i].store[RESOURCE_ENERGY]);
  }

  var terminal = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s: Structure) { return s.structureType === STRUCTURE_TERMINAL; }
  })[0] as StructureTerminal | undefined;

  var storage = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s: Structure) { return s.structureType === STRUCTURE_STORAGE; }
  })[0] as StructureStorage | undefined;

  var hostiles = room.find(FIND_HOSTILE_CREEPS);
  var combatCreeps = hostiles.filter(function(c: Creep) {
    return c.getActiveBodyparts(ATTACK) > 0 ||
           c.getActiveBodyparts(RANGED_ATTACK) > 0 ||
           c.getActiveBodyparts(HEAL) > 0;
  });

  var spawns = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s: Structure) { return s.structureType === STRUCTURE_SPAWN; }
  }) as StructureSpawn[];

  var isSpawning = false;
  for (var si = 0; si < spawns.length; si++) {
    if (spawns[si].spawning) {
      isSpawning = true;
      break;
    }
  }

  // Count walls/ramparts near controller (walls are neutral, use FIND_STRUCTURES)
  var wallCount = 0;
  if (controller.owner) {
    var nearbyStructures = controller.pos.findInRange(FIND_STRUCTURES, CONTROLLER_WALL_RANGE);
    for (var wi = 0; wi < nearbyStructures.length; wi++) {
      var st = nearbyStructures[wi].structureType;
      if (st === STRUCTURE_WALL || st === STRUCTURE_RAMPART) {
        wallCount++;
      }
    }
  }

  return {
    tick: Game.time,
    rcl: controller.level,
    ticksToDowngrade: controller.ticksToDowngrade || 0,
    upgradeBlocked: controller.upgradeBlocked || 0,
    safeModeAvailable: controller.safeModeAvailable || 0,
    safeModeCooldown: controller.safeModeCooldown || 0,
    towerCount: towers.length,
    towerEnergy: towerEnergy,
    terminalEnergy: terminal ? terminal.store[RESOURCE_ENERGY] : 0,
    storageEnergy: storage ? storage.store[RESOURCE_ENERGY] : 0,
    hostileCreepCount: hostiles.length,
    combatCreepCount: combatCreeps.length,
    spawnCount: spawns.length,
    wallCount: wallCount,
    spawning: isSpawning,
  };
}

/**
 * Analyze snapshots to detect enemy response patterns.
 * Returns new alerts generated this tick.
 */
export function analyze(
  state: CounterIntelState,
  current: IntelSnapshot,
  campaignAttackCount: number
): IntelAlert[] {
  var newAlerts: IntelAlert[] = [];

  if (state.snapshots.length < 2) return newAlerts;

  var prev = state.snapshots[state.snapshots.length - 1];
  var tickDelta = current.tick - prev.tick;
  if (tickDelta <= 0) return newAlerts;

  // --- Timer velocity check ---
  // If upgradeBlocked is 0 (our attack cooldown expired) and timer went UP,
  // enemy is actively upgrading to counter our downgrade
  if (current.upgradeBlocked === 0 && prev.upgradeBlocked === 0) {
    var timerChange = current.ticksToDowngrade - prev.ticksToDowngrade;
    if (timerChange > 0 && current.rcl === prev.rcl) {
      // Timer went UP between our attacks — enemy is upgrading
      var upgradeRate = timerChange / tickDelta;
      newAlerts.push({
        tick: Game.time,
        severity: upgradeRate > 5 ? "WARNING" : "INFO",
        type: "COUNTER_UPGRADE",
        message: "Enemy upgrading — timer increased by " + timerChange +
          " over " + tickDelta + " ticks (" + upgradeRate.toFixed(1) + "/tick). " +
          "This slows our campaign but doesn't stop it.",
      });
    }
  }

  // --- Terminal energy spike ---
  // Sudden increase = incoming shipment from ally
  var terminalDelta = current.terminalEnergy - prev.terminalEnergy;
  if (terminalDelta > 5000) {
    newAlerts.push({
      tick: Game.time,
      severity: "WARNING",
      type: "TERMINAL_SHIPMENT",
      message: "Terminal energy jumped +" + terminalDelta +
        " (was " + prev.terminalEnergy + ", now " + current.terminalEnergy +
        "). Possible ally shipment — may fund tower refills or upgrades.",
    });
  }

  // --- Storage energy spike ---
  var storageDelta = current.storageEnergy - prev.storageEnergy;
  if (storageDelta > 10000) {
    newAlerts.push({
      tick: Game.time,
      severity: "WARNING",
      type: "STORAGE_SPIKE",
      message: "Storage energy jumped +" + storageDelta +
        ". Enemy may be stockpiling for defense.",
    });
  }

  // --- New combat creeps ---
  if (current.combatCreepCount > prev.combatCreepCount) {
    var newCombat = current.combatCreepCount - prev.combatCreepCount;
    newAlerts.push({
      tick: Game.time,
      severity: newCombat >= 2 ? "WARNING" : "INFO",
      type: "NEW_DEFENDERS",
      message: newCombat + " new combat creep(s) appeared (total: " +
        current.combatCreepCount + "). May target our CLAIM creeps.",
    });
  }

  // --- Tower refill pattern ---
  // If towers were low and are now full, someone is actively managing defense
  if (prev.towerEnergy.length > 0 && current.towerEnergy.length > 0) {
    var prevTotal = 0;
    var currTotal = 0;
    for (var ti = 0; ti < prev.towerEnergy.length; ti++) {
      prevTotal += prev.towerEnergy[ti];
    }
    for (var tj = 0; tj < current.towerEnergy.length; tj++) {
      currTotal += current.towerEnergy[tj];
    }
    if (currTotal > prevTotal + 500) {
      newAlerts.push({
        tick: Game.time,
        severity: "INFO",
        type: "TOWER_REFILL",
        message: "Tower energy increased +" + (currTotal - prevTotal) +
          " (total: " + currTotal + "). Active defense management.",
      });
    }
  }

  // --- New walls near controller ---
  if (current.wallCount > prev.wallCount) {
    var newWalls = current.wallCount - prev.wallCount;
    newAlerts.push({
      tick: Game.time,
      severity: "WARNING",
      type: "CONTROLLER_FORTIFICATION",
      message: newWalls + " new wall/rampart(s) within " + CONTROLLER_WALL_RANGE +
        " tiles of controller. May block CLAIM creep pathing.",
    });
  }

  // --- Safe mode used ---
  if (current.safeModeAvailable < prev.safeModeAvailable) {
    newAlerts.push({
      tick: Game.time,
      severity: "CRITICAL",
      type: "SAFE_MODE_USED",
      message: "Safe mode activated! " + current.safeModeAvailable +
        " remaining (was " + prev.safeModeAvailable + ").",
    });
  }

  // --- Spawn actively spawning ---
  if (current.spawning && !prev.spawning) {
    newAlerts.push({
      tick: Game.time,
      severity: "INFO",
      type: "SPAWN_ACTIVE",
      message: "Enemy spawn is actively spawning. Player may be responding.",
    });
  }

  return newAlerts;
}

/**
 * Get the CounterIntel state from campaign memory.
 */
export function getState(campaign: any): CounterIntelState {
  if (!campaign.controllerAttack.counterIntel) {
    campaign.controllerAttack.counterIntel = {
      snapshots: [],
      alerts: [],
      lastSnapshotTick: 0,
      baselineTimer: 0,
      expectedDecayRate: 1900,
    };
  }
  return campaign.controllerAttack.counterIntel;
}

/**
 * Run counter-intel for a campaign. Call from MilitaryManager during ATTACKING.
 */
export function run(campaign: any): void {
  var room = Game.rooms[campaign.targetRoom];
  if (!room) return;

  var ciState = getState(campaign);

  // Only snapshot every N ticks
  if (Game.time - ciState.lastSnapshotTick < SNAPSHOT_INTERVAL) return;

  var snapshot = takeSnapshot(room);
  if (!snapshot) return;

  // Analyze before adding new snapshot
  var newAlerts = analyze(ciState, snapshot, campaign.controllerAttack.attackCount);

  // Store snapshot
  ciState.snapshots.push(snapshot);
  if (ciState.snapshots.length > MAX_SNAPSHOTS) {
    ciState.snapshots.shift();
  }
  ciState.lastSnapshotTick = Game.time;

  // Store alerts
  for (var i = 0; i < newAlerts.length; i++) {
    var alert = newAlerts[i];
    ciState.alerts.push(alert);
    // Log warnings and critical alerts to console
    if (alert.severity === "WARNING" || alert.severity === "CRITICAL") {
      console.log("[CounterIntel] " + alert.severity + " [" + alert.type + "] " + alert.message);
    }
  }
  while (ciState.alerts.length > MAX_ALERTS) {
    ciState.alerts.shift();
  }
}

/**
 * Get recent alerts for display.
 */
export function getAlerts(campaign: any, count?: number): IntelAlert[] {
  var ciState = getState(campaign);
  var n = count || 10;
  return ciState.alerts.slice(-n);
}

/**
 * Get latest snapshot.
 */
export function getLatestSnapshot(campaign: any): IntelSnapshot | null {
  var ciState = getState(campaign);
  if (ciState.snapshots.length === 0) return null;
  return ciState.snapshots[ciState.snapshots.length - 1];
}
