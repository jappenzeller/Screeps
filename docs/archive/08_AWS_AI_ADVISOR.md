# AWS AI Agent Design: Colony Advisor

## Overview

An AI-powered monitoring system that observes colony performance over time, identifies patterns and problems, and generates actionable recommendations for code improvements.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SCREEPS GAME                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                         │
│  │   Colony    │  │   Memory    │  │   Stats     │                         │
│  │   State     │  │   Segments  │  │   (custom)  │                         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                         │
└─────────┼────────────────┼────────────────┼────────────────────────────────┘
          │                │                │
          └────────────────┼────────────────┘
                           │ Screeps API
                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AWS INFRASTRUCTURE                                │
│                                                                             │
│  ┌──────────────────┐                                                       │
│  │  Data Collector  │  (Lambda, runs every 5 min)                          │
│  │  - Pull memory   │                                                       │
│  │  - Pull stats    │                                                       │
│  │  - Normalize     │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐     ┌──────────────────┐                             │
│  │   Time Series    │     │   Event Store    │                             │
│  │   (DynamoDB)     │     │   (DynamoDB)     │                             │
│  │   - Metrics      │     │   - Deaths       │                             │
│  │   - Per tick     │     │   - Attacks      │                             │
│  │   - Aggregates   │     │   - Phase changes│                             │
│  └────────┬─────────┘     └────────┬─────────┘                             │
│           │                        │                                        │
│           └───────────┬────────────┘                                        │
│                       │                                                     │
│                       ▼                                                     │
│  ┌──────────────────────────────────────────┐                              │
│  │           Analysis Engine                 │                              │
│  │           (Lambda + Claude API)           │                              │
│  │                                           │                              │
│  │  1. Pattern Detection                     │                              │
│  │  2. Anomaly Detection                     │                              │
│  │  3. Performance Scoring                   │                              │
│  │  4. Root Cause Analysis                   │                              │
│  │  5. Recommendation Generation             │                              │
│  └────────────────────┬─────────────────────┘                              │
│                       │                                                     │
│                       ▼                                                     │
│  ┌──────────────────────────────────────────┐                              │
│  │           Recommendations DB              │                              │
│  │           (DynamoDB)                      │                              │
│  │                                           │                              │
│  │  - Suggested code changes                 │                              │
│  │  - Priority scores                        │                              │
│  │  - Supporting evidence                    │                              │
│  └────────────────────┬─────────────────────┘                              │
│                       │                                                     │
│                       ▼                                                     │
│  ┌──────────────────────────────────────────┐                              │
│  │           Dashboard / API                 │                              │
│  │           (API Gateway + Lambda)          │                              │
│  │                                           │                              │
│  │  GET /analysis/summary                    │                              │
│  │  GET /analysis/recommendations            │                              │
│  │  GET /metrics/{metric}/history            │                              │
│  │  POST /feedback (was recommendation good?)│                              │
│  └──────────────────────────────────────────┘                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Collection

### Metrics to Capture (every 5 minutes)

```typescript
interface ColonySnapshot {
  timestamp: number;          // Unix timestamp
  gameTick: number;           // Game.time
  
  // Resource metrics
  energy: {
    spawnAvailable: number;
    spawnCapacity: number;
    storage: number;
    containers: number;
    dropped: number;
    total: number;
  };
  
  // Creep metrics
  creeps: {
    total: number;
    byRole: Record<string, number>;
    byState: Record<string, number>;  // idle, working, moving
    avgTicksToLive: number;
    deaths: number;                    // since last snapshot
    spawned: number;                   // since last snapshot
  };
  
  // Economy metrics
  economy: {
    energyHarvested: number;          // since last snapshot
    energySpentSpawning: number;
    energySpentBuilding: number;
    energySpentUpgrading: number;
    harvestEfficiency: number;        // actual / theoretical max
  };
  
  // Progress metrics
  controller: {
    level: number;
    progress: number;
    progressTotal: number;
    ticksToDowngrade: number;
  };
  
  // Infrastructure
  structures: {
    constructionSites: number;
    containers: number;
    extensions: number;
    towers: number;
    roads: number;
    damagedCount: number;
  };
  
  // Threats
  threats: {
    hostileCreeps: number;
    hostileDPS: number;
    lastAttackTick: number | null;
  };
  
  // Performance
  cpu: {
    used: number;
    bucket: number;
    limit: number;
  };
}
```

### Events to Capture (as they occur)

