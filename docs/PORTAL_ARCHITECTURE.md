# Screeps Empire Portal — Architecture Document

## Overview

Single-page React application replacing the three disconnected HTML pages (colony dashboard, QuickSight analytics, recording viewer) with a unified portal. Hosted on S3, consuming the existing API Gateway at `https://g9gplzbul4.execute-api.us-east-1.amazonaws.com`.

## Tech Stack

- **Framework**: React 18 + Vite
- **Routing**: React Router v6 (client-side, hash router for S3 compat)
- **Styling**: Tailwind CSS
- **Charts**: Recharts (already available in artifacts, proven)
- **Canvas**: Raw Canvas 2D API (port existing recording viewer rendering)
- **State**: React Context + useReducer for global state (empire data, selected colony), local state for everything else. No Redux — overkill for single-user tool.
- **Data fetching**: Custom hooks with SWR-like pattern (stale-while-revalidate). No library needed — just `useEffect` + `useRef` for cache.
- **Build**: Vite → S3 sync
- **No auth initially**: Single-user tool. Cognito can be added later using existing config from `analytics.html`.

## Deployment

```
S3 Bucket: screeps-dashboard-788417514918
Path: portal/           (keep existing index.html and analytics.html untouched)
URL:  https://screeps-dashboard-788417514918.s3.amazonaws.com/portal/index.html
```

Deploy script:
```bash
cd portal
npm run build
aws s3 sync dist/ s3://screeps-dashboard-788417514918/portal/ --delete
```

Future: CloudFront distribution with S3 origin for `/` and API Gateway origin for `/api/*` to unify under one domain.

---

## API Surface (Complete Reference)

Base URL: `https://g9gplzbul4.execute-api.us-east-1.amazonaws.com`

### Colonies (real-time, segment 90)
```
GET /colonies                           → ColonySummary[]
GET /colonies/{room}                    → ColonyDetail (live + diagnostics merged)
GET /colonies/{room}/creeps             → CreepRoster
GET /colonies/{room}/economy            → EnergyFlow
GET /colonies/{room}/remotes            → RemoteMiningStatus
```

### Intel (persistent, DynamoDB)
```
GET /intel                              → RoomIntel[] (all scouted rooms)
GET /intel/{room}                       → RoomIntel
GET /intel/enemies                      → RoomIntel[] (hostile owners)
GET /intel/candidates?home={room}       → ScoredCandidate[]
```

### Empire (real-time, segment 90)
```
GET /empire                             → EmpireState
GET /empire/expansion                   → ExpansionStatus
GET /empire/expansion/{room}            → ExpansionDetail
POST /empire/expansion                  → { action, roomName, parentRoom }
```

### Analysis (DynamoDB, AI-generated)
```
GET /analysis/{room}/recommendations    → Recommendation[]
GET /analysis/{room}/signals            → Signal[]
GET /analysis/{room}/signals/events     → SignalEvent[]
GET /analysis/{room}/observations       → Observation[]
GET /analysis/{room}/patterns           → Pattern[]
POST /analysis/{room}/feedback          → { recommendationId, ... }
```

### Metrics (DynamoDB, time-series)
```
GET /metrics/{room}?hours=N             → MetricDataPoint[]
```

### Recordings (DynamoDB + S3)
```
GET /recordings                         → Recording[]
GET /recordings/{id}                    → RecordingDetail
PUT /recordings/{id}                    → UpdateStatus
POST /recordings                        → CreateRecording
GET /recordings/{id}/snapshots          → SnapshotIndex
GET /recordings/{id}/snapshots/{tick}   → Snapshot
GET /recordings/{id}/terrain            → TerrainData
POST /recordings/{id}/analyze           → TriggerAnalysis
GET /recordings/{id}/analysis           → AnalysisSummary
GET /recordings/{id}/analysis/{type}    → AnalysisData (heatmap|oscillation|stuck|roads|bottlenecks)
```

### Debug
```
GET /debug/positions                    → CreepPositions (segment 92)
POST /debug/command                     → { command, shard? }
GET /debug/command?cmd={base64}         → QueueCommand
GET /debug/command/result?requestId=X   → CommandResult
```

### Response Envelope
Every API response includes metadata:
```json
{
  "source": "segment90" | "dynamodb" | "screeps-api",
  "freshness": 45,
  "fetchedAt": 1706900000000,
  "gameTick": 73079180,
  ...data
}
```

---

## Application Structure

