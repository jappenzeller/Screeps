import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Initialize clients (cached across Lambda invocations)
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});

// Environment variables
const RECORDINGS_TABLE = process.env.RECORDINGS_TABLE;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const SCREEPS_TOKEN_SECRET = process.env.SCREEPS_TOKEN_SECRET;
const SCREEPS_SHARD = process.env.SCREEPS_SHARD || "shard0";

// Token cache
let cachedToken = null;

/**
 * Get Screeps API token from Secrets Manager (cached)
 */
async function getScreepsToken() {
  if (cachedToken) return cachedToken;

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: SCREEPS_TOKEN_SECRET,
    })
  );
  cachedToken = response.SecretString;
  return cachedToken;
}

/**
 * Fetch current game tick from Screeps API
 */
async function fetchGameTime(token, shard) {
  const response = await fetch(
    `https://screeps.com/api/game/time?shard=${shard}`,
    {
      headers: {
        "X-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Screeps API error fetching game time: ${response.status}`);
  }

  const data = await response.json();
  if (data.ok !== 1) {
    throw new Error(`Screeps API returned error: ${JSON.stringify(data)}`);
  }

  return data.time;
}

/**
 * Fetch room objects from Screeps API
 */
async function fetchRoomObjects(token, room, shard) {
  const response = await fetch(
    `https://screeps.com/api/game/room-objects?room=${room}&shard=${shard}`,
    {
      headers: {
        "X-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Screeps API error fetching room objects: ${response.status}`);
  }

  const data = await response.json();
  if (data.ok !== 1) {
    console.log(`Room objects API returned: ${JSON.stringify(data)}`);
    return []; // Room may have no vision
  }

  return data.objects || [];
}

/**
 * Fetch room terrain from Screeps API
 */
async function fetchRoomTerrain(token, room, shard) {
  const response = await fetch(
    `https://screeps.com/api/game/room-terrain?room=${room}&shard=${shard}&encoded=true`,
    {
      headers: {
        "X-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Screeps API error fetching terrain: ${response.status}`);
  }

  const data = await response.json();
  if (data.ok !== 1) {
    throw new Error(`Terrain API returned error: ${JSON.stringify(data)}`);
  }

  // terrain is an array with one entry for the room
  return data.terrain?.[0]?.terrain || "";
}

/**
 * Transform raw room objects into slim snapshot format
 */
function transformRoomObjects(objects) {
  const snapshot = {
    creeps: [],
    structures: [],
    sources: [],
    minerals: [],
    constructionSites: [],
    droppedResources: [],
    tombstones: [],
  };

  for (const obj of objects) {
    switch (obj.type) {
      case "creep":
        snapshot.creeps.push({
          x: obj.x,
          y: obj.y,
          name: obj.name,
          owner: obj.user,
          hits: obj.hits,
          hitsMax: obj.hitsMax,
          store: obj.store || {},
          storeCapacity: obj.storeCapacity || 0,
          body: obj.body || [],
        });
        break;

      case "spawn":
      case "extension":
      case "road":
      case "constructedWall":
      case "rampart":
      case "link":
      case "storage":
      case "tower":
      case "observer":
      case "powerSpawn":
      case "extractor":
      case "lab":
      case "terminal":
      case "container":
      case "nuker":
      case "factory":
        snapshot.structures.push({
          x: obj.x,
          y: obj.y,
          structureType: obj.type,
          hits: obj.hits,
          hitsMax: obj.hitsMax,
          store: obj.store || obj.energy != null ? { energy: obj.energy } : undefined,
          owner: obj.user,
          // Include spawning info for spawns
          spawning: obj.spawning,
          // Include controller info
          level: obj.level,
          progress: obj.progress,
          progressTotal: obj.progressTotal,
        });
        break;

      case "controller":
        snapshot.structures.push({
          x: obj.x,
          y: obj.y,
          structureType: "controller",
          level: obj.level,
          progress: obj.progress,
          progressTotal: obj.progressTotal,
          owner: obj.user,
          reservation: obj.reservation,
        });
        break;

      case "source":
        snapshot.sources.push({
          x: obj.x,
          y: obj.y,
          id: obj._id,
          energy: obj.energy,
          energyCapacity: obj.energyCapacity,
        });
        break;

      case "mineral":
        snapshot.minerals.push({
          x: obj.x,
          y: obj.y,
          mineralType: obj.mineralType,
          mineralAmount: obj.mineralAmount,
          density: obj.density,
        });
        break;

      case "constructionSite":
        snapshot.constructionSites.push({
          x: obj.x,
          y: obj.y,
          structureType: obj.structureType,
          progress: obj.progress,
          progressTotal: obj.progressTotal,
          owner: obj.user,
        });
        break;

      case "energy":
      case "resource":
        snapshot.droppedResources.push({
          x: obj.x,
          y: obj.y,
          resourceType: obj.resourceType || "energy",
          amount: obj.amount || obj.energy,
        });
        break;

      case "tombstone":
        snapshot.tombstones.push({
          x: obj.x,
          y: obj.y,
          store: obj.store || {},
          deathTime: obj.deathTime,
        });
        break;

      // Ignore other types (flags, ruins, etc.)
    }
  }

  return snapshot;
}

/**
 * Write terrain to S3
 */
async function writeTerrain(recordingId, room, terrain) {
  const terrainData = {
    room: room,
    encoded: terrain,
    capturedAt: new Date().toISOString(),
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: ANALYTICS_BUCKET,
      Key: `recordings/${recordingId}/terrain.json`,
      Body: JSON.stringify(terrainData),
      ContentType: "application/json",
    })
  );

  console.log(`Wrote terrain for ${recordingId}`);
}

/**
 * Write snapshot to S3
 */
async function writeSnapshot(recordingId, tick, room, objects) {
  const snapshot = {
    tick: tick,
    capturedAt: new Date().toISOString(),
    room: room,
    ...transformRoomObjects(objects),
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: ANALYTICS_BUCKET,
      Key: `recordings/${recordingId}/${tick}.json`,
      Body: JSON.stringify(snapshot),
      ContentType: "application/json",
    })
  );

  console.log(`Wrote snapshot for ${recordingId} at tick ${tick}`);
}

/**
 * Update recording in DynamoDB
 */
async function updateRecording(recordingId, updates) {
  const updateParts = [];
  const exprNames = {};
  const exprValues = {};

  for (const [key, value] of Object.entries(updates)) {
    updateParts.push(`#${key} = :${key}`);
    exprNames[`#${key}`] = key;
    exprValues[`:${key}`] = value;
  }

  // Always update updatedAt
  updateParts.push("#updatedAt = :updatedAt");
  exprNames["#updatedAt"] = "updatedAt";
  exprValues[":updatedAt"] = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: RECORDINGS_TABLE,
      Key: { recordingId },
      UpdateExpression: `SET ${updateParts.join(", ")}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })
  );
}

/**
 * Main Lambda handler
 */
export async function handler(event) {
  console.log("Room recorder starting...");

  try {
    // 1. Scan for active recordings
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: RECORDINGS_TABLE,
        FilterExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "active" },
      })
    );

    const activeRecordings = scanResult.Items || [];
    if (activeRecordings.length === 0) {
      console.log("No active recordings");
      return { statusCode: 200, body: "No active recordings" };
    }

    // Process only the first active recording (constraint: 1 at a time)
    const recording = activeRecordings[0];
    console.log(`Processing recording: ${recording.recordingId} for room ${recording.room}`);

    // 2. Get Screeps token
    const token = await getScreepsToken();
    const shard = recording.shard || SCREEPS_SHARD;

    // 3. Fetch current game tick
    const currentTick = await fetchGameTime(token, shard);
    console.log(`Current game tick: ${currentTick}`);

    // 4. Check if this is the first capture (set startTick)
    if (recording.startTick === null || recording.startTick === undefined) {
      const endTick = currentTick + recording.durationTicks;
      await updateRecording(recording.recordingId, {
        startTick: currentTick,
        endTick: endTick,
      });
      recording.startTick = currentTick;
      recording.endTick = endTick;
      console.log(`First capture: set startTick=${currentTick}, endTick=${endTick}`);
    }

    // 5. Check if recording has ended
    if (currentTick >= recording.endTick) {
      await updateRecording(recording.recordingId, { status: "complete" });
      console.log(`Recording ${recording.recordingId} completed at tick ${currentTick}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Recording completed", recordingId: recording.recordingId }),
      };
    }

    // 6. Check if enough ticks have elapsed since last capture
    const tickInterval = recording.tickInterval || 3;
    if (recording.lastCapturedTick !== null && recording.lastCapturedTick !== undefined) {
      const ticksSinceCapture = currentTick - recording.lastCapturedTick;
      if (ticksSinceCapture < tickInterval) {
        console.log(`Skipping capture: only ${ticksSinceCapture} ticks since last (interval: ${tickInterval})`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "Skipped - not enough ticks elapsed" }),
        };
      }
    }

    // 7. Fetch room objects
    const objects = await fetchRoomObjects(token, recording.room, shard);
    console.log(`Fetched ${objects.length} objects from room ${recording.room}`);

    // 8. Capture terrain if not already done
    if (!recording.terrainCaptured) {
      const terrain = await fetchRoomTerrain(token, recording.room, shard);
      await writeTerrain(recording.recordingId, recording.room, terrain);
      await updateRecording(recording.recordingId, { terrainCaptured: true });
    }

    // 9. Write snapshot to S3
    await writeSnapshot(recording.recordingId, currentTick, recording.room, objects);

    // 10. Update DynamoDB tracking
    const newTicksCaptured = (recording.ticksCaptured || 0) + 1;
    await updateRecording(recording.recordingId, {
      lastCapturedTick: currentTick,
      ticksCaptured: newTicksCaptured,
    });

    console.log(`Capture complete: tick ${currentTick}, total captures: ${newTicksCaptured}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Capture complete",
        recordingId: recording.recordingId,
        tick: currentTick,
        ticksCaptured: newTicksCaptured,
        objectCount: objects.length,
      }),
    };
  } catch (error) {
    console.error("Error in room recorder:", error);
    throw error;
  }
}
