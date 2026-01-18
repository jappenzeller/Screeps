/**
 * AWSExporter: Writes colony data to a memory segment for AWS Lambda to read.
 * Uses segment 90 (reserved for external monitoring)
 */

import { ColonyManager } from "../core/ColonyManager";

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
  // New fields
  defense: DefenseExport;
  adjacentRooms: AdjacentRoomExport[];
  remoteMining: RemoteMiningExport;
  scouting: ScoutingExport;
}

interface DefenseExport {
  towerCount: number;
  towerEnergyTotal: number;
  towerEnergyCapacity: number;
  safeModeAvailable: number;
  safeModeCooldown: number;
  safeModeActive: number;
}

interface AdjacentRoomExport {
  roomName: string;
  direction: string;
  sources: number;
  owner: string | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;
  hostiles: number;
  hasKeepers: boolean;
  hasInvaderCore: boolean;
  lastScan: number;
  lastScanAge: number;
  isValidRemoteTarget: boolean;
}

interface RemoteMiningExport {
  targetRooms: RemoteRoomExport[];
  totalMiners: number;
  totalHaulers: number;
  totalReservers: number;
}

interface RemoteRoomExport {
  roomName: string;
  status: "ACTIVE" | "NO_MINERS" | "HOSTILE" | "NO_INTEL" | "RESERVED_OTHER" | "OWNED";
  sources: number;
  miners: RemoteCreepExport[];
  haulers: RemoteCreepExport[];
  reserver: RemoteCreepExport | null;
  reservation: {
    username: string;
    ticksToEnd: number;
  } | null;
}

interface RemoteCreepExport {
  name: string;
  sourceId?: string;
  ttl: number;
  room: string;
}

interface ScoutingExport {
  scouts: ScoutCreepExport[];
  roomsNeedingScan: string[];
}

