/**
 * ExpansionReadiness - Determines if a colony can support a new expansion
 *
 * Bootstrap cost estimate:
 * - Claimer: 650 energy (spawns once)
 * - Bootstrap builders: 2 x 800 = 1600 (may need respawn)
 * - Bootstrap haulers: 2 x 500 = 1000 (constant trips)
 * - Energy for spawn construction: 15000 energy
 * - Buffer for failed attempts: 5000
 * Total: ~25,000 energy minimum, 50,000 comfortable
 *
 * Time estimate: ~3000-5000 ticks from claim to spawn operational
 */

import { getConfig } from "./EmpireConfig";
import { initializeEmpireMemory } from "./EmpireMemory";

export interface ReadinessCheck {
  ready: boolean;
  score: number; // 0-100, higher = more ready
  blockers: string[];
  warnings: string[];

  // Component checks
  gclHeadroom: boolean;
  rclSufficient: boolean;
  energyReserves: boolean;
  economyHealthy: boolean;
  noActiveThreats: boolean;
  spawnCapacityAvailable: boolean;
  noActiveExpansion: boolean;
}

export interface ParentCandidate {
  roomName: string;
  readiness: ReadinessCheck;
  distanceToTarget: number;
}

export class ExpansionReadiness {
  private config = getConfig().expansion;

  /**
   * Check if the empire can expand (any colony ready + GCL allows)
   */
  canExpand(): { ready: boolean; bestParent: string | null; blockers: string[] } {
    initializeEmpireMemory();
    const blockers: string[] = [];

    // GCL check
    const ownedRooms = Object.values(Game.rooms).filter((r) => r.controller?.my).length;
    if (ownedRooms >= Game.gcl.level) {
      blockers.push(`GCL ${Game.gcl.level} maxed (${ownedRooms} rooms owned)`);
      return { ready: false, bestParent: null, blockers };
    }

    // Check for active expansion
    var empExpansion = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
    var empActive = empExpansion && empExpansion.active ? empExpansion.active : {};
    const activeExpansions = Object.keys(empActive).length;
    if (activeExpansions >= this.config.maxSimultaneous) {
      blockers.push(`Already have ${activeExpansions} active expansion(s)`);
      return { ready: false, bestParent: null, blockers };
    }

    // Find best parent colony
    const parents = this.rankParentColonies();
    const readyParent = parents.find((p) => p.readiness.ready);

    if (!readyParent) {
      // Collect blockers from best candidate
      if (parents.length > 0) {
        blockers.push(...parents[0].readiness.blockers);
      } else {
        blockers.push("No owned rooms");
      }
      return { ready: false, bestParent: null, blockers };
    }

    return { ready: true, bestParent: readyParent.roomName, blockers: [] };
  }

