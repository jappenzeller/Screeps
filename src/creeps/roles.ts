import { Role } from "../config";
import { runHarvester } from "./Harvester";
import { runHauler } from "./Hauler";
import { runUpgrader } from "./Upgrader";
import { runBuilder } from "./Builder";
import { runDefender } from "./Defender";
import { runScout } from "./Scout";
import { runRemoteMiner } from "./RemoteMiner";

export interface BodyConfig {
  base: BodyPartConstant[];
  scale?: BodyPartConstant[];
}

export const ROLE_BODIES: Record<Role, BodyConfig> = {
  // Harvester: early game does both harvest+deliver, later becomes static miner
  HARVESTER: {
    base: [WORK, CARRY, MOVE, MOVE], // Can harvest AND deliver
    scale: [WORK, CARRY, MOVE],
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

  // Defender: attacks hostiles
  DEFENDER: {
    base: [TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE],
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
  SCOUT: runScout,
  REMOTE_MINER: runRemoteMiner,
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
