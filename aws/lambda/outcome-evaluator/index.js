import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const KNOWLEDGE_TABLE = process.env.KNOWLEDGE_TABLE;
const METRICS_TABLE = process.env.METRICS_TABLE;

// Recommendation age before it expires (24 hours)
const EXPIRY_MS = 24 * 60 * 60 * 1000;
// Default confidence for new patterns
const DEFAULT_CONFIDENCE = 0.5;
// Confidence bounds
const MIN_CONFIDENCE = 0.0;
const MAX_CONFIDENCE = 1.0;

/**
 * Outcome Evaluator Lambda (Phase 4 - Learning Loop)
 *
 * Triggered by DynamoDB Stream on snapshots table (INSERT events only).
 * For each new snapshot, evaluates pending recommendations to determine if patterns are resolved.
 * Updates recommendation status and pattern confidence scores in knowledge table.
 *
 * Statuses:
 *   - resolved_helpful: Pattern resolved with measurable improvement
 *   - resolved_natural: Pattern resolved without clear improvement
 *   - resolved_unknown: Pattern resolved, no baseline metrics available
 *   - expired: Recommendation expired (24h) without resolution
 */
export async function handler(event) {
  console.log(`Processing ${event.Records?.length || 0} stream records`);

  const results = {
    processed: 0,
    evaluated: 0,
    errors: 0,
  };

  for (const record of event.Records || []) {
    // Only process INSERT events (new snapshots)
    if (record.eventName !== "INSERT") {
      continue;
    }

    try {
      // Extract snapshot from stream record
      const snapshot = unmarshall(record.dynamodb.NewImage);
      const roomName = snapshot.roomName;

      if (!roomName) {
        console.log("Skipping record without roomName");
        continue;
      }

      results.processed++;

      // Load pending recommendations for this room
      const pendingRecs = await getPendingRecommendations(roomName);

      if (pendingRecs.length === 0) {
        console.log(`No pending recommendations for ${roomName}`);
        continue;
      }

      console.log(`Evaluating ${pendingRecs.length} pending recommendations for ${roomName}`);

      // Evaluate each recommendation
      for (const rec of pendingRecs) {
        try {
          const evaluation = await evaluateRecommendation(rec, snapshot);

          if (evaluation.newStatus) {
            // Update recommendation status
            await updateRecommendationStatus(rec.id, evaluation);

            // Record outcome in knowledge table
            await recordOutcome(rec, evaluation);

            // Update pattern confidence
            if (evaluation.confidenceChange !== 0) {
              await updatePatternConfidence(rec.type, evaluation.confidenceChange);
            }

            results.evaluated++;
            console.log(`Evaluated rec ${rec.id}: pending -> ${evaluation.newStatus} (${evaluation.reason})`);
          }
        } catch (error) {
          console.error(`Error evaluating recommendation ${rec.id}:`, error.message);
          results.errors++;
        }
      }
    } catch (error) {
      console.error("Error processing stream record:", error.message);
      results.errors++;
    }
  }

  console.log(`Outcome evaluation complete:`, results);
  return results;
}

/**
 * Get pending recommendations for a room using room-status-index GSI
 */
async function getPendingRecommendations(roomName) {
  if (!RECOMMENDATIONS_TABLE) return [];

  try {
    const response = await docClient.send(new QueryCommand({
      TableName: RECOMMENDATIONS_TABLE,
      IndexName: "room-status-index",
      KeyConditionExpression: "roomName = :room AND #status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":status": "pending",
      },
      Limit: 50,
    }));

    return response.Items || [];
  } catch (error) {
    console.log("Failed to get pending recommendations:", error.message);
    return [];
  }
}

/**
 * Evaluate a recommendation against the current snapshot
 */
async function evaluateRecommendation(rec, snapshot) {
  const now = Date.now();
  const age = now - rec.createdAt;

  // Check if pattern is resolved
  const patternResolved = isPatternResolved(rec.type, snapshot);

  if (patternResolved) {
    // Pattern is resolved - compare before/after metrics
    const beforeMetrics = await getMetricsAtTime(snapshot.roomName, rec.createdAt);
    const outcome = determineOutcome(rec, snapshot, beforeMetrics);

    return {
      newStatus: outcome.status,
      reason: outcome.reason,
      confidenceChange: outcome.confidenceChange,
      evaluatedAt: now,
    };
  }

  // Pattern not resolved - check if expired
  if (age > EXPIRY_MS) {
    return {
      newStatus: "expired",
      reason: "Recommendation expired after 24 hours without resolution",
      confidenceChange: 0,
      evaluatedAt: now,
    };
  }

  // Still pending - no status change
  return {
    newStatus: null,
    reason: null,
    confidenceChange: 0,
  };
}

/**
 * Check if a pattern type is resolved based on snapshot data
 */
