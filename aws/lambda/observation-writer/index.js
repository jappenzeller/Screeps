import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const OBSERVATIONS_TABLE = process.env.OBSERVATIONS_TABLE;
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "30", 10);

/**
 * Write AI observations to DynamoDB
 * Input: Observation result from ClaudeAnalyzer
 * Output: Written observation record
 */
export async function handler(event) {
  console.log("Writing observation:", JSON.stringify({
    roomName: event.roomName,
    observationCount: event.observations?.length || 0,
    patternCount: event.patterns?.length || 0,
  }));

  if (!OBSERVATIONS_TABLE) {
    console.error("OBSERVATIONS_TABLE not configured");
    return { error: "OBSERVATIONS_TABLE not configured" };
  }

  const timestamp = event.timestamp || Date.now();
  const expiresAt = Math.floor((timestamp + RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);

  // Build the observation record
  const record = {
    roomName: event.roomName,
    timestamp,
    id: event.id || `${event.roomName}_${timestamp}`,
    snapshotTick: event.snapshotTick || 0,
    snapshotHash: event.snapshotHash || "",
    observations: event.observations || [],
    patterns: event.patterns || [],
    signalCorrelations: event.signalCorrelations || [],
    summary: event.summary || "",
    expiresAt,
  };

  // Write to DynamoDB
  await docClient.send(new PutCommand({
    TableName: OBSERVATIONS_TABLE,
    Item: record,
  }));

  console.log(`Wrote observation for ${event.roomName}: ${record.observations.length} observations, ${record.patterns.length} patterns`);

  return {
    roomName: event.roomName,
    timestamp,
    observationCount: record.observations.length,
    patternCount: record.patterns.length,
    correlationCount: record.signalCorrelations.length,
  };
}