```typescript
interface ColonyEvent {
  timestamp: number;
  gameTick: number;
  type: EventType;
  data: Record<string, any>;
}

enum EventType {
  CREEP_DEATH = 'CREEP_DEATH',
  CREEP_SPAWNED = 'CREEP_SPAWNED',
  PHASE_CHANGE = 'PHASE_CHANGE',
  HOSTILE_DETECTED = 'HOSTILE_DETECTED',
  HOSTILE_ELIMINATED = 'HOSTILE_ELIMINATED',
  STRUCTURE_BUILT = 'STRUCTURE_BUILT',
  STRUCTURE_DESTROYED = 'STRUCTURE_DESTROYED',
  RCL_UPGRADE = 'RCL_UPGRADE',
  ENERGY_CRISIS = 'ENERGY_CRISIS',      // storage dropped below threshold
  CPU_THROTTLE = 'CPU_THROTTLE',         // bucket dropped below 1000
}
```

### In-Game Stats Collection

Add to the Screeps codebase (Memory segment approach):

```typescript
// src/utils/StatsCollector.ts

interface TickStats {
  tick: number;
  energyHarvested: number;
  energySpent: {
    spawning: number;
    building: number;
    upgrading: number;
    repairing: number;
  };
  creepActions: {
    harvests: number;
    transfers: number;
    builds: number;
    repairs: number;
    upgrades: number;
    attacks: number;
  };
  events: ColonyEvent[];
}

export class StatsCollector {
  private static stats: TickStats;
  
  static startTick(): void {
    this.stats = {
      tick: Game.time,
      energyHarvested: 0,
      energySpent: { spawning: 0, building: 0, upgrading: 0, repairing: 0 },
      creepActions: { harvests: 0, transfers: 0, builds: 0, repairs: 0, upgrades: 0, attacks: 0 },
      events: []
    };
  }
  
  static recordHarvest(amount: number): void {
    this.stats.energyHarvested += amount;
    this.stats.creepActions.harvests++;
  }
  
  static recordSpawn(cost: number): void {
    this.stats.energySpent.spawning += cost;
  }
  
  static recordEvent(type: EventType, data: any): void {
    this.stats.events.push({ timestamp: Date.now(), gameTick: Game.time, type, data });
  }
  
  static endTick(): void {
    // Store in memory segment for AWS to pull
    // Aggregate into rolling windows
    if (!Memory.statsHistory) Memory.statsHistory = [];
    Memory.statsHistory.push(this.stats);
    
    // Keep last 100 ticks in memory
    if (Memory.statsHistory.length > 100) {
      Memory.statsHistory.shift();
    }
  }
}
```

---

## Analysis Engine

### Pattern Detection

The analysis engine looks for patterns that indicate problems:

```typescript
interface Pattern {
  id: string;
  name: string;
  description: string;
  detector: (snapshots: ColonySnapshot[], events: ColonyEvent[]) => PatternMatch | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface PatternMatch {
  patternId: string;
  confidence: number;        // 0-1
  evidence: string[];        // specific data points
  timeRange: [number, number];
}
```

### Built-in Pattern Detectors

