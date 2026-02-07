import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});
const s3Client = new S3Client({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const SIGNALS_TABLE = process.env.SIGNALS_TABLE;
const OBSERVATIONS_TABLE = process.env.OBSERVATIONS_TABLE;
const INTEL_TABLE = process.env.INTEL_TABLE;
const RECORDINGS_TABLE = process.env.RECORDINGS_TABLE;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;
const SCREEPS_TOKEN_SECRET = process.env.SCREEPS_TOKEN_SECRET;
const SCREEPS_SHARD = process.env.SCREEPS_SHARD || "shard0";

// Cache for Screeps token
let cachedToken = null;

// ==================== Response Metadata Helpers ====================

/**
 * Wrap response with standard metadata fields.
 * @param {object} data - The response payload
 * @param {string} source - Data source: "segment90", "dynamodb", "screeps-api"
 * @param {number|null} dataTimestamp - When the underlying data was last updated (epoch ms)
 * @returns {object} Wrapped response
 */
function withMeta(data, source, dataTimestamp) {
  return {
    source: source,
    freshness: dataTimestamp ? Math.round((Date.now() - dataTimestamp) / 1000) : null,
    fetchedAt: Date.now(),
    ...data,
  };
}

// ==================== Screeps API Helpers ====================

/**
 * Get Screeps API token from Secrets Manager (cached)
 */
async function getScreepsToken() {
  if (cachedToken) return cachedToken;

  if (!SCREEPS_TOKEN_SECRET) {
    throw new Error("SCREEPS_TOKEN_SECRET not configured");
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: SCREEPS_TOKEN_SECRET,
    })
  );
  cachedToken = response.SecretString;
  return cachedToken;
}

/**
 * Fetch segment 90 directly from Screeps API
 */
