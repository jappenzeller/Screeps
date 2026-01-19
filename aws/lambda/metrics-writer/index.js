import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const METRICS_TABLE = process.env.METRICS_TABLE;
const RETENTION_DAYS = 7; // Metrics TTL

/**
 * Write colony metrics to DynamoDB from EventBridge events
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

  // Build metric records from snapshot
  const metrics = extractMetrics(snapshot);

  if (Object.keys(metrics).length === 0) {
    console.log("No metrics to write");
    return { written: 0 };
  }

  // Write aggregated metrics as a single record
  const expiresAt = Math.floor((timestamp + RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);

  try {
    await docClient.send(new PutCommand({
      TableName: METRICS_TABLE,
      Item: {
        roomName,
        timestamp,
        metrics,
        expiresAt,
      },
    }));

    console.log(`Wrote ${Object.keys(metrics).length} metrics for room ${roomName}`);
    return { written: Object.keys(metrics).length };
  } catch (error) {
    console.error("DynamoDB write error:", error);
    throw error;
  }
}

/**
 * Extract metrics from a snapshot
 */
function extractMetrics(snapshot) {
  const metrics = {};

  // Energy metrics
  if (snapshot.energyAvailable !== undefined) {
    metrics.energy_available = snapshot.energyAvailable;
  }
  if (snapshot.energyCapacity !== undefined) {
    metrics.energy_capacity = snapshot.energyCapacity;
  }
  if (snapshot.storageEnergy !== undefined) {
    metrics.storage_energy = snapshot.storageEnergy;
  }
  if (snapshot.terminalEnergy !== undefined) {
    metrics.terminal_energy = snapshot.terminalEnergy;
  }

  // Controller metrics
  if (snapshot.rcl !== undefined) {
    metrics.rcl = snapshot.rcl;
  }
  if (snapshot.controllerProgress !== undefined) {
    metrics.controller_progress = snapshot.controllerProgress;
  }
  if (snapshot.controllerProgressTotal !== undefined) {
    metrics.controller_progress_total = snapshot.controllerProgressTotal;
  }

  // Creep metrics
  if (snapshot.creepCount !== undefined) {
    metrics.creep_count = snapshot.creepCount;
  }
  if (snapshot.creepsByRole) {
    for (const [role, count] of Object.entries(snapshot.creepsByRole)) {
      metrics[`creep_${role}`] = count;
    }
  }

  // Defense metrics
  if (snapshot.threatLevel !== undefined) {
    metrics.threat_level = snapshot.threatLevel;
  }
  if (snapshot.hostileCount !== undefined) {
    metrics.hostile_count = snapshot.hostileCount;
  }
  if (snapshot.towerCount !== undefined) {
    metrics.tower_count = snapshot.towerCount;
  }
  if (snapshot.wallHitsMin !== undefined) {
    metrics.wall_hits_min = snapshot.wallHitsMin;
  }

  // Mining metrics
  if (snapshot.sourceCount !== undefined) {
    metrics.source_count = snapshot.sourceCount;
  }
  if (snapshot.harvestRate !== undefined) {
    metrics.harvest_rate = snapshot.harvestRate;
  }
  if (snapshot.upgradeRate !== undefined) {
    metrics.upgrade_rate = snapshot.upgradeRate;
  }

  // Remote mining metrics
  if (snapshot.remoteRoomCount !== undefined) {
    metrics.remote_room_count = snapshot.remoteRoomCount;
  }
  if (snapshot.remoteIncome !== undefined) {
    metrics.remote_income = snapshot.remoteIncome;
  }

  // CPU metrics
  if (snapshot.cpuUsed !== undefined) {
    metrics.cpu_used = snapshot.cpuUsed;
  }
  if (snapshot.cpuBucket !== undefined) {
    metrics.cpu_bucket = snapshot.cpuBucket;
  }

  return metrics;
}
