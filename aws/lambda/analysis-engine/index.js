import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const RETENTION_DAYS = 30;

let anthropicClient = null;

async function getAnthropicClient() {
  if (anthropicClient) return anthropicClient;

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.ANTHROPIC_KEY_SECRET,
    })
  );

  anthropicClient = new Anthropic({ apiKey: response.SecretString });
  return anthropicClient;
}

async function getRecentSnapshots(roomName, hours = 6) {
  const since = Date.now() - hours * 60 * 60 * 1000;

  const response = await docClient.send(
    new QueryCommand({
      TableName: SNAPSHOTS_TABLE,
      KeyConditionExpression: "roomName = :room AND #ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":since": since,
      },
      ScanIndexForward: false,
      Limit: 100,
    })
  );

  return response.Items || [];
}

async function getRecentEvents(roomName, hours = 6) {
  const since = Date.now() - hours * 60 * 60 * 1000;

  const response = await docClient.send(
    new QueryCommand({
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
    })
  );

  return response.Items || [];
}

async function getActiveRooms() {
  // Get unique room names from recent snapshots
  const since = Date.now() - 60 * 60 * 1000; // Last hour

  const response = await docClient.send(
    new ScanCommand({
      TableName: SNAPSHOTS_TABLE,
      FilterExpression: "#ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: { ":since": since },
      ProjectionExpression: "roomName",
    })
  );

  const rooms = new Set();
  for (const item of response.Items || []) {
    rooms.add(item.roomName);
  }
  return Array.from(rooms);
}

function calculateTrends(snapshots) {
  if (snapshots.length < 2) return {};

  const latest = snapshots[0];
  const oldest = snapshots[snapshots.length - 1];
  const timeDiffHours = (latest.timestamp - oldest.timestamp) / (1000 * 60 * 60);

  return {
    energyChange: (latest.energy?.stored || 0) - (oldest.energy?.stored || 0),
    creepChange: (latest.creeps?.total || 0) - (oldest.creeps?.total || 0),
    rclProgress: (latest.rclProgress || 0) - (oldest.rclProgress || 0),
    avgEnergyPerHour: timeDiffHours > 0 ? ((latest.energy?.stored || 0) - (oldest.energy?.stored || 0)) / timeDiffHours : 0,
  };
}

function summarizeEvents(events) {
  const summary = {
    total: events.length,
    byType: {},
  };

  for (const event of events) {
    summary.byType[event.type] = (summary.byType[event.type] || 0) + 1;
  }

  return summary;
}

async function analyzeWithClaude(roomName, snapshots, events) {
  const client = await getAnthropicClient();

  const latest = snapshots[0];
  const oldest = snapshots[snapshots.length - 1];

  const dataSummary = {
    roomName,
    timeRange: {
      from: new Date(oldest.timestamp).toISOString(),
      to: new Date(latest.timestamp).toISOString(),
      snapshotCount: snapshots.length,
    },
    current: {
      rcl: latest.rcl,
      rclProgress: latest.rclProgress,
      rclProgressTotal: latest.rclProgressTotal,
      energy: latest.energy,
      creeps: latest.creeps,
      threats: latest.threats,
      structures: latest.structures,
      cpu: latest.global?.cpu,
    },
    trends: calculateTrends(snapshots),
    recentEvents: summarizeEvents(events),
  };

  const systemPrompt = `You are an expert AI advisor for Screeps, an MMO programming game. Your role is to analyze colony data and provide actionable recommendations to improve the player's bot performance.

Key metrics to watch:
- Energy flow: income vs spending, storage levels
- Creep population: role balance, replacement timing
- RCL progress: upgrade rate, time to next level
- CPU usage: efficiency, bucket health
- Threats: hostile activity, defense readiness

Provide specific, actionable advice based on the data patterns.`;

  const userPrompt = `Analyze this Screeps colony data and provide recommendations:

${JSON.stringify(dataSummary, null, 2)}

Respond ONLY with valid JSON in this exact format:
{
  "healthScore": <number 0-100>,
  "status": "<healthy|warning|critical>",
  "summary": "<one sentence overview>",
  "problems": [
    {"description": "<specific problem>", "severity": "<low|medium|high>"}
  ],
  "recommendations": [
    {
      "title": "<short title>",
      "description": "<detailed actionable advice>",
      "priority": <number 1-5, 1 being highest>,
      "category": "<economy|defense|expansion|optimization>"
    }
  ]
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      { role: "user", content: systemPrompt + "\n\n" + userPrompt },
    ],
  });

  const content = response.content[0].text;

  // Parse JSON from response (handle potential markdown code blocks)
  let jsonStr = content;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  } else {
    const plainMatch = content.match(/\{[\s\S]*\}/);
    if (plainMatch) {
      jsonStr = plainMatch[0];
    }
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse Claude response:", content);
    throw new Error("Failed to parse Claude response as JSON");
  }
}

async function storeRecommendations(roomName, analysis) {
  const timestamp = Date.now();
  const expiresAt = Math.floor(timestamp / 1000) + RETENTION_DAYS * 24 * 60 * 60;

  // Store overall analysis
  await docClient.send(
    new PutCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Item: {
        id: `analysis_${roomName}_${timestamp}`,
        roomName: roomName,
        createdAt: timestamp,
        expiresAt: expiresAt,
        type: "analysis",
        healthScore: analysis.healthScore,
        status: analysis.status,
        summary: analysis.summary,
        problems: analysis.problems,
      },
    })
  );

  // Store individual recommendations
  for (const rec of analysis.recommendations || []) {
    await docClient.send(
      new PutCommand({
        TableName: RECOMMENDATIONS_TABLE,
        Item: {
          id: uuidv4(),
          roomName: roomName,
          createdAt: timestamp,
          expiresAt: expiresAt,
          type: "recommendation",
          title: rec.title,
          description: rec.description,
          priority: rec.priority,
          category: rec.category,
          status: "pending",
          healthScore: analysis.healthScore,
          colonyStatus: analysis.status,
        },
      })
    );
  }

  console.log(`Stored analysis and ${analysis.recommendations?.length || 0} recommendations`);
}

export async function handler(event) {
  console.log("Analysis engine starting...");

  try {
    // Get rooms to analyze
    let rooms;
    if (event.roomName) {
      rooms = [event.roomName];
    } else {
      rooms = await getActiveRooms();
    }

    if (rooms.length === 0) {
      console.log("No active rooms found");
      return { statusCode: 200, body: "No rooms to analyze" };
    }

    const results = [];

    for (const roomName of rooms) {
      console.log(`Analyzing room: ${roomName}`);

      const snapshots = await getRecentSnapshots(roomName, 6);

      if (snapshots.length < 3) {
        console.log(`Skipping ${roomName}: insufficient data (${snapshots.length} snapshots)`);
        continue;
      }

      const events = await getRecentEvents(roomName, 6);

      console.log(`Got ${snapshots.length} snapshots and ${events.length} events for ${roomName}`);

      const analysis = await analyzeWithClaude(roomName, snapshots, events);

      console.log(`Analysis for ${roomName}: ${analysis.status}, score: ${analysis.healthScore}`);

      await storeRecommendations(roomName, analysis);

      results.push({
        roomName,
        status: analysis.status,
        healthScore: analysis.healthScore,
        recommendations: analysis.recommendations?.length || 0,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        analyzed: results.length,
        results,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}
