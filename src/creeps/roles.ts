import { runHarvester } from "./Harvester";
import { runHauler } from "./Hauler";
import { runUpgrader } from "./Upgrader";
import { runBuilder } from "./Builder";
import { runDefender } from "./Defender";
import { runScout } from "./Scout";
import { runRemoteMiner } from "./RemoteMiner";
import { runRemoteHauler } from "./RemoteHauler";
import { runRemoteBuilder } from "./RemoteBuilder";
import { runReserver } from "./Reserver";
import { runClaimer } from "./Claimer";
import { runRemoteDefender } from "./RemoteDefender";
import { runLinkFiller } from "./LinkFiller";
import { runMineralHarvester } from "./MineralHarvester";
import { runBootstrapBuilder } from "./BootstrapBuilder";
import { runBootstrapHauler } from "./BootstrapHauler";
import { runBootstrapWorker } from "./BootstrapWorker";
import { runPioneer } from "./Pioneer";

// Body configurations moved to src/spawning/bodyConfig.ts
// Use buildBody() from src/spawning/bodyBuilder.ts for body generation

export type RoleRunner = (creep: Creep) => void;

export const ROLE_RUNNERS: Record<string, RoleRunner> = {
  HARVESTER: runHarvester,
  HAULER: runHauler,
  UPGRADER: runUpgrader,
  BUILDER: runBuilder,
  DEFENDER: runDefender,
  REMOTE_DEFENDER: runRemoteDefender,
  // Legacy: existing REMOTE_DEFENDER_RANGED creeps use the same runner
  REMOTE_DEFENDER_RANGED: runRemoteDefender,
  SCOUT: runScout,
  REMOTE_MINER: runRemoteMiner,
  REMOTE_HAULER: runRemoteHauler,
  REMOTE_BUILDER: runRemoteBuilder,
  RESERVER: runReserver,
  CLAIMER: runClaimer,
  LINK_FILLER: runLinkFiller,
  MINERAL_HARVESTER: runMineralHarvester,
  BOOTSTRAP_BUILDER: runBootstrapBuilder,
  BOOTSTRAP_HAULER: runBootstrapHauler,
  BOOTSTRAP_WORKER: runBootstrapWorker,
  PIONEER: runPioneer,
};

export function runCreep(creep: Creep): void {
  const role = creep.memory.role;
  const runner = ROLE_RUNNERS[role];

  if (runner) {
    runner(creep);
  } else {
    // Fallback: unknown role, just idle
    creep.say("???");
  }
}
