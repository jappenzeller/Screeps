import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const METRICS_TABLE = process.env.METRICS_TABLE;
const RETENTION_DAYS = 7; // DynamoDB metrics TTL

/**
 * Write colony metrics to DynamoDB from EventBridge events
 * These metrics are used for trend analysis by the context-builder Lambda
 */
export async function handler(event) {
  console.log("Processing event:", JSON.stringify(event, null, 2));

  const detail = event.detail;
  if (!detail || !detail.snapshot) {
    console.log("No snapshot in event, skipping");
    return { written: 0 };
  }

  const snapshot = detail.snapshot;
  const roomName = snapshot.roomName;
  const timestamp = snapshot.timestamp || Date.now();

  // Extract metrics from snapshot (handles nested structure)
  const metrics = extractMetrics(snapshot);

  if (Object.keys(metrics).length === 0) {
    console.log("No metrics to write");
    return { written: 0 };
  }

  // Write to DynamoDB
  if (METRICS_TABLE) {
    try {
      await writeToDynamoDB(roomName, timestamp, metrics, snapshot);
      console.log(`Wrote ${Object.keys(metrics).length} metrics to DynamoDB for room ${roomName}`);
      return { written: Object.keys(metrics).length };
    } catch (error) {
      console.error("DynamoDB write error:", error);
      throw error;
    }
  }

  return { written: 0 };
}

/**
 * Write metrics to DynamoDB with enhanced data for trend analysis
 */
async function writeToDynamoDB(roomName, timestamp, metrics, snapshot) {
  const expiresAt = Math.floor((timestamp + RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);

  // Include per-role creep counts for detailed analysis
  const byRole = snapshot.creeps?.byRole || {};

  await docClient.send(
    new PutCommand({
      TableName: METRICS_TABLE,
      Item: {
        roomName,
        timestamp,
        metrics,
        byRole,
        expiresAt,
      },
    })
  );
}

/**
 * Extract metrics from a snapshot (handles nested structure)
 *
 * Snapshot structure from stream-processor EventBridge event:
 * {
 *   roomName: "E46N37",
 *   rcl: 5,
 *   rclProgress: 587631,
 *   rclProgressTotal: 1215000,
 *   energy: { available: 180, capacity: 1800, stored: 999510 },
 *   creeps: { total: 14, byRole: { HAULER: 2, ... } },
 *   threats: { hostileCount: 0, hostileDPS: 0 },
 *   structures: { constructionSites: 0, damagedCount: 0 },
 *   global: { gcl: {...}, cpu: { bucket, limit, used }, totalCreeps }
 * }
 */
function extractMetrics(snapshot) {
  const metrics = {};

  // Energy metrics (from nested energy object)
  if (snapshot.energy) {
    if (typeof snapshot.energy.available === "number") {
      metrics.energy_available = snapshot.energy.available;
    }
    if (typeof snapshot.energy.capacity === "number") {
      metrics.energy_capacity = snapshot.energy.capacity;
    }
    if (typeof snapshot.energy.stored === "number") {
      metrics.energy_stored = snapshot.energy.stored;
    }
  }

  // Controller metrics
  if (typeof snapshot.rcl === "number") {
    metrics.rcl = snapshot.rcl;
  }
  if (typeof snapshot.rclProgress === "number") {
    metrics.rcl_progress = snapshot.rclProgress;
  }
  if (typeof snapshot.rclProgressTotal === "number") {
    metrics.rcl_progress_total = snapshot.rclProgressTotal;
  }

  // Creep metrics (from nested creeps object)
  if (snapshot.creeps) {
    if (typeof snapshot.creeps.total === "number") {
      metrics.creep_count = snapshot.creeps.total;
    }
  }

  // Threat metrics (from nested threats object)
  if (snapshot.threats) {
    if (typeof snapshot.threats.hostileCount === "number") {
      metrics.hostile_count = snapshot.threats.hostileCount;
    }
    if (typeof snapshot.threats.hostileDPS === "number") {
      metrics.hostile_dps = snapshot.threats.hostileDPS;
    }
  }

  // Structure metrics (from nested structures object)
  if (snapshot.structures) {
    if (typeof snapshot.structures.constructionSites === "number") {
      metrics.construction_sites = snapshot.structures.constructionSites;
    }
    if (typeof snapshot.structures.damagedCount === "number") {
      metrics.damaged_structures = snapshot.structures.damagedCount;
    }
  }

  // Global metrics (from nested global object)
  if (snapshot.global) {
    if (snapshot.global.cpu) {
      if (typeof snapshot.global.cpu.used === "number") {
        metrics.cpu_used = snapshot.global.cpu.used;
      }
      if (typeof snapshot.global.cpu.bucket === "number") {
        metrics.cpu_bucket = snapshot.global.cpu.bucket;
      }
      if (typeof snapshot.global.cpu.limit === "number") {
        metrics.cpu_limit = snapshot.global.cpu.limit;
      }
    }
    if (snapshot.global.gcl) {
      if (typeof snapshot.global.gcl.level === "number") {
        metrics.gcl_level = snapshot.global.gcl.level;
      }
      if (typeof snapshot.global.gcl.progress === "number") {
        metrics.gcl_progress = snapshot.global.gcl.progress;
      }
    }
    if (typeof snapshot.global.totalCreeps === "number") {
      metrics.total_creeps = snapshot.global.totalCreeps;
    }
  }

  return metrics;
}
