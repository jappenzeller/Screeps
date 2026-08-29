import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const KNOWLEDGE_TABLE = process.env.KNOWLEDGE_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const METRICS_TABLE = process.env.METRICS_TABLE;

/**
 * Build comprehensive context for AI analysis
 * Input: EventBridge event with trigger details
 * Output: Rich context object for Claude analysis
 */
export async function handler(event) {
  console.log("Building context for event:", JSON.stringify(event, null, 2));

  const detail = event.detail || event;
  const roomName = detail.roomName;
  const triggerType = event["detail-type"] || detail.triggerType || "Scheduled";

  if (!roomName) {
    throw new Error("roomName is required");
  }

  // Gather all context in parallel
  const [
    currentSnapshot,
    recentSnapshots,
    recentEvents,
    relevantKnowledge,
    previousRecommendations,
    metricsTrends,
    lastAnalysisTimestamp,
  ] = await Promise.all([
    getLatestSnapshot(roomName),
    getRecentSnapshots(roomName, 12), // Last 12 snapshots (~1 hour)
    getRecentEvents(roomName, 24 * 60 * 60 * 1000), // Last 24 hours
    getRelevantKnowledge(roomName, triggerType),
    getPreviousRecommendations(roomName, 10),
    getMetricsTrends(roomName),
    getLastAnalysisTimestamp(roomName),
  ]);

  // Calculate how long ago the last analysis ran (for throttling)
  // Use a large number (1 year in ms) instead of Infinity for JSON compatibility
  const recentAnalysisAge = lastAnalysisTimestamp
    ? Date.now() - lastAnalysisTimestamp
    : 365 * 24 * 60 * 60 * 1000;

  // Build the context object
  const context = {
    timestamp: Date.now(),
    triggerType,
    roomName,
    recentAnalysisAge, // Time since last analysis (ms) - for throttling

    // Current state
    currentState: {
      snapshot: currentSnapshot,
      phase: determinePhase(currentSnapshot),
      health: calculateHealth(currentSnapshot),
    },

    // Historical context
    history: {
      recentSnapshots: summarizeSnapshots(recentSnapshots),
      trends: metricsTrends,
      events: recentEvents,
    },

    // Learning context
    knowledge: {
      relevantPatterns: relevantKnowledge,
      previousRecommendations: summarizeRecommendations(previousRecommendations),
    },

    // Trigger details
    trigger: {
      type: triggerType,
      detail: detail,
    },
  };

  console.log("Context built:", JSON.stringify({
    roomName,
    triggerType,
    snapshotCount: recentSnapshots.length,
    eventCount: recentEvents.length,
    knowledgeCount: relevantKnowledge.length,
    recommendationCount: previousRecommendations.length,
  }));

  return context;
}

/**
 * Get the latest snapshot for a room
 */
async function getLatestSnapshot(roomName) {
  const response = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: "roomName = :room",
    ExpressionAttributeValues: { ":room": roomName },
    ScanIndexForward: false,
    Limit: 1,
  }));

  return response.Items?.[0] || null;
}

/**
 * Get recent snapshots for trend analysis
 */
async function getRecentSnapshots(roomName, limit) {
  const response = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: "roomName = :room",
    ExpressionAttributeValues: { ":room": roomName },
    ScanIndexForward: false,
    Limit: limit,
  }));

  return response.Items || [];
}

/**
 * Get recent events for the room
 */
async function getRecentEvents(roomName, windowMs) {
  const since = Date.now() - windowMs;

  const response = await docClient.send(new QueryCommand({
    TableName: EVENTS_TABLE,
    IndexName: "timestamp-index",
    KeyConditionExpression: "roomName = :room AND #ts > :since",
    ExpressionAttributeNames: { "#ts": "timestamp" },
    ExpressionAttributeValues: {
      ":room": roomName,
      ":since": since,
    },
    ScanIndexForward: false,
    Limit: 50,
  }));

  return response.Items || [];
}

/**
 * Get relevant knowledge patterns
 */
async function getRelevantKnowledge(roomName, triggerType) {
  // Map trigger types to knowledge categories
  const categoryMap = {
    ThreatDetected: "defense",
    EconomyAnomaly: "economy",
    RCLProgress: "progression",
    SignificantChange: "optimization",
    Scheduled: "general",
  };

  const category = categoryMap[triggerType] || "general";

  try {
    const response = await docClient.send(new QueryCommand({
      TableName: KNOWLEDGE_TABLE,
      IndexName: "category-success-index",
      KeyConditionExpression: "category = :cat",
      ExpressionAttributeValues: { ":cat": category },
      ScanIndexForward: false, // Highest success rate first
      Limit: 5,
    }));

    return response.Items || [];
  } catch (error) {
    console.log("Knowledge query failed (table may not exist yet):", error.message);
    return [];
  }
}

/**
 * Get previous recommendations for the room
 */
async function getPreviousRecommendations(roomName, limit) {
  try {
    const response = await docClient.send(new QueryCommand({
      TableName: RECOMMENDATIONS_TABLE,
      IndexName: "room-index",
      KeyConditionExpression: "roomName = :room",
      ExpressionAttributeValues: { ":room": roomName },
      ScanIndexForward: false,
      Limit: limit,
    }));

    return response.Items || [];
  } catch (error) {
    console.log("Recommendations query failed:", error.message);
    return [];
  }
}

/**
 * Get the timestamp of the last analysis/recommendation for this room
 * Used to throttle rapid-fire analysis
 */
