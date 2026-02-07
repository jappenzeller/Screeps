import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

const RECORDINGS_TABLE = process.env.RECORDINGS_TABLE;
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET;

// Role prefixes for parsing creep names
const ROLE_PREFIXES = {
  'H': 'harvester', 'T': 'hauler', 'U': 'upgrader', 'B': 'builder',
  'R': 'repairer', 'S': 'scout', 'C': 'claimer', 'D': 'defender',
  'M': 'mineralHarvester', 'RH': 'remoteHarvester', 'RT': 'remoteHauler',
  'RD': 'remoteDefender', 'RS': 'reserver', 'LF': 'linkFiller', 'P': 'pioneer'
};

// Roles that are expected to be stationary (don't flag as stuck)
const STATIONARY_ROLES = new Set(['harvester', 'mineralHarvester', 'upgrader']);

/**
 * Parse role from creep name
 */
function parseRole(name) {
  // Try two-letter prefixes first
  for (const [prefix, role] of Object.entries(ROLE_PREFIXES)) {
    if (prefix.length === 2 && name.startsWith(prefix + '-')) {
      return role;
    }
  }
  // Then single-letter prefixes
  for (const [prefix, role] of Object.entries(ROLE_PREFIXES)) {
    if (prefix.length === 1 && name.startsWith(prefix + '-')) {
      return role;
    }
  }
  return 'unknown';
}

/**
 * Get terrain type at position from encoded terrain string
 */
function getTerrainAt(terrain, x, y) {
  if (!terrain) return 0;
  const idx = y * 50 + x;
  const val = (terrain.charCodeAt(idx) - 48) & 0x03;
  return val;
}

/**
 * Read a JSON file from S3
 */
async function readS3Json(key) {
  const result = await s3Client.send(new GetObjectCommand({
    Bucket: ANALYTICS_BUCKET,
    Key: key
  }));
  const body = await result.Body.transformToString();
  return JSON.parse(body);
}

/**
 * Write a JSON file to S3
 */
async function writeS3Json(key, data) {
  await s3Client.send(new PutObjectCommand({
    Bucket: ANALYTICS_BUCKET,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json'
  }));
}

/**
 * List all snapshot files for a recording
 */
