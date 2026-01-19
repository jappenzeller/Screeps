import { Role } from "../config";
import { runHarvester } from "./Harvester";
import { runHauler } from "./Hauler";
import { runUpgrader } from "./Upgrader";
import { runBuilder } from "./Builder";
import { runDefender } from "./Defender";
import { runScout } from "./Scout";
import { runRemoteMiner } from "./RemoteMiner";
import { runRemoteHauler } from "./RemoteHauler";
import { runReserver } from "./Reserver";
import { runClaimer } from "./Claimer";
import { runRemoteDefender } from "./RemoteDefender";

export interface BodyConfig {
  base: BodyPartConstant[];
  scale?: BodyPartConstant[];
}

export const ROLE_BODIES: Record<Role, BodyConfig> = {
  // Harvester: Prioritize WORK for mining efficiency
  // Base has CARRY for early game mobile harvesting (before containers)
  // 300 energy: [WORK, WORK, CARRY, MOVE] = 2 WORK (4 energy/tick) + can deliver
  // 400 energy: [WORK, WORK, CARRY, MOVE, WORK] = 3 WORK (6 energy/tick)
  // 550 energy: [WORK, WORK, CARRY, MOVE, WORK, WORK, WORK] = 5 WORK (10 energy/tick!)
  HARVESTER: {
    base: [WORK, WORK, CARRY, MOVE], // 300 energy - can harvest AND deliver early game
    scale: [WORK], // Add more WORK parts as capacity grows (for static mining)
  },

  // Hauler: moves energy around
  HAULER: {
    base: [CARRY, CARRY, MOVE, MOVE],
    scale: [CARRY, MOVE],
  },

  // Upgrader: upgrades controller
  UPGRADER: {
    base: [WORK, CARRY, MOVE],
    scale: [WORK, CARRY, MOVE],
  },

  // Builder: builds and repairs
  BUILDER: {
    base: [WORK, CARRY, MOVE],
    scale: [WORK, CARRY, MOVE],
  },

  // Defender: attacks hostiles (local room)
  DEFENDER: {
    base: [TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE],
    scale: [ATTACK, MOVE],
  },

  // Remote Defender: clears hostiles from remote mining rooms
  REMOTE_DEFENDER: {
    base: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE],
    scale: [ATTACK, MOVE],
  },

  // Scout: explores rooms
  SCOUT: {
    base: [MOVE],
  },

  // Remote miner: harvests in remote rooms
  REMOTE_MINER: {
    base: [WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE],
    scale: [CARRY, MOVE],
  },

  // Remote hauler: collects energy from remote rooms
  REMOTE_HAULER: {
    base: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    scale: [CARRY, MOVE],
  },

  // Reserver: reserves remote controllers
  RESERVER: {
    base: [CLAIM, CLAIM, MOVE, MOVE],
  },

  // Claimer: claims new rooms
  CLAIMER: {
    base: [CLAIM, MOVE],
  },
};

export type RoleRunner = (creep: Creep) => void;

export const ROLE_RUNNERS: Record<string, RoleRunner> = {
  HARVESTER: runHarvester,
  HAULER: runHauler,
  UPGRADER: runUpgrader,
  BUILDER: runBuilder,
  DEFENDER: runDefender,
  REMOTE_DEFENDER: runRemoteDefender,
  SCOUT: runScout,
  REMOTE_MINER: runRemoteMiner,
  REMOTE_HAULER: runRemoteHauler,
  RESERVER: runReserver,
  CLAIMER: runClaimer,
};

export function runCreep(creep: Creep): void {
  const role = creep.memory.role;
  const runner = ROLE_RUNNERS[role];

  if (runner) {
    runner(creep);
  } else {
    // Fallback: unknown role, just idle
    creep.say("❓");
  }
}
