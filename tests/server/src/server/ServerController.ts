/**
 * ServerController - Wraps screeps-server-mockup with a high-level API
 *
 * Provides clean abstractions for:
 * - Server lifecycle management (start, stop, reset)
 * - Tick control (single tick, multi-tick, run-until)
 * - Bot deployment and management
 * - Game state queries
 */

import { ServerControllerConfig, BotHandle, GameState, RoomState, CreepState, StructureState } from "../types";
import { BodyPartType, StructureType } from "../constants";

// Type definitions for screeps-server-mockup
// (The package doesn't have @types, so we define what we need)
interface ScreepsServerModule {
  ScreepsServer: new () => ScreepsServer;
  TerrainMatrix: new () => TerrainMatrix;
}

interface ScreepsServer {
  world: World;
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
}

interface World {
  gameTime: Promise<number>;
  reset(): Promise<void>;
  stubWorld(): Promise<void>;
  load(): Promise<{ C: unknown; db: Database }>;
  addRoom(room: string): Promise<void>;
  setTerrain(room: string, terrain?: TerrainMatrix): Promise<void>;
  getTerrain(room: string): Promise<TerrainMatrix>;
  addRoomObject(room: string, type: string, x: number, y: number, attributes?: Record<string, unknown>): Promise<void>;
  roomObjects(room: string): Promise<RoomObject[]>;
  addBot(options: AddBotOptions): Promise<User>;
}

interface Database {
  users: DatabaseCollection;
  "rooms.objects": DatabaseCollection;
  rooms: DatabaseCollection;
}

interface DatabaseCollection {
  find(query?: Record<string, unknown>): Promise<unknown[]>;
  findOne(query: Record<string, unknown>): Promise<unknown>;
  insert(doc: Record<string, unknown>): Promise<void>;
  update(query: Record<string, unknown>, update: Record<string, unknown>): Promise<void>;
  removeWhere(query: Record<string, unknown>): Promise<void>;
}

interface TerrainMatrix {
  get(x: number, y: number): string;
  set(x: number, y: number, type: "plain" | "wall" | "swamp"): void;
  serialize(): string;
}

interface RoomObject {
  _id: string;
  type: string;
  x: number;
  y: number;
  room: string;
  [key: string]: unknown;
}

interface AddBotOptions {
  username: string;
  room: string;
  x: number;
  y: number;
  modules: Record<string, string>;
  spawnName?: string;
  gcl?: number;
  cpu?: number;
  cpuAvailable?: number;
}

interface User {
  id: string;
  username: string;
  memory: Promise<string>;
  cpu: Promise<number>;
  cpuAvailable: Promise<number>;
  lastUsedCpu: Promise<number>;
  gcl: Promise<number>;
  rooms: Promise<string[]>;
  activeSegments: Promise<number[]>;
  on(event: "console", callback: ConsoleCallback): void;
  console(command: string): Promise<unknown>;
  getSegments(ids: number[]): Promise<Record<number, string>>;
  newNotifications: Promise<Array<{ message: string }>>;
}

type ConsoleCallback = (
  logs: string[],
  results: unknown[],
  userid: string,
  username: string
) => void;

/**
 * High-level controller for the Screeps private server
 */
export class ServerController {
  private server: ScreepsServer | null = null;
  private config: ServerControllerConfig;
  private users: Map<string, User> = new Map();
  private consoleLogs: Map<string, string[]> = new Map();
  private userIdToUsername: Map<string, string> = new Map();
  private db: Database | null = null;
  private ready = false;

  constructor(config: ServerControllerConfig = {}) {
    this.config = {
      port: config.port || 21025,
      logConsole: config.logConsole || false,
      captureMemory: config.captureMemory || false,
      dataDir: config.dataDir,
    };
  }

  /**
   * Initialize and start the server
   */
  async initialize(): Promise<void> {
    // Dynamic import to avoid issues at module load time
    const { ScreepsServer } = (await import("screeps-server-mockup")) as ScreepsServerModule;

    this.server = new ScreepsServer();
    await this.server.start();

    // Load the database
    const { db } = await this.server.world.load();
    this.db = db;

    this.ready = true;
  }

