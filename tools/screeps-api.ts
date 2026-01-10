/**
 * Screeps API Client
 * For monitoring and querying game state from external systems (AWS, etc.)
 *
 * Usage:
 *   npx ts-node tools/screeps-api.ts status
 *   npx ts-node tools/screeps-api.ts room E46N37
 *   npx ts-node tools/screeps-api.ts memory
 */

import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

interface ScreepsConfig {
  token: string;
  protocol: string;
  hostname: string;
  port: number;
  path: string;
  branch: string;
}

interface ApiResponse {
  ok: number;
  [key: string]: unknown;
}

class ScreepsAPI {
  private config: ScreepsConfig;
  private shard: string;

  constructor(configName: string = "main", shard: string = "shard0") {
    const configPath = path.join(__dirname, "..", "screeps.json");
    const configFile = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    this.config = configFile[configName];
    this.shard = shard;

    if (!this.config) {
      throw new Error(`Config "${configName}" not found in screeps.json`);
    }
  }

  private request(endpoint: string, method: string = "GET", body?: unknown): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: this.config.hostname,
        port: this.config.port,
        path: `/api${endpoint}`,
        method,
        headers: {
          "X-Token": this.config.token,
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on("error", reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // Get user info
  async me(): Promise<ApiResponse> {
    return this.request("/auth/me");
  }

  // Get room overview (energy, controller progress, etc.)
  async roomOverview(room: string, interval: number = 8): Promise<ApiResponse> {
    return this.request(`/game/room-overview?room=${room}&shard=${this.shard}&interval=${interval}`);
  }

  // Get room terrain
  async roomTerrain(room: string): Promise<ApiResponse> {
    return this.request(`/game/room-terrain?room=${room}&shard=${this.shard}&encoded=1`);
  }

  // Get room status
  async roomStatus(room: string): Promise<ApiResponse> {
    return this.request(`/game/room-status?room=${room}&shard=${this.shard}`);
  }

  // Get room objects (structures, creeps, etc.)
  async roomObjects(room: string): Promise<ApiResponse> {
    return this.request(`/game/room-objects?room=${room}&shard=${this.shard}`);
  }

  // Get memory segment
  async memory(path: string = "", shard?: string): Promise<ApiResponse> {
    const s = shard || this.shard;
    return this.request(`/user/memory?path=${path}&shard=${s}`);
  }

  // Get memory segment
  async memorySegment(segment: number): Promise<ApiResponse> {
    return this.request(`/user/memory-segment?segment=${segment}&shard=${this.shard}`);
  }

  // Get console output
  async console(): Promise<ApiResponse> {
    return this.request("/user/console");
  }

  // Send console command
  async sendConsole(expression: string): Promise<ApiResponse> {
    return this.request("/user/console", "POST", {
      expression,
      shard: this.shard,
    });
  }

  // Get world status
  async worldStatus(): Promise<ApiResponse> {
    return this.request("/user/world-status");
  }

  // Get user stats (GCL, CPU, etc.)
  async stats(): Promise<ApiResponse> {
    return this.request("/user/stats");
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  const api = new ScreepsAPI("main", "shard0");

  try {
    switch (command) {
      case "me":
      case "user": {
        const result = await api.me();
        console.log("=== User Info ===");
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "status": {
        const result = await api.worldStatus();
        console.log("=== World Status ===");
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "stats": {
        const result = await api.stats();
        console.log("=== User Stats ===");
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "room": {
        const room = args[1] || "E46N37";
        console.log(`=== Room ${room} ===`);

        const overview = await api.roomOverview(room);
        console.log("\nOverview:");
        console.log(JSON.stringify(overview, null, 2));
        break;
      }

      case "objects": {
        const room = args[1] || "E46N37";
        console.log(`=== Room Objects ${room} ===`);
        const result = await api.roomObjects(room);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "memory": {
        const memPath = args[1] || "";
        console.log(`=== Memory ${memPath || "(root)"} ===`);
        const result = await api.memory(memPath);
        if (result.data && typeof result.data === "string") {
          const decoded = decodeMemory(result.data);
          console.log(JSON.stringify(decoded, null, 2));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case "console": {
        const expr = args.slice(1).join(" ");
        if (expr) {
          console.log(`Sending: ${expr}`);
          const result = await api.sendConsole(expr);
          console.log(JSON.stringify(result, null, 2));
        } else {
          const result = await api.console();
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case "summary": {
        console.log("=== Colony Summary ===\n");

        // Get memory for creep/room info
        const memResult = await api.memory("");
        if (memResult.data && typeof memResult.data === "string") {
          const mem = decodeMemory(memResult.data) as {
            creeps?: Record<string, { role: string; room: string }>;
            rooms?: Record<string, { sources?: string[]; hostiles?: number }>;
            stats?: { gcl: number; gclLevel: number; cpu: number; bucket: number; tick: number };
          };

          // Stats
          if (mem.stats) {
            console.log(`GCL: Level ${mem.stats.gclLevel} (${Math.floor(mem.stats.gcl).toLocaleString()} progress)`);
            console.log(`CPU: ${mem.stats.cpu.toFixed(2)} | Bucket: ${mem.stats.bucket}`);
            console.log(`Tick: ${mem.stats.tick}\n`);
          }

          // Count creeps by role
          if (mem.creeps) {
            const byRole: Record<string, number> = {};
            for (const creep of Object.values(mem.creeps)) {
              byRole[creep.role] = (byRole[creep.role] || 0) + 1;
            }
            console.log("Creeps:");
            for (const [role, count] of Object.entries(byRole).sort()) {
              console.log(`  ${role}: ${count}`);
            }
            console.log(`  Total: ${Object.keys(mem.creeps).length}\n`);
          }

          // Room info
          if (mem.rooms) {
            console.log("Rooms:");
            for (const [roomName, roomData] of Object.entries(mem.rooms)) {
              const sources = roomData.sources?.length || 0;
              const hostiles = roomData.hostiles || 0;
              console.log(`  ${roomName}: ${sources} sources, ${hostiles} hostiles`);
            }
          }
        }
        break;
      }

      case "help":
      default:
        console.log(`
Screeps API CLI

Commands:
  me, user     - Get user info
  status       - Get world status
  stats        - Get user stats (GCL, CPU)
  summary      - Quick colony summary (creeps, rooms, stats)
  room [name]  - Get room overview (default: E46N37)
  objects [room] - Get room objects (creeps, structures)
  memory [path] - Get memory (e.g., "rooms.E46N37")
  console [expr] - Send console command or get console output

Examples:
  npx ts-node tools/screeps-api.ts me
  npx ts-node tools/screeps-api.ts summary
  npx ts-node tools/screeps-api.ts room E46N37
  npx ts-node tools/screeps-api.ts console "status()"
  npx ts-node tools/screeps-api.ts memory stats
`);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

// Decode gzipped base64 memory data
function decodeMemory(data: string): unknown {
  if (data.startsWith("gz:")) {
    const base64 = data.slice(3);
    const buffer = Buffer.from(base64, "base64");
    const decompressed = zlib.gunzipSync(buffer);
    return JSON.parse(decompressed.toString("utf-8"));
  }
  return JSON.parse(data);
}

// Export for use as module
export { ScreepsAPI, decodeMemory };

// Run CLI if executed directly
main();
