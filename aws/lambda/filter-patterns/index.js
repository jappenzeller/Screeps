import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const KNOWLEDGE_TABLE = process.env.KNOWLEDGE_TABLE;

// Minimum confidence threshold (0-1)
const MIN_CONFIDENCE = 0.3;
// Default confidence for unknown patterns
const DEFAULT_CONFIDENCE = 0.5;
// Time window for recently addressed patterns (2 hours)
const RECENTLY_ADDRESSED_MS = 2 * 60 * 60 * 1000;

/**
 * Filter patterns that already have pending recommendations or low confidence
 *
 * Input: { patterns: Pattern[], context: ... }
 * Output: { patterns: Pattern[], count: number, filtered: {...}, context: ... }
 */
export async function handler(event) {
  // Patterns come from detect-patterns step, stored at $.patternResult.patterns
  const patterns = event.patternResult?.patterns || event.patterns || [];
  const roomName = event.context?.roomName || event.context?.currentState?.snapshot?.roomName;

  console.log(`Filtering ${patterns.length} patterns for ${roomName}`);

  if (patterns.length === 0) {
    return {
      ...event,
      patterns: [],
      count: 0,
      filtered: { byPending: 0, byConfidence: 0, byRecent: 0 },
    };
  }

  // Get pending recommendations for this room
  const pendingRecs = await getPendingRecommendations(roomName);
  const pendingPatternTypes = new Set(pendingRecs.map(r => r.type));

  // Get recently addressed patterns (status = "applied" within last 2 hours)
  const recentlyAddressed = await getRecentlyAddressedPatterns(roomName);
  const recentPatternTypes = new Set(recentlyAddressed.map(r => r.type));

  // Get pattern confidences from knowledge table
  const patternConfidences = await getPatternConfidences(patterns.map(p => p.type));

  const filteredPatterns = [];
  const filterStats = { byPending: 0, byConfidence: 0, byRecent: 0 };

  for (const pattern of patterns) {
    // Skip if already has pending recommendation
    if (pendingPatternTypes.has(pattern.type)) {
      console.log(`Skipping ${pattern.type}: pending recommendation exists`);
      filterStats.byPending++;
      continue;
    }

    // Skip if recently addressed
    if (recentPatternTypes.has(pattern.type)) {
      console.log(`Skipping ${pattern.type}: recently addressed`);
      filterStats.byRecent++;
      continue;
    }

    // Check confidence
    const confidence = patternConfidences[pattern.type] ?? DEFAULT_CONFIDENCE;
    if (confidence < MIN_CONFIDENCE) {
      console.log(`Skipping ${pattern.type}: low confidence (${confidence})`);
      filterStats.byConfidence++;
      continue;
    }

    // Include pattern with its confidence
    filteredPatterns.push({
      ...pattern,
      confidence,
    });
  }

  console.log(`Filtered to ${filteredPatterns.length} patterns (pending: ${filterStats.byPending}, confidence: ${filterStats.byConfidence}, recent: ${filterStats.byRecent})`);

  return {
    ...event,
    patterns: filteredPatterns,
    count: filteredPatterns.length,
    filtered: filterStats,
  };
}

/**
 * Get pending recommendations for a room
 */
async function getPendingRecommendations(roomName) {
  if (!RECOMMENDATIONS_TABLE || !roomName) return [];

  try {
    const response = await docClient.send(new QueryCommand({
      TableName: RECOMMENDATIONS_TABLE,
      IndexName: "room-index",
      KeyConditionExpression: "roomName = :room",
      FilterExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":pending": "pending",
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
 * Get recently addressed patterns for a room
 */
async function getRecentlyAddressedPatterns(roomName) {
  if (!RECOMMENDATIONS_TABLE || !roomName) return [];

  try {
    const since = Date.now() - RECENTLY_ADDRESSED_MS;

    const response = await docClient.send(new QueryCommand({
      TableName: RECOMMENDATIONS_TABLE,
      IndexName: "room-index",
      KeyConditionExpression: "roomName = :room",
      FilterExpression: "#status = :applied AND createdAt > :since",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":applied": "applied",
        ":since": since,
      },
      Limit: 50,
    }));

    return response.Items || [];
  } catch (error) {
    console.log("Failed to get recent recommendations:", error.message);
    return [];
  }
}

/**
 * Get pattern confidence scores from knowledge table
 */
async function getPatternConfidences(patternTypes) {
  if (!KNOWLEDGE_TABLE || patternTypes.length === 0) return {};

  const confidences = {};

  // Query confidence for each unique pattern type
  const uniqueTypes = [...new Set(patternTypes)];

  for (const patternType of uniqueTypes) {
    try {
      // Knowledge table key format: _global|confidence:{patternType}
      const key = `_global|confidence:${patternType}`;

      const response = await docClient.send(new GetCommand({
        TableName: KNOWLEDGE_TABLE,
        Key: { patternHash: key },
      }));

      if (response.Item?.confidence !== undefined) {
        confidences[patternType] = response.Item.confidence;
      }
    } catch (error) {
      // Ignore individual lookup failures
    }
  }

  return confidences;
}
