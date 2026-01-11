import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import Anthropic from "@anthropic-ai/sdk";

const dynamodb = new DynamoDBClient({});
const secretsManager = new SecretsManagerClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE!;
const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE!;
const PATTERN_STATE_TABLE = process.env.PATTERN_STATE_TABLE!;
const ANTHROPIC_KEY_SECRET = process.env.ANTHROPIC_KEY_SECRET!;

// Pattern detection types
interface PatternMatch {
  patternId: string;
  confidence: number;
  evidence: string[];
  timeRange: [number, number];
}

interface Recommendation {
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  category: "economy" | "spawning" | "combat" | "efficiency" | "architecture";
  problem: string;
  rootCause: string;
  solution: string;
  expectedImpact: string;
  confidence: number;
  createdAt: number;
  status: "pending" | "applied" | "dismissed";
}

// Helper functions
function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

// Pattern detectors
const patternDetectors: Array<{
  id: string;
  name: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  detect: (snapshots: any[], events: any[]) => PatternMatch | null;
}> = [
  {
    id: "energy_starvation",
    name: "Energy Starvation",
    description: "Creeps waiting for energy while harvesters are not fully utilized",
    severity: "high",
    detect: (snapshots) => {
      if (snapshots.length < 12) return null;
      const recent = snapshots.slice(-12);

      const avgIdleCreeps = avg(
        recent.map((s) => s.creeps?.byState?.IDLE || s.creeps?.byState?.idle || 0)
      );
      const avgSpawnEnergy = avg(
        recent.map((s) => s.energy.spawnAvailable / s.energy.spawnCapacity)
      );
      const avgHarvestEfficiency = avg(
        recent.map((s) => s.economy?.harvestEfficiency || 0)
      );

      if (avgIdleCreeps > 2 && avgSpawnEnergy < 0.5 && avgHarvestEfficiency < 0.7) {
        return {
          patternId: "energy_starvation",
          confidence: 0.85,
          evidence: [
            `Average ${avgIdleCreeps.toFixed(1)} idle creeps`,
            `Spawn energy at ${(avgSpawnEnergy * 100).toFixed(0)}% average`,
            `Harvest efficiency at ${(avgHarvestEfficiency * 100).toFixed(0)}%`,
          ],
          timeRange: [recent[0].timestamp, recent[recent.length - 1].timestamp],
        };
      }
      return null;
    },
  },
  {
    id: "harvest_inefficiency",
    name: "Harvest Inefficiency",
    description: "Sources not being harvested at maximum rate",
    severity: "medium",
    detect: (snapshots) => {
      if (snapshots.length < 12) return null;
      const recent = snapshots.slice(-12);
      const avgEfficiency = avg(
        recent.map((s) => s.economy?.harvestEfficiency || 0)
      );

      if (avgEfficiency < 0.6) {
        return {
          patternId: "harvest_inefficiency",
          confidence: 0.9,
          evidence: [
            `Harvest efficiency at ${(avgEfficiency * 100).toFixed(0)}%`,
            `Theoretical max: 10 energy/tick per source`,
            `Actual: ${(avgEfficiency * 10).toFixed(1)} energy/tick average`,
          ],
          timeRange: [recent[0].timestamp, recent[recent.length - 1].timestamp],
        };
      }
      return null;
    },
  },
  {
    id: "creep_death_spiral",
    name: "Creep Death Spiral",
    description: "More creeps dying than spawning, colony may be collapsing",
    severity: "critical",
    detect: (snapshots, events) => {
      const oneHourAgo = Date.now() - 3600000;
      const recentDeaths = events.filter(
        (e) => e.type === "CREEP_DEATH" && e.timestamp > oneHourAgo
      ).length;
      const recentSpawns = events.filter(
        (e) => e.type === "CREEP_SPAWNED" && e.timestamp > oneHourAgo
      ).length;

      if (recentDeaths > recentSpawns * 1.5 && recentDeaths > 3) {
        return {
          patternId: "creep_death_spiral",
          confidence: 0.95,
          evidence: [
            `${recentDeaths} deaths in last hour`,
            `${recentSpawns} spawns in last hour`,
            `Net loss: ${recentDeaths - recentSpawns} creeps`,
          ],
          timeRange: [oneHourAgo, Date.now()],
        };
      }
      return null;
    },
  },
  {
    id: "cpu_pressure",
    name: "CPU Pressure",
    description: "CPU bucket draining, code may be inefficient",
    severity: "medium",
    detect: (snapshots) => {
      if (snapshots.length < 12) return null;
      const recent = snapshots.slice(-12);
      const bucketTrend =
        recent[recent.length - 1].cpu.bucket - recent[0].cpu.bucket;
      const avgCPU = avg(recent.map((s) => s.cpu.used));

      if (bucketTrend < -1000 || recent[recent.length - 1].cpu.bucket < 2000) {
        return {
          patternId: "cpu_pressure",
          confidence: 0.8,
          evidence: [
            `Bucket dropped ${Math.abs(bucketTrend)} in analysis period`,
            `Current bucket: ${recent[recent.length - 1].cpu.bucket}`,
            `Average CPU: ${avgCPU.toFixed(2)}`,
          ],
          timeRange: [recent[0].timestamp, recent[recent.length - 1].timestamp],
        };
      }
      return null;
    },
  },
  {
    id: "stuck_rcl",
    name: "Stuck RCL Progression",
    description: "Controller not upgrading despite having resources",
    severity: "low",
    detect: (snapshots) => {
      if (snapshots.length < 24) return null;
      const recent = snapshots.slice(-24);

      const progressDelta =
        recent[recent.length - 1].controller.progress -
        recent[0].controller.progress;
      const avgStorage = avg(recent.map((s) => s.energy.storage || 0));

      if (avgStorage > 10000 && progressDelta < 1000) {
        return {
          patternId: "stuck_rcl",
          confidence: 0.75,
          evidence: [
            `Only ${progressDelta} controller progress in analysis period`,
            `Average storage: ${avgStorage.toFixed(0)} energy`,
            `Upgraders may be starved or misconfigured`,
          ],
          timeRange: [recent[0].timestamp, recent[recent.length - 1].timestamp],
        };
      }
      return null;
    },
  },
  {
    id: "hauler_contention",
    name: "Hauler Contention",
    description: "Multiple haulers competing for same energy sources",
    severity: "medium",
    detect: (snapshots) => {
      if (snapshots.length < 6) return null;
      const recent = snapshots.slice(-6);

      const avgHaulers = avg(
        recent.map((s) => s.creeps?.byRole?.HAULER || 0)
      );
      const avgContainers = avg(recent.map((s) => s.structures.containers || 0));
      const avgContainerEnergy = avg(recent.map((s) => s.energy.containers || 0));

      // Too many haulers for the containers, and energy piling up
      if (avgHaulers > avgContainers * 2 && avgContainerEnergy > 1000) {
        return {
          patternId: "hauler_contention",
          confidence: 0.7,
          evidence: [
            `${avgHaulers.toFixed(1)} haulers for ${avgContainers.toFixed(0)} containers`,
            `Average container energy: ${avgContainerEnergy.toFixed(0)}`,
            `Haulers may be competing for same sources`,
          ],
          timeRange: [recent[0].timestamp, recent[recent.length - 1].timestamp],
        };
      }
      return null;
    },
  },
];

