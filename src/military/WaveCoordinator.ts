/**
 * Wave Coordinator - Manages coordinated wave attacks
 *
 * Instead of single attackers running in one at a time (tower food),
 * this coordinates 3-4 attackers to:
 * 1. Spawn simultaneously
 * 2. Rally in an approach room
 * 3. Release together to overwhelm towers
 *
 * Wave states:
 * - SPAWNING: Waiting for all wave members to spawn
 * - RALLYING: Members traveling to rally point
 * - READY: All members at rally point, waiting for release
 * - RELEASED: Wave has been released to attack
 * - SPENT: Wave is complete (all members attacked or died)
 */

import { CampaignState, getMilitaryMemory } from "./MilitaryManager";

// ============================================
// Types
// ============================================

export type WaveState = "SPAWNING" | "RALLYING" | "READY" | "RELEASED" | "SPENT";

export interface WaveMember {
  creepName: string;
  spawned: boolean;
  atRally: boolean;
  attacked: boolean;
  dead: boolean;
}

export interface Wave {
  id: string;
  campaignId: string;
  state: WaveState;
  stateChangedAt: number;
  targetSize: number;
  members: WaveMember[];
  rallyRoom: string;
  rallyPos?: { x: number; y: number };
  releasedAt?: number;
}

export interface WaveCoordinatorMemory {
  waves: Record<string, Wave>;
  nextWaveId: number;
}

// ============================================
// Constants
// ============================================

var DEFAULT_WAVE_SIZE = 3;        // Default number of attackers per wave
var RALLY_TIMEOUT = 300;          // Ticks to wait for all members to rally
var SPAWN_TIMEOUT = 500;          // Ticks to wait for all members to spawn
var RALLY_RANGE = 5;              // Range to be considered "at rally point"

// ============================================
// Memory Access
// ============================================

function getWaveMemory(): WaveCoordinatorMemory {
  if (!(Memory as any).waveCoordinator) {
    (Memory as any).waveCoordinator = {
      waves: {},
      nextWaveId: 1,
    };
  }
  return (Memory as any).waveCoordinator as WaveCoordinatorMemory;
}

// ============================================
// Wave CRUD
// ============================================

/**
 * Create a new wave for a campaign.
 * Returns wave ID or null if wave already exists.
 */
export function createWave(campaignId: string, size?: number): string | null {
  var mem = getWaveMemory();
  var milMem = getMilitaryMemory();
  var campaign = milMem.campaigns[campaignId];

  if (!campaign) {
    console.log("[Wave] ERROR: Campaign not found: " + campaignId);
    return null;
  }

  // Check if there's already an active wave for this campaign
  for (var waveId in mem.waves) {
    var existingWave = mem.waves[waveId];
    if (existingWave.campaignId === campaignId &&
        existingWave.state !== "SPENT") {
      console.log("[Wave] Campaign " + campaignId + " already has active wave: " + waveId);
      return null;
    }
  }

  // Determine rally room (use campaign's approach room or adjacent to target)
  var rallyRoom = campaign.approachRoom;
  if (!rallyRoom) {
    // Find an adjacent room to rally in
    var exits = Game.map.describeExits(campaign.targetRoom);
    if (exits) {
      // Prefer the exit opposite to where we expect to enter
      for (var dir in exits) {
        rallyRoom = (exits as any)[dir];
        break;
      }
    }
  }

  if (!rallyRoom) {
    console.log("[Wave] ERROR: No rally room for campaign " + campaignId);
    return null;
  }

  var id = "wave_" + mem.nextWaveId++;
  var wave: Wave = {
    id: id,
    campaignId: campaignId,
    state: "SPAWNING",
    stateChangedAt: Game.time,
    targetSize: size || DEFAULT_WAVE_SIZE,
    members: [],
    rallyRoom: rallyRoom,
  };

  mem.waves[id] = wave;
  console.log("[Wave] Created " + id + " for campaign " + campaignId +
    " (size: " + wave.targetSize + ", rally: " + rallyRoom + ")");

  return id;
}

/**
 * Get wave by ID
 */
export function getWave(waveId: string): Wave | null {
  var mem = getWaveMemory();
  return mem.waves[waveId] || null;
}

/**
 * Get active wave for a campaign
 */
export function getActiveWave(campaignId: string): Wave | null {
  var mem = getWaveMemory();

  for (var waveId in mem.waves) {
    var wave = mem.waves[waveId];
    if (wave.campaignId === campaignId && wave.state !== "SPENT") {
      return wave;
    }
  }

  return null;
}

/**
 * Add a member to a wave
 */
export function addMember(waveId: string, creepName: string): boolean {
  var mem = getWaveMemory();
  var wave = mem.waves[waveId];

  if (!wave) {
    console.log("[Wave] ERROR: Wave not found: " + waveId);
    return false;
  }

  // Check if already a member
  for (var i = 0; i < wave.members.length; i++) {
    if (wave.members[i].creepName === creepName) {
      return false; // Already exists
    }
  }

  wave.members.push({
    creepName: creepName,
    spawned: false,
    atRally: false,
    attacked: false,
    dead: false,
  });

  console.log("[Wave] Added " + creepName + " to " + waveId +
    " (" + wave.members.length + "/" + wave.targetSize + ")");

  return true;
}