async function listSnapshotFiles(recordingId) {
  const prefix = `recordings/${recordingId}/`;
  const files = [];
  let continuationToken;

  do {
    const result = await s3Client.send(new ListObjectsV2Command({
      Bucket: ANALYTICS_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));

    for (const obj of result.Contents || []) {
      const filename = obj.Key.replace(prefix, '');
      // Skip terrain.json and analysis folder
      if (filename === 'terrain.json' || filename.startsWith('analysis/')) continue;
      // Parse tick from filename (e.g., "48231050.json")
      const match = filename.match(/^(\d+)\.json$/);
      if (match) {
        files.push({ key: obj.Key, tick: parseInt(match[1]) });
      }
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  // Sort by tick
  files.sort((a, b) => a.tick - b.tick);
  return files;
}

/**
 * Build creep trajectories from snapshots
 */
function buildTrajectories(snapshots) {
  const trajectories = new Map();

  for (const snapshot of snapshots) {
    if (!snapshot.creeps) continue;
    for (const creep of snapshot.creeps) {
      if (!trajectories.has(creep.name)) {
        trajectories.set(creep.name, {
          name: creep.name,
          role: parseRole(creep.name),
          owner: creep.owner,
          positions: []
        });
      }
      trajectories.get(creep.name).positions.push({
        tick: snapshot.tick,
        x: creep.x,
        y: creep.y
      });
    }
  }

  return trajectories;
}

/**
 * Build traffic heatmap from snapshots
 */
function buildHeatmap(snapshots) {
  // Total heatmap
  const total = Array.from({ length: 50 }, () => new Array(50).fill(0));
  // Per-role heatmaps
  const byRole = new Map();
  let maxValue = 0;

  for (const snapshot of snapshots) {
    if (!snapshot.creeps) continue;
    for (const creep of snapshot.creeps) {
      total[creep.y][creep.x]++;
      if (total[creep.y][creep.x] > maxValue) {
        maxValue = total[creep.y][creep.x];
      }

      const role = parseRole(creep.name);
      if (!byRole.has(role)) {
        byRole.set(role, Array.from({ length: 50 }, () => new Array(50).fill(0)));
      }
      byRole.get(role)[creep.y][creep.x]++;
    }
  }

  return {
    total,
    byRole: Object.fromEntries(byRole),
    maxValue,
    ticksRecorded: snapshots.length
  };
}

/**
 * Detect oscillation events in a trajectory
 */
function detectOscillation(trajectory, windowSize = 6, minRepeats = 3) {
  const events = [];
  const positions = trajectory.positions;

  for (let i = windowSize; i < positions.length; i++) {
    const window = positions.slice(i - windowSize, i);
    const posStrings = window.map(p => `${p.x},${p.y}`);
    const unique = new Set(posStrings);

    // Oscillation: creep visits only 2-3 unique positions in a window
    if (unique.size >= 2 && unique.size <= 3) {
      const counts = {};
      posStrings.forEach(p => counts[p] = (counts[p] || 0) + 1);
      const maxCount = Math.max(...Object.values(counts));

      if (maxCount >= minRepeats) {
        events.push({
          creepName: trajectory.name,
          role: trajectory.role,
          startTick: window[0].tick,
          endTick: window[window.length - 1].tick,
          positions: [...unique].map(p => {
            const [x, y] = p.split(',').map(Number);
            return { x, y, visits: counts[p] };
          }),
          duration: window[window.length - 1].tick - window[0].tick
        });
      }
    }
  }

  // Merge overlapping events
  return mergeOverlappingEvents(events);
}

/**
 * Merge overlapping oscillation events
 */
function mergeOverlappingEvents(events) {
  if (events.length === 0) return events;

  const merged = [events[0]];
  for (let i = 1; i < events.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = events[i];

    // If events overlap in tick range, merge them
    if (curr.startTick <= prev.endTick + 10) {
      prev.endTick = Math.max(prev.endTick, curr.endTick);
      prev.duration = prev.endTick - prev.startTick;
      // Merge positions
      const posSet = new Set([
        ...prev.positions.map(p => `${p.x},${p.y}`),
        ...curr.positions.map(p => `${p.x},${p.y}`)
      ]);
      prev.positions = [...posSet].map(p => {
        const [x, y] = p.split(',').map(Number);
        return { x, y, visits: 0 }; // Reset visits on merge
      });
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Detect stuck events in a trajectory
 */
function detectStuck(trajectory, minStuckTicks = 5) {
  const events = [];
  const positions = trajectory.positions;

  if (positions.length < 2) return events;

  let stuckStart = null;
  let stuckPos = null;

  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1];
    const curr = positions[i];

    if (curr.x === prev.x && curr.y === prev.y) {
      if (!stuckStart) {
        stuckStart = prev;
        stuckPos = { x: curr.x, y: curr.y };
      }
    } else {
      if (stuckStart) {
        const duration = prev.tick - stuckStart.tick;
        if (duration >= minStuckTicks) {
          events.push({
            creepName: trajectory.name,
            role: trajectory.role,
            position: stuckPos,
            startTick: stuckStart.tick,
            endTick: prev.tick,
            duration
          });
        }
        stuckStart = null;
        stuckPos = null;
      }
    }
  }

  // Handle still-stuck at end
  if (stuckStart) {
    const last = positions[positions.length - 1];
    const duration = last.tick - stuckStart.tick;
    if (duration >= minStuckTicks) {
      events.push({
        creepName: trajectory.name,
        role: trajectory.role,
        position: stuckPos,
        startTick: stuckStart.tick,
        endTick: last.tick,
        duration
      });
    }
  }

  return events;
}

/**
 * Count nearby roads within a given radius
 */
function countNearbyRoads(roadPositions, x, y, radius) {
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (roadPositions.has(`${x + dx},${y + dy}`)) count++;
    }
  }
  return count;
}

/**
 * Generate road suggestions based on traffic and terrain
 */
function generateRoadSuggestions(heatmap, terrain, lastSnapshot, topN = 20) {
  const suggestions = [];

  // Get existing road positions from last snapshot
  const roadPositions = new Set();
  if (lastSnapshot?.structures) {
    for (const s of lastSnapshot.structures) {
      if (s.structureType === 'road') {
        roadPositions.add(`${s.x},${s.y}`);
      }
    }
  }

  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const visits = heatmap.total[y][x];
      if (visits < 10) continue; // Minimum threshold

      const key = `${x},${y}`;
      if (roadPositions.has(key)) continue; // Already has a road

      const terrainType = getTerrainAt(terrain, x, y);
      if (terrainType === 1 || terrainType === 3) continue; // Wall

      // Score: visits * terrain multiplier (swamp roads are 5x more valuable)
      const terrainMultiplier = terrainType === 2 ? 5.0 : 1.0;
      const score = visits * terrainMultiplier;
      const nearbyRoads = countNearbyRoads(roadPositions, x, y, 2);

      suggestions.push({
        x, y,
        visits,
        terrain: terrainType === 2 ? 'swamp' : 'plain',
        score,
        nearbyRoads,
        reason: `${terrainType === 2 ? 'High-traffic swamp' : 'High-traffic'} tile with ${visits} visits${nearbyRoads > 0 ? ', adjacent to road network' : ''}`
      });
    }
  }

  // Sort by score descending
  suggestions.sort((a, b) => b.score - a.score);

  // Calculate coverage stats
  let totalHighTraffic = 0;
  let coveredByRoads = 0;
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      if (heatmap.total[y][x] >= 10) {
        totalHighTraffic++;
        if (roadPositions.has(`${x},${y}`)) {
          coveredByRoads++;
        }
      }
    }
  }

  return {
    suggestions: suggestions.slice(0, topN),
    existingRoadCount: roadPositions.size,
    totalHighTrafficTiles: totalHighTraffic,
    coveredByRoads,
    coveragePercent: totalHighTraffic > 0 ? ((coveredByRoads / totalHighTraffic) * 100).toFixed(1) : 100
  };
}