function isPatternResolved(patternType, snapshot) {
  // Extract metrics from snapshot (handle nested structure)
  const energyStored = snapshot.energy?.stored ?? 0;
  const energyAvailable = snapshot.energy?.available ?? 0;
  const energyCapacity = snapshot.energy?.capacity ?? 300;
  const creepTotal = snapshot.creeps?.total ?? 0;
  const byRole = snapshot.creeps?.byRole ?? {};
  const rcl = snapshot.rcl ?? 1;
  const hostileCount = snapshot.threats?.hostileCount ?? 0;
  const cpuBucket = snapshot.global?.cpu?.bucket ?? 10000;

  // Normalize role names to uppercase
  const roleCount = {};
  for (const [role, count] of Object.entries(byRole)) {
    roleCount[role.toUpperCase()] = count;
  }
  const harvesterCount = roleCount.HARVESTER ?? roleCount.MINER ?? 0;
  const haulerCount = roleCount.HAULER ?? roleCount.FILLER ?? 0;
  const upgraderCount = roleCount.UPGRADER ?? 0;

  switch (patternType) {
    case "NO_MINERS":
      return harvesterCount > 0;

    case "NO_UPGRADERS":
      return upgraderCount > 0 || rcl >= 8;

    case "HAULER_SHORTAGE":
      return haulerCount >= harvesterCount || harvesterCount === 0;

    case "LOW_STORAGE":
      return energyStored >= 50000;

    case "STORAGE_FULL":
      return energyStored < 900000;

    case "CPU_BUCKET_LOW":
      return cpuBucket >= 5000;

    case "ACTIVE_THREAT":
      return hostileCount === 0;

    case "SPAWN_ENERGY_LOW":
      return energyAvailable >= energyCapacity * 0.3 || energyStored >= 10000;

    case "CREEP_DECLINE":
      // Resolved if creep count is stable
      return creepTotal >= 5;

    // Trend-based patterns need metric comparison
    case "ENERGY_DRAIN":
    case "RCL_STALL":
      // These will be evaluated in determineOutcome with metric trends
      return false;

    default:
      // Old-style recommendations or unknown patterns - check by category
      return isOldStylePatternResolved(patternType, snapshot);
  }
}

/**
 * Handle old-style recommendations (type: "recommendation", category: "spawning", etc.)
 */
function isOldStylePatternResolved(type, snapshot) {
  // For old recommendations without proper pattern types,
  // we can't reliably determine resolution - return false
  // They will expire after 24 hours
  return false;
}

/**
 * Determine outcome by comparing before/after metrics
 */
function determineOutcome(rec, snapshot, beforeMetrics) {
  // If no before metrics available, mark as resolved with unknown attribution
  if (!beforeMetrics) {
    return {
      status: "resolved_unknown",
      reason: "Pattern resolved, no baseline metrics available",
      confidenceChange: 0,
    };
  }

  const energyStored = snapshot.energy?.stored ?? 0;
  const beforeEnergy = beforeMetrics.energy_stored ?? 0;

  const creepTotal = snapshot.creeps?.total ?? 0;
  const beforeCreeps = beforeMetrics.creep_count ?? 0;

  // Check for meaningful improvement
  let improved = false;
  let reason = "Pattern resolved";

  switch (rec.type) {
    case "NO_MINERS":
    case "NO_UPGRADERS":
    case "HAULER_SHORTAGE":
    case "CREEP_DECLINE":
      // Workforce patterns - improvement if creep count increased
      improved = creepTotal > beforeCreeps;
      reason = improved
        ? `Creep count improved: ${beforeCreeps} -> ${creepTotal}`
        : `Pattern resolved naturally (creeps: ${beforeCreeps} -> ${creepTotal})`;
      break;

    case "LOW_STORAGE":
    case "SPAWN_ENERGY_LOW":
    case "ENERGY_DRAIN":
      // Economy patterns - improvement if energy increased by 10%+
      improved = energyStored > beforeEnergy * 1.1;
      reason = improved
        ? `Energy improved: ${beforeEnergy} -> ${energyStored}`
        : `Pattern resolved naturally (energy: ${beforeEnergy} -> ${energyStored})`;
      break;

    case "STORAGE_FULL":
      // Opposite - improvement if energy decreased
      improved = energyStored < beforeEnergy * 0.9;
      reason = improved
        ? `Storage reduced: ${beforeEnergy} -> ${energyStored}`
        : `Pattern resolved naturally`;
      break;

    case "CPU_BUCKET_LOW":
      // Improvement if bucket increased
      const cpuBucket = snapshot.global?.cpu?.bucket ?? 10000;
      const beforeBucket = beforeMetrics.cpu_bucket ?? 10000;
      improved = cpuBucket > beforeBucket * 1.1;
      reason = improved
        ? `CPU bucket improved: ${beforeBucket} -> ${cpuBucket}`
        : `Pattern resolved naturally`;
      break;

    case "ACTIVE_THREAT":
      // Threats cleared - always mark as helpful if cleared
      improved = true;
      reason = "Threat neutralized";
      break;

    case "RCL_STALL":
      // Improvement if RCL progress rate increased
      const rclProgress = snapshot.rclProgress ?? 0;
      const beforeProgress = beforeMetrics.rcl_progress ?? 0;
      improved = rclProgress > beforeProgress;
      reason = improved
        ? `RCL progress resumed: ${beforeProgress} -> ${rclProgress}`
        : `Pattern resolved naturally`;
      break;

    default:
      // Unknown pattern type - no confidence change
      return {
        status: "resolved_unknown",
        reason: "Pattern type not recognized for outcome evaluation",
        confidenceChange: 0,
      };
  }

  if (improved) {
    return {
      status: "resolved_helpful",
      reason,
      confidenceChange: 0.1,
    };
  } else {
    return {
      status: "resolved_natural",
      reason,
      confidenceChange: -0.05,
    };
  }
}

