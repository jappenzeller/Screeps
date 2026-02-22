import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const METRICS_TABLE = process.env.METRICS_TABLE;

/**
 * Detect patterns in colony snapshot and metrics trends
 *
 * Input: { context: { snapshot, trends, roomName, ... } }
 * Output: { patterns: Pattern[], context: ... }
 */
export async function handler(event) {
  const context = event.context || event;
  const snapshot = context.currentState?.snapshot || context.snapshot || {};
  const trends = context.history?.trends || {};
  const roomName = snapshot.roomName || context.roomName;

  console.log("Detecting patterns for:", roomName);

  const patterns = [];

  // Extract metrics (handle nested structure)
  const energyStored = snapshot.energy?.stored ?? snapshot.energyStored ?? 0;
  const energyAvailable = snapshot.energy?.available ?? snapshot.energyAvailable ?? 0;
  const energyCapacity = snapshot.energy?.capacity ?? snapshot.energyCapacity ?? 300;
  const creepTotal = snapshot.creeps?.total ?? snapshot.creepCount ?? 0;
  const byRole = snapshot.creeps?.byRole ?? {};
  const rcl = snapshot.rcl ?? 1;
  const rclProgress = snapshot.rclProgress ?? 0;
  const hostileCount = snapshot.threats?.hostileCount ?? snapshot.hostileCount ?? 0;
  const cpuBucket = snapshot.global?.cpu?.bucket ?? snapshot.cpuBucket ?? 10000;
  const cpuUsed = snapshot.global?.cpu?.used ?? snapshot.cpuUsed ?? 0;

  // Count roles (normalize to uppercase)
  const roleCount = {};
  for (const [role, count] of Object.entries(byRole)) {
    roleCount[role.toUpperCase()] = count;
  }
  const harvesterCount = roleCount.HARVESTER ?? roleCount.MINER ?? 0;
  const haulerCount = roleCount.HAULER ?? roleCount.FILLER ?? 0;
  const upgraderCount = roleCount.UPGRADER ?? 0;

  // ========== Pattern Detection Rules ==========

  // 1. NO_MINERS - Critical: No harvesters/miners
  if (harvesterCount === 0 && rcl > 0) {
    patterns.push({
      id: `NO_MINERS:${roomName}`,
      type: "NO_MINERS",
      severity: "critical",
      description: "No harvesters or miners - economy will collapse",
      data: { harvesterCount, creepTotal },
    });
  }

  // 2. NO_UPGRADERS - No upgraders when RCL < 8
  if (upgraderCount === 0 && rcl < 8 && creepTotal > 3) {
    patterns.push({
      id: `NO_UPGRADERS:${roomName}`,
      type: "NO_UPGRADERS",
      severity: "high",
      description: "No upgraders - controller will downgrade",
      data: { upgraderCount, rcl },
    });
  }

  // 3. HAULER_SHORTAGE - Fewer haulers than harvesters
  if (haulerCount < harvesterCount && harvesterCount > 0 && rcl >= 3) {
    patterns.push({
      id: `HAULER_SHORTAGE:${roomName}`,
      type: "HAULER_SHORTAGE",
      severity: "medium",
      description: `Hauler shortage: ${haulerCount} haulers for ${harvesterCount} harvesters`,
      data: { haulerCount, harvesterCount },
    });
  }

  // 4. LOW_STORAGE - Storage below 50k
  if (energyStored < 50000 && rcl >= 4) {
    patterns.push({
      id: `LOW_STORAGE:${roomName}`,
      type: "LOW_STORAGE",
      severity: energyStored < 10000 ? "high" : "medium",
      description: `Low storage: ${energyStored} energy`,
      data: { energyStored },
    });
  }

  // 5. STORAGE_FULL - Storage above 900k
  if (energyStored > 900000) {
    patterns.push({
      id: `STORAGE_FULL:${roomName}`,
      type: "STORAGE_FULL",
      severity: "medium",
      description: `Storage nearly full: ${energyStored} energy`,
      data: { energyStored },
    });
  }

  // 6. CPU_BUCKET_LOW - Bucket draining
  if (cpuBucket < 5000) {
    patterns.push({
      id: `CPU_BUCKET_LOW:${roomName}`,
      type: "CPU_BUCKET_LOW",
      severity: cpuBucket < 2000 ? "high" : "medium",
      description: `CPU bucket low: ${cpuBucket}`,
      data: { cpuBucket, cpuUsed },
    });
  }

  // 7. ACTIVE_THREAT - Hostiles present
  if (hostileCount > 0) {
    patterns.push({
      id: `ACTIVE_THREAT:${roomName}`,
      type: "ACTIVE_THREAT",
      severity: hostileCount >= 3 ? "critical" : "high",
      description: `Active threat: ${hostileCount} hostiles`,
      data: { hostileCount },
    });
  }

  // 8. SPAWN_ENERGY_LOW - Spawn energy critically low
  if (energyAvailable < energyCapacity * 0.3 && energyStored < 10000) {
    patterns.push({
      id: `SPAWN_ENERGY_LOW:${roomName}`,
      type: "SPAWN_ENERGY_LOW",
      severity: "high",
      description: `Spawn energy critically low: ${energyAvailable}/${energyCapacity}`,
      data: { energyAvailable, energyCapacity, energyStored },
    });
  }

  // ========== Trend-based Patterns (from DynamoDB metrics) ==========

  // Get recent metrics for trend analysis
  const recentMetrics = await getRecentMetrics(roomName, 6); // Last 6 hours

  if (recentMetrics.length >= 2) {
    const oldest = recentMetrics[recentMetrics.length - 1];
    const newest = recentMetrics[0];
    const hourlyDelta = (newest.timestamp - oldest.timestamp) / (60 * 60 * 1000);

    // 9. ENERGY_DRAIN - Energy decreasing over time
    if (oldest.metrics?.energy_stored && newest.metrics?.energy_stored) {
      const energyChange = newest.metrics.energy_stored - oldest.metrics.energy_stored;
      const hourlyRate = hourlyDelta > 0 ? energyChange / hourlyDelta : 0;

      if (hourlyRate < -5000) {
        patterns.push({
          id: `ENERGY_DRAIN:${roomName}`,
          type: "ENERGY_DRAIN",
          severity: "high",
          description: `Energy draining: ${Math.round(hourlyRate)}/hour`,
          data: { hourlyRate, startEnergy: oldest.metrics.energy_stored, endEnergy: newest.metrics.energy_stored },
        });
      }
    }

    // 10. RCL_STALL - No RCL progress despite having energy
    if (oldest.metrics?.rcl_progress && newest.metrics?.rcl_progress) {
      const progressDelta = newest.metrics.rcl_progress - oldest.metrics.rcl_progress;
      const hourlyProgress = hourlyDelta > 0 ? progressDelta / hourlyDelta : 0;

      if (hourlyProgress < 1000 && energyStored > 200000 && rcl < 8) {
        patterns.push({
          id: `RCL_STALL:${roomName}`,
          type: "RCL_STALL",
          severity: "medium",
          description: `RCL progress stalled: ${Math.round(hourlyProgress)}/hour with ${energyStored} stored`,
          data: { hourlyProgress, energyStored, rcl },
        });
      }
    }

    // 11. CREEP_DECLINE - Creep count declining
    if (oldest.metrics?.creep_count && newest.metrics?.creep_count) {
      const creepChange = newest.metrics.creep_count - oldest.metrics.creep_count;

      if (creepChange < -5 && hourlyDelta >= 1) {
        patterns.push({
          id: `CREEP_DECLINE:${roomName}`,
          type: "CREEP_DECLINE",
          severity: "high",
          description: `Creep count declining: ${creepChange} over ${Math.round(hourlyDelta)} hours`,
          data: { creepChange, startCount: oldest.metrics.creep_count, endCount: newest.metrics.creep_count },
        });
      }
    }
  }

  console.log(`Detected ${patterns.length} patterns for ${roomName}`);

  return {
    ...event,
    patterns,
    patternCount: patterns.length,
  };
}

/**
 * Get recent metrics from DynamoDB for trend analysis
 */
async function getRecentMetrics(roomName, hours) {
  if (!METRICS_TABLE) return [];

  try {
    const since = Date.now() - hours * 60 * 60 * 1000;

    const response = await docClient.send(new QueryCommand({
      TableName: METRICS_TABLE,
      KeyConditionExpression: "roomName = :room AND #ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":since": since,
      },
      ScanIndexForward: false,
      Limit: 20,
    }));

    return response.Items || [];
  } catch (error) {
    console.log("Failed to get metrics:", error.message);
    return [];
  }
}
