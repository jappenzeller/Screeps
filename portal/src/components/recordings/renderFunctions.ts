import type {
  Snapshot,
  HeatmapData,
  OscillationData,
  StuckData,
  RoadData,
  BottleneckData,
} from '../../types/recordings';
import {
  TERRAIN_COLORS,
  STRUCTURE_COLORS,
  RECORDING_ROLE_COLORS,
  parseRole,
  heatmapColor,
  getTerrainAt,
} from '../../utils/recordingConstants';

export interface OverlayState {
  terrain: boolean;
  structures: boolean;
  creeps: boolean;
  heatmap: boolean;
  oscillations: boolean;
  roads: boolean;
  bottlenecks: boolean;
  stuck: boolean;
}

export interface AnalysisData {
  heatmap?: HeatmapData | null;
  oscillations?: OscillationData | null;
  stuck?: StuckData | null;
  roads?: RoadData | null;
  bottlenecks?: BottleneckData | null;
}

export interface RenderOptions {
  zoom: number;
  panX: number;
  panY: number;
  hoverTile: { x: number; y: number } | null;
  overlays: OverlayState;
  analysis: AnalysisData;
  previousSnapshot: Snapshot | null;
  animationTime: number;
  myUsername?: string;
}

const TILE_SIZE = 10;

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  terrain: string | null,
  snapshot: Snapshot | null,
  options: RenderOptions
): void {
  const { zoom, panX, panY, overlays, analysis, hoverTile } = options;

  // Clear
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Apply zoom and pan
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // Layer order: terrain, structures, creeps, overlays
  if (overlays.terrain && terrain) {
    renderTerrain(ctx, terrain);
  }

  if (snapshot) {
    if (overlays.structures) {
      renderStructures(ctx, snapshot);
    }
    if (overlays.creeps) {
      renderCreeps(ctx, snapshot, options.previousSnapshot, options.myUsername);
    }
  }

  // Analysis overlays
  if (analysis) {
    if (overlays.heatmap && analysis.heatmap) {
      renderHeatmap(ctx, terrain, analysis.heatmap);
    }
    if (overlays.roads && analysis.roads) {
      renderRoadSuggestions(ctx, analysis.roads);
    }
    if (overlays.oscillations && analysis.oscillations) {
      renderOscillations(ctx, analysis.oscillations, options.animationTime);
    }
    if (overlays.stuck && analysis.stuck) {
      renderStuckEvents(ctx, analysis.stuck);
    }
    if (overlays.bottlenecks && analysis.bottlenecks) {
      renderBottlenecks(ctx, analysis.bottlenecks);
    }
  }

  // Hover highlight
  if (hoverTile) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(hoverTile.x * TILE_SIZE, hoverTile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  }

  ctx.restore();
}

function renderTerrain(ctx: CanvasRenderingContext2D, terrain: string): void {
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const terrainType = getTerrainAt(terrain, x, y);
      ctx.fillStyle = TERRAIN_COLORS[terrainType] || TERRAIN_COLORS[0];
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
}