/**
 * Get metrics at a specific time from metrics history
 */
async function getMetricsAtTime(roomName, timestamp) {
  if (!METRICS_TABLE) return null;

  try {
    // Find metrics closest to the target timestamp
    const response = await docClient.send(new QueryCommand({
      TableName: METRICS_TABLE,
      KeyConditionExpression: "roomName = :room AND #ts <= :ts",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":ts": timestamp,
      },
      ScanIndexForward: false,
      Limit: 1,
    }));

    if (response.Items?.length > 0) {
      return response.Items[0].metrics || response.Items[0];
    }

    return null;
  } catch (error) {
    console.log("Failed to get metrics at time:", error.message);
    return null;
  }
}

/**
 * Update recommendation status in DynamoDB
 */
async function updateRecommendationStatus(id, evaluation) {
  if (!RECOMMENDATIONS_TABLE) return;

  try {
    await docClient.send(new UpdateCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Key: { id },
      UpdateExpression: "SET #status = :status, evaluatedAt = :evaluatedAt, evaluationReason = :reason",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": evaluation.newStatus,
        ":evaluatedAt": evaluation.evaluatedAt,
        ":reason": evaluation.reason,
      },
    }));
  } catch (error) {
    console.error("Failed to update recommendation status:", error.message);
    throw error;
  }
}

/**
 * Record outcome in knowledge table
 */
async function recordOutcome(rec, evaluation) {
  if (!KNOWLEDGE_TABLE) return;

  try {
    const outcomeKey = `_global|outcome:${rec.id}`;

    await docClient.send(new PutCommand({
      TableName: KNOWLEDGE_TABLE,
      Item: {
        patternHash: outcomeKey,
        recommendationId: rec.id,
        patternType: rec.type,
        roomName: rec.roomName,
        status: evaluation.newStatus,
        reason: evaluation.reason,
        confidenceChange: evaluation.confidenceChange,
        timestamp: evaluation.evaluatedAt,
        createdAt: rec.createdAt,
      },
    }));
  } catch (error) {
    console.error("Failed to record outcome:", error.message);
    // Non-fatal - continue
  }
}

/**
 * Update pattern confidence in knowledge table
 * Confidence range: [0.0, 1.0], default 0.5
 * Patterns with confidence < 0.3 are suppressed by filter-patterns Lambda
 */
async function updatePatternConfidence(patternType, delta) {
  if (!KNOWLEDGE_TABLE || !patternType) return;

  // Skip for old-style recommendations without proper pattern types
  if (patternType === "recommendation" || patternType === "optimization") {
    return;
  }

  try {
    const confidenceKey = `_global|confidence:${patternType}`;

    // Update confidence with delta
    await docClient.send(new UpdateCommand({
      TableName: KNOWLEDGE_TABLE,
      Key: { patternHash: confidenceKey },
      UpdateExpression: "SET confidence = if_not_exists(confidence, :default) + :delta, updatedAt = :now, patternType = :type",
      ExpressionAttributeValues: {
        ":default": DEFAULT_CONFIDENCE,
        ":delta": delta,
        ":now": Date.now(),
        ":type": patternType,
      },
    }));

    // Read back and clamp if out of bounds
    const result = await docClient.send(new GetCommand({
      TableName: KNOWLEDGE_TABLE,
      Key: { patternHash: confidenceKey },
    }));

    const currentConfidence = result.Item?.confidence ?? DEFAULT_CONFIDENCE;

    if (currentConfidence < MIN_CONFIDENCE || currentConfidence > MAX_CONFIDENCE) {
      const clampedConfidence = Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, currentConfidence));

      await docClient.send(new UpdateCommand({
        TableName: KNOWLEDGE_TABLE,
        Key: { patternHash: confidenceKey },
        UpdateExpression: "SET confidence = :conf",
        ExpressionAttributeValues: {
          ":conf": clampedConfidence,
        },
      }));

      console.log(`Clamped confidence for ${patternType}: ${currentConfidence.toFixed(2)} -> ${clampedConfidence.toFixed(2)}`);
    }
  } catch (error) {
    console.error("Failed to update pattern confidence:", error.message);
    // Non-fatal - continue
  }
}