async function fetchSegment90() {
  const token = await getScreepsToken();

  const response = await fetch(
    `https://screeps.com/api/user/memory-segment?segment=90&shard=${SCREEPS_SHARD}`,
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

  return typeof data.data === "string" ? JSON.parse(data.data) : data.data;
}

/**
 * Fetch segment 92 (position log) directly from Screeps API
 */
async function fetchSegment92() {
  const token = await getScreepsToken();

  const response = await fetch(
    `https://screeps.com/api/user/memory-segment?segment=92&shard=${SCREEPS_SHARD}`,
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
  if (!data.data) return { room: null, startTick: 0, entries: [] };

  return typeof data.data === "string" ? JSON.parse(data.data) : data.data;
}

// ==================== Intel Endpoints ====================

/**
 * Get intel for a specific room from DynamoDB (with segment 90 fallback)
 */
async function getIntel(roomName) {
  // Try DynamoDB first (persistent), fall back to segment 90 (live delta)
  if (INTEL_TABLE) {
    try {
      const result = await docClient.send(
        new GetCommand({
          TableName: INTEL_TABLE,
          Key: { roomName: roomName },
        })
      );

      if (result.Item) {
        return {
          source: "dynamodb",
          fetchedAt: Date.now(),
          updatedAt: result.Item.updatedAt,
          gameTick: result.Item.gameTick,
          ...result.Item,
        };
      }
    } catch (error) {
      console.error(`Error reading intel from DynamoDB for ${roomName}:`, error);
    }
  }

  // Fallback to segment 90
  const data = await fetchSegment90();
  if (!data || !data.intel) {
    return { error: "No intel data available", roomName };
  }

  const intel = data.intel[roomName];
  if (!intel) {
    return {
      error: `Intel for room ${roomName} not found`,
      availableRooms: Object.keys(data.intel),
    };
  }

  return {
    source: "segment90",
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
    ...intel,
  };
}

/**
 * Get all intel within range of home room (from DynamoDB with segment 90 fallback)
 */
async function getAllIntel(range, homeRoom) {
  let rooms = [];
  let source = "segment90";

  // Try DynamoDB first (persistent, complete)
  if (INTEL_TABLE) {
    try {
      const result = await docClient.send(
        new ScanCommand({
          TableName: INTEL_TABLE,
        })
      );
      rooms = result.Items || [];

      // Handle pagination for large datasets
      let lastKey = result.LastEvaluatedKey;
      while (lastKey) {
        const nextResult = await docClient.send(
          new ScanCommand({
            TableName: INTEL_TABLE,
            ExclusiveStartKey: lastKey,
          })
        );
        rooms = rooms.concat(nextResult.Items || []);
        lastKey = nextResult.LastEvaluatedKey;
      }
      source = "dynamodb";
    } catch (error) {
      console.error("Error scanning intel from DynamoDB:", error);
      // Fall through to segment 90 fallback
      rooms = [];
    }
  }

  // Fallback to segment 90 if DynamoDB returned nothing
  if (rooms.length === 0) {
    const data = await fetchSegment90();
    if (!data || !data.intel) {
      return { error: "No intel data available" };
    }
    rooms = Object.values(data.intel);
    source = "segment90";
  }

  // Filter by range if specified
  if (range && homeRoom) {
    const home = parseRoomName(homeRoom);
    if (home) {
      rooms = rooms.filter(room => {
        const target = parseRoomName(room.roomName);
        if (!target) return false;
        const distance = Math.max(Math.abs(target.x - home.x), Math.abs(target.y - home.y));
        return distance <= range;
      });
    }
  }

  return {
    source: source,
    fetchedAt: Date.now(),
    homeRoom: homeRoom || "E46N37",
    range: range || "all",
    rooms: rooms,
    roomCount: rooms.length,
  };
}

/**
 * Get expansion candidates with scoring (from DynamoDB with segment 90 fallback)
 */
async function getExpansionCandidates(homeRoom) {
  let intel = {};
  let source = "segment90";

  // Try DynamoDB first
  if (INTEL_TABLE) {
    try {
      const result = await docClient.send(
        new ScanCommand({
          TableName: INTEL_TABLE,
        })
      );
      let items = result.Items || [];

      // Handle pagination
      let lastKey = result.LastEvaluatedKey;
      while (lastKey) {
        const nextResult = await docClient.send(
          new ScanCommand({
            TableName: INTEL_TABLE,
            ExclusiveStartKey: lastKey,
          })
        );
        items = items.concat(nextResult.Items || []);
        lastKey = nextResult.LastEvaluatedKey;
      }

      // Convert array to keyed object for scoring function compatibility
      for (const item of items) {
        intel[item.roomName] = item;
      }
      source = "dynamodb";
    } catch (error) {
      console.error("Error scanning intel from DynamoDB:", error);
    }
  }

  // Fallback to segment 90
  if (Object.keys(intel).length === 0) {
    const data = await fetchSegment90();
    if (!data || !data.intel) {
      return { error: "No intel data available" };
    }
    intel = data.intel;
    source = "segment90";
  }

  const home = homeRoom || "E46N37";
  const myUsername = "Superstringman";

  // Get existing colonies
  const existingColonies = Object.values(intel).filter(r =>
    r.owner === myUsername && r.ownerRcl && r.ownerRcl > 0
  );

  // Score all candidate rooms
  const candidates = Object.values(intel)
    .filter(room => room.roomType === "normal")
    .filter(room => !room.owner)
    .filter(room => room.sources && room.sources.length >= 1)
    .filter(room => room.distanceFromHome >= 3)
    .map(room => ({
      ...room,
      expansionScore: calculateExpansionScore(room, intel, existingColonies, myUsername),
    }))
    .filter(room => room.expansionScore > 0)
    .sort((a, b) => b.expansionScore - a.expansionScore)
    .slice(0, 10);

  return {
    source: source,
    fetchedAt: Date.now(),
    homeRoom: home,
    candidates,
    candidateCount: candidates.length,
  };
}

/**
 * Parse room name to coordinates
 */
function parseRoomName(roomName) {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return null;

  const x = parseInt(match[2]) * (match[1] === "E" ? 1 : -1);
  const y = parseInt(match[4]) * (match[3] === "N" ? 1 : -1);
  return { x, y };
}

/**
 * Get delta between two rooms
 */
function getRoomDelta(from, to) {
  const f = parseRoomName(from);
  const t = parseRoomName(to);
  if (!f || !t) return [0, 0];
  return [t.x - f.x, t.y - f.y];
}

/**
 * Calculate expansion score for a room
 */
function calculateExpansionScore(room, allIntel, existingColonies, myUsername) {
  let score = 0;

  // Base score: 2 sources = 20, 1 source = 10
  score += (room.sources?.length || 0) * 10;

  // Mineral diversity bonus
  const homeMineral = allIntel["E46N37"]?.mineral?.type;
  if (room.mineral && room.mineral.type !== homeMineral) {
    score += 15;
  }

  // Adjacent remote quality (the 4 cardinal rooms this colony would mine)
  const exits = [room.exits?.top, room.exits?.right, room.exits?.bottom, room.exits?.left];
  for (const exit of exits) {
    if (!exit) continue;
    const adjacent = allIntel[exit];
    if (adjacent && adjacent.roomType === "normal" && !adjacent.owner) {
      score += (adjacent.sources?.length || 0) * 5; // Good remotes = big bonus
    } else if (adjacent?.owner && adjacent.owner !== myUsername) {
      score -= 15; // Can't use this remote direction
    } else if (adjacent?.roomType === "sourceKeeper") {
      score += 3; // SK rooms are bonus income later
    }
  }

  // Terrain penalty
  if (room.terrain) {
    score -= (room.terrain.swampPercent || 0) * 0.2;
    score -= (room.terrain.wallPercent || 0) * 0.1;
  }

  // Distance from home - must be 3+ rooms in cardinal direction
  const distance = room.distanceFromHome || 0;
  if (distance < 3) {
    score -= 100; // Too close, would overlap remotes
  } else if (distance >= 3 && distance <= 6) {
    score += 10; // Optimal distance
  } else if (distance > 6) {
    score -= (distance - 6) * 5; // Too far penalty
  }

  // Check for proper 3-room cardinal spacing from existing colonies
  for (const colony of existingColonies) {
    const [dx, dy] = getRoomDelta(colony.roomName, room.roomName);

    // Cardinal alignment check (same row or column)
    if (dx === 0 || dy === 0) {
      const cardinalDistance = Math.abs(dx) + Math.abs(dy);
      if (cardinalDistance < 3) {
        score -= 100; // Would overlap remotes
      } else if (cardinalDistance === 3) {
        score += 5; // Perfect spacing
      }
    }
  }

  // Hostile neighbor penalty
  for (const exit of exits) {
    if (!exit) continue;
    const adjacent = allIntel[exit];
    if (adjacent?.owner && adjacent.owner !== myUsername) {
      score -= 20; // Hostile neighbor
    }
  }

  return Math.max(0, Math.round(score));
}

// ==================== Colony Endpoints (v2) ====================

/**
 * GET /colonies — list all colonies with summary data
 */
async function getColonies() {
  const data = await fetchSegment90();
  if (!data) return { error: "No data in segment 90" };

  const colonies = (data.colonies || []).map(function(c) {
    return {
      roomName: c.roomName,
      rcl: c.rcl,
      rclProgress: c.rclProgress,
      rclProgressTotal: c.rclProgressTotal,
      energy: c.energy,
      creepCount: c.creeps && c.creeps.total ? c.creeps.total : 0,
      creepsByRole: c.creeps && c.creeps.byRole ? c.creeps.byRole : {},
      threats: c.threats,
      constructionSites: c.structures && c.structures.constructionSites ? c.structures.constructionSites : 0,
      remoteRooms: c.remoteRooms || [],
    };
  });

  return withMeta({
    gameTick: data.gameTick,
    colonies: colonies,
    colonyCount: colonies.length,
    global: data.global,
  }, "segment90", data.timestamp);
}

/**
 * GET /colonies/{roomName} — full colony detail (merged live + diagnostics)
 */
async function getColony(roomName) {
  const data = await fetchSegment90();
  if (!data) return { error: "No data in segment 90" };

  const colony = (data.colonies || []).find(function(c) { return c.roomName === roomName; });
  if (!colony) {
    return {
      error: "Colony " + roomName + " not found",
      availableRooms: (data.colonies || []).map(function(c) { return c.roomName; }),
    };
  }

  // Merge diagnostics into colony response
  var diagnostics = data.diagnostics && data.diagnostics[roomName] ? data.diagnostics[roomName] : null;

  return withMeta({
    gameTick: data.gameTick,
    ...colony,
    diagnostics: diagnostics,
    global: data.global,
  }, "segment90", data.timestamp);
}

/**
 * GET /colonies/{roomName}/creeps — creep roster with details
 */
async function getColonyCreeps(roomName) {
  const data = await fetchSegment90();
  if (!data) return { error: "No data in segment 90" };

  const colony = (data.colonies || []).find(function(c) { return c.roomName === roomName; });
  if (!colony) return { error: "Colony " + roomName + " not found" };

  return withMeta({
    gameTick: data.gameTick,
    roomName: roomName,
    total: colony.creeps && colony.creeps.total ? colony.creeps.total : 0,
    byRole: colony.creeps && colony.creeps.byRole ? colony.creeps.byRole : {},
    details: colony.creeps && colony.creeps.details ? colony.creeps.details : [],
  }, "segment90", data.timestamp);
}

/**
 * GET /colonies/{roomName}/economy — energy flow and economic metrics
 */
async function getColonyEconomy(roomName) {
  const data = await fetchSegment90();
  if (!data) return { error: "No data in segment 90" };

  const colony = (data.colonies || []).find(function(c) { return c.roomName === roomName; });
  if (!colony) return { error: "Colony " + roomName + " not found" };

  return withMeta({
    gameTick: data.gameTick,
    roomName: roomName,
    energy: colony.energy,
    economy: colony.economy || null,
    mineral: colony.mineral || null,
  }, "segment90", data.timestamp);
}

/**
 * GET /colonies/{roomName}/remotes — remote mining status
 */
async function getColonyRemotes(roomName) {
  const data = await fetchSegment90();
  if (!data) return { error: "No data in segment 90" };

  const colony = (data.colonies || []).find(function(c) { return c.roomName === roomName; });
  if (!colony) return { error: "Colony " + roomName + " not found" };

  return withMeta({
    gameTick: data.gameTick,
    roomName: roomName,
    remoteRooms: colony.remoteRooms || [],
    remoteMining: colony.remoteMining || null,
    remoteDefense: colony.remoteDefense || null,
    adjacentRooms: colony.adjacentRooms || [],
  }, "segment90", data.timestamp);
}

/**
 * GET /intel/enemies — rooms with hostile owners
 */
async function getEnemyIntel() {
  if (!INTEL_TABLE) return { error: "Intel table not configured" };

  var items = [];
  try {
    var result = await docClient.send(new ScanCommand({ TableName: INTEL_TABLE }));
    items = result.Items || [];
    var lastKey = result.LastEvaluatedKey;
    while (lastKey) {
      var nextResult = await docClient.send(
        new ScanCommand({ TableName: INTEL_TABLE, ExclusiveStartKey: lastKey })
      );
      items = items.concat(nextResult.Items || []);
      lastKey = nextResult.LastEvaluatedKey;
    }
  } catch (error) {
    console.error("Error scanning intel for enemies:", error);
    return { error: "Failed to scan intel table" };
  }

  var myUsername = "Superstringman";
  var enemies = items.filter(function(r) {
    return r.owner && r.owner !== myUsername;
  });

  // Group by owner for summary
  var byOwner = {};
  for (var i = 0; i < enemies.length; i++) {
    var owner = enemies[i].owner;
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(enemies[i].roomName);
  }

  return withMeta({
    rooms: enemies,
    roomCount: enemies.length,
    byOwner: byOwner,
  }, "dynamodb");
}

// ==================== Empire Endpoints ====================

/**
 * Get empire status from segment 90
 */
async function getEmpireStatus() {
  const data = await fetchSegment90();

  if (!data) {
    return { error: "No data in segment 90" };
  }

  if (!data.empire) {
    return {
      error: "No empire data available",
      hint: "Ensure bot is exporting empire data via AWSExporter.getEmpireStatus()",
      availableKeys: Object.keys(data),
    };
  }

  return {
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
    timestamp: data.timestamp,
    shard: data.shard,
    ...data.empire,
  };
}

/**
 * Get expansion status from segment 90
 */
async function getExpansionStatus(roomName = null) {
  const data = await fetchSegment90();

  if (!data) {
    return { error: "No data in segment 90" };
  }

  if (!data.empire || !data.empire.expansion) {
    return {
      error: "No expansion data available",
      hint: "Ensure bot is exporting expansion data via AWSExporter.getEmpireStatus()",
    };
  }

  const expansion = data.empire.expansion;

  // If specific room requested, filter to that expansion
  if (roomName) {
    const roomExpansion = expansion.active?.find(e => e.roomName === roomName) ||
                          expansion.queue?.find(e => e.roomName === roomName);

    if (!roomExpansion) {
      return {
        error: `No expansion found for room ${roomName}`,
        activeRooms: expansion.active?.map(e => e.roomName) || [],
        queuedRooms: expansion.queue?.map(e => e.roomName) || [],
      };
    }

    return {
      live: true,
      requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      fetchedAt: Date.now(),
      gameTick: data.gameTick,
      timestamp: data.timestamp,
      shard: data.shard,
      roomName,
      ...roomExpansion,
    };
  }

  // Return all expansion data
  return {
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
    timestamp: data.timestamp,
    shard: data.shard,
    ...expansion,
  };
}

/**
 * Queue an expansion command via memory segment 91
 */
async function queueExpansionCommand(action, roomName, parentRoom = null) {
  if (!action) {
    return { error: "Missing action (start, cancel, queue)" };
  }

  if (!roomName) {
    return { error: "Missing roomName" };
  }

  let command;
  switch (action) {
    case "start":
      if (!parentRoom) {
        return { error: "Missing parentRoom for start action" };
      }
      command = `expansion.start("${roomName}", "${parentRoom}")`;
      break;
    case "queue":
      if (!parentRoom) {
        return { error: "Missing parentRoom for queue action" };
      }
      command = `expansion.queue("${roomName}", "${parentRoom}")`;
      break;
    case "cancel":
      command = `expansion.cancel("${roomName}")`;
      break;
    default:
      return { error: `Unknown action: ${action}. Use start, queue, or cancel` };
  }

  // Use the existing queueCommand function
  return queueCommand(command);
}

// ==================== DynamoDB Route Handlers ====================

async function getRecommendations(roomName) {
  const response = await docClient.send(new QueryCommand({
    TableName: RECOMMENDATIONS_TABLE,
    IndexName: 'room-index',
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: 50,
  }));

  // Filter out expired recommendations
  const now = Date.now();
  const items = response.Items || [];
  return items.filter(r => !r.expiresAt || r.expiresAt > now);
}

async function getMetricHistory(roomName, hours = 24) {
  const since = Date.now() - (hours * 60 * 60 * 1000);

  const response = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: 'roomName = :room AND #ts > :since',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':room': roomName, ':since': since },
    ScanIndexForward: true,
  }));

  return response.Items || [];
}

