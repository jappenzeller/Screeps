/**
 * AnomalyDetector - runtime invariant checks on creep behaviour.
 *
 * Static review predicts what code will do; this measures what it actually does. Every
 * defect found in the August 2026 review broke a one-line runtime invariant that no
 * amount of code reading caught: an upgrader idling beside a full container, a filler
 * renewing itself while its room starved, a hauler depositing straight back into the
 * container it had just drained.
 *
 * Two generic detectors cover that entire class:
 *
 *   STUCK  A creep whose carried energy has not changed for STUCK_TICKS while its state
 *          has also not changed. Catches every "waiting on a source that will never
 *          arrive" deadlock, regardless of which source or which role.
 *
 *   FLAP   A creep changing state faster than the work could plausibly complete. Catches
 *          collect/deliver ping-pong between two targets that are the same structure.
 *
 * Findings land in Memory.stats.anomalies and ride to AWS in segment 90, so the advisor
 * can correlate them over time instead of a human having to suspect something first.
 *
 * Deliberately only inspects creeps with CARRY parts: every deadlock of this shape has
 * been in the logistics and economy roles, and a stationary defender or a scout waiting
 * on a room edge is not an anomaly.
 */

/** Ticks of unchanged energy AND unchanged state before a creep counts as stuck. */
const STUCK_TICKS = 100;

/**
 * Movement beyond this many tiles from where energy last changed counts as travelling,
 * not stalling. Set just above the radius of a genuine oscillation (the first stall this
 * caught spanned three tiles) and well below a real haul route.
 */
const TRAVEL_RADIUS = 5;

/** A state that lasts fewer ticks than this did no useful work - count it as a flap. */
const FLAP_MIN_STATE_TICKS = 4;

/** Flap events accumulated before a creep is reported. */
const FLAP_REPORT_THRESHOLD = 6;

/** Flap score decays by one every this many ticks, so old churn ages out. */
const FLAP_DECAY_INTERVAL = 50;

/** Cap on stored findings - this rides to AWS, so it must stay small. */
const MAX_ANOMALIES = 12;

export interface Anomaly {
  type: "STUCK" | "FLAP";
  creep: string;
  role: string;
  room: string;
  state: string;
  /** Ticks stuck, or accumulated flap score. */
  ticks: number;
  /** Carried energy at detection - "beside a full container with 0" is the tell. */
  energy: number;
  detectedAt: number;
}

