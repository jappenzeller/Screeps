import { logger } from "../utils/Logger";

interface ThreatAnalysis {
  roomName: string;
  attackers: number;
  healers: number;
  totalDPS: number; // Damage per tick from hostiles
  totalHPS: number; // Healing per tick from hostile healers
  recommendedSquadSize: number;
  threatLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
}

interface SquadState {
  targetRoom: string;
  requiredSize: number;
  members: string[]; // Creep names
  status: "FORMING" | "READY" | "ATTACKING" | "DISBANDED";
  createdAt: number;
}

// Constants for combat math
const ATTACK_DAMAGE = 30; // Per ATTACK part per tick
const RANGED_DAMAGE = 10; // Per RANGED_ATTACK part per tick (at range 1)
const HEAL_POWER = 12; // Per HEAL part per tick (adjacent)

// Our defender body: [TOUGH x2, ATTACK x3, MOVE x5] = 430 energy
// DPS: 3 * 30 = 90 damage/tick
const DEFENDER_DPS = 90;

declare global {
  interface Memory {
    remoteSquads?: Record<string, SquadState>;
  }
}

export class RemoteSquadManager {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
    if (!Memory.remoteSquads) {
      Memory.remoteSquads = {};
    }
  }

  /**
   * Analyze threat in a remote room
   */
  analyzeThreat(roomName: string): ThreatAnalysis {
    const intel = Memory.rooms?.[roomName];
    const room = Game.rooms[roomName];

    let attackers = 0;
    let healers = 0;
    let totalDPS = 0;
    let totalHPS = 0;

    // Use live data if available
    if (room) {
      const hostiles = room.find(FIND_HOSTILE_CREEPS);
      for (const hostile of hostiles) {
        const attackParts = hostile.getActiveBodyparts(ATTACK);
        const rangedParts = hostile.getActiveBodyparts(RANGED_ATTACK);
        const healParts = hostile.getActiveBodyparts(HEAL);

        if (attackParts > 0 || rangedParts > 0) {
          attackers++;
          totalDPS += attackParts * ATTACK_DAMAGE + rangedParts * RANGED_DAMAGE;
        }
        if (healParts > 0) {
          healers++;
          totalHPS += healParts * HEAL_POWER;
        }
      }
    } else if ((intel as any)?.hostileDetails) {
      // Fall back to memory intel
      for (const hostile of (intel as any).hostileDetails as any[]) {
        if (hostile.hasCombat) attackers++;
      }
      // Rough estimate from memory
      totalDPS = attackers * 60; // Assume 2 ATTACK parts average
      const hostileCount = intel?.hostiles || 0;
      totalHPS = hostileCount > attackers ? (hostileCount - attackers) * 48 : 0; // Assume 4 HEAL parts
    }

    // Calculate required squad size
    // We need enough DPS to overcome their healing AND kill them
    // Formula: (our DPS - their HPS) * time > their total HP
    // Simplified: need DPS > HPS + margin
    let recommendedSquadSize = 0;
    if (totalHPS > 0 || attackers > 0) {
      // Need to out-damage their healing
      const requiredDPS = totalHPS + 50; // 50 DPS margin to actually kill
      recommendedSquadSize = Math.ceil(requiredDPS / DEFENDER_DPS);
      // Minimum 1 per attacker, but at least enough to overcome healing
      recommendedSquadSize = Math.max(recommendedSquadSize, attackers);
      // Cap at reasonable max
      recommendedSquadSize = Math.min(recommendedSquadSize, 5);
    }

    // Determine threat level
    let threatLevel: ThreatAnalysis["threatLevel"] = "NONE";
    if (attackers === 0 && healers === 0) {
      threatLevel = "NONE";
    } else if (healers === 0 && attackers <= 2) {
      threatLevel = "LOW";
    } else if (healers > 0 || attackers > 2) {
      threatLevel = "MEDIUM";
    }
    if (healers >= 2 || attackers >= 4) {
      threatLevel = "HIGH";
    }

    return {
      roomName,
      attackers,
      healers,
      totalDPS,
      totalHPS,
      recommendedSquadSize,
      threatLevel,
    };
  }

  /**
   * Get or create squad for a room
   */
  getSquad(roomName: string): SquadState | null {
    return Memory.remoteSquads?.[roomName] || null;
  }

  /**
   * Request a squad for a threatened room
   */
  requestSquad(roomName: string, size: number): void {
    if (!Memory.remoteSquads) Memory.remoteSquads = {};

    const existing = Memory.remoteSquads[roomName];
    if (existing && existing.status !== "DISBANDED") {
      // Update size if threat increased
      if (size > existing.requiredSize) {
        existing.requiredSize = size;
      }
      return;
    }

    Memory.remoteSquads[roomName] = {
      targetRoom: roomName,
      requiredSize: size,
      members: [],
      status: "FORMING",
      createdAt: Game.time,
    };

    logger.info("RemoteSquadManager", `Squad requested for ${roomName}, size ${size}`);
  }

  /**
   * Register a defender to a squad
   */
  registerDefender(creepName: string, targetRoom: string): void {
    const squad = Memory.remoteSquads?.[targetRoom];
    if (!squad) return;

    if (!squad.members.includes(creepName)) {
      squad.members.push(creepName);
      logger.info(
        "RemoteSquadManager",
        `${creepName} joined squad for ${targetRoom} (${squad.members.length}/${squad.requiredSize})`
      );
    }

    // Check if squad is ready
    if (squad.members.length >= squad.requiredSize && squad.status === "FORMING") {
      squad.status = "READY";
      logger.info("RemoteSquadManager", `Squad for ${targetRoom} is READY to attack!`);
    }
  }

  /**
   * Check if a squad is ready to attack
   */
  isSquadReady(roomName: string): boolean {
    const squad = Memory.remoteSquads?.[roomName];
    if (!squad) return false;
    return squad.status === "READY" || squad.status === "ATTACKING";
  }

  /**
   * Mark squad as attacking
   */
  setAttacking(roomName: string): void {
    const squad = Memory.remoteSquads?.[roomName];
    if (squad && squad.status === "READY") {
      squad.status = "ATTACKING";
    }
  }

  /**
   * Disband squad when threat is cleared
   */
  disbandSquad(roomName: string): void {
    const squad = Memory.remoteSquads?.[roomName];
    if (squad) {
      squad.status = "DISBANDED";
      logger.info("RemoteSquadManager", `Squad for ${roomName} disbanded`);
      // Clean up after a delay
      if (Game.time - squad.createdAt > 100) {
        delete Memory.remoteSquads![roomName];
      }
    }
  }

  /**
   * Clean up dead members from squads
   */
  cleanup(): void {
    if (!Memory.remoteSquads) return;

    for (const roomName in Memory.remoteSquads) {
      const squad = Memory.remoteSquads[roomName];

      // Remove dead creeps
      squad.members = squad.members.filter((name) => Game.creeps[name]);

      // Check if squad was forming but lost members
      if (squad.status === "READY" && squad.members.length < squad.requiredSize) {
        squad.status = "FORMING";
      }

      // Disband empty squads
      if (squad.members.length === 0 && squad.status !== "FORMING") {
        this.disbandSquad(roomName);
      }

      // Timeout squads that take too long to form (2000 ticks)
      if (squad.status === "FORMING" && Game.time - squad.createdAt > 2000) {
        logger.warn("RemoteSquadManager", `Squad for ${roomName} timed out`);
        this.disbandSquad(roomName);
      }
    }
  }

  /**
   * Get number of defenders needed for spawning
   */
  getDefendersNeeded(): { roomName: string; count: number }[] {
    const needs: { roomName: string; count: number }[] = [];

    if (!Memory.remoteSquads) return needs;

    for (const roomName in Memory.remoteSquads) {
      const squad = Memory.remoteSquads[roomName];
      if (squad.status === "FORMING" || squad.status === "READY") {
        const currentMembers = squad.members.filter((name) => Game.creeps[name]).length;
        const needed = squad.requiredSize - currentMembers;
        if (needed > 0) {
          needs.push({ roomName, count: needed });
        }
      }
    }

    return needs;
  }
}