async function submitFeedback(recommendationId, feedback) {
  await docClient.send(new UpdateCommand({
    TableName: RECOMMENDATIONS_TABLE,
    Key: { id: recommendationId },
    UpdateExpression: 'SET #status = :status, feedback = :feedback, feedbackAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': feedback.action,
      ':feedback': feedback,
      ':now': Date.now(),
    },
  }));

  return { success: true };
}

// ==================== Signal Layer Endpoints ====================

async function getSignals(roomName, hours = 24) {
  if (!SIGNALS_TABLE) {
    return { error: "Signals table not configured" };
  }

  const since = Date.now() - (hours * 60 * 60 * 1000);

  const response = await docClient.send(new QueryCommand({
    TableName: SIGNALS_TABLE,
    KeyConditionExpression: 'roomName = :room AND #ts > :since',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':room': roomName, ':since': since },
    ScanIndexForward: true,
  }));

  const items = response.Items || [];

  // Extract all events
  const events = [];
  for (const item of items) {
    if (item.events) {
      events.push(...item.events.map(e => ({
        ...e,
        gameTick: item.gameTick,
        snapshotTimestamp: item.timestamp,
      })));
    }
  }

  // Compute trends from metrics
  const trends = computeTrends(items);

  return {
    roomName,
    hours,
    dataPoints: items.length,
    events,
    eventCount: events.length,
    trends,
    latestMetrics: items.length > 0 ? items[items.length - 1].metrics : null,
  };
}