```typescript
const PATTERNS: Pattern[] = [
  {
    id: 'energy_starvation',
    name: 'Energy Starvation',
    description: 'Creeps waiting for energy while harvesters upgrade',
    severity: 'high',
    detector: (snapshots) => {
      // Look for: low spawn energy + high upgrade rate + idle creeps
      const recent = snapshots.slice(-12); // last hour
      const avgIdleCreeps = avg(recent.map(s => s.creeps.byState['idle'] || 0));
      const avgSpawnEnergy = avg(recent.map(s => s.energy.spawnAvailable / s.energy.spawnCapacity));
      const upgradeRate = sum(recent.map(s => s.economy.energySpentUpgrading));
      
      if (avgIdleCreeps > 2 && avgSpawnEnergy < 0.5 && upgradeRate > 1000) {
        return {
          patternId: 'energy_starvation',
          confidence: 0.85,
          evidence: [
            `Average ${avgIdleCreeps.toFixed(1)} idle creeps`,
            `Spawn energy at ${(avgSpawnEnergy * 100).toFixed(0)}% average`,
            `${upgradeRate} energy spent upgrading in last hour`
          ],
          timeRange: [recent[0].timestamp, recent[recent.length-1].timestamp]
        };
      }
      return null;
    }
  },
  
  {
    id: 'harvest_inefficiency',
    name: 'Harvest Inefficiency',
    description: 'Sources not being harvested at maximum rate',
    severity: 'medium',
    detector: (snapshots) => {
      const recent = snapshots.slice(-12);
      const avgEfficiency = avg(recent.map(s => s.economy.harvestEfficiency));
      
      if (avgEfficiency < 0.7) {
        return {
          patternId: 'harvest_inefficiency',
          confidence: 0.9,
          evidence: [
            `Harvest efficiency at ${(avgEfficiency * 100).toFixed(0)}%`,
            `Theoretical max: 20 energy/tick for 2 sources`,
            `Actual: ${(avgEfficiency * 20).toFixed(1)} energy/tick`
          ],
          timeRange: [recent[0].timestamp, recent[recent.length-1].timestamp]
        };
      }
      return null;
    }
  },
  
  {
    id: 'creep_death_spiral',
    name: 'Creep Death Spiral',
    description: 'More creeps dying than spawning',
    severity: 'critical',
    detector: (snapshots, events) => {
      const recentDeaths = events.filter(e => 
        e.type === 'CREEP_DEATH' && 
        e.timestamp > Date.now() - 3600000 // last hour
      ).length;
      
      const recentSpawns = events.filter(e =>
        e.type === 'CREEP_SPAWNED' &&
        e.timestamp > Date.now() - 3600000
      ).length;
      
      if (recentDeaths > recentSpawns * 1.5 && recentDeaths > 3) {
        return {
          patternId: 'creep_death_spiral',
          confidence: 0.95,
          evidence: [
            `${recentDeaths} deaths in last hour`,
            `${recentSpawns} spawns in last hour`,
            `Net loss: ${recentDeaths - recentSpawns} creeps`
          ],
          timeRange: [Date.now() - 3600000, Date.now()]
        };
      }
      return null;
    }
  },
  
  {
    id: 'cpu_pressure',
    name: 'CPU Pressure',
    description: 'CPU bucket draining, code may be inefficient',
    severity: 'medium',
    detector: (snapshots) => {
      const recent = snapshots.slice(-12);
      const bucketTrend = recent[recent.length-1].cpu.bucket - recent[0].cpu.bucket;
      
      if (bucketTrend < -1000) {
        return {
          patternId: 'cpu_pressure',
          confidence: 0.8,
          evidence: [
            `Bucket dropped ${Math.abs(bucketTrend)} in last hour`,
            `Current bucket: ${recent[recent.length-1].cpu.bucket}`,
            `Average CPU: ${avg(recent.map(s => s.cpu.used)).toFixed(2)}`
          ],
          timeRange: [recent[0].timestamp, recent[recent.length-1].timestamp]
        };
      }
      return null;
    }
  },
  
  {
    id: 'stuck_rcl',
    name: 'Stuck RCL Progression',
    description: 'Controller not upgrading despite having resources',
    severity: 'low',
    detector: (snapshots) => {
      const recent = snapshots.slice(-48); // last 4 hours
      if (recent.length < 48) return null;
      
      const progressDelta = recent[recent.length-1].controller.progress - recent[0].controller.progress;
      const avgStorage = avg(recent.map(s => s.energy.storage));
      
      // Has energy but not upgrading
      if (avgStorage > 10000 && progressDelta < 1000) {
        return {
          patternId: 'stuck_rcl',
          confidence: 0.75,
          evidence: [
            `Only ${progressDelta} controller progress in 4 hours`,
            `Average storage: ${avgStorage.toFixed(0)} energy`,
            `Upgraders may be starved or misconfigured`
          ],
          timeRange: [recent[0].timestamp, recent[recent.length-1].timestamp]
        };
      }
      return null;
    }
  }
];
```

---

## AI Recommendation Engine

### Claude API Integration

Use Claude to analyze patterns and generate recommendations:

```typescript
// analysis-lambda/src/recommendationEngine.ts

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

interface AnalysisContext {
  patterns: PatternMatch[];
  recentSnapshots: ColonySnapshot[];
  recentEvents: ColonyEvent[];
  currentCode: {
    taskCoordinator?: string;
    harvester?: string;
    // ... relevant source files
  };
}

async function generateRecommendations(context: AnalysisContext): Promise<Recommendation[]> {
  const prompt = buildAnalysisPrompt(context);
  
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are an expert Screeps AI developer analyzing colony performance data. 
Your task is to identify problems and suggest specific code changes.

When suggesting code changes:
1. Be specific - reference exact functions and line logic
2. Explain the root cause
3. Provide before/after code snippets when helpful
4. Prioritize by impact

Format each recommendation as JSON:
{
  "id": "unique_id",
  "title": "Brief title",
  "severity": "low|medium|high|critical",
  "category": "economy|spawning|combat|efficiency|architecture",
  "problem": "What's wrong",
  "rootCause": "Why it's happening",
  "solution": "What to change",
  "codeChanges": [
    {
      "file": "path/to/file.ts",
      "description": "What to change",
      "before": "code snippet or null",
      "after": "suggested code"
    }
  ],
  "expectedImpact": "What will improve",
  "confidence": 0.0-1.0
}`,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });
  
  return parseRecommendations(response.content[0].text);
}

