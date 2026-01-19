import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { randomUUID } from "crypto";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const eventBridge = new EventBridgeClient({});

const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;

/**
 * Write recommendations to DynamoDB and emit events
 * Input: Analysis result from ClaudeAnalyzer
 * Output: Written recommendations with IDs
 */
export async function handler(event) {
  console.log("Writing recommendations:", JSON.stringify({
    roomName: event.roomName,
    recommendationCount: event.recommendations?.length || 0,
  }));

  const roomName = event.roomName;
  const timestamp = event.timestamp || Date.now();
  const recommendations = event.recommendations || [];

  const writtenRecommendations = [];
  const events = [];

  for (const rec of recommendations) {
    const id = randomUUID();
    const createdAt = timestamp;

    // Build the recommendation record
    const record = {
      id,
      roomName,
      createdAt,
      status: "pending",
      type: rec.type || "optimization",
      priority: rec.priority || "medium",
      title: rec.title,
      description: rec.description,
      expectedOutcome: rec.expectedOutcome,
      checkAfterMinutes: rec.checkAfterMinutes || 60,
      triggerType: event.triggerType,
      // Context for outcome evaluation
      contextSnapshot: {
        phase: event.currentState?.phase,
        healthScore: event.currentState?.health?.score,
        metrics: event.metrics_to_watch,
      },
      // TTL - recommendations expire after 30 days
      expiresAt: Math.floor((timestamp + 30 * 24 * 60 * 60 * 1000) / 1000),
    };

    // Write to DynamoDB
    await docClient.send(new PutCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Item: record,
    }));

    writtenRecommendations.push(record);

    // Create event for outcome tracking
    events.push({
      Source: "screeps.advisor",
      DetailType: "RecommendationCreated",
      Detail: JSON.stringify({
        recommendationId: id,
        roomName,
        type: rec.type,
        priority: rec.priority,
        checkAfterMinutes: rec.checkAfterMinutes || 60,
        createdAt,
      }),
      EventBusName: EVENT_BUS_NAME,
    });
  }

  // Send events to EventBridge
  if (events.length > 0) {
    await eventBridge.send(new PutEventsCommand({ Entries: events }));
    console.log(`Sent ${events.length} RecommendationCreated events`);
  }

  console.log(`Wrote ${writtenRecommendations.length} recommendations for ${roomName}`);

  return {
    roomName,
    summary: event.summary,
    recommendationCount: writtenRecommendations.length,
    recommendations: writtenRecommendations.map(r => ({
      id: r.id,
      type: r.type,
      priority: r.priority,
      title: r.title,
    })),
    metrics_to_watch: event.metrics_to_watch,
  };
}
