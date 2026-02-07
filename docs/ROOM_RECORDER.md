# Room Recorder System

The Room Recorder system captures live game state from the Screeps API for a single room, storing snapshots to S3 for later offline rendering (e.g., video generation for demos).

## Architecture

```
EventBridge (every 1 min) --> room-recorder Lambda --> S3 (recordings/...)
                                    |
                              DynamoDB (recordings table)
                                    |
                              API Lambda (new /recordings routes)
```

## How It Works

1. **Start a Recording**: POST to `/recordings` with room name and configuration
2. **Capture Loop**: The room-recorder Lambda runs every minute via EventBridge
   - Checks for active recordings in DynamoDB
   - Fetches current game tick from Screeps API
   - If enough ticks have elapsed, fetches room objects
   - Writes snapshot to S3 as JSON
   - Updates DynamoDB with progress
3. **Automatic Completion**: When `durationTicks` is reached, status changes to "complete"
4. **Retrieve Data**: Use API endpoints to list/download snapshots and terrain

## API Endpoints

### Create Recording

```
POST /recordings
Content-Type: application/json

{
  "room": "E46N37",
  "shard": "shard0",        // Optional, defaults to env SCREEPS_SHARD
  "tickInterval": 3,        // Optional, capture every N ticks (default: 3)
  "durationTicks": 3000     // Optional, total ticks to record (default: 3000)
}
```

**Response:**
```json
{
  "recordingId": "rec-E46N37-1707300000",
  "room": "E46N37",
  "shard": "shard0",
  "status": "active",
  "tickInterval": 3,
  "durationTicks": 3000,
  "startTick": null,
  "endTick": null,
  "ticksCaptured": 0,
  "createdAt": "2026-02-07T15:00:00Z"
}
```

**Constraints:**
- Only 1 active recording allowed at a time
- Room format must match `/^[EW]\d+[NS]\d+$/`
- tickInterval: 1-20
- durationTicks: 100-50000

### List Recordings

```
GET /recordings
```

Returns all recordings sorted by createdAt descending.

### Get Recording Details

```
GET /recordings/{recordingId}
```

### Update Recording Status

```
PUT /recordings/{recordingId}
Content-Type: application/json

{
  "status": "paused"   // "active", "paused", or "complete"
}
```

- `paused`: Temporarily stop capturing (can resume with "active")
- `active`: Resume capturing
- `complete`: Permanently stop recording

### List Snapshots

```
GET /recordings/{recordingId}/snapshots
```

**Response:**
```json
{
  "recordingId": "rec-E46N37-1707300000",
  "ticks": [48231050, 48231053, 48231056, ...],
  "count": 150,
  "hasTerrain": true
}
```

### Get Snapshot

```
GET /recordings/{recordingId}/snapshots/{tick}
```

Returns the snapshot JSON for the specified tick.

### Get Terrain

```
GET /recordings/{recordingId}/terrain
```

Returns the terrain data for the recording.

## Data Schemas

### DynamoDB Recording Item

```json
{
  "recordingId": "rec-E46N37-1707300000",
  "room": "E46N37",
  "shard": "shard0",
  "status": "active",
  "tickInterval": 3,
  "durationTicks": 3000,
  "startTick": 48231050,
  "endTick": 48234050,
  "lastCapturedTick": 48231500,
  "ticksCaptured": 150,
  "terrainCaptured": true,
  "createdAt": "2026-02-07T15:00:00Z",
  "updatedAt": "2026-02-07T15:30:00Z",
  "expiresAt": 1741000000
}
```

### S3 Snapshot (per-tick)

```json
{
  "tick": 48231050,
  "capturedAt": "2026-02-07T15:30:00Z",
  "room": "E46N37",
  "creeps": [
    {
      "x": 25,
      "y": 13,
      "name": "H-1",
      "owner": "Superstringman",
      "hits": 1500,
      "hitsMax": 1500,
      "store": { "energy": 50 },
      "storeCapacity": 100,
      "body": [...]
    }
  ],
  "structures": [
    {
      "x": 24,
      "y": 12,
      "structureType": "spawn",
      "hits": 5000,
      "hitsMax": 5000,
      "store": { "energy": 300 },
      "owner": "Superstringman"
    }
  ],
  "sources": [
    {
      "x": 22,
      "y": 8,
      "id": "abc123",
      "energy": 1500,
      "energyCapacity": 3000
    }
  ],
  "minerals": [...],
  "constructionSites": [...],
  "droppedResources": [...],
  "tombstones": [...]
}
```

