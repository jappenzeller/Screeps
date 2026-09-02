/**
 * ColonyPopulation - what counts as a working creep.
 *
 * A creep whose body has lost the parts its role depends on is alive but useless: a hauler
 * with zero CARRY transports nothing, a harvester with zero WORK mines nothing. Counting
 * it as present means the colony never replaces it, and the role silently goes unfilled
 * while every count says it is staffed.
 *
 * utilitySpawning has always counted this way. The framework's snapshot counted raw roles,
 * so the two disagreed about the most basic input to a spawn decision - how many of this
 * role do we have. Shared here so they cannot.
 */

import { getCreepEffectiveness } from "../spawning/utilities/populationUtility";

/**
 * Count creeps that can actually perform their role.
 * Uses fractional counting based on damage - a hauler with 8/16 CARRY counts as 0.5.
 * This prevents the spawner from thinking "we have 1 hauler" when that hauler is damaged.
 */
export function getEffectiveCounts(creeps: Creep[], room: Room): Record<string, number> {
  var counts: Record<string, number> = {};

  // Check if source containers exist (harvesters without CARRY are OK if containers catch energy)
  var sourceContainers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
        s.pos.findInRange(FIND_SOURCES, 1).length > 0;
    }
  });
  var hasSourceContainers = sourceContainers.length > 0;

  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    var role = c.memory.role;
    var functional = true;

    // First check if creep is completely non-functional (0 key parts)
    switch (role) {
      case "HARVESTER":
        // Must have WORK parts to harvest
        if (c.getActiveBodyparts(WORK) === 0) { functional = false; break; }
        // Must have CARRY OR source containers must exist to catch dropped energy
        if (c.getActiveBodyparts(CARRY) === 0 && !hasSourceContainers) { functional = false; }
        break;

      case "HAULER":
      case "REMOTE_HAULER":
        // Must have CARRY to transport anything
        if (c.getActiveBodyparts(CARRY) === 0) functional = false;
        break;

      case "UPGRADER":
      case "BUILDER":
        // Must have WORK to do anything useful
        if (c.getActiveBodyparts(WORK) === 0) functional = false;
        break;

      case "PIONEER":
        // Must have WORK to harvest/build/upgrade AND CARRY to deliver
        if (c.getActiveBodyparts(WORK) === 0) { functional = false; break; }
        if (c.getActiveBodyparts(CARRY) === 0) functional = false;
        break;

      case "REMOTE_MINER":
        // Must have WORK to harvest
        if (c.getActiveBodyparts(WORK) === 0) functional = false;
        break;

      case "REMOTE_DEFENDER":
      case "DEFENDER":
        // Must have at least one attack-type part
        if (c.getActiveBodyparts(ATTACK) === 0 &&
            c.getActiveBodyparts(RANGED_ATTACK) === 0) functional = false;
        break;

      case "RESERVER":
      case "CLAIMER":
        // Must have CLAIM
        if (c.getActiveBodyparts(CLAIM) === 0) functional = false;
        break;

      // SCOUT, LINK_FILLER, MINERAL_HARVESTER: just needs to be alive
      default:
        break;
    }

    if (functional) {
      // Count as fractional based on damage to key body parts
      var effectiveness = getCreepEffectiveness(c);
      counts[role] = (counts[role] || 0) + effectiveness;
    }
  }

  return counts;
}