/**
 * Detect bottleneck tiles (high concurrency)
 */
function detectBottlenecks(snapshots, minConcurrent = 3, minOccurrences = 5) {
  const concurrencyMap = Array.from({ length: 50 }, () => new Array(50).fill(0));

  for (const snapshot of snapshots) {
    if (!snapshot.creeps) continue;

    // Count creeps per tile in this snapshot
    const tileCounts = {};
    for (const creep of snapshot.creeps) {
      const key = `${creep.x},${creep.y}`;
      tileCounts[key] = (tileCounts[key] || 0) + 1;
    }

    // Increment concurrency map for tiles with high concurrency
    for (const [key, count] of Object.entries(tileCounts)) {
      if (count >= minConcurrent) {
        const [x, y] = key.split(',').map(Number);
        concurrencyMap[y][x]++;
      }
    }
  }

  // Find tiles that frequently had high concurrency
  const bottlenecks = [];
  const lastSnapshot = snapshots[snapshots.length - 1];

  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      if (concurrencyMap[y][x] >= minOccurrences) {
        // Find nearby structures for context
        const nearbyStructures = [];
        if (lastSnapshot?.structures) {
          for (const s of lastSnapshot.structures) {
            const dist = Math.abs(s.x - x) + Math.abs(s.y - y);
            if (dist <= 2 && s.structureType !== 'road') {
              if (!nearbyStructures.includes(s.structureType)) {
                nearbyStructures.push(s.structureType);
              }
            }
          }
        }

        bottlenecks.push({
          x, y,
          concurrentTicks: concurrencyMap[y][x],
          percentOfRecording: ((concurrencyMap[y][x] / snapshots.length) * 100).toFixed(1),
          nearbyStructures
        });
      }
    }
  }

  return { tiles: bottlenecks.sort((a, b) => b.concurrentTicks - a.concurrentTicks) };
}

