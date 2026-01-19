import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const eventBridge = new EventBridgeClient({});
const firehose = new FirehoseClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;
const FIREHOSE_STREAM = process.env.FIREHOSE_STREAM;
const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;

// Thresholds for detecting significant changes
const THRESHOLDS = {
  energyDropPercent: 30,
  creepCountChange: 3,
  rclProgress: 0.1,
  threatLevel: 1,
};

/**
 * Process DynamoDB Stream records and emit events to EventBridge
 */
export async function handler(event) {
  console.log(`Processing ${event.Records.length} stream records`);

  const events = [];
  const archiveRecords = [];

  for (const record of event.Records) {
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") {
      continue;
    }

    const newImage = record.dynamodb.NewImage;
    const oldImage = record.dynamodb.OldImage;

    if (!newImage) continue;

    // Convert DynamoDB format to regular object
    const snapshot = unmarshall(newImage);
    const previousSnapshot = oldImage ? unmarshall(oldImage) : null;

    // Always emit SnapshotCreated event for metrics
    events.push({
      Source: "screeps.advisor",
      DetailType: "SnapshotCreated",
      Detail: JSON.stringify({
        roomName: snapshot.roomName,
        timestamp: snapshot.timestamp,
        snapshot: snapshot,
      }),
      EventBusName: EVENT_BUS_NAME,
    });

    // Detect significant changes
    const significantEvents = detectSignificantChanges(snapshot, previousSnapshot);
    events.push(...significantEvents);

    // Archive the record
    archiveRecords.push({
      Data: Buffer.from(JSON.stringify({
        eventName: record.eventName,
        timestamp: Date.now(),
        snapshot: snapshot,
      }) + "\n"),
    });
  }

  // Send events to EventBridge in batches of 10
  if (events.length > 0) {
    const batches = chunk(events, 10);
    for (const batch of batches) {
      await eventBridge.send(new PutEventsCommand({ Entries: batch }));
    }
    console.log(`Sent ${events.length} events to EventBridge`);
  }

  // Archive to Firehose
  if (archiveRecords.length > 0 && FIREHOSE_STREAM) {
    for (const record of archiveRecords) {
      await firehose.send(new PutRecordCommand({
        DeliveryStreamName: FIREHOSE_STREAM,
        Record: record,
      }));
    }
    console.log(`Archived ${archiveRecords.length} records to Firehose`);
  }

  return { processed: event.Records.length, events: events.length };
}

/**
 * Detect significant changes between snapshots
 */
function detectSignificantChanges(current, previous) {
  const events = [];
  const roomName = current.roomName;

  // No previous snapshot to compare
  if (!previous) {
    return events;
  }

  // Check for threat level changes
  if (current.threatLevel > 0 && (!previous.threatLevel || current.threatLevel > previous.threatLevel)) {
    events.push(createEvent("ThreatDetected", {
      roomName,
      threatLevel: current.threatLevel,
      previousLevel: previous.threatLevel || 0,
      hostileCount: current.hostileCount || 0,
    }));
  }

  // Check for energy economy anomalies
  if (previous.energyAvailable && current.energyAvailable) {
    const energyDrop = (previous.energyAvailable - current.energyAvailable) / previous.energyAvailable;
    if (energyDrop > THRESHOLDS.energyDropPercent / 100) {
      events.push(createEvent("EconomyAnomaly", {
        roomName,
        type: "energy_drop",
        previousEnergy: previous.energyAvailable,
        currentEnergy: current.energyAvailable,
        dropPercent: Math.round(energyDrop * 100),
      }));
    }
  }

  // Check for RCL progress
  if (current.controllerProgress && previous.controllerProgress) {
    const progressDelta = current.controllerProgress - previous.controllerProgress;
    const progressPercent = progressDelta / (current.controllerProgressTotal || 1);
    if (progressPercent >= THRESHOLDS.rclProgress) {
      events.push(createEvent("RCLProgress", {
        roomName,
        rcl: current.rcl,
        progress: current.controllerProgress,
        progressTotal: current.controllerProgressTotal,
        progressPercent: Math.round(progressPercent * 100),
      }));
    }
  }

  // Check for significant creep count changes
  if (current.creepCount !== undefined && previous.creepCount !== undefined) {
    const creepDelta = Math.abs(current.creepCount - previous.creepCount);
    if (creepDelta >= THRESHOLDS.creepCountChange) {
      events.push(createEvent("SignificantChange", {
        roomName,
        type: "creep_count",
        previous: previous.creepCount,
        current: current.creepCount,
        delta: current.creepCount - previous.creepCount,
      }));
    }
  }

  // Check for storage level changes
  if (current.storageEnergy !== undefined && previous.storageEnergy !== undefined) {
    const storageDelta = current.storageEnergy - previous.storageEnergy;
    const storagePercent = Math.abs(storageDelta) / Math.max(previous.storageEnergy, 1);
    if (storagePercent > 0.2) { // 20% change
      events.push(createEvent("SignificantChange", {
        roomName,
        type: "storage_level",
        previous: previous.storageEnergy,
        current: current.storageEnergy,
        delta: storageDelta,
      }));
    }
  }

  return events;
}

/**
 * Create an EventBridge event
 */
function createEvent(detailType, detail) {
  return {
    Source: "screeps.advisor",
    DetailType: detailType,
    Detail: JSON.stringify({
      ...detail,
      timestamp: Date.now(),
    }),
    EventBusName: EVENT_BUS_NAME,
  };
}

/**
 * Unmarshall DynamoDB record to regular object
 */
function unmarshall(item) {
  const result = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) result[key] = value.S;
    else if (value.N !== undefined) result[key] = parseFloat(value.N);
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
    else if (value.NULL !== undefined) result[key] = null;
    else if (value.M !== undefined) result[key] = unmarshall(value.M);
    else if (value.L !== undefined) result[key] = value.L.map(v => unmarshall({ v }).v);
    else result[key] = value;
  }
  return result;
}

/**
 * Split array into chunks
 */
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
