/**
 * Type declarations for screeps-server-mockup
 *
 * This is a minimal declaration to allow TypeScript to import the module.
 * The actual types are defined inline in ServerController.ts.
 */

declare module "screeps-server-mockup" {
  export class ScreepsServer {
    world: World;
    start(): Promise<void>;
    stop(): Promise<void>;
    tick(): Promise<void>;
  }

  export class TerrainMatrix {
    get(x: number, y: number): string;
    set(x: number, y: number, type: "plain" | "wall" | "swamp"): void;
    serialize(): string;
  }

  interface World {
    gameTime: Promise<number>;
    reset(): Promise<void>;
    stubWorld(): Promise<void>;
    load(): Promise<{ C: unknown; db: Database }>;
    addRoom(room: string): Promise<void>;
    setTerrain(room: string, terrain?: TerrainMatrix): Promise<void>;
    getTerrain(room: string): Promise<TerrainMatrix>;
    addRoomObject(
      room: string,
      type: string,
      x: number,
      y: number,
      attributes?: Record<string, unknown>
    ): Promise<void>;
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
    update(
      query: Record<string, unknown>,
      update: Record<string, unknown>
    ): Promise<void>;
    removeWhere(query: Record<string, unknown>): Promise<void>;
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
}
