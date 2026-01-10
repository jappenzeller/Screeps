/**
 * Screeps Monitor Lambda
 * Checks colony health hourly and sends SMS alerts via SNS
 *
 * Environment variables:
 * - API_ENDPOINT: Fargate API endpoint (e.g., https://xxx.execute-api.us-east-1.amazonaws.com)
 * - SNS_TOPIC_ARN: ARN of SNS topic for alerts
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import * as https from "https";

const sns = new SNSClient({ region: process.env.AWS_REGION || "us-east-1" });

interface SummaryResponse {
  ok: number;
  timestamp: string;
  stats: {
    gcl: number;
    gclLevel: number;
    cpu: number;
    bucket: number;
    tick: number;
  } | null;
  creeps: {
    total: number;
    byRole: Record<string, number>;
  };
  rooms: Array<{
    name: string;
    sources: number;
    hostiles: number;
  }>;
  alerts: string[];
}

async function fetchSummary(endpoint: string): Promise<SummaryResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/summary`);

    https.get(url.toString(), (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

async function sendAlert(message: string): Promise<void> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    console.error("SNS_TOPIC_ARN not configured");
    return;
  }

  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Message: message,
    Subject: "Screeps Alert",
  }));

  console.log("Alert sent:", message);
}

export async function handler(): Promise<{ statusCode: number; body: string }> {
  const apiEndpoint = process.env.API_ENDPOINT;

  if (!apiEndpoint) {
    console.error("API_ENDPOINT not configured");
    return { statusCode: 500, body: "API_ENDPOINT not configured" };
  }

  try {
    console.log(`Checking colony health at ${apiEndpoint}`);
    const summary = await fetchSummary(apiEndpoint);

    // Check for critical issues
    const criticalAlerts: string[] = [];

    // No creeps = colony dead
    if (summary.creeps.total === 0) {
      criticalAlerts.push("CRITICAL: No creeps alive! Colony may be dead.");
    }

    // Low bucket = CPU issues
    if (summary.stats && summary.stats.bucket < 5000) {
      criticalAlerts.push(`WARNING: Low CPU bucket (${summary.stats.bucket}/10000)`);
    }

    // Hostiles detected
    for (const room of summary.rooms) {
      if (room.hostiles > 0) {
        criticalAlerts.push(`ALERT: ${room.hostiles} hostile(s) in ${room.name}`);
      }
    }

    // Include any alerts from the API
    criticalAlerts.push(...summary.alerts.filter(a => !criticalAlerts.some(c => c.includes(a))));

    // Send SMS if there are issues
    if (criticalAlerts.length > 0) {
      const message = [
        "Screeps Colony Alert",
        "---",
        ...criticalAlerts,
        "",
        `Tick: ${summary.stats?.tick || "unknown"}`,
        `Creeps: ${summary.creeps.total}`,
        `Bucket: ${summary.stats?.bucket || "unknown"}`,
      ].join("\n");

      await sendAlert(message);

      return {
        statusCode: 200,
        body: JSON.stringify({ alertsSent: criticalAlerts.length, alerts: criticalAlerts }),
      };
    }

    console.log("Colony healthy - no alerts");
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "healthy",
        creeps: summary.creeps.total,
        bucket: summary.stats?.bucket,
      }),
    };

  } catch (error) {
    const errorMessage = `Failed to check colony health: ${error}`;
    console.error(errorMessage);

    // Send alert on API failure too
    await sendAlert(`Screeps Monitor Error: ${errorMessage}`);

    return { statusCode: 500, body: errorMessage };
  }
}