  /**
   * Check readiness for a specific room to be parent
   */
  checkRoom(roomName: string): ReadinessCheck {
    initializeEmpireMemory();
    const room = Game.rooms[roomName];
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (!room || !room.controller?.my) {
      return this.notReady(["Room not owned"], []);
    }

    const rcl = room.controller.level;
    const storage = room.storage;
    const energyStored = storage?.store[RESOURCE_ENERGY] || 0;

    // === HARD REQUIREMENTS ===

    // RCL check (need claimer body = 650 energy = RCL 4 capacity)
    const rclSufficient = rcl >= this.config.minParentRCL;
    if (!rclSufficient) {
      blockers.push(`RCL ${rcl} < ${this.config.minParentRCL} required`);
    }

    // Energy reserves
    const energyReserves = energyStored >= this.config.minReserves;
    if (!energyReserves) {
      blockers.push(`Energy ${energyStored} < ${this.config.minReserves} required`);
    }

    // GCL headroom (empire-wide)
    const ownedRooms = Object.values(Game.rooms).filter((r) => r.controller?.my).length;
    const gclHeadroom = ownedRooms < Game.gcl.level;
    if (!gclHeadroom) {
      blockers.push(`GCL ${Game.gcl.level} maxed`);
    }

    // No active expansion from this room
    var empExpansion2 = Memory.empire && Memory.empire.expansion ? Memory.empire.expansion : null;
    var empActive2 = empExpansion2 && empExpansion2.active ? empExpansion2.active : {};
    const activeFromHere = Object.values(empActive2).some(
      function(e: any) { return e.parentRoom === roomName; }
    );
    const noActiveExpansion = !activeFromHere;
    if (!noActiveExpansion) {
      blockers.push("Already running expansion from this room");
    }

    // === SOFT REQUIREMENTS (warnings, affect score) ===

    // Economy health - check if energy flow is positive
    const harvesters = Object.values(Game.creeps).filter(
      (c) => c.memory.room === roomName && c.memory.role === "HARVESTER"
    ).length;
    const haulers = Object.values(Game.creeps).filter(
      (c) => c.memory.room === roomName && c.memory.role === "HAULER"
    ).length;
    const economyHealthy = harvesters >= 2 && haulers >= 1;
    if (!economyHealthy) {
      warnings.push(`Weak economy (${harvesters}H/${haulers}U)`);
    }

    // No active threats
    const hostiles = room.find(FIND_HOSTILE_CREEPS).length;
    const noActiveThreats = hostiles === 0;
    if (!noActiveThreats) {
      warnings.push(`${hostiles} hostiles in room`);
    }

    // Spawn capacity - not already maxed on creeps
    const spawns = room.find(FIND_MY_SPAWNS);
    const spawnCapacityAvailable = spawns.some((s) => !s.spawning);
    if (!spawnCapacityAvailable) {
      warnings.push("All spawns busy");
    }

    // Calculate score
    let score = 0;
    if (rclSufficient) score += 20;
    if (energyReserves) score += 25;
    if (gclHeadroom) score += 15;
    if (noActiveExpansion) score += 10;
    if (economyHealthy) score += 15;
    if (noActiveThreats) score += 10;
    if (spawnCapacityAvailable) score += 5;

    // Bonus for excess energy
    if (energyStored > this.config.minReserves * 2) {
      score += 10;
    }
    if (energyStored > this.config.minReserves * 4) {
      score += 10;
    }

    // Bonus for high RCL
    if (rcl >= 6) score += 5;
    if (rcl >= 7) score += 5;

    const ready = blockers.length === 0 && score >= 60;

    return {
      ready,
      score: Math.min(100, score),
      blockers,
      warnings,
      gclHeadroom,
      rclSufficient,
      energyReserves,
      economyHealthy,
      noActiveThreats,
      spawnCapacityAvailable,
      noActiveExpansion,
    };
  }

  /**
   * Rank all owned rooms by readiness to be parent
   */
  rankParentColonies(targetRoom?: string): ParentCandidate[] {
    const candidates: ParentCandidate[] = [];

    for (const room of Object.values(Game.rooms)) {
      if (!room.controller?.my) continue;

      const readiness = this.checkRoom(room.name);
      const distanceToTarget = targetRoom
        ? Game.map.getRoomLinearDistance(room.name, targetRoom)
        : 0;

      candidates.push({
        roomName: room.name,
        readiness,
        distanceToTarget,
      });
    }

    // Sort by: ready first, then score, then distance to target
    candidates.sort((a, b) => {
      if (a.readiness.ready !== b.readiness.ready) {
        return a.readiness.ready ? -1 : 1;
      }
      if (a.readiness.score !== b.readiness.score) {
        return b.readiness.score - a.readiness.score;
      }
      return a.distanceToTarget - b.distanceToTarget;
    });

    return candidates;
  }

  private notReady(blockers: string[], warnings: string[]): ReadinessCheck {
    return {
      ready: false,
      score: 0,
      blockers,
      warnings,
      gclHeadroom: false,
      rclSufficient: false,
      energyReserves: false,
      economyHealthy: false,
      noActiveThreats: false,
      spawnCapacityAvailable: false,
      noActiveExpansion: false,
    };
  }
}