function computeTrends(items) {
  if (items.length < 2) return {};

  const first = items[0].metrics || {};
  const last = items[items.length - 1].metrics || {};

  const trends = {};
  const keys = new Set([...Object.keys(first), ...Object.keys(last)]);

  for (const key of keys) {
    const firstVal = first[key];
    const lastVal = last[key];

    if (typeof firstVal === 'number' && typeof lastVal === 'number') {
      const delta = lastVal - firstVal;
      const percentChange = firstVal !== 0 ? (delta / firstVal) * 100 : 0;

      trends[key] = {
        start: firstVal,
        end: lastVal,
        delta,
        percentChange: Math.round(percentChange * 10) / 10,
        trend: delta > 0 ? 'increasing' : delta < 0 ? 'decreasing' : 'stable',
      };
    }
  }

  return trends;
}

async function getSignalEvents(roomName, hours = 24) {
  if (!SIGNALS_TABLE) {
    return { error: "Signals table not configured" };
  }

  const since = Date.now() - (hours * 60 * 60 * 1000);

  const response = await docClient.send(new QueryCommand({
    TableName: SIGNALS_TABLE,
    KeyConditionExpression: 'roomName = :room AND #ts > :since',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':room': roomName, ':since': since },
    ScanIndexForward: false,
  }));

  // Flatten and return only events
  const events = [];
  for (const item of response.Items || []) {
    if (item.events && item.events.length > 0) {
      events.push(...item.events.map(e => ({
        ...e,
        gameTick: item.gameTick,
        snapshotTimestamp: item.timestamp,
      })));
    }
  }

  return {
    roomName,
    hours,
    events,
    eventCount: events.length,
  };
}

