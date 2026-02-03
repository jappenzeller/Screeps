import { CONFIG } from "../config";
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
    hostiles?: number;
    lastScan?: number;
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

  static cleanup(): void {
    // Clean up dead creeps every 10 ticks (cheap, prevents accumulation)
    if (Game.time % 10 === 0) {
      for (const name in Memory.creeps) {
        if (!Game.creeps[name]) {
          delete Memory.creeps[name];
        }
      }
    }

    // Clean up stale room data less frequently (more expensive)
    if (Game.time % CONFIG.MEMORY_CLEANUP_INTERVAL !== 0) return;

    logger.debug("MemoryManager", "Running full memory cleanup");

    // NOTE: Memory.rooms cleanup for non-owned rooms has been removed.
    // Intel data now lives in Memory.intel (managed by gatherRoomIntel).
    // Memory.rooms is only used for owned room data (assignments, sourceContainers, etc.)

    // Clean up colony data for rooms we no longer own
    if (Memory.colonies) {
      for (var colonyRoom in Memory.colonies) {
        var room = Game.rooms[colonyRoom];
        // Only delete if we have visibility AND it's no longer ours
        // (if no visibility, we can't confirm we lost it)
        if (room && room.controller && !room.controller.my) {
          logger.warn("MemoryManager", "Removing colony data for lost room: " + colonyRoom);
          delete Memory.colonies[colonyRoom];
        }
      }
    }
  }

  static recordStats(): void {
    // Stats recording is now handled by StatsCollector
    // This method is kept for backwards compatibility but does nothing
  }
}
