import { CONFIG } from "../config";
import { logger } from "../utils/Logger";

declare global {
  interface Memory {
    initialized?: boolean;
    stats?: {
      gcl: number;
      gclLevel: number;
      cpu: number;
      bucket: number;
      tick: number;
    };
    // Note: 'rooms' is already declared in @types/screeps
  }

  interface CreepMemory {
    role: string;
    room: string;
    working?: boolean;
    targetId?: Id<AnyStructure | Source | ConstructionSite | Resource>;
    sourceId?: Id<Source>;
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
    // Only run cleanup periodically
    if (Game.time % CONFIG.MEMORY_CLEANUP_INTERVAL !== 0) return;

    logger.debug("MemoryManager", "Running memory cleanup");

    // Clean up dead creeps
    for (const name in Memory.creeps) {
      if (!Game.creeps[name]) {
        logger.debug("MemoryManager", `Clearing memory for dead creep: ${name}`);
        delete Memory.creeps[name];
      }
    }

    // Clean up rooms we no longer own
    if (Memory.rooms) {
      for (const roomName in Memory.rooms) {
        const room = Game.rooms[roomName];
        if (!room || !room.controller?.my) {
          // Keep intel on rooms for scouting, but clear old data
          const roomMem = Memory.rooms[roomName];
          if (roomMem.lastScan && Game.time - roomMem.lastScan > 5000) {
            logger.debug("MemoryManager", `Clearing stale room data: ${roomName}`);
            delete Memory.rooms[roomName];
          }
        }
      }
    }
  }

  static recordStats(): void {
    Memory.stats = {
      gcl: Game.gcl.progress,
      gclLevel: Game.gcl.level,
      cpu: Game.cpu.getUsed(),
      bucket: Game.cpu.bucket,
      tick: Game.time,
    };
  }
}
