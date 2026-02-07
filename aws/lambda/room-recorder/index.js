import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

// Initialize clients (cached across Lambda invocations)
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});
const eventBridgeClient = new EventBridgeClient({});

// Environment variables
const RECORDINGS_TABLE = process.env.RECORDINGS_TABLE;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const SCREEPS_TOKEN_SECRET = process.env.SCREEPS_TOKEN_SECRET;
const SCREEPS_SHARD = process.env.SCREEPS_SHARD || "shard0";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;

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
 * Publish RecordingComplete event to EventBridge
 */
async function publishRecordingComplete(recording) {
  if (!EVENT_BUS_NAME) {
    console.log("EVENT_BUS_NAME not configured, skipping event publish");
    return;
  }

  try {
    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: EVENT_BUS_NAME,
            Source: "screeps.room-recorder",
            DetailType: "RecordingComplete",
            Detail: JSON.stringify({
              recordingId: recording.recordingId,
              room: recording.room,
              shard: recording.shard,
              ticksCaptured: recording.ticksCaptured,
              startTick: recording.startTick,
              endTick: recording.endTick,
              completedAt: new Date().toISOString(),
            }),
          },
        ],
      })
    );
    console.log(`Published RecordingComplete event for ${recording.recordingId}`);
  } catch (error) {
    console.error("Error publishing RecordingComplete event:", error);
    // Don't throw - event publishing is best-effort
  }
}

/**
 * Create a new recording for continuous mode rotation
 */
async function createContinuousRecording(oldRecording) {
  const recordingId = `rec-${oldRecording.room}-${Date.now()}`;
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400; // 30 days

  const newRecording = {
    recordingId,
    room: oldRecording.room,
    shard: oldRecording.shard,
    status: "active",
    tickInterval: oldRecording.tickInterval,
    durationTicks: oldRecording.durationTicks,
    continuous: true,
    startTick: null,
    endTick: null,
    lastCapturedTick: null,
    ticksCaptured: 0,
    terrainCaptured: false,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };

  await docClient.send(
    new PutCommand({
      TableName: RECORDINGS_TABLE,
      Item: newRecording,
    })
  );

  console.log(`Created continuous recording ${recordingId} for room ${oldRecording.room}`);
  return newRecording;
}

/**
 * Process a single recording
 */
async function processRecording(recording, token, currentTick, roomObjectsCache) {
  const shard = recording.shard || SCREEPS_SHARD;
  const result = { recordingId: recording.recordingId, status: "processed" };

  try {
    // Check if this is the first capture (set startTick)
    if (recording.startTick === null || recording.startTick === undefined) {
      const endTick = currentTick + recording.durationTicks;
      await updateRecording(recording.recordingId, {
        startTick: currentTick,
        endTick: endTick,
      });
      recording.startTick = currentTick;
      recording.endTick = endTick;
      console.log(`[${recording.room}] First capture: startTick=${currentTick}, endTick=${endTick}`);
    }

    // Check if recording has ended
    if (currentTick >= recording.endTick) {
      await updateRecording(recording.recordingId, { status: "complete" });
      console.log(`[${recording.room}] Recording ${recording.recordingId} completed`);
      result.status = "completed";

      // Publish RecordingComplete event to trigger analysis
      await publishRecordingComplete(recording);

      // If continuous mode, create a new recording
      if (recording.continuous) {
        const newRecording = await createContinuousRecording(recording);
        result.continuedAs = newRecording.recordingId;
      }

      return result;
    }

    // Check if enough ticks have elapsed since last capture
    const tickInterval = recording.tickInterval || 3;
    if (recording.lastCapturedTick !== null && recording.lastCapturedTick !== undefined) {
      const ticksSinceCapture = currentTick - recording.lastCapturedTick;
      if (ticksSinceCapture < tickInterval) {
        result.status = "skipped";
        result.reason = `Only ${ticksSinceCapture} ticks since last capture`;
        return result;
      }
    }

    // Fetch room objects (use cache if already fetched for this room)
    const cacheKey = `${recording.room}:${shard}`;
    let objects;
    if (roomObjectsCache.has(cacheKey)) {
      objects = roomObjectsCache.get(cacheKey);
    } else {
      objects = await fetchRoomObjects(token, recording.room, shard);
      roomObjectsCache.set(cacheKey, objects);
    }
    console.log(`[${recording.room}] Fetched ${objects.length} objects`);

    // Capture terrain if not already done
    if (!recording.terrainCaptured) {
      const terrain = await fetchRoomTerrain(token, recording.room, shard);
      await writeTerrain(recording.recordingId, recording.room, terrain);
      await updateRecording(recording.recordingId, { terrainCaptured: true });
    }

    // Write snapshot to S3
    await writeSnapshot(recording.recordingId, currentTick, recording.room, objects);

    // Update DynamoDB tracking
    const newTicksCaptured = (recording.ticksCaptured || 0) + 1;
    await updateRecording(recording.recordingId, {
      lastCapturedTick: currentTick,
      ticksCaptured: newTicksCaptured,
    });

    result.tick = currentTick;
    result.ticksCaptured = newTicksCaptured;
    result.objectCount = objects.length;

    console.log(`[${recording.room}] Capture complete: tick ${currentTick}, total: ${newTicksCaptured}`);
  } catch (error) {
    console.error(`[${recording.room}] Error processing recording:`, error);
    result.status = "error";
    result.error = error.message;
  }

  return result;
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

    console.log(`Found ${activeRecordings.length} active recording(s)`);

    // 2. Get Screeps token
    const token = await getScreepsToken();

    // 3. Fetch current game tick (once for all recordings)
    // Use the shard from the first recording, assume all are on same shard
    const shard = activeRecordings[0].shard || SCREEPS_SHARD;
    const currentTick = await fetchGameTime(token, shard);
    console.log(`Current game tick: ${currentTick}`);

    // 4. Process all active recordings
    // Cache room objects to avoid duplicate API calls for same room
    const roomObjectsCache = new Map();
    const results = [];

    for (const recording of activeRecordings) {
      const result = await processRecording(recording, token, currentTick, roomObjectsCache);
      results.push(result);
    }

    console.log(`Processed ${results.length} recording(s)`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Processing complete",
        tick: currentTick,
        recordings: results,
      }),
    };
  } catch (error) {
    console.error("Error in room recorder:", error);
    throw error;
  }
}