async function getRecentSnapshots(roomName: string): Promise<any[]> {
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;

  const response = await dynamodb.send(
    new QueryCommand({
      TableName: SNAPSHOTS_TABLE,
      KeyConditionExpression:
        "roomName = :roomName AND #ts > :since",
      ExpressionAttributeNames: {
        "#ts": "timestamp",
      },
      ExpressionAttributeValues: marshall({
        ":roomName": roomName,
        ":since": fourHoursAgo,
      }),
      ScanIndexForward: true,
    })
  );

  return (response.Items || []).map((item) => unmarshall(item));
}

async function getRecentEvents(roomName: string): Promise<any[]> {
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;

  const response = await dynamodb.send(
    new QueryCommand({
      TableName: EVENTS_TABLE,
      IndexName: "timestamp-index",
      KeyConditionExpression:
        "roomName = :roomName AND #ts > :since",
      ExpressionAttributeNames: {
        "#ts": "timestamp",
      },
      ExpressionAttributeValues: marshall({
        ":roomName": roomName,
        ":since": fourHoursAgo,
      }),
    })
  );

  return (response.Items || []).map((item) => unmarshall(item));
}

async function getAnthropicKey(): Promise<string> {
  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: ANTHROPIC_KEY_SECRET })
  );
  return response.SecretString!;
}

async function generateAIRecommendations(
  patterns: PatternMatch[],
  snapshots: any[],
  events: any[]
): Promise<Recommendation[]> {
  if (patterns.length === 0) {
    console.log("No patterns detected, skipping AI recommendations");
    return [];
  }

  const apiKey = await getAnthropicKey();
  const anthropic = new Anthropic({ apiKey });

  const prompt = buildAnalysisPrompt(patterns, snapshots, events);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: `You are an expert Screeps AI developer analyzing colony performance data.
Your task is to identify problems and suggest specific improvements.

When suggesting improvements:
1. Be specific about what to change
2. Explain the root cause
3. Prioritize by impact

Return a JSON array of recommendations with this structure:
[
  {
    "title": "Brief title",
    "severity": "low|medium|high|critical",
    "category": "economy|spawning|combat|efficiency|architecture",
    "problem": "What's wrong",
    "rootCause": "Why it's happening",
    "solution": "What to change",
    "expectedImpact": "What will improve",
    "confidence": 0.0-1.0
  }
]`,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.content[0];
  if (content.type !== "text") return [];

  try {
    // Extract JSON from response
    const jsonMatch = content.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.map((rec: any, i: number) => ({
      id: `rec-${Date.now()}-${i}`,
      ...rec,
      createdAt: Date.now(),
      status: "pending",
    }));
  } catch (e) {
    console.error("Failed to parse AI response:", e);
    return [];
  }
}