async function getLastAnalysisTimestamp(roomName) {
  try {
    const response = await docClient.send(new QueryCommand({
      TableName: RECOMMENDATIONS_TABLE,
      IndexName: "room-index",
      KeyConditionExpression: "roomName = :room",
      ExpressionAttributeValues: { ":room": roomName },
      ScanIndexForward: false,
      Limit: 1,
      ProjectionExpression: "createdAt",
    }));

    return response.Items?.[0]?.createdAt || null;
  } catch (error) {
    console.log("Failed to get last analysis timestamp:", error.message);
    return null;
  }
}

/**
 * Get metrics trends from DynamoDB metrics history table
 */
async function getMetricsTrends(roomName) {
  try {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

    const response = await docClient.send(new QueryCommand({
      TableName: METRICS_TABLE,
      KeyConditionExpression: "roomName = :room AND #ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":since": sixHoursAgo,
      },
      ScanIndexForward: true,
    }));

    const items = response.Items || [];
    if (items.length === 0) return {};

    // Aggregate metrics across all records
    const aggregated = {};

    for (const item of items) {
      const metrics = item.metrics || {};
      for (const [key, value] of Object.entries(metrics)) {
        if (!aggregated[key]) {
          aggregated[key] = { values: [], sum: 0, min: Infinity, max: -Infinity };
        }
        aggregated[key].values.push(value);
        aggregated[key].sum += value;
        aggregated[key].min = Math.min(aggregated[key].min, value);
        aggregated[key].max = Math.max(aggregated[key].max, value);
      }
    }

    // Calculate trends
    const trends = {};
    for (const [key, data] of Object.entries(aggregated)) {
      trends[key] = {
        avg: data.sum / data.values.length,
        min: data.min,
        max: data.max,
        dataPoints: data.values.length,
      };
    }

    return trends;
  } catch (error) {
    console.log("DynamoDB metrics query failed:", error.message);
    return {};
  }
}

/**
 * Determine the colony phase from snapshot
 */
function determinePhase(snapshot) {
  if (!snapshot) return "UNKNOWN";

  const rcl = snapshot.rcl || 1;
  const threatLevel = snapshot.threatLevel || 0;

  if (threatLevel >= 2) return "EMERGENCY";
  if (rcl <= 2) return "BOOTSTRAP";
  if (rcl <= 4) return "DEVELOPING";
  return "STABLE";
}

/**
 * Calculate overall colony health
 * Handles both flat and nested snapshot structures
 */
function calculateHealth(snapshot) {
  if (!snapshot) return { score: 0, issues: ["No snapshot data"] };

  const issues = [];
  let score = 100;

  // Get energy values (handle nested or flat structure)
  const energyAvailable = snapshot.energy?.available ?? snapshot.energyAvailable;
  const energyCapacity = snapshot.energy?.capacity ?? snapshot.energyCapacity;
  const energyStored = snapshot.energy?.stored ?? snapshot.storageEnergy;

  // Check spawn energy
  if (energyAvailable !== undefined && energyCapacity !== undefined && energyCapacity > 0) {
    const energyRatio = energyAvailable / energyCapacity;
    if (energyRatio < 0.2) {
      score -= 20;
      issues.push("Low spawn energy");
    }
  }

  // Check storage
  if (energyStored !== undefined && energyStored < 10000) {
    score -= 15;
    issues.push("Low storage reserves");
  }

  // Check threats (handle nested or flat structure)
  const hostileCount = snapshot.threats?.hostileCount ?? snapshot.hostileCount ?? 0;
  const threatLevel = snapshot.threatLevel ?? (hostileCount > 0 ? 1 : 0);
  if (threatLevel > 0 || hostileCount > 0) {
    score -= Math.max(threatLevel, 1) * 10;
    issues.push(`Threat detected (${hostileCount} hostiles)`);
  }

  // Check creeps (handle nested or flat structure)
  const creepCount = snapshot.creeps?.total ?? snapshot.creepCount;
  if (creepCount !== undefined && creepCount < 5) {
    score -= 25;
    issues.push("Low creep count");
  }

  return {
    score: Math.max(0, score),
    issues,
  };
}

/**
 * Summarize snapshots for context
 * Handles both flat and nested snapshot structures
 */
function summarizeSnapshots(snapshots) {
  if (snapshots.length === 0) return null;

  const first = snapshots[snapshots.length - 1];
  const last = snapshots[0];

  // Helper to get energy values from either structure
  const getEnergy = (s, field) => s?.energy?.[field] ?? s?.[`energy${field.charAt(0).toUpperCase() + field.slice(1)}`] ?? 0;
  const getCreepCount = (s) => s?.creeps?.total ?? s?.creepCount ?? 0;

  return {
    timeSpanMs: last.timestamp - first.timestamp,
    count: snapshots.length,
    energyTrend: getEnergy(last, 'available') - getEnergy(first, 'available'),
    storageTrend: getEnergy(last, 'stored') - getEnergy(first, 'stored'),
    creepTrend: getCreepCount(last) - getCreepCount(first),
  };
}

/**
 * Summarize previous recommendations
 */
function summarizeRecommendations(recommendations) {
  const summary = {
    total: recommendations.length,
    byStatus: {},
    recentImplemented: [],
  };

  for (const rec of recommendations) {
    const status = rec.status || "pending";
    summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;

    if (status === "implemented" && rec.outcome) {
      summary.recentImplemented.push({
        type: rec.type,
        outcome: rec.outcome,
        successRate: rec.successRate,
      });
    }
  }

  return summary;
}