export class AnomalyDetector {
  /**
   * Inspect one creep. Called once per creep per tick, after its role has run so the
   * state and store reflect this tick's decisions.
   */
  static inspect(creep: Creep): void {
    if (creep.spawning) return;
    if (creep.getActiveBodyparts(CARRY) === 0) return;

    const mem = creep.memory;
    const energy = creep.store[RESOURCE_ENERGY];
    const state = mem.state || "-";

    // First sighting: seed the baselines and wait for the next tick.
    if (mem._anEnergyAt === undefined || mem._anStateAt === undefined) {
      mem._anEnergy = energy;
      mem._anEnergyAt = Game.time;
      mem._anState = state;
      mem._anStateAt = Game.time;
      mem._anPos = creep.pos.x + ":" + creep.pos.y + ":" + creep.room.name;
      return;
    }

    // --- energy movement ---
    if (energy !== mem._anEnergy) {
      mem._anEnergy = energy;
      mem._anEnergyAt = Game.time;
      mem._anPos = creep.pos.x + ":" + creep.pos.y + ":" + creep.room.name;
    }

    // A creep that is travelling has unchanged energy by definition - a remote hauler
    // crossing two rooms carries nothing for well over 100 ticks and is working exactly
    // as intended. Displacement from where the energy last changed is what separates
    // "walking somewhere" from "walking in circles": the hauler this detector first
    // caught oscillated inside three tiles for 100+ ticks. Re-anchor when it moves on.
    if (mem._anPos) {
      const parts = mem._anPos.split(":");
      if (parts[2] !== creep.room.name) {
        mem._anEnergyAt = Game.time;
        mem._anPos = creep.pos.x + ":" + creep.pos.y + ":" + creep.room.name;
      } else {
        const dx = Math.abs(creep.pos.x - Number(parts[0]));
        const dy = Math.abs(creep.pos.y - Number(parts[1]));
        if (Math.max(dx, dy) > TRAVEL_RADIUS) {
          mem._anEnergyAt = Game.time;
          mem._anPos = creep.pos.x + ":" + creep.pos.y + ":" + creep.room.name;
        }
      }
    } else {
      mem._anPos = creep.pos.x + ":" + creep.pos.y + ":" + creep.room.name;
    }

    // A creep with WORK parts standing on a source is producing, even though its own
    // store never changes - static miners deposit straight into the container beneath
    // them. That is the designed pattern, not a stall.
    if (creep.getActiveBodyparts(WORK) > 0 && creep.pos.findInRange(FIND_SOURCES, 1).length > 0) {
      return;
    }

    // --- state transitions ---
    if (state !== mem._anState) {
      const heldFor = Game.time - mem._anStateAt;
      if (heldFor < FLAP_MIN_STATE_TICKS) {
        mem._anFlap = (mem._anFlap || 0) + 1;
      }
      mem._anState = state;
      mem._anStateAt = Game.time;
    }

    // Decay flap score so a creep that misbehaved once does not report forever.
    if (mem._anFlap && Game.time % FLAP_DECAY_INTERVAL === 0) {
      mem._anFlap--;
      if (mem._anFlap <= 0) delete mem._anFlap;
    }

    // --- report ---
    const energyIdle = Game.time - mem._anEnergyAt;
    const stateIdle = Game.time - mem._anStateAt;

    if (energyIdle >= STUCK_TICKS && stateIdle >= STUCK_TICKS) {
      this.record({
        type: "STUCK",
        creep: creep.name,
        role: mem.role,
        room: creep.room.name,
        state,
        ticks: energyIdle,
        energy,
        detectedAt: Game.time,
      });
      // Re-baseline so one stuck creep reports periodically rather than every tick.
      mem._anEnergyAt = Game.time;
      mem._anStateAt = Game.time;
      return;
    }

    if ((mem._anFlap || 0) >= FLAP_REPORT_THRESHOLD) {
      this.record({
        type: "FLAP",
        creep: creep.name,
        role: mem.role,
        room: creep.room.name,
        state,
        ticks: mem._anFlap || 0,
        energy,
        detectedAt: Game.time,
      });
      delete mem._anFlap;
    }
  }

  /** Store a finding, replacing any existing one for the same creep. */
  private static record(anomaly: Anomaly): void {
    if (!Memory.stats) return;
    if (!Memory.stats.anomalies) Memory.stats.anomalies = [];

    const list = Memory.stats.anomalies;
    const existing = list.findIndex((a) => a.creep === anomaly.creep);
    if (existing >= 0) {
      list[existing] = anomaly;
    } else {
      list.push(anomaly);
    }

    // Newest first, capped. Old findings for dead creeps age out naturally.
    list.sort((a, b) => b.detectedAt - a.detectedAt);
    if (list.length > MAX_ANOMALIES) list.length = MAX_ANOMALIES;

    console.log(
      `[anomaly] ${anomaly.type} ${anomaly.role} ${anomaly.creep} in ${anomaly.room}: ` +
        `state=${anomaly.state} energy=${anomaly.energy} ticks=${anomaly.ticks}`
    );
  }

  /** Drop findings for creeps that no longer exist. Called from memory cleanup. */
  static prune(): void {
    if (!Memory.stats || !Memory.stats.anomalies) return;
    Memory.stats.anomalies = Memory.stats.anomalies.filter((a) => !!Game.creeps[a.creep]);
  }

  /** Current findings, newest first. */
  static get(): Anomaly[] {
    return (Memory.stats && Memory.stats.anomalies) || [];
  }
}
