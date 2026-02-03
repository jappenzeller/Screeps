# AWS Advisor System

## Overview

External monitoring system that:
1. Collects colony data from Screeps
2. Stores metrics in DynamoDB
3. Runs AI analysis (Claude API)
4. Provides API endpoints for recommendations

## Architecture

```
SCREEPS GAME
    │
    │ Export to Memory Segment 90
    ▼
AWS LAMBDA (data-collector)
    │ Every 5 minutes
    ▼
DYNAMODB (metrics, snapshots)
    │
    ▼
AWS LAMBDA (analysis-engine)
    │ Hourly, Claude API
    ▼
DYNAMODB (recommendations)
    │
    ▼
API GATEWAY
    │
    ▼
DASHBOARD / CLAUDE CODE
```

## Data Export (AWSExporter.ts)

**Key File:** `src/utils/AWSExporter.ts` (41KB)

Exports colony data to memory segment 90 every 20 ticks.

### Exported Data

```typescript
{
  timestamp: number,
  tick: number,

  // Colony metrics
  colonies: {
    [roomName]: {
      rcl: number,
      rclProgress: number,
      phase: ColonyPhase,
      energy: { available, capacity, stored },
      creeps: { total, byRole: Record<string, number> },
      threats: { count, dps },
      construction: { sites, progress },
      economy: { harvestRate, storageLevel }
    }
  },

  // Empire-wide
  empire: {
    gcl: number,
    gclProgress: number,
    rooms: string[],
    expansionState: string
  },

  // Traffic data (for road planning)
  traffic: {
    [roomName]: {
      heatmap: Record<string, number>,
      suggestions: string[]
    }
  },

  // Intel from scouting
  intel: {
    [roomName]: RoomIntel
  },

  // Creep memory (curated)
  creepMemory: {
    [name]: {
      role, room, state, targetRoom, sourceId, taskId
    }
  },

  // Diagnostics
  diagnostics: {
    cpuUsed: number,
    bucket: number,
    memorySize: number
  }
}
```

### Size Management

Segment 90 has 100KB limit. Graceful degradation:
1. Filter intel by TTL (1500 ticks)
2. Curate creep memory (essential fields only)
3. Drop diagnostics if over 95KB
4. Reduce intel if still over limit

## API Endpoints

**Base URL:** `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com`

### Colonies (real-time from segment 90)
```
GET /colonies                         — All colonies summary
GET /colonies/{roomName}              — Full colony (live + diagnostics merged)
GET /colonies/{roomName}/creeps       — Creep roster
GET /colonies/{roomName}/economy      — Energy flow, rates
GET /colonies/{roomName}/remotes      — Remote mining status
```

### Intel (persistent DynamoDB)
```
GET /intel                            — All rooms
GET /intel/{roomName}                 — Single room
GET /intel/enemies                    — Rooms with hostile owners
GET /intel/candidates?home=E46N37     — Expansion candidates (scored)
```

### Empire (real-time from segment 90)
```
GET /empire                           — State, priorities
GET /empire/expansion                 — Active + queue + candidates
GET /empire/expansion/{roomName}      — Specific expansion
POST /empire/expansion                — Trigger action { action, roomName, parentRoom }
```

### Analysis (DynamoDB)
```
GET /analysis/{roomName}/recommendations  — AI recommendations
GET /analysis/{roomName}/signals          — Signals
GET /analysis/{roomName}/signals/events   — Signal events
GET /analysis/{roomName}/observations     — Observations
GET /analysis/{roomName}/patterns         — Patterns
POST /analysis/{roomName}/feedback        — Recommendation feedback
```

### Debug
```
GET /debug/positions                  — Heatmap (segment 92)
POST /debug/command                   — Queue console command
GET /debug/command?cmd={base64}       — Queue command (GET)
GET /debug/command/result             — Get command result
```

### Metrics (DynamoDB snapshots)
```
GET /metrics/{roomName}?hours=24      — Metric history
```

### Response Metadata

Every response includes:
```json
{
  "source": "segment90" | "dynamodb" | "screeps-api",
  "freshness": 45,
  "fetchedAt": 1706900000000,
  ...data
}
```

## Lambda Functions

### data-collector
- **Trigger:** Every 5 minutes (EventBridge)
- **Action:** Read segment 90, store in DynamoDB
- **Runtime:** Node.js 20.x

### analysis-engine
- **Trigger:** Hourly (EventBridge)
- **Action:** Analyze metrics, generate recommendations via Claude API
- **Runtime:** Node.js 20.x

### api
- **Trigger:** HTTP requests (API Gateway)
- **Action:** Serve data from DynamoDB
- **Runtime:** Node.js 20.x

## DynamoDB Tables

### screeps-snapshots
```
Primary Key: roomName (S)
Sort Key: timestamp (N)
TTL: 30 days
```

### screeps-recommendations
```
Primary Key: id (S)
Attributes: roomName, priority, category, description, createdAt
TTL: 30 days
```

### screeps-intel
```
Primary Key: roomName (S)
No TTL — rooms persist indefinitely
Fields: lastScan, roomType, owner, ownerRcl, sources, mineral, terrain, exits, distanceFromHome, expansionScore
```

## Deployment

**Infrastructure:** CloudFormation (`aws/cloudformation/template.yaml`)
**Lambda deployment:** AWS CLI

### Build Lambda
```bash
cd aws/lambda
powershell -Command "Compress-Archive -Path api/* -DestinationPath api.zip -Force"
```

### Deploy Lambda
```bash
aws lambda update-function-code \
  --function-name screeps-advisor-api \
  --zip-file fileb://aws/lambda/api.zip
```

### Add API Gateway Route
```bash
aws apigatewayv2 create-route \
  --api-id dossn1w7n5 \
  --route-key "GET /new-route" \
  --target "integrations/650eqca"
```

## Console Commands (In-Game)

```javascript
awsExport()              // Show export status
advisor()                // Show API endpoints
fetchAdvisor("W1N1")     // Show cached recommendations
```

## Cost Estimate

| Service | Usage | Monthly Cost |
|---------|-------|--------------|
| DynamoDB | ~100K writes, 500K reads | ~$5 |
| Lambda (collector) | 8640 invocations × 5s | ~$1 |
| Lambda (analysis) | 720 invocations × 60s | ~$2 |
| Claude API | ~720 calls × 4K tokens | ~$15 |
| API Gateway | ~10K requests | ~$1 |
| **Total** | | **~$25/month** |

## Troubleshooting

### Segment 90 Empty
**Cause:** Export not running
**Fix:** Check `awsExport()` in console, verify AWSExporter in main loop

### API Returns 404
**Cause:** Route not configured
**Fix:** Add route via AWS CLI

### Recommendations Stale
**Cause:** Analysis Lambda not running
**Fix:** Check CloudWatch logs for analysis-engine

### Data Over 100KB
**Cause:** Too much intel or creep memory
**Fix:** TTL filtering in AWSExporter should handle this
