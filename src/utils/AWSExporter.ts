/**
 * AWSExporter: Writes colony data to a memory segment for AWS Lambda to read.
 * Uses segment 90 (reserved for external monitoring)
 */

const AWS_SEGMENT = 90;

interface AWSExportData {
  timestamp: number;
  gameTick: number;
  shard: string;
  colonies: ColonyExport[];
  global: GlobalExport;
}

interface ColonyExport {
  roomName: string;
  rcl: number;
  rclProgress: number;
  rclProgressTotal: number;
  energy: {
    available: number;
    capacity: number;
    stored: number;
  };
  creeps: {
    total: number;
    byRole: Record<string, number>;
  };
  threats: {
    hostileCount: number;
    hostileDPS: number;
  };
  structures: {
    constructionSites: number;
    damagedCount: number;
  };
}

interface GlobalExport {
  cpu: {
    used: number;
    bucket: number;
    limit: number;
  };
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  credits: number;
  totalCreeps: number;
}

export class AWSExporter {
  /**
   * Export colony data to memory segment for AWS Lambda
   * Call this every 100 ticks or so
   */
  static export(): void {
    // Request segment for next tick
    RawMemory.setActiveSegments([AWS_SEGMENT]);

    const data: AWSExportData = {
      timestamp: Date.now(),
      gameTick: Game.time,
      shard: Game.shard?.name || "unknown",
      colonies: this.getColonies(),
      global: this.getGlobalStats(),
    };

    // Write to segment
    RawMemory.segments[AWS_SEGMENT] = JSON.stringify(data);
  }

  private static getColonies(): ColonyExport[] {
    const colonies: ColonyExport[] = [];

    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller?.my) continue;

      // Get creeps for this room
      const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === roomName);
      const byRole: Record<string, number> = {};
      for (const creep of creeps) {
        const role = creep.memory.role || "UNKNOWN";
        byRole[role] = (byRole[role] || 0) + 1;
      }

      // Get hostiles
      const hostiles = room.find(FIND_HOSTILE_CREEPS);
      const hostileDPS = hostiles.reduce((sum, h) => {
        const attack = h.body.filter((p) => p.type === ATTACK && p.hits > 0).length * 30;
        const ranged = h.body.filter((p) => p.type === RANGED_ATTACK && p.hits > 0).length * 10;
        return sum + attack + ranged;
      }, 0);

      // Get damaged structures
      const structures = room.find(FIND_STRUCTURES);
      const damagedCount = structures.filter((s) => {
        if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
          return s.hits < 10000;
        }
        return s.hits < s.hitsMax * 0.75;
      }).length;

      // Get storage energy
      const storageEnergy = room.storage?.store[RESOURCE_ENERGY] || 0;
      const containers = room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER },
      }) as StructureContainer[];
      const containerEnergy = containers.reduce((sum, c) => sum + c.store[RESOURCE_ENERGY], 0);

      colonies.push({
        roomName,
        rcl: room.controller.level,
        rclProgress: room.controller.progress,
        rclProgressTotal: room.controller.progressTotal,
        energy: {
          available: room.energyAvailable,
          capacity: room.energyCapacityAvailable,
          stored: storageEnergy + containerEnergy,
        },
        creeps: {
          total: creeps.length,
          byRole,
        },
        threats: {
          hostileCount: hostiles.length,
          hostileDPS,
        },
        structures: {
          constructionSites: room.find(FIND_CONSTRUCTION_SITES).length,
          damagedCount,
        },
      });
    }

    return colonies;
  }

  private static getGlobalStats(): GlobalExport {
    return {
      cpu: {
        used: Game.cpu.getUsed(),
        bucket: Game.cpu.bucket,
        limit: Game.cpu.limit,
      },
      gcl: {
        level: Game.gcl.level,
        progress: Game.gcl.progress,
        progressTotal: Game.gcl.progressTotal,
      },
      credits: Game.market?.credits || 0,
      totalCreeps: Object.keys(Game.creeps).length,
    };
  }

  /**
   * Read the current export data (for debugging)
   */
  static read(): AWSExportData | null {
    const raw = RawMemory.segments[AWS_SEGMENT];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AWSExportData;
    } catch {
      return null;
    }
  }
}
