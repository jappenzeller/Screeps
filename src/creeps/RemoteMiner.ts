import { logger } from "../utils/Logger";
import { moveToRoom, smartMoveTo } from "../utils/movement";
import { updateRoomIntel, shouldFlee, fleeToSafety } from "../utils/remoteIntel";

/**
 * RemoteMiner - Harvests sources in adjacent rooms
 * Also builds container at source if one doesn't exist
 * Drops energy for RemoteHaulers to collect
 */
export function runRemoteMiner(creep: Creep): void {
  const targetRoom = creep.memory.targetRoom;
  const sourceId = creep.memory.sourceId;

  // Need a target room assigned
  if (!targetRoom) {
    logger.warn("RemoteMiner", `${creep.name} has no target room assigned`);
    return;
  }

  // Check if still fleeing (must check before moving to target room)
  if (shouldFlee(creep)) {
    fleeToSafety(creep);
    return;
  }

  // Move to target room if not there
  if (creep.room.name !== targetRoom) {
    moveToRoom(creep, targetRoom, "#ffaa00");
    return;
  }

  // Update room intel whenever we have vision (critical for defense spawning)
  updateRoomIntel(creep);

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

  // Check container status at source
  const containerStatus = getContainerStatus(source);

  // Priority 1: Build container if site exists
  if (containerStatus.site) {
    // Need energy to build
    if (creep.store[RESOURCE_ENERGY] === 0) {
      // Harvest just enough to build
      const result = creep.harvest(source);
      if (result === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Build the container
    const result = creep.build(containerStatus.site);
    if (result === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, containerStatus.site, { visualizePathStyle: { stroke: "#00ff00" } });
    } else if (result === OK) {
      creep.say("🔨");
    }
    return;
  }

  // Priority 2: Place container construction site if none exists
  if (!containerStatus.container && !containerStatus.site) {
    const placed = placeContainerSite(creep.room, source);
    if (placed) {
      creep.say("📍");
      logger.info("RemoteMiner", `${creep.name} placed container site at source ${source.id}`);
    }
    // Continue to harvest while site is being placed
  }

  // Priority 3: Normal harvesting behavior
  harvestSource(creep, source, containerStatus.container);
}

interface ContainerStatus {
  container: StructureContainer | null;
  site: ConstructionSite | null;
}

function getContainerStatus(source: Source): ContainerStatus {
  const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  })[0] as StructureContainer | undefined;

  const site = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  })[0] as ConstructionSite | undefined;

  return {
    container: container || null,
    site: site || null,
  };
}

function placeContainerSite(room: Room, source: Source): boolean {
  const terrain = room.getTerrain();

  // Find best position adjacent to source
  // Prefer plain over swamp, and positions not blocked
  const candidates: { x: number; y: number; cost: number }[] = [];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;

      const x = source.pos.x + dx;
      const y = source.pos.y + dy;

      // Bounds check
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;

      // Terrain check
      const terrainType = terrain.get(x, y);
      if (terrainType === TERRAIN_MASK_WALL) continue;

      // Check for existing structures (except roads)
      const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
      const hasBlockingStructure = structures.some(
        (s) => s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_RAMPART
      );
      if (hasBlockingStructure) continue;

      // Check for existing construction sites
      const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
      if (sites.length > 0) continue;

      // Calculate cost (prefer plains)
      const cost = terrainType === TERRAIN_MASK_SWAMP ? 2 : 1;
      candidates.push({ x, y, cost });
    }
  }

  if (candidates.length === 0) {
    logger.warn("RemoteMiner", `No valid container position for source at ${source.pos}`);
    return false;
  }

  // Sort by cost (lowest first)
  candidates.sort((a, b) => a.cost - b.cost);
  const best = candidates[0];

  const result = room.createConstructionSite(best.x, best.y, STRUCTURE_CONTAINER);
  return result === OK;
}

function harvestSource(
  creep: Creep,
  source: Source,
  container: StructureContainer | null
): void {
  // If container exists, try to stand on it
  if (container) {
    if (!creep.pos.isEqualTo(container.pos)) {
      smartMoveTo(creep, container, { visualizePathStyle: { stroke: "#ffaa00" } });
      // Still try to harvest while moving
      creep.harvest(source);
      return;
    }
  }

  // Harvest the source
  const result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#ffaa00" } });
    return;
  }

  // Handle full inventory
  if (creep.store.getFreeCapacity() === 0) {
    if (container && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      creep.transfer(container, RESOURCE_ENERGY);
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
    const creep = Game.creeps[name];
    if (
      creep.memory.role === "REMOTE_MINER" &&
      creep.memory.room === homeRoom &&
      creep.memory.sourceId
    ) {
      assignedSources.add(creep.memory.sourceId);
    }
  }

  // Find first unassigned source
  for (const source of sources) {
    if (!assignedSources.has(source.id)) {
      return source;
    }
  }

  // All sources have miners - return first source (replacement scenario)
  return sources.length > 0 ? sources[0] : null;
}