function buildAnalysisPrompt(
  patterns: PatternMatch[],
  snapshots: any[],
  events: any[]
): string {
  const latestSnapshot = snapshots[snapshots.length - 1];

  return `## Detected Patterns

${patterns
  .map(
    (p) => `### ${p.patternId} (confidence: ${(p.confidence * 100).toFixed(0)}%)
Evidence:
${p.evidence.map((e) => `- ${e}`).join("\n")}`
  )
  .join("\n\n")}

## Recent Metrics

Energy Flow:
- Harvest efficiency: ${(avg(snapshots.map((s) => s.economy?.harvestEfficiency || 0)) * 100).toFixed(0)}%
- Average storage: ${avg(snapshots.map((s) => s.energy?.storage || 0)).toFixed(0)}
- Spawn energy fill rate: ${(avg(snapshots.map((s) => s.energy.spawnAvailable / s.energy.spawnCapacity)) * 100).toFixed(0)}%

Creep Population:
- Total creeps: ${latestSnapshot?.creeps?.total || 0}
- By role: ${JSON.stringify(latestSnapshot?.creeps?.byRole || {})}
- Recent deaths: ${events.filter((e) => e.type === "CREEP_DEATH").length}
- Recent spawns: ${events.filter((e) => e.type === "CREEP_SPAWNED").length}

Controller:
- RCL: ${latestSnapshot?.controller?.level || 0}
- Progress: ${latestSnapshot?.controller?.progress || 0}/${latestSnapshot?.controller?.progressTotal || 1}

CPU:
- Average used: ${avg(snapshots.map((s) => s.cpu?.used || 0)).toFixed(2)}
- Current bucket: ${latestSnapshot?.cpu?.bucket || 0}

## Task

Analyze the patterns and metrics above. Identify root causes and suggest specific improvements.
Return your recommendations as a JSON array.`;
}

async function storeRecommendations(
  recommendations: Recommendation[]
): Promise<void> {
  for (const rec of recommendations) {
    await dynamodb.send(
      new PutItemCommand({
        TableName: RECOMMENDATIONS_TABLE,
        Item: marshall(rec),
      })
    );
  }
  console.log(`Stored ${recommendations.length} recommendations`);
}

async function getRoomNames(): Promise<string[]> {
  // Query snapshots table to get unique room names from recent data
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  // This is a simple approach - in production you might want a separate index
  const response = await dynamodb.send(
    new QueryCommand({
      TableName: SNAPSHOTS_TABLE,
      KeyConditionExpression: "roomName = :roomName AND #ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: marshall({
        ":roomName": "W1N1", // Placeholder - in real impl, scan or use a rooms table
        ":since": oneDayAgo,
      }),
      Limit: 1,
    })
  );

  // For now, return a hardcoded list - in production, this should come from config
  // or be discovered from the data
  return ["W1N1"];
}

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
    console.log("Starting analysis...");

    // Get room names to analyze
    const roomNames = await getRoomNames();

    const allPatterns: PatternMatch[] = [];
    const allRecommendations: Recommendation[] = [];

    for (const roomName of roomNames) {
      console.log(`Analyzing room ${roomName}...`);

      // Fetch recent data
      const [snapshots, events] = await Promise.all([
        getRecentSnapshots(roomName),
        getRecentEvents(roomName),
      ]);

      if (snapshots.length === 0) {
        console.log(`No snapshots for ${roomName}, skipping`);
        continue;
      }

      console.log(
        `Found ${snapshots.length} snapshots and ${events.length} events`
      );

      // Run pattern detection
      const patterns: PatternMatch[] = [];
      for (const detector of patternDetectors) {
        const match = detector.detect(snapshots, events);
        if (match) {
          patterns.push(match);
          console.log(
            `Detected pattern: ${detector.name} (confidence: ${match.confidence})`
          );
        }
      }

      allPatterns.push(...patterns);

      // Generate AI recommendations if patterns detected
      if (patterns.length > 0) {
        const recommendations = await generateAIRecommendations(
          patterns,
          snapshots,
          events
        );
        allRecommendations.push(...recommendations);
      }
    }

    // Store recommendations
    if (allRecommendations.length > 0) {
      await storeRecommendations(allRecommendations);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Analysis complete",
        patternsDetected: allPatterns.length,
        recommendationsGenerated: allRecommendations.length,
      }),
    };
  } catch (error) {
    console.error("Error running analysis:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(error) }),
    };
  }
}
