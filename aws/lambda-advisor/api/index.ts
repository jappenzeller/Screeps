import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE!;
const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE!;

interface APIGatewayEvent {
  routeKey: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
}

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function response(statusCode: number, body: any): Response {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

async function getAnalysisSummary(): Promise<Response> {
  // Get latest snapshot for each room
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  // Get recent snapshots
  const snapshotsResponse = await dynamodb.send(
    new ScanCommand({
      TableName: SNAPSHOTS_TABLE,
      FilterExpression: "#ts > :since",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: marshall({ ":since": oneHourAgo }),
      Limit: 100,
    })
  );

  const snapshots = (snapshotsResponse.Items || []).map((item) =>
    unmarshall(item)
  );

  // Get pending recommendations count
  const recsResponse = await dynamodb.send(
    new QueryCommand({
      TableName: RECOMMENDATIONS_TABLE,
      IndexName: "status-index",
      KeyConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({ ":pending": "pending" }),
    })
  );

  const pendingRecs = recsResponse.Items?.length || 0;

  // Calculate health status
  const latestSnapshot = snapshots.sort((a, b) => b.timestamp - a.timestamp)[0];

  let colonyHealth: "healthy" | "warning" | "critical" = "healthy";
  if (latestSnapshot) {
    const spawnFillRate =
      latestSnapshot.energy.spawnAvailable /
      latestSnapshot.energy.spawnCapacity;
    const cpuBucket = latestSnapshot.cpu?.bucket || 10000;

    if (spawnFillRate < 0.3 || cpuBucket < 1000) {
      colonyHealth = "critical";
    } else if (spawnFillRate < 0.6 || cpuBucket < 3000) {
      colonyHealth = "warning";
    }
  }

  // Calculate trends
  const sortedSnapshots = snapshots.sort((a, b) => a.timestamp - b.timestamp);
  const first = sortedSnapshots[0];
  const last = sortedSnapshots[sortedSnapshots.length - 1];

  const energyTrend =
    first && last
      ? last.energy.total > first.energy.total * 1.1
        ? "increasing"
        : last.energy.total < first.energy.total * 0.9
        ? "decreasing"
        : "stable"
      : "stable";

  const creepTrend =
    first && last
      ? last.creeps.total > first.creeps.total
        ? "increasing"
        : last.creeps.total < first.creeps.total
        ? "decreasing"
        : "stable"
      : "stable";

  const rclProgress = latestSnapshot
    ? (latestSnapshot.controller.progress /
        latestSnapshot.controller.progressTotal) *
      100
    : 0;

  return response(200, {
    colonyHealth,
    pendingRecommendations: pendingRecs,
    metricsSnapshot: latestSnapshot || null,
    trends: {
      energyTrend,
      creepTrend,
      rclProgress: rclProgress.toFixed(1),
    },
  });
}

async function getRecommendations(): Promise<Response> {
  const recsResponse = await dynamodb.send(
    new ScanCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Limit: 50,
    })
  );

  const recommendations = (recsResponse.Items || [])
    .map((item) => unmarshall(item))
    .sort((a, b) => b.createdAt - a.createdAt);

  // Count by category and severity
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  for (const rec of recommendations) {
    byCategory[rec.category] = (byCategory[rec.category] || 0) + 1;
    bySeverity[rec.severity] = (bySeverity[rec.severity] || 0) + 1;
  }

  return response(200, {
    recommendations,
    totalCount: recommendations.length,
    byCategory,
    bySeverity,
  });
}

async function getMetricHistory(
  metric: string,
  from?: string,
  to?: string
): Promise<Response> {
  const fromTs = from ? parseInt(from) : Date.now() - 24 * 60 * 60 * 1000;
  const toTs = to ? parseInt(to) : Date.now();

  const snapshotsResponse = await dynamodb.send(
    new ScanCommand({
      TableName: SNAPSHOTS_TABLE,
      FilterExpression: "#ts BETWEEN :from AND :to",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: marshall({ ":from": fromTs, ":to": toTs }),
      Limit: 500,
    })
  );

  const snapshots = (snapshotsResponse.Items || [])
    .map((item) => unmarshall(item))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Extract the requested metric
  const dataPoints = snapshots.map((s) => {
    let value = 0;
    switch (metric) {
      case "energy.total":
        value = s.energy?.total || 0;
        break;
      case "energy.storage":
        value = s.energy?.storage || 0;
        break;
      case "energy.spawnAvailable":
        value = s.energy?.spawnAvailable || 0;
        break;
      case "creeps.total":
        value = s.creeps?.total || 0;
        break;
      case "economy.harvestEfficiency":
        value = (s.economy?.harvestEfficiency || 0) * 100;
        break;
      case "cpu.used":
        value = s.cpu?.used || 0;
        break;
      case "cpu.bucket":
        value = s.cpu?.bucket || 0;
        break;
      case "controller.progress":
        value = s.controller?.progress || 0;
        break;
      default:
        // Try nested access
        const parts = metric.split(".");
        let current: any = s;
        for (const part of parts) {
          current = current?.[part];
        }
        value = typeof current === "number" ? current : 0;
    }
    return {
      timestamp: s.timestamp,
      value,
    };
  });

  return response(200, {
    metric,
    dataPoints,
    aggregation: "raw",
  });
}

