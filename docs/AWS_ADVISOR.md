# AWS Advisor System

## Overview

External monitoring system that:
1. Collects colony data from Screeps
2. Stores metrics in DynamoDB
3. Runs AI analysis (Claude API)
4. Provides API endpoints for recommendations
5. **Event-driven alerts for critical situations**

## Architecture

```
SCREEPS GAME
    │
    ├─► Export state to Segment 90 ────────────────────┐
    │                                                  │
    ◄── Read directives from Segment 95 ◄────┐        │
    │                                        │        │
    │ Directive acks included in export ─────┼────────┤
    │                                        │        │
    ▼                                        │        ▼
AWS LAMBDA (data-collector) ◄────────────────┼──── Every 5 min
    │                                        │
    │                           LAMBDA (directive-writer)
    │                             (writes to Segment 95)
    ▼
DYNAMODB (snapshots) ──────► DynamoDB Stream
    │                              │
    │                              ▼
    │                    LAMBDA (stream-processor)
    │                              │
    │              ┌───────────────┼───────────────┐
    │              ▼               ▼               ▼
    │        EventBridge      EventBridge      EventBridge
    │        (Metrics)        (Analysis)       (Alerts)
    │              │               │               │
    │              ▼               ▼               ▼
    │        Metrics Writer   Step Functions   SNS Topic
    │                              │         (Critical Alerts)
    │                              ▼
    └───────────────────► LAMBDA (analysis-engine)
                               │ Claude API
                               ▼
                        DYNAMODB (observations, recommendations)
                               │
                               ▼
                          API GATEWAY
                               │
                               ▼
                        PORTAL / CLAUDE CODE
```

## Implementation Status

### Phase 1: Working Advisor (COMPLETED)
- [x] Analysis engine generates observations for ALL colonies (not just problematic ones)
- [x] Positive patterns added (ECONOMY_STABLE, CPU_EFFICIENT, WORKFORCE_BALANCED, RCL_PROGRESSING, REMOTE_MINING_ACTIVE)
- [x] API endpoints configured for observations, signals, patterns
- [x] Portal displays AI-generated observations

### Phase 2: Event-Driven Analysis (COMPLETED)
- [x] DynamoDB Streams enabled on snapshots table
- [x] Stream Processor classifies events and routes to EventBridge
- [x] EventBridge rules for metrics, analysis triggers, and critical alerts
- [x] SNS topic for critical alerts (ThreatDetected, CriticalEnergyLevel, NoCreepsAlive)
- [x] Metrics Writer (DynamoDB) stores historical metrics for trend analysis
- [x] Context Builder queries metrics history for 6-hour trend windows

### Phase 3: Smart Pattern Detection (COMPLETED)

- [x] Enhanced Step Functions workflow with throttling gates
- [x] ShouldAnalyze gate: skips if analyzed within 10 minutes
- [x] DetectPatterns Lambda: rule-based pattern detection from snapshot + trends
- [x] FilterPatterns Lambda: removes patterns with pending recommendations or low confidence
- [x] HasNewPatterns gate: skips Claude API if no new patterns
- [x] Pattern types: NO_MINERS, NO_UPGRADERS, HAULER_SHORTAGE, LOW_STORAGE, CPU_BUCKET_LOW, ACTIVE_THREAT, ENERGY_DRAIN, RCL_STALL

### Phase 4: Learning Loop (COMPLETED)

- [x] Outcome Evaluator Lambda: evaluates recommendations on snapshot stream
- [x] Pattern resolution detection: checks if patterns are resolved in new snapshots
- [x] Outcome classification: resolved_helpful, resolved_natural, expired, resolved_unknown
- [x] Pattern confidence scoring: adjusts confidence in [0.0, 1.0] range
- [x] Knowledge table records: stores outcomes and confidence scores
- [x] API endpoint: GET /analysis/{roomName}/learning for learning data

### Phase 5: Adaptive Intelligence (NOT STARTED)
- [ ] Embedding-based pattern discovery
- [ ] Cross-colony knowledge transfer
- [ ] Strategic decision engine

## AWS Directive System

