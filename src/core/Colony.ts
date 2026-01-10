import { logger } from "../utils/Logger";
import { CONFIG, Role } from "../config";

export interface ColonyState {
  room: Room;
  spawn: StructureSpawn | null;
  sources: Source[];
  creeps: Creep[];
  creepsByRole: Record<string, Creep[]>;
  hostiles: Creep[];
  constructionSites: ConstructionSite[];
  energyAvailable: number;
  energyCapacity: number;
}

export class Colony {
  private state: ColonyState | null = null;

  constructor(public readonly roomName: string) {}

  get room(): Room | undefined {
    return Game.rooms[this.roomName];
  }

  scan(): ColonyState | null {
    const room = this.room;
    if (!room) {
      logger.warn("Colony", `Cannot scan room ${this.roomName} - no visibility`);
      return null;
    }

    // Find spawn
    const spawns = room.find(FIND_MY_SPAWNS);
    const spawn = spawns.length > 0 ? spawns[0] : null;

    // Find sources
    const sources = room.find(FIND_SOURCES);

    // Initialize room memory if needed
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[this.roomName]) {
      Memory.rooms[this.roomName] = {};
    }

    // Cache source IDs
    if (!Memory.rooms[this.roomName].sources) {
      Memory.rooms[this.roomName].sources = sources.map((s) => s.id);
    }

    // Find our creeps in this room
    const creeps = Object.values(Game.creeps).filter((c) => c.memory.room === this.roomName);

    // Group creeps by role
    const creepsByRole: Record<string, Creep[]> = {};
    for (const creep of creeps) {
      const role = creep.memory.role;
      if (!creepsByRole[role]) creepsByRole[role] = [];
      creepsByRole[role].push(creep);
    }

    // Find hostiles
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    Memory.rooms[this.roomName].hostiles = hostiles.length;
    Memory.rooms[this.roomName].lastScan = Game.time;

    // Find construction sites
    const constructionSites = room.find(FIND_CONSTRUCTION_SITES);

    this.state = {
      room,
      spawn,
      sources,
      creeps,
      creepsByRole,
      hostiles,
      constructionSites,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
    };

    return this.state;
  }

  getState(): ColonyState | null {
    return this.state;
  }

  getCreepCount(role: string): number {
    return this.state?.creepsByRole[role]?.length ?? 0;
  }

  needsCreep(role: Role): boolean {
    const count = this.getCreepCount(role);
    const min = CONFIG.MIN_CREEPS[role as keyof typeof CONFIG.MIN_CREEPS] ?? 0;

    // Harvesters: always need them (they harvest AND deliver)
    if (role === "HARVESTER") return count < min;

    // Upgraders: need them once we have harvesters bringing energy
    if (role === "UPGRADER") {
      return count < min && this.getCreepCount("HARVESTER") > 0;
    }

    // Builders: only when construction sites exist
    if (role === "BUILDER") {
      const hasSites = (this.state?.constructionSites?.length ?? 0) > 0;
      return count < min && hasSites;
    }

    // Haulers: only needed later when we have containers
    if (role === "HAULER") {
      if (!this.state?.room) return false;
      const containers = this.state.room.find(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER,
      });
      return count < min && containers.length > 0;
    }

    return count < min;
  }

  drawVisuals(): void {
    if (!CONFIG.VISUALS.ENABLED || !this.state) return;

    const room = this.state.room;

    // Draw creep roles
    if (CONFIG.VISUALS.SHOW_ROLES) {
      for (const creep of this.state.creeps) {
        room.visual.text(creep.memory.role.charAt(0), creep.pos.x, creep.pos.y - 0.5, {
          font: 0.4,
          opacity: 0.7,
        });
      }
    }

    // Draw source assignments
    for (const source of this.state.sources) {
      const assignedHarvesters = this.state.creeps.filter(
        (c) => c.memory.role === "HARVESTER" && c.memory.sourceId === source.id
      );
      room.visual.text(`${assignedHarvesters.length}`, source.pos.x, source.pos.y - 0.5, {
        font: 0.5,
        color: "#ffff00",
      });
    }
  }
}
