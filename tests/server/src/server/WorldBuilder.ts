/**
 * WorldBuilder - Fluent API for constructing test scenarios
 *
 * Provides a clean interface for setting up rooms with:
 * - Terrain (walls, swamps)
 * - Room objects (sources, controllers, minerals)
 * - Structures (spawns, extensions, storage, towers, etc.)
 * - Creeps
 */

import { ServerController, TerrainMatrix } from "./ServerController";
import {
  SourceConfig,
  MineralConfig,
  StructurePlacement,
  StaticCreepConfig,
  Position,
} from "../types";
import {
  BodyPartType,
  StructureType,
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_ROAD,
  STRUCTURE_WALL,
  STRUCTURE_RAMPART,
  STRUCTURE_LINK,
  STRUCTURE_STORAGE,
  STRUCTURE_TOWER,
  STRUCTURE_OBSERVER,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_LAB,
  STRUCTURE_TERMINAL,
  STRUCTURE_CONTAINER,
  STRUCTURE_NUKER,
  STRUCTURE_FACTORY,
  SOURCE_ENERGY_CAPACITY,
} from "../constants";

/**
 * Builder for constructing individual rooms
 */
export class RoomBuilder {
  private roomName: string;
  private server: ServerController;
  private terrainMatrix: TerrainMatrix | null = null;
  private controllerConfig: { x: number; y: number; level?: number; user?: string } | null = null;
  private sources: SourceConfig[] = [];
  private mineral: MineralConfig | null = null;
  private structures: StructurePlacement[] = [];
  private creeps: StaticCreepConfig[] = [];
  private walls: Position[] = [];
  private swamps: Position[] = [];

  constructor(roomName: string, server: ServerController) {
    this.roomName = roomName;
    this.server = server;
  }

  // ============================================
  // Terrain
  // ============================================

  /**
   * Set a specific position as a wall
   */
  addWall(x: number, y: number): this {
    this.walls.push({ x, y });
    return this;
  }

  /**
   * Set a specific position as a swamp
   */
  addSwamp(x: number, y: number): this {
    this.swamps.push({ x, y });
    return this;
  }

