import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { createHash } from "crypto";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const scheduler = new SchedulerClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const KNOWLEDGE_TABLE = process.env.KNOWLEDGE_TABLE;
const METRICS_TABLE = process.env.METRICS_TABLE;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN;

/**
 * Evaluate recommendation outcomes and update knowledge base
 * Triggered by:
 * 1. RecommendationCreated event (schedules delayed check)
 * 2. Scheduled invocation (performs actual evaluation)
 */
export async function handler(event) {
  console.log("Outcome evaluator invoked:", JSON.stringify(event, null, 2));

  // Check if this is a scheduled callback or a new recommendation event
  if (event["detail-type"] === "RecommendationCreated") {
    // Schedule a delayed check
    return scheduleOutcomeCheck(event.detail);
  } else if (event.recommendationId) {
    // This is a scheduled callback - evaluate the outcome
    return evaluateOutcome(event.recommendationId);
  }

  console.log("Unknown event type, skipping");
  return { skipped: true };
}

/**
 * Schedule a delayed outcome check using EventBridge Scheduler
 */
async function scheduleOutcomeCheck(detail) {
  const { recommendationId, checkAfterMinutes, roomName } = detail;

  const scheduleTime = new Date(Date.now() + (checkAfterMinutes || 60) * 60 * 1000);
  const scheduleName = `screeps-outcome-${recommendationId.substring(0, 8)}`;

  try {
    await scheduler.send(new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `at(${scheduleTime.toISOString().replace(/\.\d{3}Z$/, "")})`,
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: {
        Arn: process.env.AWS_LAMBDA_FUNCTION_ARN || `arn:aws:lambda:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:function:screeps-outcome-evaluator-prod`,
        RoleArn: SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({
          recommendationId,
          roomName,
          scheduledAt: Date.now(),
        }),
      },
      ActionAfterCompletion: "DELETE",
    }));

    console.log(`Scheduled outcome check for ${recommendationId} at ${scheduleTime.toISOString()}`);
    return { scheduled: true, recommendationId, checkAt: scheduleTime.toISOString() };
  } catch (error) {
    console.error("Failed to schedule outcome check:", error);
    return { scheduled: false, error: error.message };
  }
}

/**
 * Evaluate the outcome of a recommendation
 */
async function evaluateOutcome(recommendationId) {
  // Get the recommendation
  const recResponse = await docClient.send(new GetCommand({
    TableName: RECOMMENDATIONS_TABLE,
    Key: { id: recommendationId },
  }));

  const recommendation = recResponse.Item;
  if (!recommendation) {
    console.log(`Recommendation ${recommendationId} not found`);
    return { error: "Recommendation not found" };
  }

  // Skip if already evaluated
  if (recommendation.status === "evaluated") {
    console.log(`Recommendation ${recommendationId} already evaluated`);
    return { skipped: true, reason: "already_evaluated" };
  }

  const roomName = recommendation.roomName;
  const createdAt = recommendation.createdAt;

  // Get metrics before and after the recommendation
  const [beforeMetrics, afterMetrics, currentSnapshot] = await Promise.all([
    getMetricsAround(roomName, createdAt - 30 * 60 * 1000, createdAt), // 30 min before
    getMetricsAround(roomName, createdAt, Date.now()), // After recommendation
    getLatestSnapshot(roomName),
  ]);

  // Calculate outcome
  const outcome = calculateOutcome(recommendation, beforeMetrics, afterMetrics, currentSnapshot);

  // Update the recommendation with outcome
  await docClient.send(new UpdateCommand({
    TableName: RECOMMENDATIONS_TABLE,
    Key: { id: recommendationId },
    UpdateExpression: "SET #status = :status, outcome = :outcome, evaluatedAt = :now",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": "evaluated",
      ":outcome": outcome,
      ":now": Date.now(),
    },
  }));

  // Update knowledge base
  await updateKnowledge(recommendation, outcome);

  console.log(`Evaluated recommendation ${recommendationId}: ${outcome.success ? "SUCCESS" : "FAILURE"} (confidence: ${outcome.confidence})`);

  return {
    recommendationId,
    outcome,
  };
}

/**
 * Get metrics around a time window from DynamoDB metrics history table
 */