// ============================================
// Wave State Machine
// ============================================

function transitionWave(wave: Wave, newState: WaveState): void {
  var oldState = wave.state;
  wave.state = newState;
  wave.stateChangedAt = Game.time;
  console.log("[Wave] " + wave.id + ": " + oldState + " -> " + newState);
}

/**
 * Run wave state machine - call this every tick from MilitaryManager
 */
export function runWaves(): void {
  var mem = getWaveMemory();

  for (var waveId in mem.waves) {
    var wave = mem.waves[waveId];

    switch (wave.state) {
      case "SPAWNING":
        runSpawning(wave);
        break;
      case "RALLYING":
        runRallying(wave);
        break;
      case "READY":
        runReady(wave);
        break;
      case "RELEASED":
        runReleased(wave);
        break;
      case "SPENT":
        // Cleanup old spent waves
        if (Game.time - wave.stateChangedAt > 5000) {
          delete mem.waves[waveId];
        }
        break;
    }
  }
}

function runSpawning(wave: Wave): void {
  // Update member spawn status
  for (var i = 0; i < wave.members.length; i++) {
    var member = wave.members[i];
    var creep = Game.creeps[member.creepName];

    if (creep) {
      member.spawned = true;
    } else if (member.spawned) {
      // Creep died before wave started
      member.dead = true;
    }
  }

  // Check if all members have spawned
  var aliveMembers = wave.members.filter(function(m) { return !m.dead; });
  var spawnedMembers = aliveMembers.filter(function(m) { return m.spawned; });

  if (spawnedMembers.length >= wave.targetSize) {
    console.log("[Wave] " + wave.id + ": All " + spawnedMembers.length + " members spawned");
    transitionWave(wave, "RALLYING");
    return;
  }

  // Timeout check
  if (Game.time - wave.stateChangedAt > SPAWN_TIMEOUT) {
    if (spawnedMembers.length > 0) {
      console.log("[Wave] " + wave.id + ": Spawn timeout, proceeding with " +
        spawnedMembers.length + " members");
      transitionWave(wave, "RALLYING");
    } else {
      console.log("[Wave] " + wave.id + ": Spawn timeout with no members, marking spent");
      transitionWave(wave, "SPENT");
    }
  }
}

function runRallying(wave: Wave): void {
  // Calculate rally position (center of rally room)
  if (!wave.rallyPos) {
    wave.rallyPos = { x: 25, y: 25 };
  }

  // Update member positions
  var atRallyCount = 0;
  var aliveCount = 0;

  for (var i = 0; i < wave.members.length; i++) {
    var member = wave.members[i];
    var creep = Game.creeps[member.creepName];

    if (!creep) {
      member.dead = true;
      continue;
    }

    aliveCount++;

    // Check if at rally point
    if (creep.room.name === wave.rallyRoom) {
      var dist = Math.max(
        Math.abs(creep.pos.x - wave.rallyPos.x),
        Math.abs(creep.pos.y - wave.rallyPos.y)
      );

      if (dist <= RALLY_RANGE) {
        member.atRally = true;
        atRallyCount++;
      } else {
        member.atRally = false;
      }
    } else {
      member.atRally = false;
    }
  }

  // All alive members at rally?
  if (atRallyCount === aliveCount && aliveCount > 0) {
    console.log("[Wave] " + wave.id + ": All " + aliveCount + " members at rally point");
    transitionWave(wave, "READY");
    return;
  }

  // Timeout check
  if (Game.time - wave.stateChangedAt > RALLY_TIMEOUT) {
    if (atRallyCount > 0) {
      console.log("[Wave] " + wave.id + ": Rally timeout, releasing " +
        atRallyCount + "/" + aliveCount + " members");
      transitionWave(wave, "READY");
    } else {
      console.log("[Wave] " + wave.id + ": Rally timeout with no members at rally, marking spent");
      transitionWave(wave, "SPENT");
    }
  }

  // Log progress periodically
  if (Game.time % 20 === 0) {
    console.log("[Wave] " + wave.id + " rallying: " + atRallyCount + "/" + aliveCount +
      " at " + wave.rallyRoom);
  }
}

function runReady(wave: Wave): void {
  // Auto-release after a brief pause for stragglers
  if (Game.time - wave.stateChangedAt >= 5) {
    releaseWave(wave.id);
  }
}

function runReleased(wave: Wave): void {
  // Track attack status
  var anyAlive = false;
  var allAttacked = true;

  for (var i = 0; i < wave.members.length; i++) {
    var member = wave.members[i];
    var creep = Game.creeps[member.creepName];

    if (!creep) {
      member.dead = true;
      continue;
    }

    anyAlive = true;

    // Check if creep has attacked (via memory flag)
    if ((creep.memory as any).attacked) {
      member.attacked = true;
    } else {
      allAttacked = false;
    }
  }

  // Wave is spent when all members are dead or have attacked
  if (!anyAlive || allAttacked) {
    var attackedCount = wave.members.filter(function(m) { return m.attacked; }).length;
    console.log("[Wave] " + wave.id + ": Wave spent (" + attackedCount +
      " attacks landed, " + wave.members.filter(function(m) { return m.dead; }).length + " dead)");
    transitionWave(wave, "SPENT");
  }
}

