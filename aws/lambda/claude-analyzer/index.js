import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});
const ANTHROPIC_KEY_SECRET = process.env.ANTHROPIC_KEY_SECRET;

// Cache for API key
let cachedApiKey = null;

/**
 * Analyze colony context using Claude API
 * Input: Context object from ContextBuilder
 * Output: Analysis with recommendations
 */
export async function handler(event) {
  console.log("Analyzing context:", JSON.stringify({
    roomName: event.roomName,
    triggerType: event.triggerType,
    phase: event.currentState?.phase,
    health: event.currentState?.health?.score,
  }));

  const apiKey = await getAnthropicKey();
  const prompt = buildPrompt(event);

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

  // Parse the structured response
  const analysis = parseAnalysis(analysisText, event);

  console.log("Analysis complete:", JSON.stringify({
    recommendationCount: analysis.recommendations.length,
    urgentCount: analysis.recommendations.filter(r => r.priority === "urgent").length,
  }));

  return analysis;
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
 * Build the analysis prompt for Claude
 */
function buildPrompt(context) {
  const { roomName, triggerType, currentState, history, knowledge, trigger } = context;

  return `You are an AI advisor for a Screeps colony (room ${roomName}). Analyze the current state and provide actionable recommendations.

## Current State
- Phase: ${currentState?.phase || "UNKNOWN"}
- Health Score: ${currentState?.health?.score || 0}/100
- Issues: ${currentState?.health?.issues?.join(", ") || "None"}

## Snapshot Data
${JSON.stringify(currentState?.snapshot || {}, null, 2)}

## Recent Trends
${JSON.stringify(history?.trends || {}, null, 2)}

## Historical Summary
${JSON.stringify(history?.recentSnapshots || {}, null, 2)}

## Trigger Event
- Type: ${triggerType}
- Details: ${JSON.stringify(trigger?.detail || {}, null, 2)}

## Previous Recommendations Summary
${JSON.stringify(knowledge?.previousRecommendations || {}, null, 2)}

## Relevant Knowledge Patterns
${JSON.stringify(knowledge?.relevantPatterns || [], null, 2)}

---

Based on this analysis, provide recommendations in the following JSON format:

\`\`\`json
{
  "summary": "Brief overall assessment (1-2 sentences)",
  "recommendations": [
    {
      "type": "economy|defense|progression|optimization",
      "priority": "urgent|high|medium|low",
      "title": "Short title",
      "description": "Detailed description of what to do",
      "expectedOutcome": "What metrics should improve",
      "checkAfterMinutes": 30
    }
  ],
  "metrics_to_watch": ["metric1", "metric2"]
}
\`\`\`

Focus on:
1. Immediate issues that need attention (if any)
2. Optimization opportunities based on trends
3. Phase-appropriate advice (${currentState?.phase})
4. Learning from previous recommendation outcomes

Provide 1-3 specific, actionable recommendations. Be concise.`;
}

/**
 * Parse Claude's response into structured format
 */
function parseAnalysis(text, context) {
  try {
    // Extract JSON from the response
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        roomName: context.roomName,
        timestamp: Date.now(),
        triggerType: context.triggerType,
        ...parsed,
      };
    }

    // Try to parse the entire response as JSON
    const parsed = JSON.parse(text);
    return {
      roomName: context.roomName,
      timestamp: Date.now(),
      triggerType: context.triggerType,
      ...parsed,
    };
  } catch (error) {
    console.error("Failed to parse Claude response:", error);

    // Return a basic structure with the raw text
    return {
      roomName: context.roomName,
      timestamp: Date.now(),
      triggerType: context.triggerType,
      summary: "Analysis completed but response parsing failed",
      recommendations: [
        {
          type: "optimization",
          priority: "low",
          title: "Manual Review Needed",
          description: text.substring(0, 500),
          expectedOutcome: "Unknown",
          checkAfterMinutes: 60,
        },
      ],
      metrics_to_watch: [],
      rawResponse: text,
    };
  }
}
