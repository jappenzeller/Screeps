import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const secretsClient = new SecretsManagerClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const ANTHROPIC_KEY_SECRET = process.env.ANTHROPIC_KEY_SECRET;
const OBSERVATIONS_TABLE = process.env.OBSERVATIONS_TABLE;
const SIGNALS_TABLE = process.env.SIGNALS_TABLE;

// Cache for API key
let cachedApiKey = null;

/**
 * Analyze colony context using Claude API - generates OBSERVATIONS not recommendations
 * Input: Context object from ContextBuilder
 * Output: Observations with pattern recognition
 */
export async function handler(event) {
  console.log("Analyzing context:", JSON.stringify({
    roomName: event.roomName,
    triggerType: event.triggerType,
    phase: event.currentState?.phase,
    health: event.currentState?.health?.score,
  }));

  const apiKey = await getAnthropicKey();

  // Get previous observations for this room (historical context)
  const previousObservations = await getPreviousObservations(event.roomName, 5);

  // Get recent signal events
  const recentSignals = await getRecentSignals(event.roomName, 1); // Last hour

  // Build the observation-focused prompt
  const prompt = buildObservationPrompt(event, previousObservations, recentSignals);

  // Call Claude API
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const result = await response.json();
  const analysisText = result.content[0]?.text || "";

  // Parse the observation response
  const observation = parseObservation(analysisText, event);

  console.log("Observation complete:", JSON.stringify({
    observationCount: observation.observations.length,
    patternCount: observation.patterns?.length || 0,
    correlationCount: observation.signalCorrelations?.length || 0,
  }));

  return observation;
}

/**
 * Get Anthropic API key from Secrets Manager
 */
async function getAnthropicKey() {
  if (cachedApiKey) return cachedApiKey;

  const response = await secretsClient.send(new GetSecretValueCommand({
    SecretId: ANTHROPIC_KEY_SECRET,
  }));

  cachedApiKey = response.SecretString;
  return cachedApiKey;
}

/**
 * Get previous observations for historical context
 */
async function getPreviousObservations(roomName, limit) {
  if (!OBSERVATIONS_TABLE) return [];

  try {
    const response = await docClient.send(new QueryCommand({
      TableName: OBSERVATIONS_TABLE,
      KeyConditionExpression: "roomName = :room",
      ExpressionAttributeValues: { ":room": roomName },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return response.Items || [];
  } catch (error) {
    console.log("Failed to get previous observations:", error.message);
    return [];
  }
}

/**
 * Get recent signal events
 */
async function getRecentSignals(roomName, hours) {
  if (!SIGNALS_TABLE) return [];

  try {
    const since = Date.now() - hours * 60 * 60 * 1000;
    const response = await docClient.send(new QueryCommand({
      TableName: SIGNALS_TABLE,
      KeyConditionExpression: "roomName = :room AND #ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":room": roomName,
        ":since": since,
      },
      ScanIndexForward: false,
      Limit: 10,
    }));

    // Flatten to just the events
    const events = [];
    for (const item of response.Items || []) {
      if (item.events) {
        events.push(...item.events);
      }
    }
    return events;
  } catch (error) {
    console.log("Failed to get recent signals:", error.message);
    return [];
  }
}

/**
 * Build the observation-focused prompt for Claude
 */
function buildObservationPrompt(context, previousObservations, recentSignals) {
  const { roomName, currentState, history, trigger } = context;

  // Format previous observations
  const prevObsText = previousObservations.length > 0
    ? previousObservations.map(obs => `
### ${new Date(obs.timestamp).toISOString()}
${(obs.observations || []).map(o => `- [${o.category}] ${o.summary}`).join('\n')}
${obs.patterns ? `Patterns noted: ${obs.patterns.map(p => p.description).join(', ')}` : ''}`).join('\n')
    : "No previous observations.";

  // Format signal events
  const signalsText = recentSignals.length > 0
    ? recentSignals.map(e => `- ${e.type}: ${e.metric} = ${e.value}${e.threshold ? ` (threshold: ${e.threshold})` : ''}${e.description ? ` - ${e.description}` : ''}`).join('\n')
    : "No recent signal events.";

  return `You are building a historical record of observations for a Screeps colony (room ${roomName}).

## Current Colony Snapshot
\`\`\`json
${JSON.stringify(currentState?.snapshot || {}, null, 2)}
\`\`\`

## Recent Signal Events
${signalsText}

## Your Previous Observations
${prevObsText}

## Recent Trends
${JSON.stringify(history?.trends || {}, null, 2)}

## Task

Analyze the current snapshot. You are building a historical record of observations - NOT generating recommendations.

1. **What do you notice?** List observations by category. Be specific - reference creep names, positions, IDs, exact numbers.

2. **What's changed?** Compare to your previous observations. Note improvements, regressions, or new issues.

3. **What patterns are emerging?** If you've noted something similar before, track it as a pattern with its trend (stable, improving, worsening, resolved).

4. **Signal correlations?** Do any of your observations explain or relate to the signal events?

Respond ONLY with valid JSON (no markdown code blocks):
{
  "observations": [
    {
      "category": "economy|population|behavior|infrastructure|defense|anomaly",
      "summary": "Brief one-line summary",
      "details": "Detailed explanation with specific references",
      "confidence": 0.0-1.0,
      "relatedEntities": ["CREEP_NAME", "structure_id", "25,30"]
    }
  ],
  "patterns": [
    {
      "description": "Pattern description",
      "trend": "stable|improving|worsening|resolved",
      "firstSeen": null,
      "occurrences": 1,
      "evidence": "What you're seeing that indicates this pattern"
    }
  ],
  "signalCorrelations": [
    {
      "metric": "metric_name",
      "observation": "Which observation this relates to",
      "hypothesis": "Why you think they're correlated"
    }
  ],
  "summary": "2-3 sentence overall assessment of colony state"
}`;
}

/**
 * Parse Claude's response into structured observation format
 */
function parseObservation(text, context) {
  const snapshotHash = JSON.stringify(context.currentState?.snapshot || {}).length.toString();

  try {
    // Try to parse directly as JSON
    let parsed;

    // Check if wrapped in code blocks
    const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1]);
    } else {
      parsed = JSON.parse(text);
    }

    return {
      id: `${context.roomName}_${Date.now()}`,
      roomName: context.roomName,
      timestamp: Date.now(),
      snapshotTick: context.currentState?.snapshot?.gameTick || 0,
      snapshotHash,
      observations: parsed.observations || [],
      patterns: parsed.patterns || [],
      signalCorrelations: parsed.signalCorrelations || [],
      summary: parsed.summary || "Analysis completed",
    };
  } catch (error) {
    console.error("Failed to parse Claude response:", error);

    // Return a fallback observation
    return {
      id: `${context.roomName}_${Date.now()}`,
      roomName: context.roomName,
      timestamp: Date.now(),
      snapshotTick: context.currentState?.snapshot?.gameTick || 0,
      snapshotHash,
      observations: [
        {
          category: "anomaly",
          summary: "Response parsing failed",
          details: text.substring(0, 500),
          confidence: 0.5,
          relatedEntities: [],
        },
      ],
      patterns: [],
      signalCorrelations: [],
      summary: "Analysis completed but response parsing failed",
      rawResponse: text,
    };
  }
}
