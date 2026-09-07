import { logger } from "../utils/Logger";

declare global {
  interface Memory {
    initialized?: boolean;
    // Note: stats is now defined in StatsCollector.ts
    // Note: 'rooms' is already declared in @types/screeps
  }

  interface CreepMemory {
    role: string;
    room: string;
    working?: boolean;
    targetId?: Id<AnyStructure | Source | ConstructionSite | Resource>;
    sourceId?: Id<Source>;
    _renewWaitStart?: number;
  }

  // Extend the built-in RoomMemory interface
  interface RoomMemory {
    sources?: Id<Source>[];
    sourceContainers?: Record<Id<Source>, Id<StructureContainer>>;
  }
}

export class MemoryManager {
  static init(): void {
    if (!Memory.initialized) {
      logger.info("MemoryManager", "Initializing memory structure");
      Memory.initialized = true;
      Memory.rooms = {};
    }
  }

  /**
   * Removed. This was a second, never-called creep-and-colony cleanup sitting alongside
   * the live one in main.ts's cleanupMemory(). Nothing referenced it, so everything
   * written here silently never ran - including the stale-colony purge (Memory.colonies
   * grew four entries for rooms lost millions of ticks earlier) and, later, the scout
   * mortality hook that was added to it in good faith.
   *
   * Dead code that mirrors a live path is worse than no code: it reads as the place to
   * make the change. Both behaviours now live in main.ts's cleanupMemory().
   */

  static recordStats(): void {
    // Stats recording is now handled by StatsCollector
    // This method is kept for backwards compatibility but does nothing
  }
}
