import type { RoomCoords, GridBounds } from '../types/intel';

/**
 * Parse a Screeps room name into world coordinates.
 * E.g., "W10N5" -> { wx: -10, wy: -5 }
 * E.g., "E5S10" -> { wx: 5, wy: 10 }
 */
export function parseRoomName(roomName: string): RoomCoords | null {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;

  const [, we, xStr, ns, yStr] = match;
  const x = parseInt(xStr, 10);
  const y = parseInt(yStr, 10);

  return {
    wx: we === 'W' ? -(x + 1) : x,
    wy: ns === 'N' ? -(y + 1) : y,
  };
}

/**
 * Convert world coordinates back to a room name.
 * E.g., { wx: -10, wy: -5 } -> "W9N4"
 */
export function coordsToRoomName(coords: RoomCoords): string {
  const we = coords.wx < 0 ? 'W' : 'E';
  const ns = coords.wy < 0 ? 'N' : 'S';
  const x = coords.wx < 0 ? Math.abs(coords.wx) - 1 : coords.wx;
  const y = coords.wy < 0 ? Math.abs(coords.wy) - 1 : coords.wy;
  return `${we}${x}${ns}${y}`;
}

/**
 * Get the bounds of a set of rooms for determining grid size.
 */
export function getRoomBounds(roomNames: string[]): GridBounds | null {
  if (roomNames.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const name of roomNames) {
    const coords = parseRoomName(name);
    if (!coords) continue;

    minX = Math.min(minX, coords.wx);
    maxX = Math.max(maxX, coords.wx);
    minY = Math.min(minY, coords.wy);
    maxY = Math.max(maxY, coords.wy);
  }

  if (!isFinite(minX)) return null;

  return { minX, maxX, minY, maxY };
}

/**
 * Convert world coordinates to grid position (0-indexed from top-left).
 */
export function coordsToGrid(coords: RoomCoords, bounds: GridBounds): { gx: number; gy: number } {
  return {
    gx: coords.wx - bounds.minX,
    gy: coords.wy - bounds.minY,
  };
}

/**
 * Convert grid position back to world coordinates.
 */
export function gridToCoords(gx: number, gy: number, bounds: GridBounds): RoomCoords {
  return {
    wx: gx + bounds.minX,
    wy: gy + bounds.minY,
  };
}

/**
 * Calculate distance between two rooms (Chebyshev distance).
 */
export function roomDistance(room1: string, room2: string): number | null {
  const coords1 = parseRoomName(room1);
  const coords2 = parseRoomName(room2);
  if (!coords1 || !coords2) return null;

  return Math.max(
    Math.abs(coords1.wx - coords2.wx),
    Math.abs(coords1.wy - coords2.wy)
  );
}

/**
 * Get the room type based on coordinates.
 * - Highway: x % 10 === 0 || y % 10 === 0
 * - Highway intersection: both are multiples of 10
 * - Source keeper: within 4 of a highway intersection (but not on highway)
 * - Center: x % 10 === 5 && y % 10 === 5 (sector center)
 * - Normal: everything else
 */
export function getRoomType(roomName: string): 'normal' | 'sourceKeeper' | 'center' | 'highway' | 'highwayIntersection' {
  const coords = parseRoomName(roomName);
  if (!coords) return 'normal';

  // Convert to sector-relative coordinates (0-9)
  const sectorX = ((coords.wx % 10) + 10) % 10;
  const sectorY = ((coords.wy % 10) + 10) % 10;

  // Highway intersection (corners of sectors)
  if (sectorX === 0 && sectorY === 0) return 'highwayIntersection';

  // Highway (edges of sectors)
  if (sectorX === 0 || sectorY === 0) return 'highway';

  // Center room
  if (sectorX === 5 && sectorY === 5) return 'center';

  // Source keeper rooms (within range 4 of center, but not center itself)
  const distToCenter = Math.max(Math.abs(sectorX - 5), Math.abs(sectorY - 5));
  if (distToCenter <= 2 && distToCenter > 0) return 'sourceKeeper';

  return 'normal';
}

/**
 * Get all room names within a bounds.
 */
export function getRoomsInBounds(bounds: GridBounds): string[] {
  const rooms: string[] = [];
  for (let wy = bounds.minY; wy <= bounds.maxY; wy++) {
    for (let wx = bounds.minX; wx <= bounds.maxX; wx++) {
      rooms.push(coordsToRoomName({ wx, wy }));
    }
  }
  return rooms;
}

/**
 * Expand bounds by a margin.
 */
export function expandBounds(bounds: GridBounds, margin: number): GridBounds {
  return {
    minX: bounds.minX - margin,
    maxX: bounds.maxX + margin,
    minY: bounds.minY - margin,
    maxY: bounds.maxY + margin,
  };
}

/**
 * Get the sector name for a room (e.g., "W10N0" -> "W1N0").
 */
export function getSectorName(roomName: string): string | null {
  const coords = parseRoomName(roomName);
  if (!coords) return null;

  const sectorX = Math.floor(Math.abs(coords.wx) / 10);
  const sectorY = Math.floor(Math.abs(coords.wy) / 10);
  const we = coords.wx < 0 ? 'W' : 'E';
  const ns = coords.wy < 0 ? 'N' : 'S';

  return `${we}${sectorX}${ns}${sectorY}`;
}