/**
 * Cluster oscillation events into hotspots
 */
function clusterOscillationHotspots(events, radius = 2) {
  const hotspotMap = new Map();

  for (const event of events) {
    for (const pos of event.positions) {
      // Find or create hotspot within radius
      let found = false;
      for (const [key, hotspot] of hotspotMap) {
        const [hx, hy] = key.split(',').map(Number);
        if (Math.abs(hx - pos.x) <= radius && Math.abs(hy - pos.y) <= radius) {
          hotspot.totalEvents++;
          hotspot.totalDuration += event.duration;
          if (!hotspot.affectedRoles.includes(event.role)) {
            hotspot.affectedRoles.push(event.role);
          }
          found = true;
          break;
        }
      }
      if (!found) {
        hotspotMap.set(`${pos.x},${pos.y}`, {
          x: pos.x,
          y: pos.y,
          totalEvents: 1,
          affectedRoles: [event.role],
          totalDuration: event.duration
        });
      }
    }
  }

  return [...hotspotMap.values()].sort((a, b) => b.totalEvents - a.totalEvents);
}

/**
 * Cluster stuck events into hotspots
 */
function clusterStuckHotspots(events) {
  const hotspotMap = new Map();

  for (const event of events) {
    const key = `${event.position.x},${event.position.y}`;
    if (!hotspotMap.has(key)) {
      hotspotMap.set(key, {
        x: event.position.x,
        y: event.position.y,
        totalEvents: 0,
        affectedRoles: [],
        totalDuration: 0
      });
    }
    const hotspot = hotspotMap.get(key);
    hotspot.totalEvents++;
    hotspot.totalDuration += event.duration;
    if (!hotspot.affectedRoles.includes(event.role)) {
      hotspot.affectedRoles.push(event.role);
    }
  }

  return [...hotspotMap.values()].sort((a, b) => b.totalEvents - a.totalEvents);
}

/**
 * Main analysis function
 */
