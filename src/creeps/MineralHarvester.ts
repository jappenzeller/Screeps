import { smartMoveTo } from "../utils/movement";

/**
 * MineralHarvester - Extracts minerals from extractor and delivers to terminal/storage
 *
 * Lifecycle:
 * 1. Move to mineral
 * 2. Harvest (5 tick cooldown between harvests)
 * 3. When full, deliver to terminal or storage
 * 4. Return to mineral
 *
 * Only one mineral harvester is needed per room.
 * When mineral depletes, harvester idles until regeneration (~50k ticks).
 */

export function runMineralHarvester(creep: Creep): void {
  const room = creep.room;

  // Find mineral and extractor
  const mineral = room.find(FIND_MINERALS)[0];
  if (!mineral) {
    creep.say("NO MIN");
    return;
  }

  const extractor = mineral.pos
    .lookFor(LOOK_STRUCTURES)
    .find((s) => s.structureType === STRUCTURE_EXTRACTOR) as StructureExtractor | undefined;

  if (!extractor) {
    creep.say("NO EXT");
    return;
  }

  // Check if mineral is depleted
  if (mineral.mineralAmount === 0) {
    // Mineral depleted - idle near storage or recycle
    const storage = room.storage;
    if (storage && !creep.pos.inRangeTo(storage, 3)) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#888888" } });
    }
    creep.say("EMPTY");
    return;
  }

  // State machine: HARVESTING or DELIVERING
  if (!creep.memory.state) {
    creep.memory.state = creep.store.getUsedCapacity() > 0 ? "DELIVERING" : "HARVESTING";
  }

  if (creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
  } else if (creep.store.getUsedCapacity() === 0) {
    creep.memory.state = "HARVESTING";
  }

  if (creep.memory.state === "DELIVERING") {
    deliver(creep, mineral.mineralType);
  } else {
    harvestMineral(creep, mineral);
  }
}

function harvestMineral(creep: Creep, mineral: Mineral): void {
  const result = creep.harvest(mineral);

  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, mineral, {
      reusePath: 20,
      visualizePathStyle: { stroke: "#ffaa00" },
    });
  } else if (result === ERR_TIRED) {
    // Extractor on cooldown (5 ticks) - just wait
    creep.say("COOL");
  } else if (result === OK) {
    creep.say("DIG");
  }
}

function deliver(creep: Creep, mineralType: MineralConstant): void {
  const room = creep.room;

  // Find the actual resource type we're carrying (might differ from mineralType)
  const carryingType = (Object.keys(creep.store) as ResourceConstant[]).find(
    (r) => r !== RESOURCE_ENERGY && creep.store[r] > 0
  );

  if (!carryingType) {
    creep.memory.state = "HARVESTING";
    return;
  }

  // Priority 1: Terminal (for future trading)
  const terminal = room.terminal;
  if (terminal && terminal.store.getFreeCapacity(carryingType) > 0) {
    if (creep.transfer(terminal, carryingType) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, terminal, {
        reusePath: 20,
        visualizePathStyle: { stroke: "#00ffff" },
      });
    }
    return;
  }

  // Priority 2: Storage
  const storage = room.storage;
  if (storage && storage.store.getFreeCapacity(carryingType) > 0) {
    if (creep.transfer(storage, carryingType) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, {
        reusePath: 20,
        visualizePathStyle: { stroke: "#00ff00" },
      });
    }
    return;
  }

  // No valid target - drop on ground as last resort
  creep.drop(carryingType);
  creep.say("DROP");
}