  /**
   * Reset the world to a clean state
   */
  async reset(): Promise<void> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }

    await this.server.world.reset();

    // Clear tracked state
    this.users.clear();
    this.consoleLogs.clear();
    this.userIdToUsername.clear();
  }

  /**
   * Stop the server
   */
  async shutdown(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.ready = false;
    }
  }

  /**
   * Check if server is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get current game tick
   */
  async getCurrentTick(): Promise<number> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    return this.server.world.gameTime;
  }

  /**
   * Advance the game by one or more ticks
   */
  async tick(count = 1): Promise<void> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }

    for (let i = 0; i < count; i++) {
      await this.server.tick();
    }
  }

  /**
   * Run ticks until a condition is met or max ticks reached
   * @returns true if condition was met, false if max ticks reached
   */
  async runUntil(
    condition: (state: GameState) => Promise<boolean>,
    maxTicks: number,
    checkInterval = 1
  ): Promise<boolean> {
    let ticksRun = 0;

    while (ticksRun < maxTicks) {
      await this.tick(checkInterval);
      ticksRun += checkInterval;

      const state = await this.getGameState();
      if (await condition(state)) {
        return true;
      }
    }

    return false;
  }

  // ============================================
  // World Management
  // ============================================

  /**
   * Get direct access to the world object for advanced operations
   */
  getWorld(): World {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    return this.server.world;
  }

  /**
   * Create the default stub world (9 rooms with sources and controllers)
   */
  async createStubWorld(): Promise<void> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    await this.server.world.stubWorld();
  }

  /**
   * Add a room to the world
   */
  async addRoom(roomName: string): Promise<void> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    await this.server.world.addRoom(roomName);
  }

  /**
   * Set terrain for a room
   */
  async setTerrain(roomName: string, terrain?: TerrainMatrix): Promise<void> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    await this.server.world.setTerrain(roomName, terrain);
  }

  /**
   * Get terrain matrix for a room
   */
  async getTerrain(roomName: string): Promise<TerrainMatrix> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    return this.server.world.getTerrain(roomName);
  }

  /**
   * Add a room object (source, controller, mineral, structure, etc.)
   */
  async addRoomObject(
    room: string,
    type: string,
    x: number,
    y: number,
    attributes?: Record<string, unknown>
  ): Promise<void> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    await this.server.world.addRoomObject(room, type, x, y, attributes);
  }

  /**
   * Get all objects in a room
   */
  async getRoomObjects(roomName: string): Promise<RoomObject[]> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }
    return this.server.world.roomObjects(roomName);
  }

  // ============================================
  // Bot Management
  // ============================================

  /**
   * Deploy a bot to the server
   */
  async deployBot(
    username: string,
    code: string | Record<string, string>,
    room: string,
    position: { x: number; y: number } = { x: 25, y: 25 },
    options: {
      spawnName?: string;
      gcl?: number;
      cpu?: number;
      cpuAvailable?: number;
    } = {}
  ): Promise<BotHandle> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }

    // Convert string code to modules format
    const modules = typeof code === "string" ? { main: code } : code;

    const user = await this.server.world.addBot({
      username,
      room,
      x: position.x,
      y: position.y,
      modules,
      spawnName: options.spawnName || "Spawn1",
      gcl: options.gcl || 1,
      cpu: options.cpu || 100,
      cpuAvailable: options.cpuAvailable || 10000,
    });

    // Track the user
    this.users.set(username, user);
    this.consoleLogs.set(username, []);

    // Get the user's database ID and store the mapping
    const userId = await this.getUserId(username);
    if (userId) {
      this.userIdToUsername.set(userId, username);
    }

    // Subscribe to console output
    user.on("console", (logs, _results, _userid, uname) => {
      const botLogs = this.consoleLogs.get(uname) || [];
      botLogs.push(...logs);
      this.consoleLogs.set(uname, botLogs);

      if (this.config.logConsole) {
        for (const log of logs) {
          console.log(`[${uname}] ${log}`);
        }
      }
    });

    return {
      username,
      startRoom: room,
      consoleLogs: this.consoleLogs.get(username) || [],
    };
  }

  /**
   * Remove a bot from the server
   */
  async removeBot(username: string): Promise<void> {
    if (!this.db) {
      throw new Error("Server not initialized");
    }

    // Remove from database
    await this.db.users.removeWhere({ username });
    await this.db["rooms.objects"].removeWhere({ user: username });

    // Clean up tracking
    this.users.delete(username);
    this.consoleLogs.delete(username);
  }

  /**
   * Get a bot's memory
   */
  async getMemory(username: string): Promise<unknown> {
    const user = this.users.get(username);
    if (!user) {
      throw new Error(`Bot not found: ${username}`);
    }

    const memoryStr = await user.memory;
    try {
      return JSON.parse(memoryStr);
    } catch {
      return {};
    }
  }

  /**
   * Get console logs for a bot
   */
  getConsoleLogs(username: string): string[] {
    return this.consoleLogs.get(username) || [];
  }

  /**
   * Clear console logs for a bot
   */
  clearConsoleLogs(username: string): void {
    this.consoleLogs.set(username, []);
  }

  /**
   * Execute a console command as a bot
   */
  async executeCommand(username: string, command: string): Promise<unknown> {
    const user = this.users.get(username);
    if (!user) {
      throw new Error(`Bot not found: ${username}`);
    }

    return user.console(command);
  }

  /**
   * Get a user's database ID by username
   */
  async getUserId(username: string): Promise<string | null> {
    if (!this.db) {
      throw new Error("Server not initialized");
    }

    const user = await this.db.users.findOne({ username }) as { _id: string } | null;
    return user?._id || null;
  }

  /**
   * Update a room object's attributes
   */
  async updateRoomObject(
    room: string,
    type: string,
    updates: Record<string, unknown>
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Server not initialized");
    }

    await this.db["rooms.objects"].update(
      { room, type },
      { $set: updates }
    );
  }

  /**
   * Set controller level and ownership for a room
   */
  async setControllerLevel(room: string, level: number, userId?: string): Promise<void> {
    if (!this.db) {
      throw new Error("Server not initialized");
    }

    const updates: Record<string, unknown> = {
      level,
      progress: 0,
      downgradeTime: level > 0 ? 20000 : null,
    };

    if (userId) {
      updates.user = userId;
    }

    await this.db["rooms.objects"].update(
      { room, type: "controller" },
      { $set: updates }
    );
  }

  /**
   * Add a structure owned by a specific user (by userId)
   */
  async addOwnedStructure(
    room: string,
    type: string,
    x: number,
    y: number,
    userId: string,
    attributes?: Record<string, unknown>
  ): Promise<void> {
    const attrs: Record<string, unknown> = {
      user: userId,
      ...attributes,
    };

    await this.addRoomObject(room, type, x, y, attrs);
  }

  // ============================================
  // State Queries
  // ============================================

  /**
   * Get comprehensive game state for assertions
   */
  async getGameState(): Promise<GameState> {
    if (!this.server) {
      throw new Error("Server not initialized");
    }

    const tick = await this.getCurrentTick();
    const rooms = new Map<string, RoomState>();
    const memory = new Map<string, unknown>();
    const consoleLogs = new Map<string, string[]>();

    // Get all rooms from database
    if (this.db) {
      const roomDocs = await this.db.rooms.find({});
      for (const roomDoc of roomDocs as Array<{ _id: string }>) {
        const roomName = roomDoc._id;
        const roomState = await this.getRoomState(roomName);
        rooms.set(roomName, roomState);
      }
    }

    // Get memory for each tracked bot
    for (const [username, user] of this.users) {
      try {
        const memoryStr = await user.memory;
        memory.set(username, JSON.parse(memoryStr));
      } catch {
        memory.set(username, {});
      }
      consoleLogs.set(username, [...(this.consoleLogs.get(username) || [])]);
    }

    return {
      tick,
      rooms,
      memory,
      consoleLogs,
    };
  }

  /**
   * Convert a user ID to username (or return the ID if not found)
   */
  private resolveUsername(userId: string | null): string | null {
    if (!userId) return null;
    return this.userIdToUsername.get(userId) || userId;
  }

  /**
   * Get state for a specific room
   */
  async getRoomState(roomName: string): Promise<RoomState> {
    const objects = await this.getRoomObjects(roomName);

    // Find controller to determine ownership and RCL
    const controller = objects.find((o) => o.type === "controller");
    let owner: string | null = null;
    let rcl: number | null = null;
    let ticksToDowngrade: number | undefined;

    if (controller) {
      owner = this.resolveUsername((controller.user as string) || null);
      rcl = (controller.level as number) || null;
      ticksToDowngrade = controller.downgradeTime as number | undefined;
    }

    // Extract creeps
    const creeps: CreepState[] = objects
      .filter((o) => o.type === "creep")
      .map((o) => ({
        id: o._id,
        name: o.name as string,
        owner: this.resolveUsername((o.user as string) || null) || "unknown",
        body: (o.body as Array<{ type: BodyPartType }>)?.map((b) => b.type) || [],
        hits: (o.hits as number) || 0,
        hitsMax: (o.hitsMax as number) || 0,
        x: o.x,
        y: o.y,
        ticksToLive: o.ageTime as number | undefined,
        memory: o.memory as Record<string, unknown> | undefined,
        role: (o.memory as Record<string, unknown>)?.role as string | undefined,
      }));

    // Extract structures
    const structureTypes = [
      "spawn",
      "extension",
      "road",
      "constructedWall",
      "rampart",
      "link",
      "storage",
      "tower",
      "observer",
      "powerSpawn",
      "extractor",
      "lab",
      "terminal",
      "container",
      "nuker",
      "factory",
    ];

    const structures: StructureState[] = objects
      .filter((o) => structureTypes.includes(o.type))
      .map((o) => ({
        id: o._id,
        type: o.type as StructureType,
        owner: this.resolveUsername((o.user as string) || null),
        hits: (o.hits as number) || 0,
        hitsMax: (o.hitsMax as number) || 0,
        x: o.x,
        y: o.y,
        store: o.store as Record<string, number> | undefined,
      }));

    // Map internal objects to our RoomObject type
    const mappedObjects = objects.map((o) => {
      const { _id, ...rest } = o;
      return {
        id: _id,
        ...rest,
      };
    });

    return {
      name: roomName,
      owner,
      rcl,
      ticksToDowngrade,
      objects: mappedObjects,
      creeps,
      structures,
    };
  }
}

// Export the TerrainMatrix type for use in WorldBuilder
export { TerrainMatrix };
