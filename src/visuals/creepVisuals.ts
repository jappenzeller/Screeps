/**
 * Custom creep visuals - role-specific icons and status indicators
 * Toggle with Memory.settings.showVisuals = false
 */

export function drawCreepVisuals(room: Room): void {
  const visual = room.visual;

  for (const creep of room.find(FIND_MY_CREEPS)) {
    drawBodyCircle(visual, creep);
    drawHealthBar(visual, creep);
    drawStateIndicator(visual, creep);
    drawCarryBar(visual, creep);
  }
}

// Body part colors matching Screeps style
const BODY_COLORS: Record<string, string> = {
  [WORK]: "#ffe56d", // Yellow
  [CARRY]: "#555555", // Gray
  [MOVE]: "#a9b7c6", // Light gray/blue
  [ATTACK]: "#f93842", // Red
  [RANGED_ATTACK]: "#5d80b2", // Blue
  [HEAL]: "#65fd62", // Green
  [TOUGH]: "#ffffff", // White
  [CLAIM]: "#b99cfb", // Purple
};

function drawBodyCircle(visual: RoomVisual, creep: Creep): void {
  const { x, y } = creep.pos;
  const body = creep.body;
  const totalParts = body.length;

  if (totalParts === 0) return;

  const radius = 0.4;
  const centerRadius = 0.15;

  // Count parts by type
  const partCounts: Record<string, number> = {};
  for (const part of body) {
    partCounts[part.type] = (partCounts[part.type] || 0) + 1;
  }

  // Draw segments
  let startAngle = -Math.PI / 2; // Start at top

  for (const [partType, count] of Object.entries(partCounts)) {
    const sweepAngle = (count / totalParts) * Math.PI * 2;
    const endAngle = startAngle + sweepAngle;
    const color = BODY_COLORS[partType] || "#ffffff";

    // Draw arc segment using polygon approximation
    drawArcSegment(visual, x, y, radius, centerRadius, startAngle, endAngle, color);

    startAngle = endAngle;
  }

  // Draw center circle (role indicator)
  const roleColors: Record<string, string> = {
    HARVESTER: "#f9ca24",
    HAULER: "#4ecdc4",
    UPGRADER: "#45b7d1",
    BUILDER: "#e056fd",
    REMOTE_MINER: "#ff6b6b",
    REMOTE_HAULER: "#26de81",
    REMOTE_DEFENDER: "#eb4d4b",
    REMOTE_DEFENDER_RANGED: "#5d80b2",
    RESERVER: "#b99cfb",
    SCOUT: "#778ca3",
    LINK_FILLER: "#20bf6b",
    MINERAL_HARVESTER: "#00d2d3",
    DEFENDER: "#e74c3c",
  };

  const centerColor = roleColors[creep.memory.role] || "#333333";
  visual.circle(x, y, {
    radius: centerRadius,
    fill: centerColor,
    opacity: 0.9,
  });
}

function drawArcSegment(
  visual: RoomVisual,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
  color: string
): void {
  const segments = Math.max(3, Math.ceil(Math.abs(endAngle - startAngle) / 0.3));
  const points: [number, number][] = [];

  // Outer arc
  for (let i = 0; i <= segments; i++) {
    const angle = startAngle + ((endAngle - startAngle) * i) / segments;
    points.push([cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR]);
  }

  // Inner arc (reverse)
  for (let i = segments; i >= 0; i--) {
    const angle = startAngle + ((endAngle - startAngle) * i) / segments;
    points.push([cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR]);
  }

  visual.poly(points, {
    fill: color,
    opacity: 0.85,
    stroke: "#000000",
    strokeWidth: 0.02,
  });
}