  /**
   * Add a rectangular wall area
   */
  addWallRect(x1: number, y1: number, x2: number, y2: number): this {
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        this.walls.push({ x, y });
      }
    }
    return this;
  }

  /**
   * Add walls around the room borders (natural walls)
   */
  addBorderWalls(): this {
    for (let i = 0; i < 50; i++) {
      this.walls.push({ x: 0, y: i });
      this.walls.push({ x: 49, y: i });
      this.walls.push({ x: i, y: 0 });
      this.walls.push({ x: i, y: 49 });
    }
    return this;
  }

  // ============================================
  // Room Objects
  // ============================================

  /**
   * Add a controller to the room
   */
  addController(x: number, y: number, level = 0, user?: string): this {
    this.controllerConfig = { x, y, level, user };
    return this;
  }

  /**
   * Add a source to the room
   */
  addSource(x: number, y: number, energy: number = SOURCE_ENERGY_CAPACITY): this {
    this.sources.push({ x, y, energy });
    return this;
  }

  /**
   * Add a mineral to the room
   */
  addMineral(x: number, y: number, mineralType: string, density = 3): this {
    this.mineral = { x, y, mineralType, density };
    return this;
  }

  // ============================================
  // Structures
  // ============================================

  /**
   * Add a spawn to the room
   */
  addSpawn(x: number, y: number, owner: string, energy = 300): this {
    this.structures.push({
      type: STRUCTURE_SPAWN,
      x,
      y,
      owner,
      energy,
    });
    return this;
  }

  /**
   * Add an extension to the room
   */
  addExtension(x: number, y: number, owner: string, energy = 0): this {
    this.structures.push({
      type: STRUCTURE_EXTENSION,
      x,
      y,
      owner,
      energy,
    });
    return this;
  }

  /**
   * Add multiple extensions in a cluster
   */
  addExtensionCluster(centerX: number, centerY: number, count: number, owner: string): this {
    const offsets = [
      [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
      [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1],
      [-2, 0], [-1, 0], /* center */ [1, 0], [2, 0],
      [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1],
      [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2],
    ];

    for (let i = 0; i < Math.min(count, offsets.length); i++) {
      const [dx, dy] = offsets[i];
      this.addExtension(centerX + dx, centerY + dy, owner);
    }
    return this;
  }

  /**
   * Add a storage to the room
   */
  addStorage(x: number, y: number, owner: string, energy = 0): this {
    this.structures.push({
      type: STRUCTURE_STORAGE,
      x,
      y,
      owner,
      store: { energy },
    });
    return this;
  }

  /**
   * Add a tower to the room
   */
  addTower(x: number, y: number, owner: string, energy = 0): this {
    this.structures.push({
      type: STRUCTURE_TOWER,
      x,
      y,
      owner,
      energy,
    });
    return this;
  }

  /**
   * Add a container to the room
   */
  addContainer(x: number, y: number, energy = 0): this {
    this.structures.push({
      type: STRUCTURE_CONTAINER,
      x,
      y,
      store: { energy },
    });
    return this;
  }

  /**
   * Add a link to the room
   */
  addLink(x: number, y: number, owner: string, energy = 0): this {
    this.structures.push({
      type: STRUCTURE_LINK,
      x,
      y,
      owner,
      energy,
    });
    return this;
  }

  /**
   * Add a road to the room
   */
  addRoad(x: number, y: number): this {
    this.structures.push({
      type: STRUCTURE_ROAD,
      x,
      y,
    });
    return this;
  }

  /**
   * Add a road path between two points
   */
  addRoadPath(from: Position, to: Position): this {
    // Simple straight-line or L-shaped path
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    // First move horizontally
    const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
    let x = from.x;
    while (x !== to.x) {
      this.addRoad(x, from.y);
      x += stepX;
    }

    // Then move vertically
    const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
    let y = from.y;
    while (y !== to.y) {
      this.addRoad(to.x, y);
      y += stepY;
    }

    // Add the final position
    this.addRoad(to.x, to.y);

    return this;
  }

  /**
   * Add a rampart to the room
   */
  addRampart(x: number, y: number, owner: string, hits = 100000): this {
    this.structures.push({
      type: STRUCTURE_RAMPART,
      x,
      y,
      owner,
      hits,
    });
    return this;
  }

  /**
   * Add a constructed wall to the room
   */
  addWallStructure(x: number, y: number, hits = 100000): this {
    this.structures.push({
      type: STRUCTURE_WALL,
      x,
      y,
      hits,
    });
    return this;
  }

  /**
   * Add a terminal to the room
   */
  addTerminal(x: number, y: number, owner: string, resources?: Record<string, number>): this {
    this.structures.push({
      type: STRUCTURE_TERMINAL,
      x,
      y,
      owner,
      store: resources || {},
    });
    return this;
  }

  /**
   * Add a lab to the room
   */
  addLab(x: number, y: number, owner: string): this {
    this.structures.push({
      type: STRUCTURE_LAB,
      x,
      y,
      owner,
    });
    return this;
  }

  /**
   * Add an extractor to the room
   */
  addExtractor(x: number, y: number, owner: string): this {
    this.structures.push({
      type: STRUCTURE_EXTRACTOR,
      x,
      y,
      owner,
    });
    return this;
  }

  /**
   * Add a factory to the room
   */
  addFactory(x: number, y: number, owner: string): this {
    this.structures.push({
      type: STRUCTURE_FACTORY,
      x,
      y,
      owner,
    });
    return this;
  }

  /**
   * Add an observer to the room
   */
  addObserver(x: number, y: number, owner: string): this {
    this.structures.push({
      type: STRUCTURE_OBSERVER,
      x,
      y,
      owner,
    });
    return this;
  }

  /**
   * Add a power spawn to the room
   */
  addPowerSpawn(x: number, y: number, owner: string): this {
    this.structures.push({
      type: STRUCTURE_POWER_SPAWN,
      x,
      y,
      owner,
    });
    return this;
  }

  /**
   * Add a nuker to the room
   */
  addNuker(x: number, y: number, owner: string): this {
    this.structures.push({
      type: STRUCTURE_NUKER,
      x,
      y,
      owner,
    });
    return this;
  }

  /**
   * Add a generic structure
   */
  addStructure(placement: StructurePlacement): this {
    this.structures.push(placement);
    return this;
  }

  // ============================================
  // Creeps
  // ============================================

  /**
   * Add a creep to the room
   */
  addCreep(
    owner: string,
    body: BodyPartType[],
    x: number,
    y: number,
    memory?: Record<string, unknown>
  ): this {
    this.creeps.push({ body, x, y, owner, memory });
    return this;
  }

  // ============================================
  // Build
  // ============================================

  /**
   * Build the room in the server
   */
  async build(): Promise<void> {
    const world = this.server.getWorld();

    // Add the room
    await world.addRoom(this.roomName);

    // First set default terrain (all plains)
    await world.setTerrain(this.roomName);

    // Now get the terrain to modify it
    const terrain = await world.getTerrain(this.roomName);

    for (const wall of this.walls) {
      terrain.set(wall.x, wall.y, "wall");
    }

    for (const swamp of this.swamps) {
      terrain.set(swamp.x, swamp.y, "swamp");
    }

    // Set modified terrain back
    await world.setTerrain(this.roomName, terrain);

    // Add controller
    if (this.controllerConfig) {
      await world.addRoomObject(
        this.roomName,
        "controller",
        this.controllerConfig.x,
        this.controllerConfig.y,
        {
          level: this.controllerConfig.level || 0,
          user: this.controllerConfig.user,
          progress: 0,
          downgradeTime: this.controllerConfig.level ? 20000 : undefined,
        }
      );
    }

    // Add sources
    for (const source of this.sources) {
      await world.addRoomObject(this.roomName, "source", source.x, source.y, {
        energy: source.energy || SOURCE_ENERGY_CAPACITY,
        energyCapacity: SOURCE_ENERGY_CAPACITY,
        ticksToRegeneration: 300,
      });
    }

    // Add mineral
    if (this.mineral) {
      await world.addRoomObject(this.roomName, "mineral", this.mineral.x, this.mineral.y, {
        mineralType: this.mineral.mineralType,
        density: this.mineral.density || 3,
        mineralAmount: 50000,
      });
    }

    // Add structures
    for (const struct of this.structures) {
      const attrs: Record<string, unknown> = {};

      if (struct.owner) {
        attrs.user = struct.owner;
      }

      if (struct.hits !== undefined) {
        attrs.hits = struct.hits;
        attrs.hitsMax = struct.hits;
      }

      if (struct.energy !== undefined) {
        attrs.store = { energy: struct.energy };
        attrs.storeCapacity = struct.energy;
      }

      if (struct.store) {
        attrs.store = struct.store;
      }

      await world.addRoomObject(this.roomName, struct.type, struct.x, struct.y, attrs);
    }

    // Add creeps
    for (const creep of this.creeps) {
      const bodyParts = creep.body.map((type) => ({
        type,
        hits: 100,
      }));

      await world.addRoomObject(this.roomName, "creep", creep.x, creep.y, {
        user: creep.owner,
        name: `${creep.owner}_creep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        body: bodyParts,
        hits: bodyParts.length * 100,
        hitsMax: bodyParts.length * 100,
        store: { energy: 0 },
        storeCapacity: creep.body.filter((p) => p === "carry").length * 50,
        fatigue: 0,
        memory: creep.memory || {},
        ageTime: 1500,
      });
    }
  }
}

/**
 * Main WorldBuilder class
 */
export class WorldBuilder {
  private server: ServerController;
  private rooms: RoomBuilder[] = [];

  constructor(server: ServerController) {
    this.server = server;
  }

  /**
   * Add a room to build
   */
  addRoom(roomName: string): RoomBuilder {
    const builder = new RoomBuilder(roomName, this.server);
    this.rooms.push(builder);
    return builder;
  }

  /**
   * Create a single room with basic setup
   */
  async createSingleRoom(roomName: string, rcl = 0, owner?: string): Promise<RoomBuilder> {
    const builder = this.addRoom(roomName);

    // Add controller in center area
    builder.addController(25, 25, rcl, owner);

    // Add two sources
    builder.addSource(10, 10);
    builder.addSource(40, 40);

    // Add a mineral
    builder.addMineral(25, 40, "H");

    return builder;
  }

  /**
   * Create the default stub world (9 rooms)
   */
  async createStubWorld(): Promise<void> {
    await this.server.createStubWorld();
  }

  /**
   * Build all configured rooms
   */
  async build(): Promise<void> {
    for (const room of this.rooms) {
      await room.build();
    }
  }

  /**
   * Reset the world before building
   */
  async resetAndBuild(): Promise<void> {
    await this.server.reset();
    await this.build();
  }
}