function renderStructures(ctx: CanvasRenderingContext2D, snapshot: Snapshot): void {
  const structures = snapshot.structures || [];
  const constructionSites = snapshot.constructionSites || [];
  const droppedResources = snapshot.droppedResources || [];
  const sources = snapshot.sources || [];
  const minerals = snapshot.minerals || [];

  // Render sources
  for (const source of sources) {
    const cx = source.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = source.y * TILE_SIZE + TILE_SIZE / 2;
    ctx.fillStyle = '#ffff00';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Render minerals
  for (const mineral of minerals) {
    const cx = mineral.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = mineral.y * TILE_SIZE + TILE_SIZE / 2;
    ctx.fillStyle = '#aa44ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pass 1: Roads (small circles)
  for (const struct of structures) {
    if (struct.structureType === 'road') {
      const cx = struct.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = struct.y * TILE_SIZE + TILE_SIZE / 2;
      ctx.fillStyle = STRUCTURE_COLORS.road;
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Pass 2: Ramparts (semi-transparent overlay)
  for (const struct of structures) {
    if (struct.structureType === 'rampart') {
      ctx.fillStyle = 'rgba(68, 255, 68, 0.3)';
      ctx.fillRect(struct.x * TILE_SIZE, struct.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  // Pass 3: Other structures
  for (const struct of structures) {
    if (struct.structureType === 'road' || struct.structureType === 'rampart') continue;

    const color = STRUCTURE_COLORS[struct.structureType] || '#888888';
    const size = struct.structureType === 'extension' ? 6 : 8;
    const offset = (TILE_SIZE - size) / 2;

    ctx.fillStyle = color;
    ctx.fillRect(
      struct.x * TILE_SIZE + offset,
      struct.y * TILE_SIZE + offset,
      size,
      size
    );
  }

  // Construction sites (dashed outline)
  ctx.setLineDash([2, 2]);
  for (const site of constructionSites) {
    const color = STRUCTURE_COLORS[site.structureType] || '#888888';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      site.x * TILE_SIZE + 1,
      site.y * TILE_SIZE + 1,
      TILE_SIZE - 2,
      TILE_SIZE - 2
    );
  }
  ctx.setLineDash([]);

  // Dropped resources
  for (const resource of droppedResources) {
    const cx = resource.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = resource.y * TILE_SIZE + TILE_SIZE / 2;
    ctx.fillStyle = resource.resourceType === 'energy' ? '#ffff00' : '#888888';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderCreeps(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  previousSnapshot: Snapshot | null,
  myUsername?: string
): void {
  const creeps = snapshot.creeps || [];
  const prevCreepMap = new Map<string, { x: number; y: number }>();

  if (previousSnapshot?.creeps) {
    for (const creep of previousSnapshot.creeps) {
      prevCreepMap.set(creep.name, { x: creep.x, y: creep.y });
    }
  }

  for (const creep of creeps) {
    const role = parseRole(creep.name);
    const isHostile = creep.owner && myUsername && creep.owner !== myUsername;
    const color = isHostile ? '#ff0000' : (RECORDING_ROLE_COLORS[role] || RECORDING_ROLE_COLORS.UNKNOWN);

    const cx = creep.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = creep.y * TILE_SIZE + TILE_SIZE / 2;

    // Draw creep circle
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Draw direction indicator if moved
    const prevPos = prevCreepMap.get(creep.name);
    if (prevPos && (prevPos.x !== creep.x || prevPos.y !== creep.y)) {
      const dx = creep.x - prevPos.x;
      const dy = creep.y - prevPos.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        const ndx = dx / len;
        const ndy = dy / len;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + ndx * 6, cy + ndy * 6);
        ctx.stroke();
      }
    }
  }
}

function renderHeatmap(
  ctx: CanvasRenderingContext2D,
  terrain: string | null,
  heatmap: HeatmapData
): void {
  const maxValue = heatmap.maxValue || 1;
  const total = heatmap.total;

  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      // Skip walls
      if (terrain) {
        const terrainType = getTerrainAt(terrain, x, y);
        if (terrainType === 1 || terrainType === 3) continue;
      }

      const value = total[y]?.[x] || 0;
      if (value === 0) continue;

      const normalized = value / maxValue;
      ctx.fillStyle = heatmapColor(normalized);
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
}

function renderRoadSuggestions(ctx: CanvasRenderingContext2D, roads: RoadData): void {
  const suggestions = roads.suggestions || [];
  const maxSuggestions = suggestions.length;

  ctx.setLineDash([3, 3]);
  for (let i = 0; i < suggestions.length; i++) {
    const road = suggestions[i];
    const opacity = 1 - (i / maxSuggestions) * 0.7;

    ctx.strokeStyle = `rgba(68, 255, 68, ${opacity})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      road.x * TILE_SIZE + 1,
      road.y * TILE_SIZE + 1,
      TILE_SIZE - 2,
      TILE_SIZE - 2
    );

    // Priority number
    ctx.fillStyle = `rgba(68, 255, 68, ${opacity})`;
    ctx.font = '6px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      String(i + 1),
      road.x * TILE_SIZE + TILE_SIZE / 2,
      road.y * TILE_SIZE + TILE_SIZE / 2
    );
  }
  ctx.setLineDash([]);
}

function renderOscillations(
  ctx: CanvasRenderingContext2D,
  oscillations: OscillationData,
  animationTime: number
): void {
  const hotspots = oscillations.hotspots || [];

  for (const hotspot of hotspots) {
    const cx = hotspot.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = hotspot.y * TILE_SIZE + TILE_SIZE / 2;

    // Pulsing animation
    const pulse = Math.sin(animationTime / 200) * 0.5 + 0.5;
    const radius = 6 + pulse * 4;

    ctx.strokeStyle = 'rgba(255, 136, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function renderStuckEvents(ctx: CanvasRenderingContext2D, stuck: StuckData): void {
  const hotspots = stuck.hotspots || [];

  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = 2;

  for (const hotspot of hotspots) {
    const x = hotspot.x * TILE_SIZE;
    const y = hotspot.y * TILE_SIZE;

    // Draw X
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 2);
    ctx.lineTo(x + TILE_SIZE - 2, y + TILE_SIZE - 2);
    ctx.moveTo(x + TILE_SIZE - 2, y + 2);
    ctx.lineTo(x + 2, y + TILE_SIZE - 2);
    ctx.stroke();
  }
}

function renderBottlenecks(ctx: CanvasRenderingContext2D, bottlenecks: BottleneckData): void {
  const tiles = bottlenecks.tiles || [];

  for (const tile of tiles) {
    const opacity = Math.min(tile.concurrentTicks / 50, 1);

    ctx.strokeStyle = `rgba(255, 68, 68, ${opacity})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      tile.x * TILE_SIZE + 1,
      tile.y * TILE_SIZE + 1,
      TILE_SIZE - 2,
      TILE_SIZE - 2
    );

    // Exclamation mark
    ctx.fillStyle = `rgba(255, 68, 68, ${opacity})`;
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      '!',
      tile.x * TILE_SIZE + TILE_SIZE / 2,
      tile.y * TILE_SIZE + TILE_SIZE / 2
    );
  }
}
