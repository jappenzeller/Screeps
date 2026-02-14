/**
 * Scenario Helpers - Utility functions for building scenarios
 *
 * Provides:
 * - Structure placement helpers
 * - Body templates
 * - Room layout generators
 */

import { StructurePlacement, Position } from "../types";
import {
  BodyPartType,
  StructureType,
  STRUCTURE_EXTENSION,
  STRUCTURE_RAMPART,
  STRUCTURE_ROAD,
  STRUCTURE_WALL,
  WORK,
  CARRY,
  MOVE,
  ATTACK,
  RANGED_ATTACK,
  HEAL,
  TOUGH,
  CLAIM,
} from "../constants";

// ============================================
// Extension Cluster Generators
// ============================================

/**
 * Generate an extension cluster around a center point
 * Uses a 5x5 pattern minus the center
 */
export function generateExtensionCluster(
  centerX: number,
  centerY: number,
  count: number,
  owner: string
): StructurePlacement[] {
  const extensions: StructurePlacement[] = [];
  const offsets = [
    [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
    [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1],
    [-2, 0], [-1, 0], /* center */ [1, 0], [2, 0],
    [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1],
    [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2],
  ];

  for (let i = 0; i < Math.min(count, offsets.length); i++) {
    const [dx, dy] = offsets[i];
    extensions.push({
      type: STRUCTURE_EXTENSION as StructureType,
      x: centerX + dx,
      y: centerY + dy,
      owner,
    });
  }

  return extensions;
}

/**
 * Generate a compact extension flower pattern
 * More efficient for RCL 7-8
 */
export function generateExtensionFlower(
  centerX: number,
  centerY: number,
  count: number,
  owner: string
): StructurePlacement[] {
  const extensions: StructurePlacement[] = [];
  const offsets = [
    // Inner ring (8 positions)
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], /* center */ [1, 0],
    [-1, 1], [0, 1], [1, 1],
    // Outer ring (16 positions)
    [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
    [-2, -1], [2, -1],
    [-2, 0], [2, 0],
    [-2, 1], [2, 1],
    [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2],
  ];

  for (let i = 0; i < Math.min(count, offsets.length); i++) {
    const [dx, dy] = offsets[i];
    extensions.push({
      type: STRUCTURE_EXTENSION as StructureType,
      x: centerX + dx,
      y: centerY + dy,
      owner,
    });
  }

  return extensions;
}

// ============================================
// Rampart/Wall Generators
// ============================================

/**
 * Generate ramparts around a perimeter
 */
export function generateRampartPerimeter(
  x: number,
  y: number,
  width: number,
  height: number,
  owner: string,
  hits = 100000
): StructurePlacement[] {
  const ramparts: StructurePlacement[] = [];

  // Top and bottom edges
  for (let dx = 0; dx < width; dx++) {
    ramparts.push({
      type: STRUCTURE_RAMPART as StructureType,
      x: x + dx,
      y: y,
      owner,
      hits,
    });
    ramparts.push({
      type: STRUCTURE_RAMPART as StructureType,
      x: x + dx,
      y: y + height - 1,
      owner,
      hits,
    });
  }

  // Left and right edges (excluding corners)
  for (let dy = 1; dy < height - 1; dy++) {
    ramparts.push({
      type: STRUCTURE_RAMPART as StructureType,
      x: x,
      y: y + dy,
      owner,
      hits,
    });
    ramparts.push({
      type: STRUCTURE_RAMPART as StructureType,
      x: x + width - 1,
      y: y + dy,
      owner,
      hits,
    });
  }

  return ramparts;
}

/**
 * Generate ramparts over specific positions (for protecting structures)
 */
export function generateRampartsOver(
  positions: Position[],
  owner: string,
  hits = 100000
): StructurePlacement[] {
  return positions.map((pos) => ({
    type: STRUCTURE_RAMPART as StructureType,
    x: pos.x,
    y: pos.y,
    owner,
    hits,
  }));
}

/**
 * Generate constructed walls for a perimeter
 */
export function generateWallPerimeter(
  x: number,
  y: number,
  width: number,
  height: number,
  hits = 100000
): StructurePlacement[] {
  const walls: StructurePlacement[] = [];

  for (let dx = 0; dx < width; dx++) {
    walls.push({ type: STRUCTURE_WALL as StructureType, x: x + dx, y: y, hits });
    walls.push({ type: STRUCTURE_WALL as StructureType, x: x + dx, y: y + height - 1, hits });
  }

  for (let dy = 1; dy < height - 1; dy++) {
    walls.push({ type: STRUCTURE_WALL as StructureType, x: x, y: y + dy, hits });
    walls.push({ type: STRUCTURE_WALL as StructureType, x: x + width - 1, y: y + dy, hits });
  }

  return walls;
}

// ============================================
// Road Generators
// ============================================

/**
 * Generate a straight road path between two points
 */
export function generateRoadPath(from: Position, to: Position): StructurePlacement[] {
  const roads: StructurePlacement[] = [];
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);

  // Move horizontally first
  let x = from.x;
  while (x !== to.x) {
    roads.push({ type: STRUCTURE_ROAD as StructureType, x, y: from.y });
    x += dx;
  }

  // Then vertically
  let y = from.y;
  while (y !== to.y) {
    roads.push({ type: STRUCTURE_ROAD as StructureType, x: to.x, y });
    y += dy;
  }

  // Final position
  roads.push({ type: STRUCTURE_ROAD as StructureType, x: to.x, y: to.y });

  return roads;
}

