# Screeps AI Advisor - API Reference

## Base URL
```
https://dossn1w7n5.execute-api.us-east-1.amazonaws.com
```

## Endpoints for Claude

Claude can fetch these URLs directly when provided in conversation or referenced from project knowledge.

### Live Data (Real-time)
**URL:** `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/live/E46N37`

Returns real-time colony data read directly from game memory segment 90.
- Includes full colony export: energy, creeps, threats, traffic, remote mining, scouting
- Use for current state queries
- ~200-500ms latency (Screeps API call)
- Has `"live": true` flag in response

**URL (all colonies):** `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/live`

### Colony Summary (0-5 min cached)
**URL:** `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/summary/E46N37`

Returns colony snapshot from DynamoDB (updated every 5 minutes by data-collector).
Includes:
- RCL progress
- Energy levels (available, capacity, stored)
- Creep counts by role
- Threat status
- CPU usage
- Active recommendations count

### Recommendations
**URL:** `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/recommendations/E46N37`

Returns AI-generated recommendations with:
- Priority level
- Category
- Description
- Supporting evidence

### Metric History
**URL:** `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/metrics/E46N37?hours=24`

Returns time-series data for colony metrics over specified time range.
- Default: 24 hours
- Configurable via `?hours=N` parameter

### Dashboard (HTML)
**URL:** `https://screeps-dashboard-488218643044.s3.amazonaws.com/index.html`

Static HTML dashboard (requires JavaScript - Claude can fetch but not render)

### Analytics Dashboard (HTML)
**URL:** `https://screeps-dashboard-488218643044.s3.amazonaws.com/analytics.html`

QuickSight embedded dashboard with Cognito auth (requires JavaScript)

---

## Usage in Conversation

When asking Claude to check colony status, simply say:
- "Check my colony status"
- "What's the current state of E46N37?"
- "Any recommendations for my colony?"

Claude will fetch the appropriate endpoint and analyze the results.

## Adding New Rooms

When expanding to new rooms, add their endpoints here:
- `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/summary/{roomName}`
- `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/recommendations/{roomName}`
- `https://dossn1w7n5.execute-api.us-east-1.amazonaws.com/metrics/{roomName}`

---

## Future Endpoints to Add

These would enhance Claude's monitoring capabilities:

### Traffic Data
`GET /traffic/{roomName}` - Export current traffic heatmap and hotspots

### Events
`GET /events/{roomName}?hours=24` - Recent colony events (deaths, spawns, attacks)

### Code Snapshot
`GET /code/current` - Current deployed code version/hash for reference

### Memory Segment
`GET /memory/{roomName}/{segment}` - Direct memory segment access
