import { smartMoveTo } from "../utils/movement";
import { LinkManager } from "../structures/LinkManager";

/**
 * UpgradeHauler - Supplements link transfers by hauling from storage to controller link.
 * Bridges the gap between link transfer rate (~35/tick) and upgrader demand (45/tick).
 * Opportunistically renews at spawn during round trips for infinite lifetime.
 */
export function runUpgradeHauler(creep: Creep): void {
  const storage = creep.room.storage;
  if (!storage) {
    creep.say("no stor");
    return;
  }

  const linkManager = new LinkManager(creep.room);
  const controllerLink = linkManager.getControllerLink();

  if (!controllerLink) {
    creep.say("no link");
    return;
  }

  // Opportunistic renewal when passing near spawn
  if (creep.ticksToLive && creep.ticksToLive < 1200) {
    const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (spawn && creep.pos.isNearTo(spawn) && !spawn.spawning) {
      spawn.renewCreep(creep);
    }
  }

  // Empty: go to storage
  if (creep.store[RESOURCE_ENERGY] === 0) {
    const result = creep.withdraw(storage, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { reusePath: 10 });
    }
    return;
  }

  // Has energy: deliver to controller link
  const result = creep.transfer(controllerLink, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, controllerLink, { reusePath: 10 });
  } else if (result === ERR_FULL) {
    // Link full - wait nearby
    if (!creep.pos.inRangeTo(controllerLink, 2)) {
      smartMoveTo(creep, controllerLink, { reusePath: 10, range: 2 });
    }
  }
}
