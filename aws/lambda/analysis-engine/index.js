import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";

// Code-aware analysis modules
import { fetchFiles, isGitHubConfigured } from "./code-reader.js";
import { getMostRelevantFiles } from "./pattern-files.js";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const SIGNALS_TABLE = process.env.SIGNALS_TABLE;
const OBSERVATIONS_TABLE = process.env.OBSERVATIONS_TABLE;
const API_ENDPOINT = process.env.API_ENDPOINT || "https://dossn1w7n5.execute-api.us-east-1.amazonaws.com";
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

// ==================== Data Fetching ====================

async function fetchLiveData(roomName) {
  try {
    const url = roomName === "all"
      ? `${API_ENDPOINT}/live`
      : `${API_ENDPOINT}/live/${roomName}`;

    const response = await fetch(url);
    if (!response.ok) {
      console.log(`Live data fetch failed: ${response.status}`);
      return null;
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch live data:", error);
    return null;
  }
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
  // First try live data for active rooms
  const liveData = await fetchLiveData("all");
  if (liveData?.colonies?.length > 0) {
    return liveData.colonies.map(c => c.roomName);
  }

  // Fall back to recent snapshots
  const since = Date.now() - 60 * 60 * 1000;
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

  // Default room if no data
  if (rooms.size === 0) {
    rooms.add("E46N37");
  }

  return Array.from(rooms);
}

async function getRecentSignals(roomName, hours = 6) {
  if (!SIGNALS_TABLE) return [];

  const since = Date.now() - hours * 60 * 60 * 1000;

  try {
    const response = await docClient.send(
      new QueryCommand({
        TableName: SIGNALS_TABLE,
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
  } catch (error) {
    console.error("Failed to fetch signals:", error.message);
    return [];
  }
}

async function getPreviousObservations(roomName, limit = 5) {
  if (!OBSERVATIONS_TABLE) return [];

  try {
    const response = await docClient.send(
      new QueryCommand({
        TableName: OBSERVATIONS_TABLE,
        KeyConditionExpression: "roomName = :room",
        ExpressionAttributeValues: {
          ":room": roomName,
        },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return response.Items || [];
  } catch (error) {
    console.error("Failed to fetch previous observations:", error.message);
    return [];
  }
}

// ==================== Pattern Detection ====================

function detectPatterns(snapshots, liveColony) {
  const patterns = [];
  const current = liveColony || snapshots[0];

  if (!current) return patterns;

  // Use nested data structure from live export
  const energy = current.energy || {};
  const creeps = current.creeps || {};
  const byRole = creeps.byRole || {};
  const cpu = current.global?.cpu || current.cpu || {};
  const threats = current.threats || {};
  const remoteMining = current.remoteMining || {};
  const traffic = current.traffic || {};

  // Energy starvation: storage low AND spawn energy low
  if ((energy.stored || 0) < 10000 && (energy.available || 0) < (energy.capacity || 300) * 0.5) {
    patterns.push({
      id: "ENERGY_STARVATION",
      severity: "HIGH",
      message: `Storage below 10k (${energy.stored || 0}) and spawn energy below 50% (${energy.available || 0}/${energy.capacity || 300})`,
    });
  }

  // Hauler shortage: fewer haulers than harvesters
  const haulers = (byRole.HAULER || 0) + (byRole.hauler || 0);
  const harvesters = (byRole.HARVESTER || 0) + (byRole.harvester || 0);
  if (haulers < harvesters && harvesters > 0) {
    patterns.push({
      id: "HAULER_SHORTAGE",
      severity: "MEDIUM",
      message: `Fewer haulers (${haulers}) than harvesters (${harvesters}), energy may be stuck at sources`,
    });
  }

  // No upgraders
  const upgraders = (byRole.UPGRADER || 0) + (byRole.upgrader || 0);
  if (upgraders === 0 && (current.rcl || 0) < 8) {
    patterns.push({
      id: "NO_UPGRADERS",
      severity: "HIGH",
      message: "No upgraders spawned, RCL progress stalled",
    });
  }

  // CPU bucket low
  const bucket = cpu.bucket || 10000;
  if (bucket < 5000) {
    patterns.push({
      id: "CPU_BUCKET_LOW",
      severity: bucket < 2000 ? "HIGH" : "MEDIUM",
      message: `CPU bucket at ${bucket}/10000, efficiency may suffer`,
    });
  }

  // Remote hauler shortage
  const remoteMiners = remoteMining.totalMiners || 0;
  const remoteHaulers = remoteMining.totalHaulers || 0;
  if (remoteMiners > 0 && remoteHaulers < remoteMiners) {
    patterns.push({
      id: "REMOTE_HAULER_SHORTAGE",
      severity: "MEDIUM",
      message: `Not enough remote haulers (${remoteHaulers}) for remote miners (${remoteMiners})`,
    });
  }

  // Active threats
  const hostileCount = threats.hostileCount || 0;
  if (hostileCount > 0) {
    patterns.push({
      id: "ACTIVE_THREAT",
      severity: "CRITICAL",
      message: `${hostileCount} hostile(s) in room`,
    });
  }

  // Traffic bottleneck
  const hotspots = traffic.hotspots || [];
  if (hotspots.length > 0) {
    const maxVisits = Math.max(...hotspots.map(h => h.visits || 0));
    if (maxVisits > 100) {
      const topHotspot = hotspots.find(h => h.visits === maxVisits);
      patterns.push({
        id: "TRAFFIC_BOTTLENECK",
        severity: "LOW",
        message: `High traffic tile at (${topHotspot?.x},${topHotspot?.y}) with ${maxVisits} visits needs road`,
      });
    }
  }

  // RCL progress stall (compare snapshots)
  if (snapshots.length >= 2 && (current.rcl || 0) < 8) {
    const oldest = snapshots[snapshots.length - 1];
    const progressDelta = (current.rclProgress || 0) - (oldest.rclProgress || 0);
    const hoursPassed = ((current.timestamp || Date.now()) - (oldest.timestamp || Date.now())) / (1000 * 60 * 60);
    const progressPerHour = hoursPassed > 0 ? progressDelta / hoursPassed : 0;

    if (progressPerHour < 1000 && (energy.stored || 0) > 100000) {
      patterns.push({
        id: "RCL_STALL",
        severity: "HIGH",
        message: `Only ${Math.round(progressPerHour)} RCL progress/hour despite ${energy.stored} stored energy`,
      });
    }
  }

  // Storage nearly full
  if ((energy.stored || 0) > 900000) {
    patterns.push({
      id: "STORAGE_FULL",
      severity: "MEDIUM",
      message: `Storage nearly full (${energy.stored}), energy backing up - increase spending`,
    });
  }

  // No miners
  const miners = harvesters + (byRole.MINER || 0) + (byRole.miner || 0);
  if (miners === 0 && (creeps.total || 0) > 0) {
    patterns.push({
      id: "NO_MINERS",
      severity: "CRITICAL",
      message: "No harvesters/miners - economy will collapse",
    });
  }

  return patterns;
}

function calculateTrends(snapshots) {
  if (snapshots.length < 2) return {};

  const latest = snapshots[0];
  const oldest = snapshots[snapshots.length - 1];
  const timeDiffHours = (latest.timestamp - oldest.timestamp) / (1000 * 60 * 60);

  const latestEnergy = latest.energy?.stored || 0;
  const oldestEnergy = oldest.energy?.stored || 0;

  return {
    energyChange: latestEnergy - oldestEnergy,
    creepChange: (latest.creeps?.total || 0) - (oldest.creeps?.total || 0),
    rclProgress: (latest.rclProgress || 0) - (oldest.rclProgress || 0),
    avgEnergyPerHour: timeDiffHours > 0 ? (latestEnergy - oldestEnergy) / timeDiffHours : 0,
    hoursAnalyzed: timeDiffHours,
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

// ==================== Code Context ====================

async function buildCodeContext(patterns) {
  // Check if GitHub is configured
  const configured = await isGitHubConfigured();
  if (!configured) {
    console.log("GitHub not configured, skipping code context");
    return "";
  }

  // Get the most relevant files for detected patterns
  const relevantFiles = getMostRelevantFiles(patterns, 6);
  console.log(`Fetching ${relevantFiles.length} relevant code files:`, relevantFiles);

  try {
    const fileContents = await fetchFiles(relevantFiles);

    if (fileContents.size === 0) {
      return "(Code context unavailable)";
    }

    // Build code context (limit size to avoid token limits)
    const maxCodeSize = 15000; // ~4k tokens
    let codeContext = "";
    let currentSize = 0;

    for (const [path, content] of fileContents) {
      const fileSection = `\n### ${path}\n\`\`\`typescript\n${content}\n\`\`\`\n`;

      if (currentSize + fileSection.length > maxCodeSize) {
        // Truncate large files - include first 100 lines
        const lines = content.split("\n").slice(0, 100).join("\n");
        const truncatedSection = `\n### ${path} (truncated)\n\`\`\`typescript\n${lines}\n// ... truncated ...\n\`\`\`\n`;
        codeContext += truncatedSection;
        currentSize += truncatedSection.length;
      } else {
        codeContext += fileSection;
        currentSize += fileSection.length;
      }
    }

    console.log(`Built code context: ${currentSize} chars from ${fileContents.size} files`);
    return codeContext;
  } catch (error) {
    console.warn("Failed to fetch code files:", error.message);
    return "(Code context unavailable)";
  }
}

// ==================== AI Analysis ====================

async function analyzeWithClaude(roomName, snapshots, events, patterns, liveColony, signals, previousObservations) {
  const client = await getAnthropicClient();
  const current = liveColony || snapshots[0];

  if (!current) {
    throw new Error("No data available for analysis");
  }

  // Fetch relevant code context
  const codeContext = await buildCodeContext(patterns);
  const hasCodeContext = codeContext && !codeContext.includes("unavailable");

  const dataSummary = {
    roomName,
    snapshotCount: snapshots.length,
    current: {
      rcl: current.rcl,
      rclProgress: current.rclProgress,
      rclProgressTotal: current.rclProgressTotal,
      progressPercent: current.rclProgressTotal
        ? ((current.rclProgress / current.rclProgressTotal) * 100).toFixed(1)
        : 0,
      energy: current.energy,
      creeps: current.creeps,
      threats: current.threats,
      cpu: current.global?.cpu || current.cpu,
      remoteMining: current.remoteMining,
      traffic: current.traffic ? {
        hotspotsCount: current.traffic.hotspots?.length || 0,
        topHotspots: (current.traffic.hotspots || []).slice(0, 3),
      } : null,
    },
    trends: calculateTrends(snapshots),
    recentEvents: summarizeEvents(events),
    detectedPatterns: patterns.map(p => `[${p.severity}] ${p.id}: ${p.message}`),
  };

  // Build signal summary
  const signalSummary = signals.length > 0 ? {
    count: signals.length,
    recentEvents: signals.flatMap(s => s.events || []).slice(0, 10),
    latestMetrics: signals[0]?.metrics || null,
    latestDeltas: signals[0]?.deltas || null,
  } : null;

  // Build previous observations context
  const observationHistory = previousObservations.length > 0 ? previousObservations.map(obs => ({
    timestamp: obs.timestamp,
    summary: obs.summary,
    patterns: obs.patterns?.slice(0, 3),
    keyObservations: obs.observations?.slice(0, 3),
  })) : null;

  const systemPrompt = `You are an expert observer for Screeps, an MMO programming game. Your role is to OBSERVE and NOTICE what's happening in the colony - not to prescribe solutions.

You are building a continuous understanding of this colony over time. Focus on:
1. What patterns are emerging?
2. What has changed since the last observation?
3. What correlations do you notice between metrics?
4. What trends are developing?

${observationHistory ? `You have access to your previous observations below. Track patterns over time and note when things change.` : ""}
${hasCodeContext ? "You have access to the actual game code below. Reference specific code when relevant to your observations." : ""}`;

  let userPrompt = `Observe this Screeps colony and record what you notice:

## Current Colony State
${JSON.stringify(dataSummary, null, 2)}

${signalSummary ? `## Signal Data (metrics & events)
${JSON.stringify(signalSummary, null, 2)}` : ""}

${observationHistory ? `## Your Previous Observations
${JSON.stringify(observationHistory, null, 2)}` : ""}
`;

  // Add code context if available
  if (hasCodeContext) {
    userPrompt += `
## Relevant Code
${codeContext}
`;
  }

  userPrompt += `
Record your observations. Focus on WHAT you notice, not WHAT TO DO about it.

Respond ONLY with valid JSON in this exact format:
{
  "summary": "<one sentence overview of current state>",
  "observations": [
    {
      "category": "<economy|defense|expansion|optimization|spawning|behavior>",
      "observation": "<what you noticed>",
      "significance": "<low|medium|high>",
      "dataPoints": ["<specific metrics that support this observation>"]
    }
  ],
  "patterns": [
    {
      "id": "<pattern identifier like ENERGY_ACCUMULATING or CREEP_POPULATION_STABLE>",
      "description": "<what the pattern is>",
      "confidence": "<low|medium|high>",
      "trend": "<improving|stable|declining|new>"
    }
  ],
  "signalCorrelations": [
    {
      "signals": ["<signal1>", "<signal2>"],
      "correlation": "<what relationship you notice between them>"
    }
  ],
  "changesFromPrevious": "<what's different from your last observation, or null if first observation>"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    messages: [
      { role: "user", content: systemPrompt + "\n\n" + userPrompt },
    ],
  });

  const content = response.content[0].text;

  // Parse JSON from response
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

// ==================== Storage ====================

async function storeObservations(roomName, analysis, patterns, snapshotInfo) {
  const timestamp = Date.now();
  const expiresAt = Math.floor(timestamp / 1000) + RETENTION_DAYS * 24 * 60 * 60;

  // Store to observations table
  if (OBSERVATIONS_TABLE) {
    const observationRecord = {
      roomName: roomName,
      timestamp: timestamp,
      id: `${roomName}_${timestamp}`,
      snapshotTick: snapshotInfo.tick || 0,
      snapshotHash: snapshotInfo.hash || "",
      summary: analysis.summary,
      observations: analysis.observations || [],
      patterns: analysis.patterns || [],
      signalCorrelations: analysis.signalCorrelations || [],
      changesFromPrevious: analysis.changesFromPrevious || null,
      detectedPatterns: patterns.map(p => p.id),
      expiresAt: expiresAt,
    };

    await docClient.send(
      new PutCommand({
        TableName: OBSERVATIONS_TABLE,
        Item: observationRecord,
      })
    );

    console.log(`Stored observation for ${roomName}: ${analysis.observations?.length || 0} observations, ${analysis.patterns?.length || 0} patterns`);
  }

  // Also store summary to recommendations table for backwards compatibility
  if (RECOMMENDATIONS_TABLE) {
    await docClient.send(
      new PutCommand({
        TableName: RECOMMENDATIONS_TABLE,
        Item: {
          id: `observation_${roomName}_${timestamp}`,
          roomName: roomName,
          createdAt: timestamp,
          expiresAt: expiresAt,
          type: "observation",
          summary: analysis.summary,
          observationCount: analysis.observations?.length || 0,
          patternCount: analysis.patterns?.length || 0,
          detectedPatterns: patterns.map(p => p.id),
        },
      })
    );
  }
}

// ==================== Main Handler ====================

export async function handler(event) {
  console.log("Analysis engine starting...", { event });

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
      return { statusCode: 200, body: JSON.stringify({ message: "No rooms to analyze" }) };
    }

    console.log(`Analyzing ${rooms.length} room(s): ${rooms.join(", ")}`);

    const results = [];

    for (const roomName of rooms) {
      console.log(`\n=== Analyzing ${roomName} ===`);

      // Get historical snapshots
      const snapshots = await getRecentSnapshots(roomName, 6);
      console.log(`Found ${snapshots.length} historical snapshots`);

      // Get live data
      const liveData = await fetchLiveData(roomName);
      const liveColony = liveData?.colony || liveData;
      console.log(`Live data: ${liveColony ? "available" : "unavailable"}`);

      // Skip if insufficient data
      if (snapshots.length < 2 && !liveColony) {
        console.log(`Skipping ${roomName}: insufficient data`);
        continue;
      }

      // Get events
      const events = await getRecentEvents(roomName, 6);
      console.log(`Found ${events.length} events`);

      // Get signals and previous observations
      const signals = await getRecentSignals(roomName, 6);
      console.log(`Found ${signals.length} signal records`);

      const previousObservations = await getPreviousObservations(roomName, 5);
      console.log(`Found ${previousObservations.length} previous observations`);

      // Detect patterns
      const patterns = detectPatterns(snapshots, liveColony);
      console.log(`Detected ${patterns.length} patterns:`, patterns.map(p => p.id));

      // Generate AI observations if patterns found OR enough data
      if (patterns.length > 0 || snapshots.length >= 3) {
        try {
          const analysis = await analyzeWithClaude(roomName, snapshots, events, patterns, liveColony, signals, previousObservations);
          console.log(`Analysis for ${roomName}: ${analysis.observations?.length || 0} observations, ${analysis.patterns?.length || 0} patterns`);

          const snapshotInfo = {
            tick: liveColony?.tick || snapshots[0]?.tick || 0,
            hash: `${roomName}_${Date.now()}`,
          };

          await storeObservations(roomName, analysis, patterns, snapshotInfo);

          results.push({
            roomName,
            summary: analysis.summary,
            observationsGenerated: analysis.observations?.length || 0,
            patternsDetected: patterns.length,
            patternsIdentified: analysis.patterns?.length || 0,
          });
        } catch (aiError) {
          console.error(`AI analysis failed for ${roomName}:`, aiError);
          results.push({
            roomName,
            error: aiError.message,
            patternsDetected: patterns.length,
          });
        }
      } else {
        console.log(`Skipping AI analysis for ${roomName}: no patterns and insufficient data`);
        results.push({
          roomName,
          skipped: true,
          reason: "No patterns detected and insufficient historical data",
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Analysis complete",
        roomsAnalyzed: results.length,
        results,
      }),
    };
  } catch (error) {
    console.error("Analysis engine error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