async function analyzeRecording(recordingId) {
  console.log(`Analyzing recording: ${recordingId}`);

  // 1. Get recording metadata
  const recording = await docClient.send(new GetCommand({
    TableName: RECORDINGS_TABLE,
    Key: { recordingId }
  }));

  if (!recording.Item) {
    throw new Error(`Recording not found: ${recordingId}`);
  }

  const recordingData = recording.Item;
  console.log(`Recording: room=${recordingData.room}, ticks=${recordingData.ticksCaptured}`);

  // 2. List snapshot files
  const snapshotFiles = await listSnapshotFiles(recordingId);
  console.log(`Found ${snapshotFiles.length} snapshots`);

  if (snapshotFiles.length === 0) {
    throw new Error(`No snapshots found for recording: ${recordingId}`);
  }

  // 3. Load terrain
  let terrain = null;
  try {
    const terrainData = await readS3Json(`recordings/${recordingId}/terrain.json`);
    terrain = terrainData.encoded || terrainData.terrain;
  } catch (e) {
    console.log('No terrain file found, continuing without terrain data');
  }

  // 4. Load snapshots in batches to avoid memory issues
  const batchSize = 50;
  const snapshots = [];

  for (let i = 0; i < snapshotFiles.length; i += batchSize) {
    const batch = snapshotFiles.slice(i, i + batchSize);
    const batchData = await Promise.all(
      batch.map(f => readS3Json(f.key))
    );
    snapshots.push(...batchData);
    console.log(`Loaded ${snapshots.length}/${snapshotFiles.length} snapshots`);
  }

  // 5. Build trajectories
  console.log('Building trajectories...');
  const trajectories = buildTrajectories(snapshots);
  console.log(`Found ${trajectories.size} unique creeps`);

  // 6. Build heatmap
  console.log('Building heatmap...');
  const heatmap = buildHeatmap(snapshots);

  // 7. Detect oscillations
  console.log('Detecting oscillations...');
  const allOscillations = [];
  for (const trajectory of trajectories.values()) {
    const events = detectOscillation(trajectory);
    allOscillations.push(...events);
  }
  const oscillationHotspots = clusterOscillationHotspots(allOscillations);

  // 8. Detect stuck events (only for mobile roles)
  console.log('Detecting stuck events...');
  const allStuck = [];
  for (const trajectory of trajectories.values()) {
    if (STATIONARY_ROLES.has(trajectory.role)) continue;
    const events = detectStuck(trajectory);
    allStuck.push(...events);
  }
  const stuckHotspots = clusterStuckHotspots(allStuck);

  // 9. Generate road suggestions
  console.log('Generating road suggestions...');
  const lastSnapshot = snapshots[snapshots.length - 1];
  const roads = generateRoadSuggestions(heatmap, terrain, lastSnapshot);

  // 10. Detect bottlenecks
  console.log('Detecting bottlenecks...');
  const bottlenecks = detectBottlenecks(snapshots);

  // 11. Build summary
  const tickRange = [
    snapshots[0].tick,
    snapshots[snapshots.length - 1].tick
  ];

  const summary = {
    recordingId,
    room: recordingData.room,
    analyzedAt: new Date().toISOString(),
    tickRange,
    snapshotsAnalyzed: snapshots.length,
    uniqueCreeps: trajectories.size,
    totalOscillationEvents: allOscillations.length,
    totalStuckEvents: allStuck.length,
    roadSuggestions: roads.suggestions.length,
    bottlenecks: bottlenecks.tiles.length
  };

  // 12. Write results to S3
  console.log('Writing analysis results to S3...');
  const analysisPrefix = `recordings/${recordingId}/analysis`;

  await Promise.all([
    writeS3Json(`${analysisPrefix}/summary.json`, summary),
    writeS3Json(`${analysisPrefix}/heatmap.json`, heatmap),
    writeS3Json(`${analysisPrefix}/oscillations.json`, {
      events: allOscillations,
      hotspots: oscillationHotspots
    }),
    writeS3Json(`${analysisPrefix}/stuck.json`, {
      events: allStuck,
      hotspots: stuckHotspots
    }),
    writeS3Json(`${analysisPrefix}/roads.json`, roads),
    writeS3Json(`${analysisPrefix}/bottlenecks.json`, bottlenecks)
  ]);

  // 13. Update DynamoDB with analysis status
  await docClient.send(new UpdateCommand({
    TableName: RECORDINGS_TABLE,
    Key: { recordingId },
    UpdateExpression: 'SET analysisStatus = :status, analysisAt = :at',
    ExpressionAttributeValues: {
      ':status': 'complete',
      ':at': new Date().toISOString()
    }
  }));

  console.log('Analysis complete');
  return summary;
}

/**
 * Lambda handler
 */
export async function handler(event) {
  console.log('Recording analyzer invoked:', JSON.stringify(event));

  try {
    // Extract recordingId from various event sources
    let recordingId;

    if (event.recordingId) {
      // Direct invocation
      recordingId = event.recordingId;
    } else if (event.detail?.recordingId) {
      // EventBridge event
      recordingId = event.detail.recordingId;
    } else if (event.pathParameters?.recordingId) {
      // API Gateway (if used)
      recordingId = event.pathParameters.recordingId;
    }

    if (!recordingId) {
      throw new Error('No recordingId provided');
    }

    const summary = await analyzeRecording(recordingId);

    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };
  } catch (error) {
    console.error('Analysis error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}