Enables AWS to send commands to the bot via memory segment 95.

### How It Works

1. AWS analysis generates directives (spawn decisions, remote mining, etc.)
2. Directive-writer Lambda writes to Segment 95
3. Bot reads segment 95 via `DirectiveReader.run()` each tick
4. Bot executes directives and sends acknowledgments in segment 90
5. AWS reads acks and updates directive state

### Directive Types

| Type            | Payload                         | Action                                      |
|-----------------|---------------------------------|---------------------------------------------|
| `SPAWN`         | role, targetRoom, body, memory  | Queue creep for spawning                    |
| `REMOTE_ADD`    | remoteRoom, distance, sources   | Add remote mining room                      |
| `REMOTE_REMOVE` | remoteRoom, killCreeps          | Remove remote and optionally suicide creeps |
| `CONSTRUCT`     | structureType, pos              | Place construction site                     |
| `CONFIG`        | key, value                      | Update colony config                        |
| `MILITARY`      | action, targetRoom, composition | Launch attack/defend                        |
| `EXPAND`        | targetRoom, parentRoom          | Start expansion                             |

### Staleness Protection

Directives older than 500 ticks trigger automatic fallback to local logic. This prevents stale AWS decisions from overriding bot autonomy.

### Console Commands

```javascript
directives()           // Show current directive payload
directives.toggle()    // Enable/disable directive system
directives.status()    // Show execution history
directives.clear()     // Clear all directive state
spawnQueue()           // Show queued spawn directives
```

### Memory Schema

```typescript
Memory.settings.useDirectives: boolean;  // Master toggle
Memory.directives: {                     // Execution tracking
  [directiveId]: {
    status: "COMPLETED" | "FAILED" | "EXPIRED";
    executedAt: number;
    result?: string;
  }
};
Memory.spawnDirectives: [{               // Queued spawns
  directiveId, colony, role, priority, reason, addedAt
}];
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
  },

  // Directive acknowledgments (for AWS directive system)
  directiveAcks: [{
    id: string,
    status: "COMPLETED" | "FAILED" | "EXPIRED",
    executedAt: number,
    result?: string
  }]
}
```

### Size Management

Segment 90 has 100KB limit. Graceful degradation:
1. Filter intel by TTL (1500 ticks)
2. Curate creep memory (essential fields only)
3. Drop diagnostics if over 95KB
4. Reduce intel if still over limit

## API Endpoints

**Base URL:** `https://g9gplzbul4.execute-api.us-east-1.amazonaws.com`

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
GET /analysis/{roomName}/learning         — Learning loop status & confidence
POST /analysis/{roomName}/feedback        — Recommendation feedback
```

#### Learning Endpoint Response

```json
{
  "patternConfidence": {
    "NO_UPGRADERS": 0.6,
    "HAULER_SHORTAGE": 0.45,
    "LOW_STORAGE": 0.7
  },
  "recentOutcomes": [...],
  "stats": {
    "totalEvaluated": 15,
    "helpful": 6,
    "natural": 4,
    "expired": 5,
    "helpfulRate": 0.6
  },
  "confidenceRange": {
    "min": 0.0,
    "max": 1.0,
    "default": 0.5,
    "suppressionThreshold": 0.3
  }
}
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
- **Trigger:** Every 5 minutes (EventBridge Scheduler)
- **Action:** Read segment 90, store in DynamoDB
- **Runtime:** Node.js 20.x

### stream-processor
- **Trigger:** DynamoDB Streams (on snapshot insert)
- **Action:** Classify events and emit to EventBridge
- **Events Emitted:**
  - `SnapshotCreated` → Metrics Writer
  - `SignificantChange` → Analysis Workflow
  - `ThreatDetected` → SNS + Analysis Workflow
  - `EconomyAnomaly` → Analysis Workflow
  - `RCLProgress` → Analysis Workflow
  - `CriticalEnergyLevel` → SNS
  - `NoCreepsAlive` → SNS
- **Runtime:** Node.js 20.x

