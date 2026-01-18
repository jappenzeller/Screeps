import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});
const s3Client = new S3Client({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const SCREEPS_SHARD = process.env.SCREEPS_SHARD || "shard0";
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "7", 10);

let cachedToken = null;

async function getScreepsToken() {
  if (cachedToken) return cachedToken;

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.SCREEPS_TOKEN_SECRET,
    })
  );
  cachedToken = response.SecretString;
  return cachedToken;
}

async function fetchMemorySegment(token, segment = 90) {
  const response = await fetch(
    `https://screeps.com/api/user/memory-segment?segment=${segment}&shard=${SCREEPS_SHARD}`,
    {
      headers: {
        "X-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Screeps API error: ${response.status}`);
  }

  const data = await response.json();
  if (!data.data) return null;

  // Segment data comes as a string
  return typeof data.data === "string" ? JSON.parse(data.data) : data.data;
}

async function storeSnapshot(snapshot) {
  const timestamp = Date.now();
  const expiresAt = Math.floor(timestamp / 1000) + RETENTION_DAYS * 24 * 60 * 60;

  // Store each colony as a separate item
  for (const colony of snapshot.colonies || []) {
    await docClient.send(
      new PutCommand({
        TableName: SNAPSHOTS_TABLE,
        Item: {
          roomName: colony.roomName,
          timestamp: timestamp,
          expiresAt: expiresAt,
          gameTick: snapshot.gameTick,
          shard: snapshot.shard,
          rcl: colony.rcl,
          rclProgress: colony.rclProgress,
          rclProgressTotal: colony.rclProgressTotal,
          energy: colony.energy,
          creeps: colony.creeps,
          threats: colony.threats,
          structures: colony.structures,
          global: snapshot.global,
        },
      })
    );
  }

  console.log(`Stored ${snapshot.colonies?.length || 0} colony snapshots`);
}

async function storeEvents(events, roomName) {
  if (!events || events.length === 0) return;

  const timestamp = Date.now();
  const expiresAt = Math.floor(timestamp / 1000) + RETENTION_DAYS * 24 * 60 * 60;

  // Batch write events (max 25 per batch)
  const batches = [];
  for (let i = 0; i < events.length; i += 25) {
    batches.push(events.slice(i, i + 25));
  }

  for (const batch of batches) {
    const writeRequests = batch.map((event, idx) => ({
      PutRequest: {
        Item: {
          roomName: event.roomName || roomName,
          eventId: `${event.gameTick}_${idx}_${Date.now()}`,
          timestamp: event.timestamp || timestamp,
          expiresAt: expiresAt,
          gameTick: event.gameTick,
          type: event.type,
          data: event.data,
        },
      },
    }));

    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [EVENTS_TABLE]: writeRequests,
        },
      })
    );
  }

  console.log(`Stored ${events.length} events`);
}

async function writeToS3(snapshot) {
  if (!ANALYTICS_BUCKET) {
    console.log("ANALYTICS_BUCKET not configured, skipping S3 export");
    return;
  }

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const hourStr = now.toISOString().split("T")[1].split(":")[0]; // HH

  // Flatten snapshot data for Athena
  for (const colony of snapshot.colonies || []) {
    const flatRecord = {
      timestamp: now.toISOString(),
      timestampMs: Date.now(),
      gameTick: snapshot.gameTick,
      shard: snapshot.shard,
      roomName: colony.roomName,
      rcl: colony.rcl,
      rclProgress: colony.rclProgress,
      rclProgressTotal: colony.rclProgressTotal,
      energyAvailable: colony.energy?.available || 0,
      energyCapacity: colony.energy?.capacity || 0,
      energyStored: colony.energy?.stored || 0,
      creepsTotal: colony.creeps?.total || 0,
      creepsHarvester: colony.creeps?.byRole?.HARVESTER || 0,
      creepsHauler: colony.creeps?.byRole?.HAULER || 0,
      creepsUpgrader: colony.creeps?.byRole?.UPGRADER || 0,
      creepsBuilder: colony.creeps?.byRole?.BUILDER || 0,
      creepsDefender: colony.creeps?.byRole?.DEFENDER || 0,
      creepsRemoteMiner: colony.creeps?.byRole?.REMOTE_MINER || 0,
      creepsRemoteHauler: colony.creeps?.byRole?.REMOTE_HAULER || 0,
      creepsReserver: colony.creeps?.byRole?.RESERVER || 0,
      hostileCount: colony.threats?.hostileCount || 0,
      hostileDPS: colony.threats?.hostileDPS || 0,
      constructionSites: colony.structures?.constructionSites || 0,
      damagedStructures: colony.structures?.damagedCount || 0,
      cpuUsed: snapshot.global?.cpu?.used || 0,
      cpuLimit: snapshot.global?.cpu?.limit || 0,
      cpuBucket: snapshot.global?.cpu?.bucket || 0,
      gclLevel: snapshot.global?.gcl?.level || 0,
      gclProgress: snapshot.global?.gcl?.progress || 0,
      gclProgressTotal: snapshot.global?.gcl?.progressTotal || 0,
    };

    // Write as newline-delimited JSON (one record per line)
    const key = `snapshots/dt=${dateStr}/hour=${hourStr}/${colony.roomName}_${snapshot.gameTick}.json`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: ANALYTICS_BUCKET,
        Key: key,
        Body: JSON.stringify(flatRecord),
        ContentType: "application/json",
      })
    );
  }

  console.log(`Wrote ${snapshot.colonies?.length || 0} records to S3`);
}

export async function handler(event) {
  console.log("Data collector starting...");

  try {
    const token = await getScreepsToken();
    const data = await fetchMemorySegment(token, 90);

    if (!data) {
      console.log("No data in segment 90");
      return { statusCode: 200, body: "No data available" };
    }

    console.log(`Received data from tick ${data.gameTick}, ${data.colonies?.length || 0} colonies`);

    // Store snapshots to DynamoDB
    await storeSnapshot(data);

    // Store snapshots to S3 for analytics
    await writeToS3(data);

    // Store events if present
    if (data.events && data.events.length > 0) {
      await storeEvents(data.events, data.colonies?.[0]?.roomName);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "OK",
        tick: data.gameTick,
        colonies: data.colonies?.length || 0,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}