/**
 * Generate roads around a structure position (for access)
 */
export function generateRoadsAround(centerX: number, centerY: number): StructurePlacement[] {
  const roads: StructurePlacement[] = [];
  const offsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], /* center */ [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];

  for (const [dx, dy] of offsets) {
    roads.push({
      type: STRUCTURE_ROAD as StructureType,
      x: centerX + dx,
      y: centerY + dy,
    });
  }

  return roads;
}

// ============================================
// Body Templates
// ============================================

/**
 * Standard harvester bodies by RCL
 */
export const HARVESTER_BODIES: Record<number, BodyPartType[]> = {
  1: [WORK, CARRY, MOVE],
  2: [WORK, WORK, CARRY, MOVE],
  3: [WORK, WORK, WORK, CARRY, MOVE, MOVE],
  4: [WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE],
  5: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE],
  6: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE],
  7: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE],
  8: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE],
};

/**
 * Standard hauler bodies by RCL
 */
export const HAULER_BODIES: Record<number, BodyPartType[]> = {
  1: [CARRY, MOVE],
  2: [CARRY, CARRY, MOVE, MOVE],
  3: [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
  4: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  5: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  6: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  7: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  8: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
};

/**
 * Standard upgrader bodies by RCL
 */
export const UPGRADER_BODIES: Record<number, BodyPartType[]> = {
  1: [WORK, CARRY, MOVE],
  2: [WORK, WORK, CARRY, MOVE],
  3: [WORK, WORK, WORK, CARRY, MOVE, MOVE],
  4: [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
  5: [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
  6: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
  7: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  8: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
};

/**
 * Defender bodies by threat level
 */
export const DEFENDER_BODIES = {
  light: [TOUGH, TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  medium: [TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  heavy: [TOUGH, TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
};

/**
 * Invader bodies
 */
export const INVADER_BODIES = {
  melee: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  ranged: [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
  healer: [TOUGH, TOUGH, HEAL, HEAL, MOVE, MOVE, MOVE, MOVE] as BodyPartType[],
};

/**
 * Claimer body
 */
export const CLAIMER_BODY: BodyPartType[] = [CLAIM, MOVE];

// ============================================
// Energy Capacity Helpers
// ============================================

/**
 * Calculate energy capacity at a given RCL
 */
export function energyCapacityAtRCL(rcl: number): number {
  const spawnEnergy = 300;
  const extensionCount = [0, 0, 5, 10, 20, 30, 40, 50, 60][rcl] || 0;
  const extensionCapacity = rcl >= 8 ? 200 : rcl >= 7 ? 100 : 50;
  return spawnEnergy + extensionCount * extensionCapacity;
}

/**
 * Calculate total extension count at RCL
 */
export function extensionCountAtRCL(rcl: number): number {
  return [0, 0, 5, 10, 20, 30, 40, 50, 60][rcl] || 0;
}

// ============================================
// Position Helpers
// ============================================

/**
 * Get adjacent positions (8 directions)
 */
export function getAdjacentPositions(x: number, y: number): Position[] {
  return [
    { x: x - 1, y: y - 1 },
    { x: x, y: y - 1 },
    { x: x + 1, y: y - 1 },
    { x: x - 1, y: y },
    { x: x + 1, y: y },
    { x: x - 1, y: y + 1 },
    { x: x, y: y + 1 },
    { x: x + 1, y: y + 1 },
  ];
}

/**
 * Check if a position is within room bounds
 */
export function isValidPosition(x: number, y: number): boolean {
  return x >= 0 && x <= 49 && y >= 0 && y <= 49;
}

/**
 * Check if a position is on the room edge
 */
export function isEdgePosition(x: number, y: number): boolean {
  return x === 0 || x === 49 || y === 0 || y === 49;
}