### analysis-engine
- **Trigger:** Hourly (EventBridge Scheduler)
- **Action:** Analyze metrics, generate observations via Claude API
- **Pattern Detection:** Detects both problem patterns and healthy state patterns
- **Runtime:** Node.js 20.x

### metrics-writer

- **Trigger:** EventBridge (SnapshotCreated event)
- **Action:** Write colony metrics to DynamoDB for trend analysis
- **Metrics:** energy_available, energy_stored, rcl_progress, creep_count, cpu_used, etc.
- **Retention:** 7 days TTL
- **Runtime:** Node.js 20.x

### context-builder

- **Trigger:** Step Functions (AnalysisWorkflow)
- **Action:** Build rich context from snapshots, events, knowledge, metrics history
- **Features:** 6-hour trend analysis, recentAnalysisAge for throttling
- **Runtime:** Node.js 20.x

### detect-patterns

- **Trigger:** Step Functions (AnalysisWorkflow)
- **Action:** Run rule-based pattern detection on snapshot and metrics trends
- **Patterns:** NO_MINERS, NO_UPGRADERS, HAULER_SHORTAGE, LOW_STORAGE, CPU_BUCKET_LOW, etc.
- **Runtime:** Node.js 20.x

### filter-patterns

- **Trigger:** Step Functions (AnalysisWorkflow)
- **Action:** Remove patterns with pending recommendations or low confidence scores
- **Features:** Checks knowledge table for pattern confidence, filters duplicates
- **Runtime:** Node.js 20.x

### claude-analyzer
- **Trigger:** Step Functions (AnalysisWorkflow)
- **Action:** Call Claude API with context
- **Runtime:** Node.js 20.x

### recommendation-writer
- **Trigger:** Step Functions (AnalysisWorkflow)
- **Action:** Store recommendations in DynamoDB
- **Runtime:** Node.js 20.x

### outcome-evaluator

- **Trigger:** DynamoDB Stream (snapshots table INSERT events)
- **Action:** Evaluate pending recommendations against new snapshots
- **Features:**
  - Pattern resolution detection (checks if detected patterns are now resolved)
  - Outcome classification: resolved_helpful, resolved_natural, expired, resolved_unknown
  - Confidence scoring: adjusts pattern confidence based on outcomes (+0.1 helpful, -0.05 natural)
  - Knowledge table updates: records outcomes and confidence scores
- **Runtime:** Node.js 20.x

### api
- **Trigger:** HTTP requests (API Gateway)
- **Action:** Serve data from DynamoDB
- **Runtime:** Node.js 20.x

## Event-Driven Architecture

### EventBridge Event Bus
**Name:** `screeps-advisor-events`

### Event Types

| Event | Source | Trigger | Target |
|-------|--------|---------|--------|
| `SnapshotCreated` | stream-processor | Every snapshot insert | Metrics Writer |
| `SignificantChange` | stream-processor | Creep/storage changes | Analysis Workflow |
| `ThreatDetected` | stream-processor | Hostiles detected | SNS + Analysis |
| `EconomyAnomaly` | stream-processor | Energy drops >30% | Analysis Workflow |
| `RCLProgress` | stream-processor | RCL progress >10% | Analysis Workflow |
| `CriticalEnergyLevel` | stream-processor | Storage <5k + spawn <50% | SNS |
| `NoCreepsAlive` | stream-processor | Creep count drops to 0 | SNS |

### SNS Critical Alerts

**Topic ARN:** `arn:aws:sns:us-east-1:488218643044:screeps-advisor-critical-alerts`

Subscribe to receive email/SMS alerts:
```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:488218643044:screeps-advisor-critical-alerts \
  --protocol email \
  --notification-endpoint your@email.com
```

### Step Functions Workflow

**Name:** `screeps-advisor-analysis-workflow`

