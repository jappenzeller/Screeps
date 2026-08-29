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
  /** Why it is stuck, from the deeper path diagnostic. Absent if none was run. */
  diagnosis?: string;
}

export class AnomalyDetector {
  /** Last tick a deep diagnosis ran - one per tick empire-wide caps the pathfinding. */
  private static lastDiagnosisTick = 0;

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
      // Pay for the expensive explanation only now, and only once per tick.
      let diagnosis: string | undefined;
      if (Game.time !== this.lastDiagnosisTick) {
        this.lastDiagnosisTick = Game.time;
        try {
          diagnosis = this.diagnose(creep);
        } catch (err) {
          diagnosis = `diagnosis failed: ${String(err)}`;
        }
      }

      this.record({
        type: "STUCK",
        creep: creep.name,
        role: mem.role,
        room: creep.room.name,
        state,
        ticks: energyIdle,
        energy,
        detectedAt: Game.time,
        diagnosis,
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

  /**
   * Explain WHY a creep is stuck, using checks too expensive to run continuously.
   *
   * Only ever reached for a creep the cheap detectors have already confirmed STUCK, and
   * rate-limited to one per tick empire-wide, so the pathfinding is paid a handful of
   * times per thousand ticks. The payoff is turning "creep X is stuck" into a specific
   * cause without a human investigating.
   *
   * The distinctions here are the ones that took manual work to establish the first time:
   * a map route existing says nothing about whether a creep can walk out of its own room
   * (Game.map.findRoute operates on the room graph and ignores walls inside a room), and
   * "cannot reach the exit" is a very different fault from "cannot reach anything".
   */
  private static diagnose(creep: Creep): string {
    const target = creep.memory.targetRoom;

    // Cross-room assignment: can it physically leave toward the target at all?
    if (target && target !== creep.room.name) {
      const route = Game.map.findRoute(creep.room.name, target);
      if (route === ERR_NO_PATH || route.length === 0) {
        return `no map route to ${target}`;
      }

      const exit = creep.pos.findClosestByPath(route[0].exit, { ignoreCreeps: true });
      if (!exit) {
        // Separate "this border is sealed" from "this creep is walled into a pocket".
        const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS, { ignoreCreeps: true });
        return spawn
          ? `map route to ${target} exists but no exit toward it is reachable - border sealed`
          : `isolated - cannot reach any exit or spawn`;
      }
      return `exit toward ${target} is reachable - blocked or oscillating en route`;
    }

    // Empty and going nowhere: is there energy it cannot get to?
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const sources = creep.room.find(FIND_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
          (s as StructureContainer | StructureStorage).store[RESOURCE_ENERGY] > 0,
      });
      if (sources.length === 0) return "no stored energy anywhere in room";

      const reachable = creep.pos.findClosestByPath(sources, { ignoreCreeps: true });
      return reachable
        ? `energy available and reachable at ${reachable.pos.x},${reachable.pos.y} - not collecting it`
        : "energy present in room but none of it is reachable";
    }

    // Carrying energy with nowhere to put it.
    const sinks = creep.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => {
        const store = (s as AnyStoreStructure).store;
        return !!store && store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      },
    });
    if (sinks.length === 0) return "carrying energy, every sink in the room is full";

    const sink = creep.pos.findClosestByPath(sinks, { ignoreCreeps: true });
    return sink
      ? `sink reachable at ${sink.pos.x},${sink.pos.y} - not delivering to it`
      : "carrying energy, no reachable sink";
  }

  /** Store a finding, replacing any existing one for the same creep. */
  private static record(anomaly: Anomaly): void {
    if (!Memory.stats) return;
    if (!Memory.stats.anomalies) Memory.stats.anomalies = [];

    const list = Memory.stats.anomalies;
    const existing = list.findIndex((a) => a.creep === anomaly.creep);
    if (existing >= 0) {
      // Keep an earlier diagnosis rather than losing it to a rate-limited re-report.
      if (!anomaly.diagnosis && list[existing].diagnosis) {
        anomaly.diagnosis = list[existing].diagnosis;
      }
      list[existing] = anomaly;
    } else {
      list.push(anomaly);
    }

    // Newest first, capped. Old findings for dead creeps age out naturally.
    list.sort((a, b) => b.detectedAt - a.detectedAt);
    if (list.length > MAX_ANOMALIES) list.length = MAX_ANOMALIES;

    console.log(
      `[anomaly] ${anomaly.type} ${anomaly.role} ${anomaly.creep} in ${anomaly.room}: ` +
        `state=${anomaly.state} energy=${anomaly.energy} ticks=${anomaly.ticks}` +
        (anomaly.diagnosis ? ` :: ${anomaly.diagnosis}` : "")
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
