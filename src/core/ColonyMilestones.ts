/**
 * ColonyMilestones - Infrastructure-based colony state detection
 * Used by spawning, construction, and hauler logic to make milestone-aware decisions.
 * This replaces RCL-based gating for early colony progression.
 */

export interface Milestones {
  hasSpawn: boolean;
  hasSourceContainers: boolean; // At least 1 source has a BUILT container
  allSourceContainers: boolean; // All sources have built containers
  hasHauler: boolean;
  hasControllerContainer: boolean; // Built container within 3 tiles of controller
  hasExtensions: boolean;
  allExtensions: boolean; // All extensions for current RCL built
  hasTower: boolean;
  hasStorage: boolean;
}

// Cache per tick
let cache: { tick: number; data: Map<string, Milestones> } = {
  tick: -1,
  data: new Map(),
};

export function getMilestones(room: Room): Milestones {
  if (cache.tick !== Game.time) {
    cache = { tick: Game.time, data: new Map() };
  }
  const cached = cache.data.get(room.name);
  if (cached) return cached;

  const sources = room.find(FIND_SOURCES);
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  }) as StructureContainer[];
  const controller = room.controller;
  const rcl = controller?.level || 0;

  const sourceContainerCount = sources.filter(
    (source) => source.pos.findInRange(containers, 1).length > 0
  ).length;

  const controllerContainers = controller
    ? controller.pos.findInRange(containers, 3).length
    : 0;

  const extensionCount = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION,
  }).length;
  const maxExtensions = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][rcl] || 0;

  const result: Milestones = {
    hasSpawn: room.find(FIND_MY_SPAWNS).length > 0,
    hasSourceContainers: sourceContainerCount > 0,
    allSourceContainers: sourceContainerCount >= sources.length,
    hasHauler: Object.values(Game.creeps).some(
      (c) => c.memory.role === "HAULER" && c.memory.room === room.name
    ),
    hasControllerContainer: controllerContainers > 0,
    hasExtensions: extensionCount > 0,
    allExtensions: maxExtensions > 0 ? extensionCount >= maxExtensions : true,
    hasTower:
      room.find(FIND_MY_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_TOWER,
      }).length > 0,
    hasStorage: !!room.storage,
  };

  cache.data.set(room.name, result);
  return result;
}

/**
 * Get human-readable milestone phase name for logging
 */
export function getMilestonePhase(m: Milestones): string {
  if (!m.hasSpawn) return "NO_SPAWN";
  if (!m.hasSourceContainers) return "BARE_SPAWN";
  if (!m.hasControllerContainer) return "CONTAINERS_BUILDING";
  if (!m.allExtensions) return "ECONOMY_ONLINE";
  return "INFRASTRUCTURE_COMPLETE";
}