async function getMetricsAround(roomName, startTime, endTime) {
  try {
    const response = await docClient.send(new QueryCommand({
      TableName: METRICS_TABLE,
      KeyConditionExpression: "roomName = :room AND #ts BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":start": startTime,
        ":end": endTime,
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
          aggregated[key] = { sum: 0, count: 0 };
        }
        aggregated[key].sum += value;
        aggregated[key].count++;
      }
    }

    // Calculate averages
    const result = {};
    for (const [key, data] of Object.entries(aggregated)) {
      result[key] = data.sum / data.count;
    }

    return result;
  } catch (error) {
    console.log("Metrics query failed:", error.message);
    return {};
  }
}

/**
 * Get latest snapshot for a room
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
 * Calculate the outcome of a recommendation
 */
function calculateOutcome(recommendation, beforeMetrics, afterMetrics, currentSnapshot) {
  const type = recommendation.type;
  const expectedOutcome = recommendation.expectedOutcome || "";

  let success = false;
  let confidence = 0.5;
  let details = {};

  // Type-specific evaluation
  switch (type) {
    case "economy":
      // Check energy-related metrics
      const energyBefore = beforeMetrics.storage_energy || beforeMetrics.energy_available || 0;
      const energyAfter = afterMetrics.storage_energy || afterMetrics.energy_available || 0;
      const energyChange = energyAfter - energyBefore;

      success = energyChange > 0;
      confidence = Math.min(1, Math.abs(energyChange) / 10000);
      details = { energyBefore, energyAfter, change: energyChange };
      break;

    case "defense":
      // Check threat level and hostile count
      const threatBefore = beforeMetrics.threat_level || 0;
      const threatAfter = afterMetrics.threat_level || 0;

      success = threatAfter <= threatBefore;
      confidence = 0.7; // Defense is hard to measure
      details = { threatBefore, threatAfter };
      break;

    case "progression":
      // Check RCL and controller progress
      const progressBefore = beforeMetrics.controller_progress || 0;
      const progressAfter = afterMetrics.controller_progress || 0;
      const progressChange = progressAfter - progressBefore;

      success = progressChange > 0;
      confidence = Math.min(1, progressChange / 100000);
      details = { progressBefore, progressAfter, change: progressChange };
      break;

    case "optimization":
    default:
      // General health check
      const currentHealth = currentSnapshot?.healthScore || 50;
      const contextHealth = recommendation.contextSnapshot?.healthScore || 50;

      success = currentHealth >= contextHealth;
      confidence = 0.5;
      details = { healthBefore: contextHealth, healthAfter: currentHealth };
      break;
  }

  return {
    success,
    confidence,
    type,
    details,
    evaluatedAt: Date.now(),
  };
}

/**
 * Update the knowledge base with outcome data
 */
async function updateKnowledge(recommendation, outcome) {
  // Create a pattern hash for this type of recommendation
  const patternHash = createHash("md5")
    .update(`${recommendation.type}-${recommendation.title}`)
    .digest("hex")
    .substring(0, 16);

  try {
    // Try to get existing knowledge
    const existing = await docClient.send(new GetCommand({
      TableName: KNOWLEDGE_TABLE,
      Key: { patternHash },
    }));

    if (existing.Item) {
      // Update existing knowledge
      const item = existing.Item;
      const totalAttempts = (item.totalAttempts || 0) + 1;
      const successCount = (item.successCount || 0) + (outcome.success ? 1 : 0);
      const successRate = successCount / totalAttempts;

      await docClient.send(new UpdateCommand({
        TableName: KNOWLEDGE_TABLE,
        Key: { patternHash },
        UpdateExpression: "SET totalAttempts = :total, successCount = :success, successRate = :rate, lastUpdated = :now, lastOutcome = :outcome",
        ExpressionAttributeValues: {
          ":total": totalAttempts,
          ":success": successCount,
          ":rate": successRate,
          ":now": Date.now(),
          ":outcome": outcome,
        },
      }));
    } else {
      // Create new knowledge entry
      await docClient.send(new PutCommand({
        TableName: KNOWLEDGE_TABLE,
        Item: {
          patternHash,
          category: recommendation.type,
          title: recommendation.title,
          description: recommendation.description,
          totalAttempts: 1,
          successCount: outcome.success ? 1 : 0,
          successRate: outcome.success ? 1 : 0,
          createdAt: Date.now(),
          lastUpdated: Date.now(),
          lastOutcome: outcome,
        },
      }));
    }

    console.log(`Updated knowledge for pattern ${patternHash}: success=${outcome.success}`);
  } catch (error) {
    console.error("Failed to update knowledge:", error);
  }
}