### S3 Terrain

```json
{
  "room": "E46N37",
  "encoded": "0110022...",
  "capturedAt": "2026-02-07T15:00:00Z"
}
```

The `encoded` field is a 2500-character string where each character represents terrain at position `(i % 50, floor(i / 50))`:
- `0` = plain
- `1` = wall
- `2` = swamp
- `3` = wall+swamp (treat as wall)

## S3 Structure

```
recordings/
  rec-E46N37-1707300000/
    terrain.json
    48231050.json
    48231053.json
    48231056.json
    ...
```

## Deployment

### Prerequisites

- AWS CLI configured
- S3 bucket for Lambda code (specified in CloudFormation `LambdaCodeBucket` parameter)
- Screeps API token in Secrets Manager (already configured for data-collector)

### Steps

1. **Install dependencies for room-recorder Lambda:**
   ```bash
   cd aws/lambda/room-recorder
   npm install
   ```

2. **Package room-recorder Lambda:**
   ```powershell
   cd aws/lambda/room-recorder
   Compress-Archive -Path * -DestinationPath ../room-recorder.zip -Force
   ```

3. **Upload to S3:**
   ```bash
   aws s3 cp aws/lambda/room-recorder.zip s3://{code-bucket}/room-recorder.zip
   ```

4. **Package updated API Lambda:**
   ```powershell
   cd aws/lambda/api
   Compress-Archive -Path * -DestinationPath ../api.zip -Force
   ```

5. **Upload API to S3:**
   ```bash
   aws s3 cp aws/lambda/api.zip s3://{code-bucket}/api.zip
   ```

6. **Deploy CloudFormation:**
   ```bash
   aws cloudformation deploy \
     --template-file aws/cloudformation/template.yaml \
     --stack-name screeps-advisor-prod \
     --capabilities CAPABILITY_IAM
   ```

7. **Update Lambda function code (if stack already exists):**
   ```bash
   aws lambda update-function-code \
     --function-name screeps-room-recorder-prod \
     --s3-bucket {code-bucket} \
     --s3-key room-recorder.zip

   aws lambda update-function-code \
     --function-name screeps-api-prod \
     --s3-bucket {code-bucket} \
     --s3-key api.zip
   ```

## Testing

1. **Create a test recording:**
   ```bash
   curl -X POST https://{api-endpoint}/recordings \
     -H "Content-Type: application/json" \
     -d '{"room": "E46N37", "tickInterval": 3, "durationTicks": 100}'
   ```

2. **Wait 2-3 minutes for Lambda to capture some ticks**

3. **Check recording status:**
   ```bash
   curl https://{api-endpoint}/recordings
   ```

4. **Verify terrain was captured:**
   ```bash
   curl https://{api-endpoint}/recordings/{recordingId}/terrain
   ```

5. **List captured snapshots:**
   ```bash
   curl https://{api-endpoint}/recordings/{recordingId}/snapshots
   ```

6. **Get a specific snapshot:**
   ```bash
   curl https://{api-endpoint}/recordings/{recordingId}/snapshots/{tick}
   ```

## Cost Considerations

- **Lambda**: ~720 invocations/day (1 per minute), minimal cost
- **S3 Storage**: ~5-30KB per snapshot, ~100-1000 snapshots per recording
  - Example: 1000 snapshots x 15KB = 15MB per recording
- **DynamoDB**: PAY_PER_REQUEST, minimal reads/writes
- **Data retention**: 30-day TTL on DynamoDB items, S3 lifecycle can be configured

## Limitations

- Only 1 active recording at a time
- Room must have vision (owned or with observer) for objects to be captured
- Terrain is always available, even without vision
- Lambda runs every 1 minute (EventBridge minimum), so actual tick interval may vary
- No automatic S3 cleanup (configure lifecycle rule if needed)