// ==================== Observation Layer Endpoints ====================

async function getObservations(roomName, limit = 10) {
  if (!OBSERVATIONS_TABLE) {
    return { error: "Observations table not configured" };
  }

  const response = await docClient.send(new QueryCommand({
    TableName: OBSERVATIONS_TABLE,
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: limit,
  }));

  return {
    roomName,
    observations: response.Items || [],
    count: response.Items?.length || 0,
  };
}

async function getPatterns(roomName) {
  if (!OBSERVATIONS_TABLE) {
    return { error: "Observations table not configured" };
  }

  // Get recent observations to aggregate patterns
  const response = await docClient.send(new QueryCommand({
    TableName: OBSERVATIONS_TABLE,
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: 20,
  }));

  // Aggregate patterns across observations
  const patternMap = new Map();

  for (const obs of response.Items || []) {
    for (const pattern of obs.patterns || []) {
      const key = pattern.description;
      if (!patternMap.has(key)) {
        patternMap.set(key, {
          description: pattern.description,
          trend: pattern.trend,
          firstSeen: obs.timestamp,
          lastSeen: obs.timestamp,
          occurrences: 1,
          evidence: [pattern.evidence],
        });
      } else {
        const existing = patternMap.get(key);
        existing.lastSeen = Math.max(existing.lastSeen, obs.timestamp);
        existing.firstSeen = Math.min(existing.firstSeen, obs.timestamp);
        existing.occurrences++;
        existing.trend = pattern.trend; // Use most recent trend
        if (pattern.evidence && !existing.evidence.includes(pattern.evidence)) {
          existing.evidence.push(pattern.evidence);
        }
      }
    }
  }

  return {
    roomName,
    patterns: Array.from(patternMap.values()).sort((a, b) => b.occurrences - a.occurrences),
    patternCount: patternMap.size,
  };
}

