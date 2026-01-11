import {
  DynamoDBClient,
  PutItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({});
const secretsManager = new SecretsManagerClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE!;
const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const SCREEPS_TOKEN_SECRET = process.env.SCREEPS_TOKEN_SECRET!;
const SNAPSHOT_RETENTION_DAYS = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || "30");
const EVENT_RETENTION_DAYS = parseInt(process.env.EVENT_RETENTION_DAYS || "90");

interface ScreepsMemory {
  stats?: {
    tickStats: any[];
    snapshots: any[];
    events: any[];
    lastSnapshotTick: number;
  };
}

interface ScreepsResponse {
  ok: number;
  data?: string;
}

async function getScreepsToken(): Promise<string> {
  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: SCREEPS_TOKEN_SECRET })
  );
  return response.SecretString!;
}

async function fetchScreepsMemory(token: string): Promise<ScreepsMemory> {
  const response = await fetch(
    "https://screeps.com/api/user/memory?path=stats&shard=shard0",
    {
      headers: {
        "X-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Screeps API error: ${response.status}`);
  }

  const json: ScreepsResponse = await response.json();
  if (json.ok !== 1) {
    throw new Error("Screeps API returned error");
  }

  // Memory is gzipped and base64 encoded with "gz:" prefix
  if (json.data?.startsWith("gz:")) {
    const compressed = Buffer.from(json.data.slice(3), "base64");
    const { gunzipSync } = await import("zlib");
    const decompressed = gunzipSync(compressed).toString("utf-8");
    return { stats: JSON.parse(decompressed) };
  }

  return json.data ? JSON.parse(json.data) : {};
}

async function storeSnapshots(snapshots: any[]): Promise<void> {
  if (snapshots.length === 0) return;

  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60;

  // Batch write snapshots (max 25 per batch)
  for (let i = 0; i < snapshots.length; i += 25) {
    const batch = snapshots.slice(i, i + 25);
    const requests = batch.map((snapshot) => ({
      PutRequest: {
        Item: marshall({
          roomName: snapshot.roomName,
          timestamp: snapshot.timestamp,
          gameTick: snapshot.gameTick,
          energy: snapshot.energy,
          creeps: snapshot.creeps,
          economy: snapshot.economy,
          controller: snapshot.controller,
          structures: snapshot.structures,
          threats: snapshot.threats,
          cpu: snapshot.cpu,
          expiresAt,
        }),
      },
    }));

    await dynamodb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [SNAPSHOTS_TABLE]: requests,
        },
      })
    );
  }

  console.log(`Stored ${snapshots.length} snapshots`);
}

async function storeEvents(events: any[]): Promise<void> {
  if (events.length === 0) return;

  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + EVENT_RETENTION_DAYS * 24 * 60 * 60;

  // Batch write events (max 25 per batch)
  for (let i = 0; i < events.length; i += 25) {
    const batch = events.slice(i, i + 25);
    const requests = batch.map((event) => ({
      PutRequest: {
        Item: marshall({
          roomName: event.roomName,
          eventId: `${event.gameTick}-${event.type}-${Math.random().toString(36).slice(2)}`,
          timestamp: event.timestamp,
          gameTick: event.gameTick,
          type: event.type,
          data: event.data || {},
          expiresAt,
        }),
      },
    }));

    await dynamodb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [EVENTS_TABLE]: requests,
        },
      })
    );
  }

  console.log(`Stored ${events.length} events`);
}

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
    console.log("Fetching Screeps memory...");
    const token = await getScreepsToken();
    const memory = await fetchScreepsMemory(token);

    if (!memory.stats) {
      console.log("No stats found in memory");
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No stats available" }),
      };
    }

    const { snapshots, events } = memory.stats;

    // Store data in DynamoDB
    await Promise.all([
      storeSnapshots(snapshots || []),
      storeEvents(events || []),
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Data collected successfully",
        snapshots: snapshots?.length || 0,
        events: events?.length || 0,
      }),
    };
  } catch (error) {
    console.error("Error collecting data:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(error) }),
    };
  }
}