```
BuildContext
    │
    │ Gather snapshots, events, knowledge, metrics history
    ▼
ShouldAnalyze ──────(analyzed <10min ago)──────► SkipAnalysis (Succeed)
    │
    │ Check recentAnalysisAge
    ▼
DetectPatterns
    │
    │ Rule-based pattern detection from snapshot + trends
    ▼
FilterPatterns
    │
    │ Remove patterns with pending recs or low confidence
    ▼
HasNewPatterns ─────(count = 0)─────► NoNewPatterns (Succeed)
    │
    │ New patterns detected
    ▼
AnalyzeWithClaude
    │
    │ Generate recommendations via Claude API
    ▼
WriteRecommendations
    │
    │ Store to DynamoDB + emit events
    ▼
Success
```

**Throttling Gates:**

- **ShouldAnalyze**: Skips workflow if room was analyzed within last 10 minutes
- **HasNewPatterns**: Skips Claude API call if no new patterns detected (saves API costs)

## Pattern Detection

### Problem Patterns (analysis-engine)
| Pattern ID | Severity | Condition |
|------------|----------|-----------|
| `ENERGY_STARVATION` | HIGH | Storage <10k AND spawn <50% |
| `HAULER_SHORTAGE` | MEDIUM | Haulers < harvesters |
| `NO_UPGRADERS` | HIGH | 0 upgraders AND RCL <8 |
| `CPU_BUCKET_LOW` | MEDIUM/HIGH | Bucket <5000/<2000 |
| `REMOTE_HAULER_SHORTAGE` | MEDIUM | Remote haulers < miners |
| `ACTIVE_THREAT` | CRITICAL | Hostiles present |
| `TRAFFIC_BOTTLENECK` | LOW | Tile >100 visits |
| `RCL_STALL` | HIGH | <1000 progress/hr with 100k+ energy |
| `STORAGE_FULL` | MEDIUM | Storage >900k |
| `NO_MINERS` | CRITICAL | 0 harvesters/miners |

### Healthy State Patterns (analysis-engine)
| Pattern ID | Severity | Condition |
|------------|----------|-----------|
| `ECONOMY_STABLE` | INFO | Storage 100k-800k |
| `CPU_EFFICIENT` | INFO | Bucket >8000 |
| `WORKFORCE_BALANCED` | INFO | 2+ miners, 2+ haulers, 1+ upgrader |
| `RCL_PROGRESSING` | INFO | >2000 progress/hr |
| `RCL_PROGRESSING_FAST` | INFO | >5000 progress/hr |
| `REMOTE_MINING_ACTIVE` | INFO | Remote rooms active with adequate haulers |

## DynamoDB Tables

| Table | Primary Key | Sort Key | TTL | Purpose |
|-------|-------------|----------|-----|---------|
| `screeps-advisor-snapshots` | roomName (S) | timestamp (N) | 30d | Colony state snapshots |
| `screeps-advisor-events` | roomName (S) | eventId (S) | 30d | Game events |
| `screeps-advisor-recommendations` | id (S) | - | 30d | AI recommendations |
| `screeps-advisor-observations` | roomName (S) | timestamp (N) | 30d | AI observations |
| `screeps-advisor-signals` | roomName (S) | timestamp (N) | 30d | Metrics & threshold events |
| `screeps-advisor-intel` | roomName (S) | - | - | Room intelligence |
| `screeps-advisor-knowledge` | patternHash (S) | - | - | Learning/feedback loop |
| `screeps-advisor-metrics-history` | roomName (S) | timestamp (N) | 7d | Historical metrics |
| `screeps-advisor-recordings` | recordingId (S) | - | 30d | Room recordings metadata |
| `screeps-advisor-pattern-state` | patternId (S) | - | - | Pattern detection state |

### Knowledge Table Key Patterns

The knowledge table uses a single `patternHash` key with prefixed patterns:

| Key Pattern | Description | Example |
|-------------|-------------|---------|
| `_global\|confidence:{patternType}` | Pattern confidence score (0.0-1.0) | `_global\|confidence:NO_UPGRADERS` |
| `_global\|outcome:{recommendationId}` | Outcome record for a recommendation | `_global\|outcome:abc-123` |

**Confidence Scoring:**

- Default: 0.5 (new patterns)
- Range: [0.0, 1.0]
- Suppression threshold: 0.3 (patterns below this are filtered)
- Adjustment: +0.1 for resolved_helpful, -0.05 for resolved_natural

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