interface ScoutCreepExport {
  name: string;
  room: string;
  targetRoom: string | null;
  state: string;
  ttl: number;
  pos: { x: number; y: number };
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
        defense: this.getDefenseStatus(room),
        adjacentRooms: this.getAdjacentRoomIntel(roomName),
        remoteMining: this.getRemoteMiningStatus(roomName),
        scouting: this.getScoutingStatus(roomName),
      });
    }

    return colonies;
  }

  /**
   * Get defense status for a room
   */
  private static getDefenseStatus(room: Room): DefenseExport {
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_TOWER },
    }) as StructureTower[];

    const towerEnergyTotal = towers.reduce((sum, t) => sum + t.store[RESOURCE_ENERGY], 0);
    const towerEnergyCapacity = towers.length * TOWER_CAPACITY;

    const controller = room.controller;

    return {
      towerCount: towers.length,
      towerEnergyTotal,
      towerEnergyCapacity,
      safeModeAvailable: controller?.safeModeAvailable || 0,
      safeModeCooldown: controller?.safeModeCooldown || 0,
      safeModeActive: controller?.safeMode || 0,
    };
  }

  /**
   * Get intel for all adjacent rooms
   */
  private static getAdjacentRoomIntel(homeRoom: string): AdjacentRoomExport[] {
    const adjacent: AdjacentRoomExport[] = [];
    const exits = Game.map.describeExits(homeRoom);

    if (!exits) return adjacent;

    // Get our username
    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;
    const colonyManager = ColonyManager.getInstance(homeRoom);
    const validRemoteTargets = new Set(colonyManager.getRemoteMiningTargets());

    const directionNames: Record<string, string> = {
      "1": "TOP",
      "3": "RIGHT",
      "5": "BOTTOM",
      "7": "LEFT",
    };

    for (const dir in exits) {
      const roomName = exits[dir as ExitKey];
      if (!roomName) continue;

      const intel = Memory.rooms?.[roomName];
      const lastScan = intel?.lastScan || 0;
      const lastScanAge = Game.time - lastScan;

      // Check ownership
      const owner = intel?.controller?.owner || null;
      const reservation = intel?.controller?.reservation || null;

      // Determine if valid remote target using same logic as ColonyManager
      const isValidRemoteTarget = validRemoteTargets.has(roomName);

      adjacent.push({
        roomName,
        direction: directionNames[dir] || dir,
        sources: intel?.sources?.length || 0,
        owner,
        reservation,
        hostiles: intel?.hostiles || 0,
        hasKeepers: intel?.hasKeepers || false,
        hasInvaderCore: intel?.hasInvaderCore || false,
        lastScan,
        lastScanAge,
        isValidRemoteTarget,
      });
    }

    return adjacent;
  }

  /**
   * Get remote mining status for all target rooms
   */
  private static getRemoteMiningStatus(homeRoom: string): RemoteMiningExport {
    const colonyManager = ColonyManager.getInstance(homeRoom);
    const targetRoomNames = colonyManager.getRemoteMiningTargets();

    // Also include rooms with active miners that aren't in the target list
    const allRemoteCreeps = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.room === homeRoom &&
        (c.memory.role === "REMOTE_MINER" ||
          c.memory.role === "REMOTE_HAULER" ||
          c.memory.role === "RESERVER")
    );

    // Find all remote rooms with creeps
    const roomsWithCreeps = new Set<string>();
    for (const creep of allRemoteCreeps) {
      if (creep.memory.targetRoom) {
        roomsWithCreeps.add(creep.memory.targetRoom);
      }
    }

    // Combine both lists
    const allRemoteRooms = new Set([...targetRoomNames, ...roomsWithCreeps]);

    const myUsername = Object.values(Game.spawns)[0]?.owner?.username;

    const targetRooms: RemoteRoomExport[] = [];
    let totalMiners = 0;
    let totalHaulers = 0;
    let totalReservers = 0;

    for (const roomName of allRemoteRooms) {
      const intel = Memory.rooms?.[roomName];

      // Get creeps assigned to this remote room
      const miners = allRemoteCreeps
        .filter((c) => c.memory.role === "REMOTE_MINER" && c.memory.targetRoom === roomName)
        .map((c) => ({
          name: c.name,
          sourceId: c.memory.sourceId,
          ttl: c.ticksToLive || 0,
          room: c.room?.name || "unknown",
        }));

      const haulers = allRemoteCreeps
        .filter((c) => c.memory.role === "REMOTE_HAULER" && c.memory.targetRoom === roomName)
        .map((c) => ({
          name: c.name,
          ttl: c.ticksToLive || 0,
          room: c.room?.name || "unknown",
        }));

      const reserverCreep = allRemoteCreeps.find(
        (c) => c.memory.role === "RESERVER" && c.memory.targetRoom === roomName
      );
      const reserver = reserverCreep
        ? {
            name: reserverCreep.name,
            ttl: reserverCreep.ticksToLive || 0,
            room: reserverCreep.room?.name || "unknown",
          }
        : null;

      // Determine status
      let status: RemoteRoomExport["status"] = "ACTIVE";

      if (!intel || !intel.lastScan) {
        status = "NO_INTEL";
      } else if (intel.controller?.owner && intel.controller.owner !== myUsername) {
        status = "OWNED";
      } else if (
        intel.controller?.reservation &&
        intel.controller.reservation.username !== myUsername
      ) {
        status = "RESERVED_OTHER";
      } else if ((intel.hostiles || 0) > 0) {
        status = "HOSTILE";
      } else if (miners.length === 0) {
        status = "NO_MINERS";
      }

      totalMiners += miners.length;
      totalHaulers += haulers.length;
      if (reserver) totalReservers++;

      targetRooms.push({
        roomName,
        status,
        sources: intel?.sources?.length || 0,
        miners,
        haulers,
        reserver,
        reservation: intel?.controller?.reservation || null,
      });
    }

    return {
      targetRooms,
      totalMiners,
      totalHaulers,
      totalReservers,
    };
  }

  /**
   * Get scouting status
   */
  private static getScoutingStatus(homeRoom: string): ScoutingExport {
    // Get scout creeps for this home room
    const scouts = Object.values(Game.creeps)
      .filter((c) => c.memory.room === homeRoom && c.memory.role === "SCOUT")
      .map((c) => ({
        name: c.name,
        room: c.room?.name || "unknown",
        targetRoom: c.memory.targetRoom || null,
        state: c.memory.state || "SCOUTING",
        ttl: c.ticksToLive || 0,
        pos: { x: c.pos.x, y: c.pos.y },
      }));

    // Find rooms needing scan (adjacent rooms with stale intel)
    const roomsNeedingScan: string[] = [];
    const exits = Game.map.describeExits(homeRoom);

    if (exits) {
      for (const dir in exits) {
        const roomName = exits[dir as ExitKey];
        if (!roomName) continue;

        const intel = Memory.rooms?.[roomName];
        const lastScan = intel?.lastScan || 0;

        // Room needs scan if never scanned or > 2000 ticks stale
        if (Game.time - lastScan > 2000) {
          roomsNeedingScan.push(roomName);
        }
      }
    }

    return {
      scouts,
      roomsNeedingScan,
    };
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
