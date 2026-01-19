/**
 * Screeps Monitor API Server
 * Express server for monitoring Screeps colony from AWS
 */

import express, { Request, Response } from "express";
import * as https from "https";
import * as zlib from "zlib";

const app = express();
app.use(express.json());

// Configuration from environment
const SCREEPS_TOKEN = process.env.SCREEPS_TOKEN || "";
const SCREEPS_HOST = process.env.SCREEPS_HOST || "screeps.com";
const SCREEPS_SHARD = process.env.SCREEPS_SHARD || "shard0";
const PORT = parseInt(process.env.PORT || "3000");

if (!SCREEPS_TOKEN) {
  console.error("ERROR: SCREEPS_TOKEN environment variable is required");
  process.exit(1);
}

// Screeps API client
interface ApiResponse {
  ok: number;
  [key: string]: unknown;
}

function screepsRequest(endpoint: string, method = "GET", body?: unknown): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: SCREEPS_HOST,
      port: 443,
      path: `/api${endpoint}`,
      method,
      headers: {
        "X-Token": SCREEPS_TOKEN,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function decodeMemory(data: string): unknown {
  if (data.startsWith("gz:")) {
    const base64 = data.slice(3);
    const buffer = Buffer.from(base64, "base64");
    const decompressed = zlib.gunzipSync(buffer);
    return JSON.parse(decompressed.toString("utf-8"));
  }
  return JSON.parse(data);
}

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// User info
app.get("/me", async (_req: Request, res: Response) => {
  try {
    const result = await screepsRequest("/auth/me");
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// World status
app.get("/status", async (_req: Request, res: Response) => {
  try {
    const result = await screepsRequest("/user/world-status");
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// User stats
app.get("/stats", async (_req: Request, res: Response) => {
  try {
    const result = await screepsRequest("/user/stats");
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Room overview
app.get("/room/:name", async (req: Request, res: Response) => {
  try {
    const room = req.params.name;
    const result = await screepsRequest(
      `/game/room-overview?room=${room}&shard=${SCREEPS_SHARD}&interval=8`
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Room objects (raw)
app.get("/objects/:room", async (req: Request, res: Response) => {
  try {
    const room = req.params.room;
    const result = await screepsRequest(
      `/game/room-objects?room=${room}&shard=${SCREEPS_SHARD}`
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Room terrain
app.get("/terrain/:room", async (req: Request, res: Response) => {
  try {
    const room = req.params.room;
    const result = await screepsRequest(
      `/game/room-terrain?room=${room}&shard=${SCREEPS_SHARD}&encoded=true`
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Helper to extract terrain string from API response
function getTerrainString(result: ApiResponse): string | null {
  const terrain = result.terrain as Array<{ terrain: string }> | undefined;
  if (terrain && terrain.length > 0 && terrain[0].terrain) {
    return terrain[0].terrain;
  }
  return null;
}

// Comprehensive room data (objects organized by type + terrain)
interface RoomObject {
  _id: string;
  type: string;
  x: number;
  y: number;
  [key: string]: unknown;
}

interface OrganizedRoomData {
  room: string;
  shard: string;
  timestamp: string;
  terrain: string | null;
  objects: {
    structures: Record<string, RoomObject[]>;
    creeps: RoomObject[];
    constructionSites: RoomObject[];
    sources: RoomObject[];
    minerals: RoomObject[];
    droppedResources: RoomObject[];
    tombstones: RoomObject[];
    ruins: RoomObject[];
    other: RoomObject[];
  };
  counts: {
    totalObjects: number;
    structures: number;
    creeps: number;
    constructionSites: number;
    sources: number;
    minerals: number;
  };
}

app.get("/room-data/:room", async (req: Request, res: Response) => {
  try {
    const room = req.params.room;

    // Fetch objects and terrain in parallel
    const [objectsResult, terrainResult] = await Promise.all([
      screepsRequest(`/game/room-objects?room=${room}&shard=${SCREEPS_SHARD}`),
      screepsRequest(`/game/room-terrain?room=${room}&shard=${SCREEPS_SHARD}&encoded=true`),
    ]);

    if (!objectsResult.ok) {
      res.status(500).json({ error: "Failed to fetch room objects", details: objectsResult });
      return;
    }

    // Organize objects by type
    const objects = (objectsResult.objects || []) as RoomObject[];
    const organized: OrganizedRoomData = {
      room,
      shard: SCREEPS_SHARD,
      timestamp: new Date().toISOString(),
      terrain: getTerrainString(terrainResult),
      objects: {
        structures: {},
        creeps: [],
        constructionSites: [],
        sources: [],
        minerals: [],
        droppedResources: [],
        tombstones: [],
        ruins: [],
        other: [],
      },
      counts: {
        totalObjects: objects.length,
        structures: 0,
        creeps: 0,
        constructionSites: 0,
        sources: 0,
        minerals: 0,
      },
    };

    // Structure types from Screeps API
    const structureTypes = new Set([
      "spawn", "extension", "road", "constructedWall", "rampart", "keeper_lair",
      "portal", "controller", "link", "storage", "tower", "observer", "power_bank",
      "power_spawn", "extractor", "lab", "terminal", "container", "nuker", "factory",
      "invader_core",
    ]);

    for (const obj of objects) {
      const type = obj.type;

      if (structureTypes.has(type)) {
        // Group structures by their type
        if (!organized.objects.structures[type]) {
          organized.objects.structures[type] = [];
        }
        organized.objects.structures[type].push(obj);
        organized.counts.structures++;
      } else if (type === "creep") {
        organized.objects.creeps.push(obj);
        organized.counts.creeps++;
      } else if (type === "constructionSite") {
        organized.objects.constructionSites.push(obj);
        organized.counts.constructionSites++;
      } else if (type === "source") {
        organized.objects.sources.push(obj);
        organized.counts.sources++;
      } else if (type === "mineral") {
        organized.objects.minerals.push(obj);
        organized.counts.minerals++;
      } else if (type === "energy" || type === "resource") {
        organized.objects.droppedResources.push(obj);
      } else if (type === "tombstone") {
        organized.objects.tombstones.push(obj);
      } else if (type === "ruin") {
        organized.objects.ruins.push(obj);
      } else {
        organized.objects.other.push(obj);
      }
    }

    res.json({ ok: 1, data: organized });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Memory
app.get("/memory", async (req: Request, res: Response) => {
  try {
    const path = (req.query.path as string) || "";
    const result = await screepsRequest(`/user/memory?path=${path}&shard=${SCREEPS_SHARD}`);
    if (result.data && typeof result.data === "string") {
      const decoded = decodeMemory(result.data);
      res.json({ ok: 1, data: decoded });
    } else {
      res.json(result);
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/memory/:path", async (req: Request, res: Response) => {
  try {
    const path = req.params.path;
    const result = await screepsRequest(`/user/memory?path=${path}&shard=${SCREEPS_SHARD}`);
    if (result.data && typeof result.data === "string") {
      const decoded = decodeMemory(result.data);
      res.json({ ok: 1, data: decoded });
    } else {
      res.json(result);
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Console command
app.post("/console", async (req: Request, res: Response) => {
  try {
    const { expression } = req.body;
    if (!expression) {
      res.status(400).json({ error: "expression required" });
      return;
    }
    const result = await screepsRequest("/user/console", "POST", {
      expression,
      shard: SCREEPS_SHARD,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Colony summary (main monitoring endpoint)
interface MemoryData {
  creeps?: Record<string, { role: string; room: string }>;
  rooms?: Record<string, { sources?: string[]; hostiles?: number }>;
  stats?: { gcl: number; gclLevel: number; cpu: number; bucket: number; tick: number };
}

app.get("/summary", async (_req: Request, res: Response) => {
  try {
    const result = await screepsRequest(`/user/memory?path=&shard=${SCREEPS_SHARD}`);

    if (!result.data || typeof result.data !== "string") {
      res.status(500).json({ error: "No memory data" });
      return;
    }

    const mem = decodeMemory(result.data) as MemoryData;

    // Build summary
    const summary: {
      ok: number;
      timestamp: string;
      stats: MemoryData["stats"] | null;
      creeps: { total: number; byRole: Record<string, number> };
      rooms: { name: string; sources: number; hostiles: number }[];
      alerts: string[];
    } = {
      ok: 1,
      timestamp: new Date().toISOString(),
      stats: mem.stats || null,
      creeps: { total: 0, byRole: {} },
      rooms: [],
      alerts: [],
    };

    // Count creeps by role
    if (mem.creeps) {
      for (const creep of Object.values(mem.creeps)) {
        summary.creeps.byRole[creep.role] = (summary.creeps.byRole[creep.role] || 0) + 1;
        summary.creeps.total++;
      }
    }

    // Room info
    if (mem.rooms) {
      for (const [roomName, roomData] of Object.entries(mem.rooms)) {
        summary.rooms.push({
          name: roomName,
          sources: roomData.sources?.length || 0,
          hostiles: roomData.hostiles || 0,
        });

        // Alert on hostiles
        if (roomData.hostiles && roomData.hostiles > 0) {
          summary.alerts.push(`Hostiles detected in ${roomName}: ${roomData.hostiles}`);
        }
      }
    }

    // Alert on low bucket
    if (mem.stats && mem.stats.bucket < 5000) {
      summary.alerts.push(`Low CPU bucket: ${mem.stats.bucket}`);
    }

    // Alert on no creeps
    if (summary.creeps.total === 0) {
      summary.alerts.push("No creeps alive!");
    }

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Screeps Monitor API running on port ${PORT}`);
  console.log(`Shard: ${SCREEPS_SHARD}`);
});