function buildAnalysisPrompt(context: AnalysisContext): string {
  return `
## Detected Patterns

${context.patterns.map(p => `
### ${p.patternId} (confidence: ${(p.confidence * 100).toFixed(0)}%)
Evidence:
${p.evidence.map(e => `- ${e}`).join('\n')}
`).join('\n')}

## Recent Metrics (last 4 hours)

Energy Flow:
- Harvest efficiency: ${avg(context.recentSnapshots.map(s => s.economy.harvestEfficiency * 100)).toFixed(0)}%
- Average storage: ${avg(context.recentSnapshots.map(s => s.energy.storage)).toFixed(0)}
- Spawn energy fill rate: ${avg(context.recentSnapshots.map(s => s.energy.spawnAvailable / s.energy.spawnCapacity * 100)).toFixed(0)}%

Creep Population:
- Average total: ${avg(context.recentSnapshots.map(s => s.creeps.total)).toFixed(1)}
- Average idle: ${avg(context.recentSnapshots.map(s => s.creeps.byState['idle'] || 0)).toFixed(1)}
- Deaths: ${context.recentEvents.filter(e => e.type === 'CREEP_DEATH').length}
- Spawns: ${context.recentEvents.filter(e => e.type === 'CREEP_SPAWNED').length}

Controller:
- Current RCL: ${context.recentSnapshots[context.recentSnapshots.length-1]?.controller.level}
- Progress rate: ${calculateProgressRate(context.recentSnapshots)} points/hour

## Relevant Code

${Object.entries(context.currentCode).map(([name, code]) => `
### ${name}
\`\`\`typescript
${code}
\`\`\`
`).join('\n')}

## Task

Analyze the patterns and metrics above. Identify the root causes of any problems and suggest specific code changes to fix them.

Return your recommendations as a JSON array.
`;
}
```

### Recommendation Types

```typescript
interface Recommendation {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'economy' | 'spawning' | 'combat' | 'efficiency' | 'architecture';
  problem: string;
  rootCause: string;
  solution: string;
  codeChanges: CodeChange[];
  expectedImpact: string;
  confidence: number;
  createdAt: number;
  status: 'pending' | 'applied' | 'dismissed';
  feedback?: {
    helpful: boolean;
    notes: string;
  };
}

interface CodeChange {
  file: string;
  description: string;
  before: string | null;
  after: string;
}
```

---

## Learning Loop

### Feedback Collection

When recommendations are applied or dismissed, collect feedback:

```typescript
interface RecommendationFeedback {
  recommendationId: string;
  action: 'applied' | 'dismissed' | 'modified';
  helpful: boolean;
  notes?: string;
  
  // If applied, track results
  metricsBeforeApply?: ColonySnapshot;
  metricsAfterApply?: ColonySnapshot;  // 24 hours later
  actualImpact?: string;
}
```

### Tuning Pattern Detectors

Use feedback to adjust pattern detector thresholds:

```typescript
// Over time, learn which patterns lead to good recommendations
interface PatternPerformance {
  patternId: string;
  totalDetections: number;
  recommendationsGenerated: number;
  recommendationsApplied: number;
  helpfulFeedback: number;
  unhelpfulFeedback: number;
  
  // Calculated
  precision: number;  // helpful / total applied
}

// Adjust detector sensitivity based on performance
function adjustPatternThresholds(performance: PatternPerformance[]): void {
  for (const p of performance) {
    if (p.precision < 0.5 && p.totalDetections > 10) {
      // Too many false positives, tighten threshold
      increaseDetectorThreshold(p.patternId);
    } else if (p.precision > 0.9 && p.helpfulFeedback > 5) {
      // Very accurate, could detect more aggressively
      decreaseDetectorThreshold(p.patternId);
    }
  }
}
```

---

## API Endpoints

