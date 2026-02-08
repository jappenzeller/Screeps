import { useRef, useEffect, useCallback, useState } from 'react';
import { renderFrame } from './renderFunctions';
import type { OverlayState, AnalysisData } from './renderFunctions';
import type { Snapshot, SnapshotCreep, SnapshotStructure } from '../../types/recordings';
import { getTerrainAt, getTerrainName, parseRole } from '../../utils/recordingConstants';

interface RoomCanvasProps {
  terrain: string | null;
  snapshot: Snapshot | null;
  previousSnapshot: Snapshot | null;
  zoom: number;
  panX: number;
  panY: number;
  hoverTile: { x: number; y: number } | null;
  overlays: OverlayState;
  analysis: AnalysisData;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
  onWheel: (e: React.WheelEvent) => void;
  onDoubleClick: () => void;
  onHoverChange: (tile: { x: number; y: number } | null) => void;
}

const TILE_SIZE = 10;

export function RoomCanvas({
  terrain,
  snapshot,
  previousSnapshot,
  zoom,
  panX,
  panY,
  hoverTile,
  overlays,
  analysis,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onMouseLeave,
  onWheel,
  onDoubleClick,
  onHoverChange,
}: RoomCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Convert client coordinates to tile
  const clientToTile = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      const rect = canvas.getBoundingClientRect();
      const canvasX = clientX - rect.left;
      const canvasY = clientY - rect.top;
      const tileX = Math.floor((canvasX - panX) / (TILE_SIZE * zoom));
      const tileY = Math.floor((canvasY - panY) / (TILE_SIZE * zoom));

      if (tileX >= 0 && tileX < 50 && tileY >= 0 && tileY < 50) {
        return { x: tileX, y: tileY };
      }
      return null;
    },
    [panX, panY, zoom]
  );

  // Render the canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    renderFrame(ctx, width, height, terrain, snapshot, {
      zoom,
      panX,
      panY,
      hoverTile,
      overlays,
      analysis,
      previousSnapshot,
      animationTime: Date.now(),
    });
  }, [terrain, snapshot, previousSnapshot, zoom, panX, panY, hoverTile, overlays, analysis]);

  // Handle resize
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
      }
      render();
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [render]);

  // Animation loop for oscillation overlay
  useEffect(() => {
    const shouldAnimate = overlays.oscillations && analysis.oscillations;

    if (shouldAnimate) {
      const animate = () => {
        render();
        animationRef.current = requestAnimationFrame(animate);
      };
      animationRef.current = requestAnimationFrame(animate);
    } else {
      render();
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [overlays.oscillations, analysis.oscillations, render]);

  // Re-render when data changes
  useEffect(() => {
    if (!overlays.oscillations || !analysis.oscillations) {
      render();
    }
  }, [terrain, snapshot, zoom, panX, panY, hoverTile, overlays, analysis, render]);

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    setDragging(true);
    onMouseDown(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const tile = clientToTile(e.clientX, e.clientY);
    onHoverChange(tile);
    setTooltipPos({ x: e.clientX, y: e.clientY });
    onMouseMove(e);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    setDragging(false);
    onMouseUp(e);
  };

  const handleMouseLeave = () => {
    setDragging(false);
    setTooltipPos(null);
    onHoverChange(null);
    onMouseLeave();
  };

  // Get tooltip content
  const getTooltipContent = (): React.ReactNode => {
    if (!hoverTile) return null;

    const { x, y } = hoverTile;
    const lines: React.ReactNode[] = [];

    // Coordinates
    lines.push(
      <div key="coords" className="font-bold">
        ({x}, {y})
      </div>
    );

    // Terrain
    if (terrain) {
      const terrainType = getTerrainAt(terrain, x, y);
      const terrainName = getTerrainName(terrainType);
      lines.push(
        <div key="terrain" className="text-[#888]">
          Terrain: {terrainName}
        </div>
      );
    }

    // Structures at this tile
    if (snapshot?.structures) {
      const structures = snapshot.structures.filter((s) => s.x === x && s.y === y);
      for (const struct of structures) {
        lines.push(
          <div key={`struct-${struct.structureType}`}>
            {struct.structureType}
            {struct.energy !== undefined && ` (${struct.energy}/${struct.energyCapacity || '?'})`}
          </div>
        );
      }
    }

    // Construction sites
    if (snapshot?.constructionSites) {
      const sites = snapshot.constructionSites.filter((s) => s.x === x && s.y === y);
      for (const site of sites) {
        lines.push(
          <div key={`site-${site.structureType}`} className="text-[#888]">
            Building: {site.structureType}
            {site.progress !== undefined && ` (${site.progress}/${site.progressTotal})`}
          </div>
        );
      }
    }

    // Creeps at this tile
    if (snapshot?.creeps) {
      const creeps = snapshot.creeps.filter((c) => c.x === x && c.y === y);
      for (const creep of creeps) {
        const role = parseRole(creep.name);
        lines.push(
          <div key={`creep-${creep.name}`} className="text-[#00ff88]">
            {creep.name} ({role})
            {creep.hits !== undefined && creep.hitsMax !== undefined && (
              <span className="text-[#888]">
                {' '}
                HP: {creep.hits}/{creep.hitsMax}
              </span>
            )}
          </div>
        );
      }
    }

    // Dropped resources
    if (snapshot?.droppedResources) {
      const resources = snapshot.droppedResources.filter((r) => r.x === x && r.y === y);
      for (const res of resources) {
        lines.push(
          <div key={`res-${res.resourceType}`} className="text-[#ffcc00]">
            {res.resourceType}: {res.amount}
          </div>
        );
      }
    }

    // Heatmap value
    if (overlays.heatmap && analysis.heatmap) {
      const value = analysis.heatmap.total[y]?.[x] || 0;
      if (value > 0) {
        lines.push(
          <div key="heatmap" className="text-[#4488ff]">
            Visits: {value}
          </div>
        );
      }
    }

    return lines;
  };

  const tooltipContent = getTooltipContent();

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className={`w-full h-full ${dragging ? 'cursor-grabbing' : 'cursor-crosshair'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      />

      {/* Tooltip */}
      {tooltipPos && tooltipContent && hoverTile && (
        <div
          className="absolute pointer-events-none bg-[#1a1a1a] border border-[#333] rounded px-2 py-1 text-xs z-10"
          style={{
            left: tooltipPos.x + 15,
            top: tooltipPos.y + 15,
            transform: 'translate(-50%, 0)',
          }}
        >
          {tooltipContent}
        </div>
      )}
    </div>
  );
}

// Helper type exports
export type { SnapshotCreep, SnapshotStructure };
