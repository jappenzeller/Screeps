import { logger } from "../utils/Logger";

/**
 * RemoteMiner - Harvests sources in adjacent rooms
 * Drops energy for RemoteHaulers to collect (or hauls itself if small)
 */
export function runRemoteMiner(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  const sourceId = creep.memory.sourceId;

  // Need a target room assigned
  if (!targetRoom) {
    logger.warn("RemoteMiner", `${creep.name} has no target room assigned`);
    return;
  }

  // Move to target room if not there
  if (creep.room.name !== targetRoom) {
    const exitDir = creep.room.findExitTo(targetRoom);
    if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
      const exit = creep.pos.findClosestByPath(exitDir);
      if (exit) {
        creep.moveTo(exit, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
    }
    return;
  }

  // Check for hostiles - flee if dangerous
  const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length > 0) {
    const dangerous = hostiles.filter(
      (h) =>
        h.getActiveBodyparts(ATTACK) > 0 ||
        h.getActiveBodyparts(RANGED_ATTACK) > 0
    );
    if (dangerous.length > 0) {
      // Flee to home room
      const homeRoom = creep.memory.room;
      const exitDir = creep.room.findExitTo(homeRoom);
      if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
        const exit = creep.pos.findClosestByPath(exitDir);
        if (exit) {
          creep.moveTo(exit, { visualizePathStyle: { stroke: "#ff0000" } });
        }
      }
      return;
    }
  }

  // Find or validate source
  let source: Source | null = null;
  if (sourceId) {
    source = Game.getObjectById(sourceId);
  }

  if (!source) {
    // Find an unassigned source in this room
    source = findUnassignedRemoteSource(creep.room, creep.memory.room);
    if (source) {
      creep.memory.sourceId = source.id;
      logger.info("RemoteMiner", `${creep.name} assigned to source ${source.id}`);
    } else {
      logger.warn("RemoteMiner", `No available sources in ${targetRoom}`);
      return;
    }
  }

  // Harvest the source
  const result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
  }

  // If we have carry parts and are full, drop energy (or find container)
  if (creep.store.getFreeCapacity() === 0) {
    // Look for a container at the source
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) => s.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];

    if (containers.length > 0 && containers[0].store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.transfer(containers[0], RESOURCE_ENERGY);
    } else {
      // Just drop it - haulers will pick it up
      creep.drop(RESOURCE_ENERGY);
    }
  }
}

function findUnassignedRemoteSource(room: Room, homeRoom: string): Source | null {
  const sources = room.find(FIND_SOURCES);

  // Check which sources already have miners assigned
  const assignedSources = new Set<string>();
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (
      c.memory.role === "REMOTE_MINER" &&
      c.memory.room === homeRoom &&
      c.memory.sourceId
    ) {
      assignedSources.add(c.memory.sourceId);
    }
  }

  // Find first unassigned source
  for (const source of sources) {
    if (!assignedSources.has(source.id)) {
      return source;
    }
  }

  // All assigned - return one with fewest miners
  if (sources.length > 0) {
    const sourceCounts = new Map<string, number>();
    for (const source of sources) {
      sourceCounts.set(source.id, 0);
    }
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (
        c.memory.role === "REMOTE_MINER" &&
        c.memory.room === homeRoom &&
        c.memory.sourceId
      ) {
        const count = sourceCounts.get(c.memory.sourceId) || 0;
        sourceCounts.set(c.memory.sourceId, count + 1);
      }
    }

    let minSource = sources[0];
    let minCount = Infinity;
    for (const source of sources) {
      const count = sourceCounts.get(source.id) || 0;
      if (count < minCount) {
        minCount = count;
        minSource = source;
      }
    }
    return minSource;
  }

  return null;
}