```typescript
// GET /api/analysis/summary
interface AnalysisSummary {
  colonyHealth: 'healthy' | 'warning' | 'critical';
  activePatterns: PatternMatch[];
  pendingRecommendations: number;
  metricsSnapshot: ColonySnapshot;
  trends: {
    energyTrend: 'increasing' | 'stable' | 'decreasing';
    creepTrend: 'increasing' | 'stable' | 'decreasing';
    rclProgress: number;  // percent to next level
  };
}

// GET /api/analysis/recommendations
interface RecommendationList {
  recommendations: Recommendation[];
  totalCount: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
}

// GET /api/metrics/{metric}/history?from={timestamp}&to={timestamp}
interface MetricHistory {
  metric: string;
  dataPoints: Array<{
    timestamp: number;
    value: number;
  }>;
  aggregation: 'raw' | '5min' | 'hourly' | 'daily';
}

// POST /api/recommendations/{id}/feedback
interface FeedbackRequest {
  action: 'applied' | 'dismissed' | 'modified';
  helpful: boolean;
  notes?: string;
}

// GET /api/analysis/report
// Returns a comprehensive analysis report suitable for review
interface AnalysisReport {
  generatedAt: number;
  timeRange: [number, number];
  executiveSummary: string;
  patterns: PatternMatch[];
  recommendations: Recommendation[];
  metrics: {
    economy: MetricSummary;
    population: MetricSummary;
    progress: MetricSummary;
    efficiency: MetricSummary;
  };
  comparisonToPrevious: {
    metric: string;
    change: number;
    changePercent: number;
  }[];
}
```

---

## Infrastructure (Terraform)

```hcl
# DynamoDB Tables
resource "aws_dynamodb_table" "colony_snapshots" {
  name         = "screeps-colony-snapshots"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "roomName"
  range_key    = "timestamp"
  
  attribute {
    name = "roomName"
    type = "S"
  }
  
  attribute {
    name = "timestamp"
    type = "N"
  }
  
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "colony_events" {
  name         = "screeps-colony-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "roomName"
  range_key    = "eventId"
  
  # ... similar structure
}

resource "aws_dynamodb_table" "recommendations" {
  name         = "screeps-recommendations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  
  # ... 
}

# Lambda Functions
resource "aws_lambda_function" "data_collector" {
  function_name = "screeps-data-collector"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  timeout       = 30
  
  environment {
    variables = {
      SCREEPS_TOKEN = aws_secretsmanager_secret_version.screeps_token.secret_string
      DYNAMODB_TABLE_SNAPSHOTS = aws_dynamodb_table.colony_snapshots.name
      DYNAMODB_TABLE_EVENTS = aws_dynamodb_table.colony_events.name
    }
  }
}

resource "aws_lambda_function" "analysis_engine" {
  function_name = "screeps-analysis-engine"
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  timeout       = 120
  memory_size   = 512
  
  environment {
    variables = {
      ANTHROPIC_API_KEY = aws_secretsmanager_secret_version.anthropic_key.secret_string
      DYNAMODB_TABLE_RECOMMENDATIONS = aws_dynamodb_table.recommendations.name
    }
  }
}

# EventBridge Schedules
resource "aws_cloudwatch_event_rule" "collect_data" {
  name                = "screeps-collect-data"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_rule" "run_analysis" {
  name                = "screeps-run-analysis"
  schedule_expression = "rate(1 hour)"
}
```

---

## Cost Estimation

| Service | Usage | Monthly Cost |
|---------|-------|--------------|
| DynamoDB | ~100K writes, 500K reads | ~$5 |
| Lambda (collector) | 8640 invocations × 5s | ~$1 |
| Lambda (analysis) | 720 invocations × 60s | ~$2 |
| Claude API | ~720 calls × 4K tokens | ~$15 |
| API Gateway | ~10K requests | ~$1 |
| **Total** | | **~$25/month** |

---

## Implementation Phases

### Phase 1: Data Collection (Week 1)
- [ ] Add StatsCollector to Screeps codebase
- [ ] Create DynamoDB tables
- [ ] Deploy data collector Lambda
- [ ] Verify data flowing correctly

### Phase 2: Pattern Detection (Week 2)
- [ ] Implement pattern detectors
- [ ] Create analysis Lambda
- [ ] Test pattern detection accuracy
- [ ] Add basic alerting

### Phase 3: AI Recommendations (Week 3)
- [ ] Integrate Claude API
- [ ] Build recommendation generation
- [ ] Create API endpoints
- [ ] Test recommendation quality

### Phase 4: Dashboard & Feedback (Week 4)
- [ ] Build simple web dashboard
- [ ] Add feedback collection
- [ ] Implement learning loop
- [ ] Document system