async function submitFeedback(
  recommendationId: string,
  body: string
): Promise<Response> {
  const feedback = JSON.parse(body);

  await dynamodb.send(
    new UpdateItemCommand({
      TableName: RECOMMENDATIONS_TABLE,
      Key: marshall({ id: recommendationId }),
      UpdateExpression:
        "SET #status = :status, feedback = :feedback, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({
        ":status": feedback.action === "applied" ? "applied" : "dismissed",
        ":feedback": {
          helpful: feedback.helpful,
          notes: feedback.notes || "",
        },
        ":now": Date.now(),
      }),
    })
  );

  return response(200, { message: "Feedback recorded" });
}

async function getAnalysisReport(): Promise<Response> {
  // Get comprehensive analysis data
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;

  const [snapshotsRes, eventsRes, recsRes] = await Promise.all([
    dynamodb.send(
      new ScanCommand({
        TableName: SNAPSHOTS_TABLE,
        FilterExpression: "#ts > :since",
        ExpressionAttributeNames: { "#ts": "timestamp" },
        ExpressionAttributeValues: marshall({ ":since": fourHoursAgo }),
        Limit: 200,
      })
    ),
    dynamodb.send(
      new ScanCommand({
        TableName: EVENTS_TABLE,
        FilterExpression: "#ts > :since",
        ExpressionAttributeNames: { "#ts": "timestamp" },
        ExpressionAttributeValues: marshall({ ":since": fourHoursAgo }),
        Limit: 200,
      })
    ),
    dynamodb.send(
      new ScanCommand({
        TableName: RECOMMENDATIONS_TABLE,
        Limit: 20,
      })
    ),
  ]);

  const snapshots = (snapshotsRes.Items || [])
    .map((item) => unmarshall(item))
    .sort((a, b) => a.timestamp - b.timestamp);
  const events = (eventsRes.Items || []).map((item) => unmarshall(item));
  const recommendations = (recsRes.Items || [])
    .map((item) => unmarshall(item))
    .sort((a, b) => b.createdAt - a.createdAt);

  const latest = snapshots[snapshots.length - 1];
  const first = snapshots[0];

  // Calculate metric summaries
  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const economySummary = {
    avgHarvestEfficiency: avg(
      snapshots.map((s) => (s.economy?.harvestEfficiency || 0) * 100)
    ),
    avgStorageEnergy: avg(snapshots.map((s) => s.energy?.storage || 0)),
    avgSpawnFillRate: avg(
      snapshots.map(
        (s) => (s.energy?.spawnAvailable / s.energy?.spawnCapacity) * 100
      )
    ),
  };

  const populationSummary = {
    avgCreeps: avg(snapshots.map((s) => s.creeps?.total || 0)),
    deaths: events.filter((e) => e.type === "CREEP_DEATH").length,
    spawns: events.filter((e) => e.type === "CREEP_SPAWNED").length,
  };

  const progressSummary = {
    rclLevel: latest?.controller?.level || 0,
    rclProgress:
      ((latest?.controller?.progress || 0) /
        (latest?.controller?.progressTotal || 1)) *
      100,
    progressDelta: first && latest
      ? latest.controller?.progress - first.controller?.progress
      : 0,
  };

  const efficiencySummary = {
    avgCPU: avg(snapshots.map((s) => s.cpu?.used || 0)),
    currentBucket: latest?.cpu?.bucket || 0,
    bucketTrend: first && latest ? latest.cpu?.bucket - first.cpu?.bucket : 0,
  };

  return response(200, {
    generatedAt: Date.now(),
    timeRange: [fourHoursAgo, Date.now()],
    executiveSummary: generateExecutiveSummary(
      economySummary,
      populationSummary,
      efficiencySummary
    ),
    recommendations: recommendations.slice(0, 10),
    metrics: {
      economy: economySummary,
      population: populationSummary,
      progress: progressSummary,
      efficiency: efficiencySummary,
    },
  });
}

function generateExecutiveSummary(
  economy: any,
  population: any,
  efficiency: any
): string {
  const issues: string[] = [];

  if (economy.avgHarvestEfficiency < 60) {
    issues.push("harvest efficiency is below optimal");
  }
  if (economy.avgSpawnFillRate < 50) {
    issues.push("spawn energy is frequently low");
  }
  if (population.deaths > population.spawns) {
    issues.push("creep population is declining");
  }
  if (efficiency.currentBucket < 3000) {
    issues.push("CPU bucket is concerning");
  }

  if (issues.length === 0) {
    return "Colony is operating efficiently with no significant issues detected.";
  }

  return `Colony has ${issues.length} area(s) needing attention: ${issues.join(", ")}.`;
}

export async function handler(event: APIGatewayEvent): Promise<Response> {
  console.log("Route:", event.routeKey);

  try {
    switch (event.routeKey) {
      case "GET /api/analysis/summary":
        return await getAnalysisSummary();

      case "GET /api/analysis/recommendations":
        return await getRecommendations();

      case "GET /api/metrics/{metric}/history":
        return await getMetricHistory(
          event.pathParameters?.metric || "energy.total",
          event.queryStringParameters?.from,
          event.queryStringParameters?.to
        );

      case "POST /api/recommendations/{id}/feedback":
        return await submitFeedback(
          event.pathParameters?.id || "",
          event.body || "{}"
        );

      case "GET /api/analysis/report":
        return await getAnalysisReport();

      default:
        return response(404, { error: "Not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return response(500, { error: String(error) });
  }
}