```
portal/
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── package.json
├── tsconfig.json
├── src/
│   ├── main.tsx                    # Entry point, router setup
│   ├── App.tsx                     # Layout shell (sidebar + content area)
│   ├── api/
│   │   ├── client.ts              # Base fetch wrapper, error handling, freshness parsing
│   │   ├── colonies.ts            # /colonies endpoints
│   │   ├── intel.ts               # /intel endpoints
│   │   ├── empire.ts              # /empire endpoints
│   │   ├── analysis.ts            # /analysis endpoints
│   │   ├── metrics.ts             # /metrics endpoints
│   │   ├── recordings.ts          # /recordings endpoints
│   │   └── debug.ts               # /debug endpoints
│   ├── hooks/
│   │   ├── useApi.ts              # Generic fetch hook with caching + polling
│   │   ├── useEmpire.ts           # Empire-wide state (colonies list, GCL)
│   │   ├── useColony.ts           # Single colony detail
│   │   └── usePolling.ts          # Configurable polling interval
│   ├── context/
│   │   └── EmpireContext.tsx       # Global: colony list, selected colony, empire state
│   ├── pages/
│   │   ├── EmpireOverview.tsx      # Dashboard landing page
│   │   ├── ColonyDetail.tsx        # Per-colony deep dive
│   │   ├── IntelMap.tsx            # Scouted rooms grid/map
│   │   ├── Advisor.tsx             # AI recommendations, signals, observations
│   │   ├── Recordings.tsx          # Recording list + viewer
│   │   └── Debug.tsx               # Console + positions
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx         # Navigation + colony switcher
│   │   │   ├── Header.tsx          # Breadcrumbs, freshness indicator, empire ticker
│   │   │   └── FreshnessIndicator.tsx  # Shows data age, source
│   │   ├── empire/
│   │   │   ├── ColonyCard.tsx      # Summary card (RCL, energy, threats)
│   │   │   ├── GclProgress.tsx     # GCL bar
│   │   │   └── ExpansionPanel.tsx  # Expansion queue + candidates
│   │   ├── colony/
│   │   │   ├── RclProgress.tsx     # RCL progress bar
│   │   │   ├── EnergyPanel.tsx     # Energy stats + flow
│   │   │   ├── CreepRoster.tsx     # Creeps by role, expandable
│   │   │   ├── RemoteMining.tsx    # Remote room cards
│   │   │   ├── ThreatIndicator.tsx # Threat status badge
│   │   │   └── SpawnQueue.tsx      # Current spawn activity
│   │   ├── metrics/
│   │   │   ├── TimeSeriesChart.tsx # Recharts line chart (energy, CPU, creeps)
│   │   │   ├── CpuGauge.tsx        # CPU usage gauge
│   │   │   └── MetricSelector.tsx  # Timerange + metric picker
│   │   ├── intel/
│   │   │   ├── RoomGrid.tsx        # 2D grid of scouted rooms (like Screeps world map)
│   │   │   ├── RoomCell.tsx        # Individual room tile (owner, sources, mineral)
│   │   │   ├── CandidateList.tsx   # Scored expansion candidates
│   │   │   └── EnemyList.tsx       # Hostile rooms
│   │   ├── advisor/
│   │   │   ├── RecommendationCard.tsx  # Single recommendation with feedback buttons
│   │   │   ├── SignalTimeline.tsx      # Signal events over time
│   │   │   ├── ObservationFeed.tsx     # AI observations feed
│   │   │   ├── PatternList.tsx         # Detected patterns
│   │   │   └── FeedbackButtons.tsx     # Helpful/unhelpful/applied
│   │   ├── recordings/
│   │   │   ├── RecordingList.tsx       # List of recordings with status
│   │   │   ├── RoomCanvas.tsx          # Canvas renderer (port from recording-viewer.html)
│   │   │   ├── PlaybackControls.tsx    # Play/pause/scrub/speed
│   │   │   ├── OverlayToggles.tsx      # Heatmap, oscillations, roads, etc.
│   │   │   └── AnalysisOverlay.tsx     # Analysis results overlaid on canvas
│   │   └── debug/
│   │       ├── CommandConsole.tsx       # Send commands, view results
│   │       └── PositionViewer.tsx      # Creep positions from segment 92
│   └── utils/
│       ├── constants.ts            # API base URL, polling intervals, colors
│       ├── formatting.ts           # Number formatting, time formatting
│       ├── roomCoords.ts           # Screeps room name ↔ grid coordinates
│       └── colors.ts               # Consistent color palette for roles, structures
```

---

## Page Designs

### 1. Empire Overview (`/`)

The landing page. Shows the health of the entire empire at a glance.

**Layout**: Header with GCL progress bar + empire state. Below that, a grid of ColonyCards (one per owned room). Below cards, ExpansionPanel showing active expansions and top candidates.

**Data sources**:
- `GET /empire` → state, GCL, priorities
- `GET /colonies` → all colony summaries
- `GET /empire/expansion` → expansion queue

