import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const secretsClient = new SecretsManagerClient({});

const SNAPSHOTS_TABLE = process.env.SNAPSHOTS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const RECOMMENDATIONS_TABLE = process.env.RECOMMENDATIONS_TABLE;
const SIGNALS_TABLE = process.env.SIGNALS_TABLE;
const OBSERVATIONS_TABLE = process.env.OBSERVATIONS_TABLE;
const SCREEPS_TOKEN_SECRET = process.env.SCREEPS_TOKEN_SECRET;
const SCREEPS_SHARD = process.env.SCREEPS_SHARD || "shard0";

// Cache for Screeps token
let cachedToken = null;

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
 * Fetch room objects from Screeps API
 */
async function fetchRoomObjects(roomName) {
  const token = await getScreepsToken();

  const response = await fetch(
    `https://screeps.com/api/game/room-objects?room=${roomName}&shard=${SCREEPS_SHARD}`,
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

  return response.json();
}

/**
 * Fetch room terrain from Screeps API
 */
async function fetchRoomTerrain(roomName) {
  const token = await getScreepsToken();

  const response = await fetch(
    `https://screeps.com/api/game/room-terrain?room=${roomName}&shard=${SCREEPS_SHARD}&encoded=true`,
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

  return response.json();
}

/**
 * Get comprehensive room data (objects organized by type + terrain)
 */
async function getRoomData(roomName) {
  // Fetch objects and terrain in parallel
  const [objectsResult, terrainResult] = await Promise.all([
    fetchRoomObjects(roomName),
    fetchRoomTerrain(roomName),
  ]);

  if (!objectsResult.ok) {
    throw new Error("Failed to fetch room objects");
  }

  const objects = objectsResult.objects || [];

  // Structure types from Screeps API
  const structureTypes = new Set([
    "spawn", "extension", "road", "constructedWall", "rampart", "keeper_lair",
    "portal", "controller", "link", "storage", "tower", "observer", "power_bank",
    "power_spawn", "extractor", "lab", "terminal", "container", "nuker", "factory",
    "invader_core",
  ]);

  const organized = {
    room: roomName,
    shard: SCREEPS_SHARD,
    timestamp: new Date().toISOString(),
    terrain: terrainResult.terrain?.[0]?.terrain || null,
    objects: {
      structures: {},
      creeps: [],
      constructionSites: [],
      sources: [],
      minerals: [],
      droppedResources: [],
      tombstones: [],
      ruins: [],
      other: [],
    },
    counts: {
      totalObjects: objects.length,
      structures: 0,
      creeps: 0,
      constructionSites: 0,
      sources: 0,
      minerals: 0,
    },
  };

  for (const obj of objects) {
    const type = obj.type;

    if (structureTypes.has(type)) {
      if (!organized.objects.structures[type]) {
        organized.objects.structures[type] = [];
      }
      organized.objects.structures[type].push(obj);
      organized.counts.structures++;
    } else if (type === "creep") {
      organized.objects.creeps.push(obj);
      organized.counts.creeps++;
    } else if (type === "constructionSite") {
      organized.objects.constructionSites.push(obj);
      organized.counts.constructionSites++;
    } else if (type === "source") {
      organized.objects.sources.push(obj);
      organized.counts.sources++;
    } else if (type === "mineral") {
      organized.objects.minerals.push(obj);
      organized.counts.minerals++;
    } else if (type === "energy" || type === "resource") {
      organized.objects.droppedResources.push(obj);
    } else if (type === "tombstone") {
      organized.objects.tombstones.push(obj);
    } else if (type === "ruin") {
      organized.objects.ruins.push(obj);
    } else {
      organized.objects.other.push(obj);
    }
  }

  return organized;
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
 * Get live data from segment 90
 */
async function getLiveData(roomName) {
  const data = await fetchSegment90();

  if (!data) {
    return { error: "No data in segment 90", roomName };
  }

  // If roomName specified, filter to that colony
  if (roomName && roomName !== "all") {
    const colony = data.colonies?.find(c => c.roomName === roomName);
    if (!colony) {
      return {
        error: `Room ${roomName} not found`,
        availableRooms: data.colonies?.map(c => c.roomName) || [],
      };
    }

    return {
      live: true,
      requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      fetchedAt: Date.now(),
      gameTick: data.gameTick,
      timestamp: data.timestamp,
      shard: data.shard,
      colony,
      global: data.global,
    };
  }

  // Return everything
  return {
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    ...data,
  };
}

/**
 * Get diagnostics for a specific room from segment 90
 */
async function getDiagnostics(roomName) {
  const data = await fetchSegment90();

  if (!data) {
    return { error: "No data in segment 90", roomName };
  }

  if (!data.diagnostics) {
    return {
      error: "No diagnostics data available",
      hint: "Ensure bot is exporting diagnostics to segment 90 via AWSExporter",
      availableKeys: Object.keys(data),
      roomName,
    };
  }

  const diagnostics = data.diagnostics[roomName];
  if (!diagnostics) {
    return {
      error: `Diagnostics for room ${roomName} not found`,
      availableRooms: Object.keys(data.diagnostics),
    };
  }

  return {
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
    timestamp: data.timestamp,
    shard: data.shard,
    ...diagnostics,
  };
}

// ==================== Intel Endpoints ====================

/**
 * Get intel for a specific room from segment 90
 */
async function getIntel(roomName) {
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
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
    ...intel,
  };
}

/**
 * Get all intel within range of home room
 */
async function getAllIntel(range, homeRoom) {
  const data = await fetchSegment90();

  if (!data || !data.intel) {
    return { error: "No intel data available" };
  }

  const intel = data.intel;
  let filtered = Object.values(intel);

  // Filter by range if specified
  if (range && homeRoom) {
    const home = parseRoomName(homeRoom);
    if (home) {
      filtered = filtered.filter(room => {
        const target = parseRoomName(room.roomName);
        if (!target) return false;
        const distance = Math.max(Math.abs(target.x - home.x), Math.abs(target.y - home.y));
        return distance <= range;
      });
    }
  }

  return {
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
    homeRoom: homeRoom || data.homeRoom || "E46N37",
    range: range || "all",
    rooms: filtered,
    roomCount: filtered.length,
  };
}

/**
 * Get expansion candidates with scoring
 */
async function getExpansionCandidates(homeRoom) {
  const data = await fetchSegment90();

  if (!data || !data.intel) {
    return { error: "No intel data available" };
  }

  const intel = data.intel;
  const home = homeRoom || data.homeRoom || "E46N37";
  const myUsername = data.username || "Superstringman";

  // Get existing colonies
  const existingColonies = Object.values(intel).filter(r =>
    r.owner === myUsername && r.ownerRcl && r.ownerRcl > 0
  );

  // Score all candidate rooms
  const candidates = Object.values(intel)
    .filter(room => room.roomType === "normal")
    .filter(room => !room.owner) // Not owned
    .filter(room => room.sources && room.sources.length >= 1)
    .filter(room => room.distanceFromHome >= 3) // Don't overlap current remotes
    .map(room => ({
      ...room,
      expansionScore: calculateExpansionScore(room, intel, existingColonies, myUsername),
    }))
    .filter(room => room.expansionScore > 0)
    .sort((a, b) => b.expansionScore - a.expansionScore)
    .slice(0, 10);

  return {
    live: true,
    requestId: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    fetchedAt: Date.now(),
    gameTick: data.gameTick,
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

// ==================== DynamoDB Route Handlers ====================

// Route handlers
async function getSummary(roomName) {
  const since = Date.now() - (60 * 60 * 1000); // Last hour

  const snapshots = await docClient.send(new QueryCommand({
    TableName: SNAPSHOTS_TABLE,
    KeyConditionExpression: 'roomName = :room AND #ts > :since',
    ExpressionAttributeNames: { '#ts': 'timestamp' },
    ExpressionAttributeValues: { ':room': roomName, ':since': since },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const recommendations = await docClient.send(new QueryCommand({
    TableName: RECOMMENDATIONS_TABLE,
    IndexName: 'room-index',
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: 10,
  }));

  const latest = snapshots.Items?.[0];
  const now = Date.now();
  const pending = recommendations.Items?.filter(r =>
    r.status === 'pending' && (!r.expiresAt || r.expiresAt > now)
  ) || [];

  return {
    roomName,
    snapshot: latest || null,
    recommendations: pending,
    recommendationCount: pending.length,
  };
}

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

async function searchObservations(roomName, query) {
  if (!OBSERVATIONS_TABLE) {
    return { error: "Observations table not configured" };
  }

  const response = await docClient.send(new QueryCommand({
    TableName: OBSERVATIONS_TABLE,
    KeyConditionExpression: 'roomName = :room',
    ExpressionAttributeValues: { ':room': roomName },
    ScanIndexForward: false,
    Limit: 50,
  }));

  const queryLower = query.toLowerCase();
  const matches = [];

  for (const obs of response.Items || []) {
    for (const observation of obs.observations || []) {
      if (
        observation.summary?.toLowerCase().includes(queryLower) ||
        observation.details?.toLowerCase().includes(queryLower) ||
        observation.relatedEntities?.some(e => e.toLowerCase().includes(queryLower))
      ) {
        matches.push({
          timestamp: obs.timestamp,
          gameTick: obs.snapshotTick,
          ...observation,
        });
      }
    }
  }

  return {
    roomName,
    query,
    matches,
    matchCount: matches.length,
  };
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

    if (path === 'GET /summary/{roomName}') {
      result = await getSummary(params.roomName);
    }
    else if (path === 'GET /recommendations/{roomName}') {
      result = await getRecommendations(params.roomName);
    }
    else if (path === 'GET /metrics/{roomName}') {
      const hours = parseInt(query.hours) || 24;
      result = await getMetricHistory(params.roomName, hours);
    }
    else if (path === 'POST /feedback/{recommendationId}') {
      result = await submitFeedback(params.recommendationId, body);
    }
    // Live data endpoints (real-time segment 90 read)
    else if (path === 'GET /live/{roomName}') {
      result = await getLiveData(params.roomName);
    }
    else if (path === 'GET /live') {
      result = await getLiveData('all');
    }
    // Room data endpoint (real-time room objects + terrain)
    else if (path === 'GET /room/{roomName}') {
      result = await getRoomData(params.roomName);
    }
    // Diagnostics endpoint (creep and structure state for debugging)
    else if (path === 'GET /diagnostics/{roomName}') {
      result = await getDiagnostics(params.roomName);
    }
    // Signal layer endpoints
    else if (path === 'GET /signals/{roomName}') {
      const hours = parseInt(query.hours) || 24;
      result = await getSignals(params.roomName, hours);
    }
    else if (path === 'GET /signals/{roomName}/events') {
      const hours = parseInt(query.hours) || 24;
      result = await getSignalEvents(params.roomName, hours);
    }
    // Observation layer endpoints
    else if (path === 'GET /observations/{roomName}') {
      const limit = parseInt(query.limit) || 10;
      result = await getObservations(params.roomName, limit);
    }
    else if (path === 'GET /observations/{roomName}/patterns') {
      result = await getPatterns(params.roomName);
    }
    else if (path === 'GET /observations/{roomName}/search') {
      const q = query.q || '';
      result = await searchObservations(params.roomName, q);
    }
    // Intel endpoints (room scouting data)
    else if (path === 'GET /intel/{roomName}') {
      result = await getIntel(params.roomName);
    }
    else if (path === 'GET /intel') {
      const range = query.range ? parseInt(query.range) : null;
      const homeRoom = query.home || null;
      result = await getAllIntel(range, homeRoom);
    }
    else if (path === 'GET /intel/expansion-candidates') {
      const homeRoom = query.home || null;
      result = await getExpansionCandidates(homeRoom);
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