// ==================== Console Command Endpoint ====================

const COMMAND_SEGMENT = 91;

/**
 * Queue a command for execution via memory segment 91
 * The game code will pick it up and write the result back
 */
async function queueCommand(command, shard = "shard0") {
  if (!command) {
    return { error: "Missing command" };
  }

  // Basic safety check - block obviously dangerous commands
  const blocked = [
    "Game.cpu.halt",
    "delete Memory",
    "Memory = {}",
    "Memory = null",
    "RawMemory.set",
  ];

  if (blocked.some((b) => command.includes(b))) {
    return { error: "Command blocked for safety", command };
  }

  const token = await getScreepsToken();
  const requestId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Write command to segment 91
  const segmentPayload = JSON.stringify({
    status: "pending",
    requestId: requestId,
    command: command,
    sentAt: Date.now(),
  });

  const response = await fetch("https://screeps.com/api/user/memory-segment", {
    method: "POST",
    headers: {
      "X-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      segment: COMMAND_SEGMENT,
      shard: shard,
      data: segmentPayload,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Failed to write command segment:", error);
    return { error: "Failed to queue command", details: error };
  }

  // Log command for audit trail
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      action: "queue_command",
      requestId: requestId,
      command: command,
      shard: shard,
    })
  );

  return {
    success: true,
    requestId: requestId,
    command: command,
    shard: shard,
    message: "Command queued. Fetch /command/result to get output after next game tick.",
  };
}

/**
 * Get command result from memory segment 91
 */
async function getCommandResult(shard = "shard0", requestId = null) {
  const token = await getScreepsToken();

  const response = await fetch(
    `https://screeps.com/api/user/memory-segment?segment=${COMMAND_SEGMENT}&shard=${shard}`,
    {
      headers: { "X-Token": token },
    }
  );

  if (!response.ok) {
    return { error: "Failed to fetch result segment" };
  }

  const data = await response.json();

  if (!data.ok || !data.data) {
    return { status: "empty", message: "No command result available" };
  }

  const result = JSON.parse(data.data);

  // If requestId provided, verify it matches
  if (requestId && result.requestId !== requestId) {
    return {
      status: "mismatch",
      message: "Result is from a different command",
      expectedRequestId: requestId,
      actualRequestId: result.requestId,
      currentResult: result,
    };
  }

  return result;
}

// ==================== Recording Endpoints ====================

/**
 * Create a new recording
 */
async function createRecording(body) {
  if (!RECORDINGS_TABLE) {
    return { error: "Recordings table not configured" };
  }

  const { room, shard, tickInterval, durationTicks, continuous } = body;

  // Validate room format
  if (!room || !/^[EW]\d+[NS]\d+$/.test(room)) {
    return { error: "Invalid room format. Expected format: E46N37" };
  }

  // Validate tickInterval (1-20)
  const finalTickInterval = tickInterval || 3;
  if (finalTickInterval < 1 || finalTickInterval > 20) {
    return { error: "tickInterval must be between 1 and 20" };
  }

  // Check for existing active recording FOR THE SAME ROOM (one per room allowed)
  const existing = await docClient.send(new ScanCommand({
    TableName: RECORDINGS_TABLE,
    FilterExpression: "#status = :active AND room = :room",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":active": "active", ":room": room }
  }));

  if (existing.Items?.length > 0) {
    return {
      error: `Active recording already exists for room ${room}`,
      existingRecordingId: existing.Items[0].recordingId,
      room: existing.Items[0].room
    };
  }

  // Continuous mode: set durationTicks to 30000 (~24 hours at 3s/tick)
  // Otherwise validate durationTicks (100-50000)
  let finalDurationTicks = durationTicks || 3000;
  const isContinuous = continuous === true;
  if (isContinuous) {
    finalDurationTicks = 30000;
  } else if (finalDurationTicks < 100 || finalDurationTicks > 50000) {
    return { error: "durationTicks must be between 100 and 50000" };
  }

  const recordingId = `rec-${room}-${Date.now()}`;
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days TTL

  const item = {
    recordingId,
    room,
    shard: shard || SCREEPS_SHARD,
    status: "active",
    tickInterval: finalTickInterval,
    durationTicks: finalDurationTicks,
    continuous: isContinuous,
    startTick: null,
    endTick: null,
    lastCapturedTick: null,
    ticksCaptured: 0,
    terrainCaptured: false,
    createdAt: now,
    updatedAt: now,
    expiresAt
  };

  await docClient.send(new PutCommand({
    TableName: RECORDINGS_TABLE,
    Item: item
  }));

  return item;
}

/**
 * List all recordings
 */
