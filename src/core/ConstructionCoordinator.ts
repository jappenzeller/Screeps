import { logger } from "../utils/Logger";

/**
 * ConstructionCoordinator - Centralized construction priority management
 * Ensures critical structures (containers, extensions) are built before roads
 */

interface ConstructionPriority {
  structureType: BuildableStructureConstant;
  priority: number; // lower = build first
  minRCL: number;
  maxConcurrentSites: number;
}

const CONSTRUCTION_PRIORITIES: ConstructionPriority[] = [
  { structureType: STRUCTURE_SPAWN, priority: 0, minRCL: 1, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_CONTAINER, priority: 1, minRCL: 1, maxConcurrentSites: 3 },
  { structureType: STRUCTURE_EXTENSION, priority: 2, minRCL: 2, maxConcurrentSites: 5 },
  { structureType: STRUCTURE_TOWER, priority: 3, minRCL: 3, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_STORAGE, priority: 4, minRCL: 4, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_LINK, priority: 4, minRCL: 5, maxConcurrentSites: 2 },
  { structureType: STRUCTURE_ROAD, priority: 5, minRCL: 2, maxConcurrentSites: 5 },
  { structureType: STRUCTURE_TERMINAL, priority: 5, minRCL: 6, maxConcurrentSites: 1 },
  { structureType: STRUCTURE_LAB, priority: 6, minRCL: 6, maxConcurrentSites: 3 },
  { structureType: STRUCTURE_WALL, priority: 7, minRCL: 2, maxConcurrentSites: 5 },
  { structureType: STRUCTURE_RAMPART, priority: 7, minRCL: 2, maxConcurrentSites: 5 },
];

export class ConstructionCoordinator {
  constructor(private room: Room) {}

  /**
   * Check if a structure type is allowed to place new construction sites
   */
  canPlaceSites(structureType: BuildableStructureConstant): boolean {
    const controller = this.room.controller;
    if (!controller || !controller.my) return false;

    const priority = CONSTRUCTION_PRIORITIES.find((p) => p.structureType === structureType);
    if (!priority) return false;

    // Check RCL requirement
    if (controller.level < priority.minRCL) return false;

    // Check if higher priority structures are incomplete
    for (const higherPriority of CONSTRUCTION_PRIORITIES) {
      if (higherPriority.priority >= priority.priority) break;
      if (controller.level < higherPriority.minRCL) continue;

      if (!this.isStructureTypeComplete(higherPriority.structureType)) {
        return false; // Higher priority not done yet
      }
    }

    // Check concurrent site limit for this structure type
    const currentSites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === structureType,
    }).length;

    return currentSites < priority.maxConcurrentSites;
  }

  /**
   * Check if a structure type has reached its max count (built + under construction)
   */
  private isStructureTypeComplete(structureType: BuildableStructureConstant): boolean {
    const controller = this.room.controller;
    if (!controller) return true;

    // Special case: containers don't have CONTROLLER_STRUCTURES limit
    // Consider complete when we have containers at sources
    if (structureType === STRUCTURE_CONTAINER) {
      return this.areContainersComplete();
    }

    const existing = this.room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === structureType,
    }).length;

    const sites = this.room.find(FIND_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === structureType,
    }).length;

    const max = CONTROLLER_STRUCTURES[structureType][controller.level] ?? 0;

    return existing + sites >= max;
  }

  /**
   * Check if containers are placed at all sources
   */
  private areContainersComplete(): boolean {
    const sources = this.room.find(FIND_SOURCES);
    for (const source of sources) {
      const hasContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }).length > 0;

      const hasSite = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      }).length > 0;

      if (!hasContainer && !hasSite) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get construction status for debugging
   */
  getStatus(): string {
    const status: string[] = [];
    const controller = this.room.controller;
    if (!controller) return "No controller";

    for (const priority of CONSTRUCTION_PRIORITIES) {
      if (controller.level < priority.minRCL) continue;

      const existing = this.room.find(FIND_MY_STRUCTURES, {
        filter: (s) => s.structureType === priority.structureType,
      }).length;

      const sites = this.room.find(FIND_CONSTRUCTION_SITES, {
        filter: (s) => s.structureType === priority.structureType,
      }).length;

      let max: number;
      if (priority.structureType === STRUCTURE_CONTAINER) {
        max = this.room.find(FIND_SOURCES).length + 1; // sources + controller
      } else {
        max = CONTROLLER_STRUCTURES[priority.structureType][controller.level] ?? 0;
      }

      if (max > 0) {
        const complete = this.isStructureTypeComplete(priority.structureType);
        status.push(`${priority.structureType}: ${existing}/${max} (sites: ${sites}) ${complete ? "✓" : ""}`);
      }
    }

    return status.join("\n");
  }
}