// ============================================
// Wave Commands
// ============================================

/**
 * Release a wave to attack
 */
export function releaseWave(waveId: string): string {
  var mem = getWaveMemory();
  var wave = mem.waves[waveId];

  if (!wave) {
    return "Wave not found: " + waveId;
  }

  if (wave.state === "SPENT") {
    return "Wave already spent";
  }

  if (wave.state === "RELEASED") {
    return "Wave already released";
  }

  wave.releasedAt = Game.time;
  transitionWave(wave, "RELEASED");

  var aliveCount = wave.members.filter(function(m) { return !m.dead; }).length;
  console.log("[Wave] RELEASING " + wave.id + " with " + aliveCount + " members!");

  return "Wave released with " + aliveCount + " members";
}

/**
 * Abort a wave
 */
export function abortWave(waveId: string): string {
  var mem = getWaveMemory();
  var wave = mem.waves[waveId];

  if (!wave) {
    return "Wave not found: " + waveId;
  }

  transitionWave(wave, "SPENT");
  return "Wave " + waveId + " aborted";
}

// ============================================
// Creep Behavior Helpers
// ============================================

/**
 * Check if a creep should be rallying (called from ControllerAttacker)
 * Returns rally position if should rally, null if should proceed to target
 */
export function shouldRally(creep: Creep): { room: string; x: number; y: number } | null {
  var mem = getWaveMemory();
  var creepMem = creep.memory as any;

  if (!creepMem.waveId) {
    return null; // Not part of a wave
  }

  var wave = mem.waves[creepMem.waveId];

  if (!wave) {
    return null; // Wave doesn't exist
  }

  // Only rally during SPAWNING, RALLYING, or READY states
  if (wave.state === "RELEASED" || wave.state === "SPENT") {
    return null;
  }

  // Return rally position
  return {
    room: wave.rallyRoom,
    x: wave.rallyPos ? wave.rallyPos.x : 25,
    y: wave.rallyPos ? wave.rallyPos.y : 25,
  };
}

/**
 * Check if a creep's wave has been released
 */
export function isWaveReleased(creep: Creep): boolean {
  var mem = getWaveMemory();
  var creepMem = creep.memory as any;

  if (!creepMem.waveId) {
    return true; // Not part of a wave, act independently
  }

  var wave = mem.waves[creepMem.waveId];

  if (!wave) {
    return true; // Wave doesn't exist, act independently
  }

  return wave.state === "RELEASED" || wave.state === "SPENT";
}

// ============================================
// Integration with MilitaryManager
// ============================================

/**
 * Check if campaign needs a new wave
 */
export function needsWave(campaign: CampaignState): boolean {
  // Only create waves during ATTACKING phase
  if (campaign.state !== "ATTACKING") {
    return false;
  }

  // Check if there's already an active wave
  var activeWave = getActiveWave(campaign.id);
  if (activeWave) {
    return false;
  }

  return true;
}

/**
 * Get the number of attackers needed for active wave
 */
export function getWaveSpawnNeed(campaignId: string): number {
  var wave = getActiveWave(campaignId);

  if (!wave) {
    return 0;
  }

  if (wave.state !== "SPAWNING") {
    return 0; // Only spawn during SPAWNING state
  }

  var currentMembers = wave.members.filter(function(m) { return !m.dead; }).length;
  return wave.targetSize - currentMembers;
}

// ============================================
// Console Commands
// ============================================

export function status(): string {
  var mem = getWaveMemory();
  var lines: string[] = [];

  lines.push("=== Wave Coordinator ===");

  var waveIds = Object.keys(mem.waves);
  if (waveIds.length === 0) {
    lines.push("No active waves");
    return lines.join("\n");
  }

  for (var i = 0; i < waveIds.length; i++) {
    var wave = mem.waves[waveIds[i]];
    var alive = wave.members.filter(function(m) { return !m.dead; }).length;
    var atRally = wave.members.filter(function(m) { return m.atRally; }).length;
    var attacked = wave.members.filter(function(m) { return m.attacked; }).length;

    lines.push("");
    lines.push("[" + wave.id + "] Campaign: " + wave.campaignId);
    lines.push("  State: " + wave.state + " (since " + wave.stateChangedAt + ")");
    lines.push("  Rally: " + wave.rallyRoom);
    lines.push("  Members: " + alive + "/" + wave.targetSize + " alive, " +
      atRally + " at rally, " + attacked + " attacked");

    if (wave.members.length > 0) {
      for (var j = 0; j < wave.members.length; j++) {
        var m = wave.members[j];
        var status = m.dead ? "DEAD" : (m.attacked ? "ATTACKED" : (m.atRally ? "READY" : "MOVING"));
        lines.push("    - " + m.creepName + ": " + status);
      }
    }
  }

  return lines.join("\n");
}