**Polling**: Every 30 seconds for colonies, every 60 seconds for empire.

**ColonyCard contents**: Room name, RCL + progress bar, energy stored (bar), creep count, threat indicator (green/yellow/red dot), spawn utilization.

### 2. Colony Detail (`/colony/:roomName`)

Deep dive into a single colony. Tabbed or scrollable sections.

**Sections**:
- **Overview**: RCL, energy, storage level, phase
- **Creeps**: Roster grouped by role with body part summary
- **Economy**: Energy income/spend breakdown, storage trends (TimeSeriesChart)
- **Remotes**: Remote mining rooms with hauler/miner status
- **Metrics**: CPU, energy, creep count charts over configurable time range
- **Threats**: Current hostile info, tower status

**Data sources**:
- `GET /colonies/{room}` → everything
- `GET /colonies/{room}/creeps` → detailed roster
- `GET /colonies/{room}/economy` → energy flow
- `GET /colonies/{room}/remotes` → remote status
- `GET /metrics/{room}?hours=24` → time-series

**Polling**: Colony data every 15 seconds. Metrics on-demand (user selects timerange).

### 3. Intel Map (`/intel`)

Grid visualization of scouted rooms, similar to the Screeps world map but showing your intel data.

**Layout**: Left panel with filters (owned/hostile/neutral/unowned, mineral type, source count). Main area is the room grid. Clicking a room shows a detail panel on the right.

**Room grid**: Each cell colored by status — green for owned, red for hostile, yellow for reserved/SK, gray for neutral. Shows mineral icon, source count, owner initial if claimed.

**Expansion candidates**: Toggle to highlight top-scored candidates with ranking overlay. Click to see full scoring breakdown.

**Data sources**:
- `GET /intel` → all rooms
- `GET /intel/enemies` → hostile filter
- `GET /intel/candidates?home={room}` → scored candidates

**Key detail**: Room coordinates parsed from room name to position on grid. E46N37 → grid position (46, -37). The grid should be pannable/zoomable since you're scouting a large area.

### 4. AI Advisor (`/advisor`)

The AI analysis results in a consumable format.

**Layout**: Colony selector at top (tabs or dropdown). Below that, three columns or tabbed sections.

**Recommendations**: Card-based feed sorted by priority. Each card shows category, severity, description, evidence, and feedback buttons (helpful/unhelpful/applied). Cards are color-coded by priority (critical=red, high=orange, medium=yellow, low=blue).

**Signals & Events**: Timeline view showing signal events over time. Clickable to expand details. Shows when energy crashes happened, spawner stalls, threat detections, RCL ups.

**Observations**: AI narrative observations in a feed format. Each observation is a paragraph with timestamp and confidence indicator.

**Patterns**: List of detected patterns with severity, occurrence count, and trend (improving/worsening/stable).

**Data sources**:
- `GET /analysis/{room}/recommendations`
- `GET /analysis/{room}/signals`
- `GET /analysis/{room}/signals/events`
- `GET /analysis/{room}/observations`
- `GET /analysis/{room}/patterns`
- `POST /analysis/{room}/feedback` → on button click

### 5. Recordings (`/recordings`)

Port of the existing recording viewer as a React component.

**Layout**: Left sidebar with recording list (same as current viewer). Main area is the canvas with playback controls below. Right panel for analysis overlays and info.

**Canvas rendering**: Port the existing `render()` function from `recording-viewer.html` into a `RoomCanvas` React component. The canvas logic (terrain rendering, structure/creep drawing, zoom/pan, hover tooltips) stays mostly the same — wrap it in `useEffect` with refs.

**Key porting decisions**:
- Canvas element managed via `useRef`
- All rendering state (zoom, pan, playback index, snapshot cache) in `useReducer`
- Overlay toggles as React state → passed to render function
- Snapshot fetching via the `useApi` hook with batch prefetching
- Analysis data loaded on-demand when overlay is toggled