async function listRecordings() {
  if (!RECORDINGS_TABLE) {
    return { error: "Recordings table not configured" };
  }

  const result = await docClient.send(new ScanCommand({
    TableName: RECORDINGS_TABLE
  }));

  const items = result.Items || [];
  // Sort by createdAt descending
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return {
    recordings: items,
    count: items.length
  };
}

/**
 * Get a single recording
 */
async function getRecording(recordingId) {
  if (!RECORDINGS_TABLE) {
    return { error: "Recordings table not configured" };
  }

  const result = await docClient.send(new GetCommand({
    TableName: RECORDINGS_TABLE,
    Key: { recordingId }
  }));

  if (!result.Item) {
    return { error: "Recording not found", recordingId };
  }

  return result.Item;
}

/**
 * Update recording status
 */
async function updateRecordingStatus(recordingId, body) {
  if (!RECORDINGS_TABLE) {
    return { error: "Recordings table not configured" };
  }

  const { status, continuous } = body;
  const validStatuses = ["active", "paused", "complete"];

  if (!status || !validStatuses.includes(status)) {
    return { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` };
  }

  // Verify recording exists
  const existing = await docClient.send(new GetCommand({
    TableName: RECORDINGS_TABLE,
    Key: { recordingId }
  }));

  if (!existing.Item) {
    return { error: "Recording not found", recordingId };
  }

  // Build update expression
  let updateExpr = "SET #status = :status, updatedAt = :updatedAt";
  const exprNames = { "#status": "status" };
  const exprValues = {
    ":status": status,
    ":updatedAt": new Date().toISOString()
  };

  // If setting to complete and continuous was provided as false, disable continuous mode
  // This prevents auto-rotation from creating a new recording
  if (status === "complete" && continuous === false) {
    updateExpr += ", continuous = :continuous";
    exprValues[":continuous"] = false;
  }

  await docClient.send(new UpdateCommand({
    TableName: RECORDINGS_TABLE,
    Key: { recordingId },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues
  }));

  return {
    success: true,
    recordingId,
    status,
    continuousStopped: status === "complete" && continuous === false,
    message: `Recording status updated to ${status}`
  };
}

/**
 * List snapshots for a recording
 */
async function listSnapshots(recordingId) {
  if (!ANALYTICS_BUCKET) {
    return { error: "Analytics bucket not configured" };
  }

  const prefix = `recordings/${recordingId}/`;

  const result = await s3Client.send(new ListObjectsV2Command({
    Bucket: ANALYTICS_BUCKET,
    Prefix: prefix
  }));

  const objects = result.Contents || [];
  const ticks = [];

  for (const obj of objects) {
    const key = obj.Key;
    const filename = key.replace(prefix, "");

    // Skip terrain.json, extract tick numbers from other files
    if (filename === "terrain.json") continue;

    const match = filename.match(/^(\d+)\.json$/);
    if (match) {
      ticks.push(parseInt(match[1], 10));
    }
  }

  // Sort ticks ascending
  ticks.sort((a, b) => a - b);

  return {
    recordingId,
    ticks,
    count: ticks.length,
    hasTerrain: objects.some(o => o.Key.endsWith("terrain.json"))
  };
}

/**
 * Get a specific snapshot
 */
async function getSnapshot(recordingId, tick) {
  if (!ANALYTICS_BUCKET) {
    return { error: "Analytics bucket not configured" };
  }

  try {
    const result = await s3Client.send(new GetObjectCommand({
      Bucket: ANALYTICS_BUCKET,
      Key: `recordings/${recordingId}/${tick}.json`
    }));

    const body = await result.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    if (error.name === "NoSuchKey") {
      return { error: "Snapshot not found", recordingId, tick };
    }
    throw error;
  }
}

/**
 * Get terrain for a recording
 */
async function getTerrain(recordingId) {
  if (!ANALYTICS_BUCKET) {
    return { error: "Analytics bucket not configured" };
  }

  try {
    const result = await s3Client.send(new GetObjectCommand({
      Bucket: ANALYTICS_BUCKET,
      Key: `recordings/${recordingId}/terrain.json`
    }));

    const body = await result.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    if (error.name === "NoSuchKey") {
      return { error: "Terrain not found", recordingId };
    }
    throw error;
  }
}

export async function handler(event) {
  console.log('API request:', event.routeKey, event.pathParameters);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  };

  try {
    const path = event.routeKey;
    const params = event.pathParameters || {};
    const query = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    let result;

    // ==================== v2 Routes ====================

    // Colony endpoints (v2)
    if (path === 'GET /colonies') {
      result = await getColonies();
    }
    else if (path === 'GET /colonies/{roomName}/creeps') {
      result = await getColonyCreeps(params.roomName);
    }
    else if (path === 'GET /colonies/{roomName}/economy') {
      result = await getColonyEconomy(params.roomName);
    }
    else if (path === 'GET /colonies/{roomName}/remotes') {
      result = await getColonyRemotes(params.roomName);
    }
    else if (path === 'GET /colonies/{roomName}') {
      result = await getColony(params.roomName);
    }

    // Intel endpoints (v2 additions)
    else if (path === 'GET /intel/enemies') {
      result = await getEnemyIntel();
    }
    else if (path === 'GET /intel/candidates') {
      const homeRoom = query.home || null;
      result = await getExpansionCandidates(homeRoom);
    }

    // Analysis endpoints (v2 regrouping)
    else if (path === 'GET /analysis/{roomName}/recommendations') {
      result = await getRecommendations(params.roomName);
    }
    else if (path === 'GET /analysis/{roomName}/signals/events') {
      const hours = parseInt(query.hours) || 24;
      result = await getSignalEvents(params.roomName, hours);
    }
    else if (path === 'GET /analysis/{roomName}/signals') {
      const hours = parseInt(query.hours) || 24;
      result = await getSignals(params.roomName, hours);
    }
    else if (path === 'GET /analysis/{roomName}/observations') {
      const limit = parseInt(query.limit) || 10;
      result = await getObservations(params.roomName, limit);
    }
    else if (path === 'GET /analysis/{roomName}/patterns') {
      result = await getPatterns(params.roomName);
    }
    else if (path === 'POST /analysis/{roomName}/feedback') {
      const recommendationId = body.recommendationId;
      if (!recommendationId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing recommendationId in request body' }),
        };
      }
      result = await submitFeedback(recommendationId, body);
    }

    // Debug endpoints (v2 regrouping)
    else if (path === 'GET /debug/positions') {
      result = await fetchSegment92();
    }
    else if (path === 'POST /debug/command') {
      const { command, shard } = body;
      result = await queueCommand(command, shard || SCREEPS_SHARD);
    }
    else if (path === 'GET /debug/command') {
      const encoded = query.cmd;
      if (!encoded) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing cmd parameter' }),
        };
      }
      const command = Buffer.from(encoded, 'base64').toString('utf-8');
      const shard = query.shard || SCREEPS_SHARD;
      result = await queueCommand(command, shard);
    }
    else if (path === 'GET /debug/command/result') {
      const shard = query.shard || SCREEPS_SHARD;
      const requestId = query.requestId || null;
      result = await getCommandResult(shard, requestId);
    }

    // ==================== Existing v1 Routes (kept, no change) ====================

    // Intel (already v2-style from Phase 5, no deprecation needed)
    else if (path === 'GET /intel/{roomName}') {
      result = await getIntel(params.roomName);
    }
    else if (path === 'GET /intel') {
      const range = query.range ? parseInt(query.range) : null;
      const homeRoom = query.home || null;
      result = await getAllIntel(range, homeRoom);
    }

    // Empire (already well-organized, no deprecation needed)
    else if (path === 'GET /empire') {
      result = await getEmpireStatus();
    }
    else if (path === 'GET /empire/expansion/{roomName}') {
      result = await getExpansionStatus(params.roomName);
    }
    else if (path === 'GET /empire/expansion') {
      result = await getExpansionStatus();
    }
    else if (path === 'POST /empire/expansion') {
      const { action, roomName, parentRoom } = body;
      result = await queueExpansionCommand(action, roomName, parentRoom);
    }

    // Metrics (stays as-is, good namespace)
    else if (path === 'GET /metrics/{roomName}') {
      const hours = parseInt(query.hours) || 24;
      result = await getMetricHistory(params.roomName, hours);
    }

    // ==================== Recording Endpoints ====================
    else if (path === 'POST /recordings') {
      result = await createRecording(body);
    }
    else if (path === 'GET /recordings') {
      result = await listRecordings();
    }
    else if (path === 'GET /recordings/{recordingId}') {
      result = await getRecording(params.recordingId);
    }
    else if (path === 'PUT /recordings/{recordingId}') {
      result = await updateRecordingStatus(params.recordingId, body);
    }
    else if (path === 'GET /recordings/{recordingId}/snapshots') {
      result = await listSnapshots(params.recordingId);
    }
    else if (path === 'GET /recordings/{recordingId}/snapshots/{tick}') {
      result = await getSnapshot(params.recordingId, params.tick);
    }
    else if (path === 'GET /recordings/{recordingId}/terrain') {
      result = await getTerrain(params.recordingId);
    }

    // ==================== Viewer Endpoint ====================
    else if (path === 'GET /viewer') {
      // Serve the recording viewer HTML from S3
      try {
        const result = await s3Client.send(new GetObjectCommand({
          Bucket: ANALYTICS_BUCKET,
          Key: 'viewer/index.html'
        }));
        const html = await result.Body.transformToString();
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'
          },
          body: html
        };
      } catch (e) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Viewer not found' })
        };
      }
    }

    else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Not found' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