function drawHealthBar(visual: RoomVisual, creep: Creep): void {
  if (creep.hits === creep.hitsMax) return; // Don't show if full health

  const { x, y } = creep.pos;
  const healthPct = creep.hits / creep.hitsMax;
  const barWidth = 0.8;
  const barHeight = 0.1;

  // Background (red)
  visual.rect(x - barWidth / 2, y + 0.35, barWidth, barHeight, {
    fill: "#c0392b",
    opacity: 0.8,
  });

  // Health (green to yellow to red based on %)
  const healthColor = healthPct > 0.5 ? "#27ae60" : healthPct > 0.25 ? "#f39c12" : "#c0392b";
  visual.rect(x - barWidth / 2, y + 0.35, barWidth * healthPct, barHeight, {
    fill: healthColor,
    opacity: 0.9,
  });
}

function drawStateIndicator(visual: RoomVisual, creep: Creep): void {
  const { x, y } = creep.pos;
  const state = creep.memory.state;

  if (!state) return;

  // Small state dot
  const stateColors: Record<string, string> = {
    HARVESTING: "#f9ca24",
    COLLECTING: "#4ecdc4",
    DELIVERING: "#26de81",
    UPGRADING: "#45b7d1",
    BUILDING: "#e056fd",
    REPAIRING: "#ff9f43",
    FLEEING: "#eb4d4b",
    RENEWING: "#a55eea",
    TRAVELING: "#778ca3",
    IDLE: "#95a5a6",
  };

  const color = stateColors[state] || "#ffffff";

  visual.circle(x + 0.35, y - 0.35, {
    radius: 0.1,
    fill: color,
    opacity: 0.9,
  });
}

// Energy fill indicator for haulers/carriers
function drawCarryBar(visual: RoomVisual, creep: Creep): void {
  if (creep.store.getCapacity() === 0) return;

  const { x, y } = creep.pos;
  const fillPct = creep.store.getUsedCapacity() / creep.store.getCapacity();

  if (fillPct === 0) return;

  const barWidth = 0.6;
  const barHeight = 0.08;

  // Background
  visual.rect(x - barWidth / 2, y + 0.45, barWidth, barHeight, {
    fill: "#2c3e50",
    opacity: 0.6,
  });

  // Fill (yellow for energy)
  visual.rect(x - barWidth / 2, y + 0.45, barWidth * fillPct, barHeight, {
    fill: "#f1c40f",
    opacity: 0.9,
  });
}

/**
 * Draw room-level stats panel
 */
export function drawRoomStats(room: Room): void {
  const visual = room.visual;

  // Top-left stats panel
  const stats = [
    `Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`,
    `Stored: ${room.storage?.store[RESOURCE_ENERGY] || 0}`,
    `Creeps: ${room.find(FIND_MY_CREEPS).length}`,
    `RCL: ${room.controller?.level} (${Math.floor(((room.controller?.progress || 0) / (room.controller?.progressTotal || 1)) * 100)}%)`,
  ];

  // Background panel
  visual.rect(0.5, 0.5, 8, stats.length * 0.8 + 0.5, {
    fill: "#1a1a2e",
    opacity: 0.7,
    stroke: "#4ecdc4",
    strokeWidth: 0.05,
  });

  stats.forEach((text, i) => {
    visual.text(text, 1, 1.2 + i * 0.8, {
      align: "left",
      font: 0.6,
      color: "#e0e0e0",
    });
  });
}

/**
 * Draw spawn queue progress
 */
export function drawSpawnQueue(room: Room): void {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn?.spawning) return;

  const visual = room.visual;
  const { x, y } = spawn.pos;

  // Spawning name
  visual.text(spawn.spawning.name.split("_")[0], x, y - 1, {
    font: 0.4,
    color: "#4ecdc4",
    opacity: 0.9,
  });

  // Progress bar under spawn
  const progress = 1 - spawn.spawning.remainingTime / spawn.spawning.needTime;
  visual.rect(x - 0.5, y + 0.6, 1, 0.15, {
    fill: "#2c3e50",
    opacity: 0.8,
  });
  visual.rect(x - 0.5, y + 0.6, progress, 0.15, {
    fill: "#4ecdc4",
    opacity: 0.9,
  });
}

/**
 * Draw all room visuals (call from main loop)
 */
export function drawRoomVisuals(room: Room): void {
  drawCreepVisuals(room);
  drawRoomStats(room);
  drawSpawnQueue(room);
}