**Data sources**:
- `GET /recordings` → list
- `GET /recordings/{id}/snapshots` → tick index
- `GET /recordings/{id}/snapshots/{tick}` → individual frame
- `GET /recordings/{id}/terrain` → terrain (cached, doesn't change)
- `GET /recordings/{id}/analysis` → summary
- `GET /recordings/{id}/analysis/{type}` → overlay data

### 6. Debug Console (`/debug`)

Simple but useful.

**Layout**: Two sections side by side. Left: command input with history, result display. Right: creep position visualizer.

**Console**: Text input, send button. Command history (localStorage). Results displayed as formatted JSON or plain text. Supports both POST (body) and GET (base64 query param) modes.

**Position viewer**: Fetches segment 92, renders creep positions on a simplified room grid. Useful for seeing where creeps are clustering.

**Data sources**:
- `POST /debug/command` or `GET /debug/command?cmd=...`
- `GET /debug/command/result?requestId=X`
- `GET /debug/positions`

---

## Shared Patterns

### API Client (`api/client.ts`)

```typescript
const API_BASE = 'https://g9gplzbul4.execute-api.us-east-1.amazonaws.com';

interface ApiResponse<T> {
  data: T;
  source: 'segment90' | 'dynamodb' | 'screeps-api';
  freshness: number;      // seconds since last update
  fetchedAt: number;
  gameTick?: number;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const raw = await res.json();

  // Extract envelope metadata
  const { source, freshness, fetchedAt, gameTick, ...data } = raw;
  return { data: data as T, source, freshness, fetchedAt, gameTick };
}
```

### Polling Hook (`hooks/usePolling.ts`)

```typescript
function usePolling<T>(
  fetcher: () => Promise<ApiResponse<T>>,
  intervalMs: number,
  options?: { enabled?: boolean; onError?: (e: Error) => void }
): { data: T | null; loading: boolean; error: Error | null; freshness: number | null; refetch: () => void }
```

Polls on interval, pauses when tab is not visible (`document.hidden`), auto-retries on error with backoff.

### Freshness Indicator

Every panel that displays API data shows a small indicator: green dot + "12s ago" for fresh data, yellow for >60s, red for >300s. Source shown on hover ("segment90", "dynamodb").

### Room Name Utilities (`utils/roomCoords.ts`)

```typescript
// E46N37 → { x: 46, y: -37 }
function parseRoomName(name: string): { x: number; y: number }

// Calculate grid offset for room grid rendering
function roomToGrid(name: string, origin: string): { col: number; row: number }
```

---

## Color Palette

Consistent with existing dashboard aesthetics (dark theme, green accents).

```
Background:     #111111, #1a1a1a, #222222
Text primary:   #eeeeee
Text secondary: #888888
Accent green:   #00ff88 (energy, positive)
Accent blue:    #4488ff (RCL, info)
Accent yellow:  #ffcc00 (warnings, recording viewer)
Accent red:     #ff4444 (threats, critical)
Accent purple:  #aa88ff (minerals, tech)
Border:         #333333
```

---

## Implementation Phases

### Phase 1: Scaffold + Empire Overview
- Vite + React + Tailwind + React Router setup
- API client with fetch wrapper
- Layout shell (sidebar, header, content area)
- Empire Overview page with ColonyCards
- Deploy to S3, verify it works
- **Estimated effort**: 2-3 hours

### Phase 2: Colony Detail + Metrics
- Colony detail page with all sections
- Recharts integration for time-series
- Creep roster, economy panel, remote mining panel
- Metric selector (timerange)
- **Estimated effort**: 3-4 hours

### Phase 3: Intel Map
- Room grid with pan/zoom
- Room cell rendering with status colors
- Expansion candidate overlay
- Filter panel
- **Estimated effort**: 3-4 hours

### Phase 4: AI Advisor
- Recommendation cards with feedback
- Signal timeline
- Observation feed
- Pattern list
- **Estimated effort**: 2-3 hours

### Phase 5: Recording Viewer
- Port canvas rendering from existing viewer
- React wrapper with refs
- Playback controls
- Analysis overlay integration
- **Estimated effort**: 4-5 hours (most complex port)

### Phase 6: Debug Console
- Command input + history
- Result display
- Position viewer
- **Estimated effort**: 1-2 hours

### Phase 7: Polish
- Loading states, error boundaries
- Responsive sidebar (collapsible)
- Keyboard shortcuts (space for play/pause in recordings)
- Cross-page navigation (click colony in intel map → colony detail)
- **Estimated effort**: 2-3 hours

---

## Decisions & Tradeoffs

**Hash router vs browser router**: Hash router (`/#/colony/E46N37`) avoids needing S3 redirect rules or CloudFront functions for SPA routing. Switch to browser router when CloudFront is added.

**No SSR/SSG**: Single-user tool. No SEO needed. Pure client-side rendering.

**No WebSocket**: The API is REST-only. Polling at 15-30 second intervals matches the game tick rate (every ~3 seconds, but data-collector runs every 5 minutes). WebSocket would be premature.

**Canvas vs SVG for recordings**: Canvas. The existing viewer uses Canvas and it performs well for 50x50 tile grids with dozens of entities. SVG would be slower for the heatmap overlays.

**No component library**: Tailwind utilities are sufficient. A component library like shadcn would add weight for minimal benefit in a personal tool.

**TypeScript**: Yes. The API responses are complex enough that type definitions will save debugging time, especially for the analysis endpoints.
