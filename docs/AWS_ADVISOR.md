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

### Live Data
```
GET /live/{roomName}
GET /live
```
Real-time data from segment 90 (~200-500ms latency).

### Colony Summary
```
GET /summary/{roomName}
```
Cached snapshot from DynamoDB (updated every 5 min).

Returns:
- RCL progress
- Energy levels
- Creep counts
- Threat status
- CPU usage
- Recommendations count

### Recommendations
```
GET /recommendations/{roomName}
```
AI-generated recommendations with:
- Priority level
- Category (economy, spawning, defense, etc.)
- Description
- Supporting evidence

### Metric History
```
GET /metrics/{roomName}?hours=24
```
Time-series data for colony metrics.

### Expansion Data
```
GET /expansion
```
Empire expansion overview with candidates and readiness.

### Feedback
```
POST /feedback/{recommendationId}
{
  "helpful": boolean,
  "notes": string
}
```
Submit feedback on recommendation quality.

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

## Deployment

**Note:** Uses AWS CLI, NOT Terraform.

### Build Lambda
```bash
cd aws/lambda
powershell -Command "Compress-Archive -Path api/* -DestinationPath api.zip -Force"
```

### Deploy Lambda
```bash
aws lambda update-function-code \
  --function-name screeps-api-prod \
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
