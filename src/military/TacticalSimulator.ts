/**
 * Tactical Simulator
 *
 * Pure functions for simulating combat outcomes BEFORE committing resources.
 * These functions can be run from console, tests, or AWS Lambda.
 *
 * Key insight: Run simulations before spawning to validate attack strategies.
 *
 * Usage:
 *   military.simulate("E44N39")   — Full strategy comparison
 *   military.simApproach("E43N39", 3)  — Simulate wave from specific room
 */

// ============================================
// Types
// ============================================

export interface TowerData {
  x: number;
  y: number;
  energy: number;
}

export interface ApproachParams {
  entryX: number;
  entryY: number;
  targetX: number;
  targetY: number;
  towers: TowerData[];
  creepHP: number;
  healPerTick?: number;     // HPS from escort
}

export interface ApproachResult {
  survived: boolean;
  hpRemaining: number;
  ticksToTarget: number;
  totalDamageTaken: number;
  damageByTick: number[];
  deathTick: number | null;
  path: { x: number; y: number }[];
}

export interface WaveParams {
  waveSize: number;
  entryX: number;
  entryY: number;
  targetX: number;
  targetY: number;
  towers: TowerData[];
  creepHP: number;
  staggerTicks?: number;    // Ticks between creep entries (default 0 = same tick)
}

export interface WaveResult {
  survivorsAtTarget: number;
  totalCreeps: number;
  survivalRate: number;
  totalDamageTaken: number;
  towerShotsTotal: number;
  creepResults: ApproachResult[];
}

export interface StrategySimulation {
  name: string;
  approach: string;
  entryEdge: "north" | "south" | "east" | "west";
  survivalRate: number;
  costPerWave: number;
  estimatedWavesNeeded: number;
  estimatedTotalCost: number;
  estimatedDurationTicks: number;
  risk: "IMPOSSIBLE" | "HIGH" | "MEDIUM" | "LOW";
  viable: boolean;
  details: WaveResult | ApproachResult;
}

export interface CampaignEstimate {
  targetRoom: string;
  controllerTimer: number;
  controllerRCL: number;
  cyclesNeeded: number;
  attacksPerCycle: number;
  totalAttacksNeeded: number;
  safeModeCharges: number;
  safeModeDelayTicks: number;
  estimatedTotalTicks: number;
  estimatedHours: number;
}

export interface TargetIntel {
  roomName: string;
  controllerPos: { x: number; y: number };
  controllerRCL: number;
  controllerTimer: number;
  towers: TowerData[];
  owner: string;
  safeModeCharges?: number;
}

// ============================================
// Core Damage Calculations (Pure Functions)
// ============================================

/**
 * Calculate tower damage at a given range.
 * Screeps tower damage formula:
 *   - Range 0-5: 600 damage
 *   - Range 6-19: Linear falloff (600 at 5, 150 at 20)
 *   - Range 20+: 150 damage
 *
 * Formula: damage = 600 - 30 * (range - 5) for range 5-20
 */
export function towerDamageAtRange(range: number): number {
  if (range <= 5) return 600;
  if (range >= 20) return 150;
  return 600 - 30 * (range - 5);
}

/**
 * Calculate total tower damage at a position from all towers.
 */
export function calcTowerDamageAtPos(
  x: number,
  y: number,
  towers: TowerData[]
): number {
  var totalDamage = 0;

  for (var i = 0; i < towers.length; i++) {
    var t = towers[i];
    if (t.energy <= 0) continue;

    // Chebyshev distance (Screeps uses this for tower range)
    var range = Math.max(Math.abs(x - t.x), Math.abs(y - t.y));
    totalDamage += towerDamageAtRange(range);
  }

  return totalDamage;
}

/**
 * Calculate Chebyshev distance (max of dx, dy).
 * This is the movement cost in Screeps.
 */
export function chebyshevDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
}

/**
 * Generate a simple path from entry to target.
 * Uses diagonal movement toward target (greedy).
 * For accurate simulation, use pre-computed PathFinder paths.
 */
export function generateSimplePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): { x: number; y: number }[] {
  var path: { x: number; y: number }[] = [];
  var x = startX;
  var y = startY;

  while (x !== endX || y !== endY) {
    path.push({ x: x, y: y });

    // Move toward target (one step in each axis if needed)
    if (x < endX) x++;
    else if (x > endX) x--;

    if (y < endY) y++;
    else if (y > endY) y--;
  }

  // Add final position
  path.push({ x: endX, y: endY });

  return path;
}

// ============================================
// Approach Simulation (Single Creep)
// ============================================

/**
 * Simulate a single creep approaching from entry to target.
 * Returns survival status, HP remaining, and damage taken per tick.
 *
 * This is a PURE FUNCTION - no game state dependency.
 */
export function simulateApproach(params: ApproachParams): ApproachResult {
  var hp = params.creepHP;
  var healPerTick = params.healPerTick || 0;
  var damageByTick: number[] = [];
  var totalDamageTaken = 0;

  // Generate path
  var path = generateSimplePath(
    params.entryX,
    params.entryY,
    params.targetX,
    params.targetY
  );

  // Simulate each tick of movement
  for (var tick = 0; tick < path.length; tick++) {
    var pos = path[tick];

    // Calculate tower damage at this position
    var damage = calcTowerDamageAtPos(pos.x, pos.y, params.towers);

    // Apply healing (if any)
    var netDamage = Math.max(0, damage - healPerTick);

    hp -= netDamage;
    damageByTick.push(netDamage);
    totalDamageTaken += netDamage;

    // Check death
    if (hp <= 0) {
      return {
        survived: false,
        hpRemaining: 0,
        ticksToTarget: tick,
        totalDamageTaken: totalDamageTaken,
        damageByTick: damageByTick,
        deathTick: tick,
        path: path.slice(0, tick + 1),
      };
    }
  }

  return {
    survived: true,
    hpRemaining: hp,
    ticksToTarget: path.length,
    totalDamageTaken: totalDamageTaken,
    damageByTick: damageByTick,
    deathTick: null,
    path: path,
  };
}

// ============================================
// Wave Simulation (Multiple Creeps)
// ============================================

/**
 * Simulate a wave of creeps approaching simultaneously.
 *
 * Tower targeting logic (simplified):
 * - Towers fire once per tick
 * - Each tower targets one creep (closest, or random if equidistant)
 * - When multiple creeps are equidistant, damage is distributed
 *
 * This simulation uses a pessimistic model where towers focus-fire
 * (worst case). In reality, tower targeting may be more favorable.
 */
export function simulateWave(params: WaveParams): WaveResult {
  var waveSize = params.waveSize;
  var staggerTicks = params.staggerTicks || 0;
  var creepResults: ApproachResult[] = [];
  var survivors = 0;
  var totalDamage = 0;

  if (staggerTicks === 0) {
    // Simultaneous entry - towers split fire
    return simulateWaveSimultaneous(params);
  }

  // Staggered entry - simulate each creep independently (pessimistic)
  for (var i = 0; i < waveSize; i++) {
    var result = simulateApproach({
      entryX: params.entryX,
      entryY: params.entryY,
      targetX: params.targetX,
      targetY: params.targetY,
      towers: params.towers,
      creepHP: params.creepHP,
    });

    creepResults.push(result);
    totalDamage += result.totalDamageTaken;
    if (result.survived) survivors++;
  }

  return {
    survivorsAtTarget: survivors,
    totalCreeps: waveSize,
    survivalRate: survivors / waveSize,
    totalDamageTaken: totalDamage,
    towerShotsTotal: Math.ceil(totalDamage / 300),
    creepResults: creepResults,
  };
}

/**
 * Simulate wave entering simultaneously (same tick).
 * Tower fire is distributed across creeps.
 */
function simulateWaveSimultaneous(params: WaveParams): WaveResult {
  var waveSize = params.waveSize;
  var creepHP = params.creepHP;
  var towers = params.towers;

  // Generate shared path
  var path = generateSimplePath(
    params.entryX,
    params.entryY,
    params.targetX,
    params.targetY
  );

  // Track each creep's HP
  var creepHPs: number[] = [];
  for (var i = 0; i < waveSize; i++) {
    creepHPs.push(creepHP);
  }

  var aliveCount = waveSize;
  var totalDamage = 0;
  var creepResults: ApproachResult[] = [];

  // Initialize result tracking per creep
  var creepDamageByTick: number[][] = [];
  var creepDeathTick: (number | null)[] = [];
  for (var c = 0; c < waveSize; c++) {
    creepDamageByTick.push([]);
    creepDeathTick.push(null);
  }

  // Simulate tick by tick
  for (var tick = 0; tick < path.length; tick++) {
    var pos = path[tick];

    // Calculate total tower damage at this position
    var towerDamageThisTick = calcTowerDamageAtPos(pos.x, pos.y, towers);

    // Distribute damage among alive creeps
    var damagePerCreep = aliveCount > 0 ? towerDamageThisTick / aliveCount : 0;

    for (var ci = 0; ci < waveSize; ci++) {
      if (creepHPs[ci] <= 0) {
        creepDamageByTick[ci].push(0);
        continue;
      }

      creepHPs[ci] -= damagePerCreep;
      creepDamageByTick[ci].push(damagePerCreep);
      totalDamage += damagePerCreep;

      if (creepHPs[ci] <= 0) {
        creepDeathTick[ci] = tick;
        aliveCount--;
      }
    }
  }

  // Build results for each creep
  var survivors = 0;
  for (var ri = 0; ri < waveSize; ri++) {
    var survived = creepHPs[ri] > 0;
    if (survived) survivors++;

    creepResults.push({
      survived: survived,
      hpRemaining: Math.max(0, creepHPs[ri]),
      ticksToTarget: creepDeathTick[ri] !== null ? creepDeathTick[ri]! : path.length,
      totalDamageTaken: creepDamageByTick[ri].reduce(function(a, b) { return a + b; }, 0),
      damageByTick: creepDamageByTick[ri],
      deathTick: creepDeathTick[ri],
      path: path,
    });
  }

  return {
    survivorsAtTarget: survivors,
    totalCreeps: waveSize,
    survivalRate: survivors / waveSize,
    totalDamageTaken: totalDamage,
    towerShotsTotal: Math.ceil(totalDamage / 300),
    creepResults: creepResults,
  };
}

// ============================================
// Campaign Estimation
// ============================================

/**
 * Estimate total campaign duration and cost.
 *
 * Key numbers:
 * - Each CLAIM attack removes 300 ticks per CLAIM part
 * - Standard attacker has 3 CLAIM parts = 900 ticks removed per attack
 * - Controller natural decay: varies by RCL (roughly 1000/cycle for RCL 6)
 * - Attack cooldown: 1000 ticks (upgradeBlocked duration)
 * - Safe mode: 20,000 ticks per charge
 */
export function estimateCampaign(intel: TargetIntel): CampaignEstimate {
  var timer = intel.controllerTimer;
  var rcl = intel.controllerRCL;

  // Effect per attack cycle
  // 900 ticks from CLAIM + natural decay during 1000 tick cooldown
  var effectPerCycle = 900 + 1000; // ~1900 ticks effective

  // Cycles needed to reduce timer to 0
  var cyclesNeeded = Math.ceil(timer / effectPerCycle);

  // Safe mode delays
  var safeModeCharges = intel.safeModeCharges || (rcl >= 3 ? 3 : 0);
  var safeModeDelay = safeModeCharges * 20000;

  // Total ticks = cycles * 1000 (cooldown) + safe mode delays
  var totalTicks = cyclesNeeded * 1000 + safeModeDelay;

  // Hours = ticks / 3600 * 3 (3 second ticks)
  var hours = (totalTicks / 3600) * 3;

  return {
    targetRoom: intel.roomName,
    controllerTimer: timer,
    controllerRCL: rcl,
    cyclesNeeded: cyclesNeeded,
    attacksPerCycle: 1,
    totalAttacksNeeded: cyclesNeeded,
    safeModeCharges: safeModeCharges,
    safeModeDelayTicks: safeModeDelay,
    estimatedTotalTicks: totalTicks,
    estimatedHours: Math.round(hours * 10) / 10,
  };
}

// ============================================
// Strategy Evaluation
// ============================================

// Controller attacker body: [CLAIM×3, MOVE×3] = 3×600 + 3×50 = 1950 energy
var CONTROLLER_ATTACKER_COST = 1950;
var CONTROLLER_ATTACKER_HP = 600; // 6 parts × 100 HP

/**
 * Get entry position for an edge.
 */
export function getEntryPositionForEdge(
  edge: "north" | "south" | "east" | "west",
  controllerX: number,
  controllerY: number
): { x: number; y: number } {
  switch (edge) {
    case "north":
      return { x: controllerX, y: 0 };
    case "south":
      return { x: controllerX, y: 49 };
    case "east":
      return { x: 49, y: controllerY };
    case "west":
      return { x: 0, y: controllerY };
  }
}

/**
 * Evaluate a single approach strategy.
 */
export function evaluateStrategy(
  name: string,
  approachRoom: string,
  entryEdge: "north" | "south" | "east" | "west",
  entryX: number,
  entryY: number,
  intel: TargetIntel,
  waveSize: number
): StrategySimulation {
  var controllerX = intel.controllerPos.x;
  var controllerY = intel.controllerPos.y;

  // Simulate wave approach
  var waveResult = simulateWave({
    waveSize: waveSize,
    entryX: entryX,
    entryY: entryY,
    targetX: controllerX,
    targetY: controllerY,
    towers: intel.towers,
    creepHP: CONTROLLER_ATTACKER_HP,
  });

  // Calculate costs
  var costPerWave = waveSize * CONTROLLER_ATTACKER_COST;
  var survivalRate = waveResult.survivalRate;

  // Estimate campaign
  var campaignEst = estimateCampaign(intel);
  var attacksNeeded = campaignEst.totalAttacksNeeded;

  // Waves needed (accounting for survival rate)
  var wavesNeeded = survivalRate > 0 ?
    Math.ceil(attacksNeeded / (survivalRate * waveSize)) :
    Infinity;

  var totalCost = wavesNeeded === Infinity ? Infinity : wavesNeeded * costPerWave;
  var totalTicks = wavesNeeded === Infinity ? Infinity :
    wavesNeeded * 1000 + campaignEst.safeModeDelayTicks;

  // Determine risk level
  var risk: "IMPOSSIBLE" | "HIGH" | "MEDIUM" | "LOW";
  var viable: boolean;

  if (survivalRate === 0) {
    risk = "IMPOSSIBLE";
    viable = false;
  } else if (survivalRate < 0.25) {
    risk = "HIGH";
    viable = true;
  } else if (survivalRate < 0.5) {
    risk = "MEDIUM";
    viable = true;
  } else {
    risk = "LOW";
    viable = true;
  }

  return {
    name: name,
    approach: approachRoom,
    entryEdge: entryEdge,
    survivalRate: survivalRate,
    costPerWave: costPerWave,
    estimatedWavesNeeded: wavesNeeded,
    estimatedTotalCost: totalCost,
    estimatedDurationTicks: totalTicks,
    risk: risk,
    viable: viable,
    details: waveResult,
  };
}

/**
 * Evaluate all approach strategies for a target.
 */
export function evaluateAllStrategies(
  intel: TargetIntel,
  approachRooms: Record<string, string>
): StrategySimulation[] {
  var strategies: StrategySimulation[] = [];
  var controllerX = intel.controllerPos.x;
  var controllerY = intel.controllerPos.y;

  // Wave sizes to test
  var waveSizes = [1, 2, 3, 4];

  for (var edge in approachRooms) {
    var approachRoom = approachRooms[edge as keyof typeof approachRooms];
    var entryPos = getEntryPositionForEdge(
      edge as "north" | "south" | "east" | "west",
      controllerX,
      controllerY
    );

    for (var wi = 0; wi < waveSizes.length; wi++) {
      var waveSize = waveSizes[wi];
      var stratName = (waveSize === 1 ? "Solo " : "Wave-" + waveSize + " ") +
        edge.charAt(0).toUpperCase() + edge.slice(1);

      var result = evaluateStrategy(
        stratName,
        approachRoom,
        edge as "north" | "south" | "east" | "west",
        entryPos.x,
        entryPos.y,
        intel,
        waveSize
      );

      strategies.push(result);
    }
  }

  // Sort by viability, then by cost efficiency
  strategies.sort(function(a, b) {
    if (a.viable && !b.viable) return -1;
    if (!a.viable && b.viable) return 1;
    if (a.viable && b.viable) {
      return a.estimatedTotalCost - b.estimatedTotalCost;
    }
    return b.survivalRate - a.survivalRate;
  });

  return strategies;
}

// ============================================
// Console Output Formatting
// ============================================

/**
 * Format simulation results for console output.
 */
export function formatSimulationReport(
  intel: TargetIntel,
  strategies: StrategySimulation[]
): string {
  var lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║  ATTACK SIMULATION: " + intel.roomName.padEnd(40) + "║");
  lines.push("╠══════════════════════════════════════════════════════════════╣");

  // Intel summary
  lines.push("║  Owner: " + intel.owner.padEnd(52) + "║");
  lines.push("║  Controller: (" + intel.controllerPos.x + "," + intel.controllerPos.y +
    ") RCL " + intel.controllerRCL + " timer " + intel.controllerTimer.toString().padEnd(18) + "║");

  var towerStr = intel.towers.map(function(t) {
    return "(" + t.x + "," + t.y + ")";
  }).join(" ");
  lines.push("║  Towers: " + intel.towers.length + " " + towerStr.substring(0, 45).padEnd(49) + "║");
  lines.push("║                                                              ║");

  // Campaign estimate
  var est = estimateCampaign(intel);
  lines.push("║  Est cycles: " + est.cyclesNeeded + " | Safe modes: " + est.safeModeCharges +
    " | ~" + est.estimatedHours + "h total".padEnd(20) + "║");
  lines.push("║                                                              ║");

  // Strategy results (show top 8)
  var viableCount = 0;
  for (var i = 0; i < strategies.length && i < 8; i++) {
    var s = strategies[i];
    var icon = s.viable ? "✓" : "✗";

    if (s.viable) viableCount++;

    var line1 = "║  " + icon + " " + s.name.padEnd(15) +
      "survival: " + (s.survivalRate * 100).toFixed(0).padStart(3) + "% | " +
      s.risk.padEnd(10);
    lines.push(line1.padEnd(62) + "║");

    if (s.viable) {
      var costStr = s.estimatedTotalCost === Infinity ? "∞" :
        Math.round(s.estimatedTotalCost / 1000) + "k";
      var durationStr = s.estimatedDurationTicks === Infinity ? "∞" :
        Math.round(s.estimatedDurationTicks / 3600 * 3) + "h";
      var line2 = "║      cost: ~" + costStr.padEnd(6) + " duration: ~" + durationStr.padEnd(20);
      lines.push(line2.padEnd(62) + "║");
    }
  }

  lines.push("║                                                              ║");

  // Recommendation
  var bestViable = strategies.find(function(s) { return s.viable; });
  if (bestViable) {
    lines.push("║  RECOMMENDED: " + bestViable.name.padEnd(45) + "║");
  } else {
    lines.push("║  ⚠ NO VIABLE STRATEGY — all approaches result in 0% survival║");
  }

  lines.push("╚══════════════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

// ============================================
// Game State Integration
// ============================================

/**
 * Build intel from current game state.
 * This is the ONLY function that depends on Game state.
 */
export function buildIntelFromGame(roomName: string): TargetIntel | null {
  var room = Game.rooms[roomName];

  // Try memory if no vision
  if (!room) {
    var memIntel = Memory.intel && (Memory.intel as any)[roomName];
    if (!memIntel || !memIntel.controllerPos) {
      return null;
    }

    return {
      roomName: roomName,
      controllerPos: memIntel.controllerPos,
      controllerRCL: memIntel.controllerLevel || 0,
      controllerTimer: memIntel.ticksToDowngrade || 200000,
      towers: (memIntel.towers || []).map(function(t: any) {
        return { x: t.x, y: t.y, energy: t.energy || 500 };
      }),
      owner: memIntel.owner || "unknown",
      safeModeCharges: memIntel.safeModeCharges,
    };
  }

  // Build from live room
  var controller = room.controller;
  if (!controller) return null;

  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_TOWER; }
  }) as StructureTower[];

  return {
    roomName: roomName,
    controllerPos: { x: controller.pos.x, y: controller.pos.y },
    controllerRCL: controller.level,
    controllerTimer: controller.ticksToDowngrade || 0,
    towers: towers.map(function(t) {
      return { x: t.pos.x, y: t.pos.y, energy: t.store[RESOURCE_ENERGY] };
    }),
    owner: controller.owner ? controller.owner.username : "none",
    safeModeCharges: controller.safeModeAvailable,
  };
}

/**
 * Get approach rooms for a target.
 */
export function getApproachRooms(targetRoom: string): Record<string, string> {
  var exits = Game.map.describeExits(targetRoom);
  var result: Record<string, string> = {};

  if (exits) {
    if (exits[TOP]) result.north = exits[TOP];
    if (exits[BOTTOM]) result.south = exits[BOTTOM];
    if (exits[LEFT]) result.west = exits[LEFT];
    if (exits[RIGHT]) result.east = exits[RIGHT];
  }

  return result;
}

// ============================================
// Console Commands
// ============================================

/**
 * Main simulation entry point.
 * Usage: military.simulate("E44N39")
 */
export function simulate(targetRoom: string): string {
  var intel = buildIntelFromGame(targetRoom);

  if (!intel) {
    return "No intel available for " + targetRoom +
      ". Need vision or stored intel in Memory.intel.";
  }

  if (intel.towers.length === 0) {
    return "No towers detected in " + targetRoom + ". Solo attacks should succeed.";
  }

  var approaches = getApproachRooms(targetRoom);
  var strategies = evaluateAllStrategies(intel, approaches);

  return formatSimulationReport(intel, strategies);
}

/**
 * Simulate specific approach.
 * Usage: military.simApproach("E44N39", "E43N39", 3)
 */
export function simApproach(
  targetRoom: string,
  approachRoom: string,
  waveSize?: number
): string {
  var intel = buildIntelFromGame(targetRoom);

  if (!intel) {
    return "No intel available for " + targetRoom;
  }

  var size = waveSize || 1;

  // Determine entry edge
  var exits = Game.map.describeExits(targetRoom);
  var edge: "north" | "south" | "east" | "west" | null = null;

  if (exits) {
    if (exits[TOP] === approachRoom) edge = "north";
    else if (exits[BOTTOM] === approachRoom) edge = "south";
    else if (exits[LEFT] === approachRoom) edge = "west";
    else if (exits[RIGHT] === approachRoom) edge = "east";
  }

  if (!edge) {
    return approachRoom + " is not adjacent to " + targetRoom;
  }

  var entryPos = getEntryPositionForEdge(edge, intel.controllerPos.x, intel.controllerPos.y);

  var result = evaluateStrategy(
    "Custom",
    approachRoom,
    edge,
    entryPos.x,
    entryPos.y,
    intel,
    size
  );

  var lines: string[] = [];
  lines.push("=== Approach: " + approachRoom + " → " + targetRoom + " ===");
  lines.push("Entry: " + edge + " edge at (" + entryPos.x + "," + entryPos.y + ")");
  lines.push("Target: controller at (" + intel.controllerPos.x + "," + intel.controllerPos.y + ")");
  lines.push("Distance: " + chebyshevDistance(entryPos.x, entryPos.y,
    intel.controllerPos.x, intel.controllerPos.y) + " tiles");
  lines.push("Wave size: " + size);
  lines.push("");
  lines.push("Survival rate: " + (result.survivalRate * 100).toFixed(0) + "%");
  lines.push("Risk: " + result.risk);
  lines.push("Viable: " + (result.viable ? "YES" : "NO"));

  if (result.viable) {
    lines.push("");
    lines.push("Cost per wave: " + result.costPerWave);
    lines.push("Waves needed: " + (result.estimatedWavesNeeded === Infinity ? "∞" : result.estimatedWavesNeeded));
    lines.push("Total cost: " + (result.estimatedTotalCost === Infinity ? "∞" : result.estimatedTotalCost));
    lines.push("Duration: ~" + Math.ceil(result.estimatedDurationTicks / 3600 * 3) + " hours");
  }

  return lines.join("\n");
}

/**
 * Quick tower damage check.
 * Usage: military.towerDamage("E44N39", 6, 34)
 */
export function towerDamage(roomName: string, x: number, y: number): string {
  var intel = buildIntelFromGame(roomName);

  if (!intel) {
    return "No intel available for " + roomName;
  }

  var lines: string[] = [];
  lines.push("=== Tower Damage at (" + x + "," + y + ") ===");

  var total = 0;
  for (var i = 0; i < intel.towers.length; i++) {
    var t = intel.towers[i];
    var range = Math.max(Math.abs(x - t.x), Math.abs(y - t.y));
    var damage = towerDamageAtRange(range);
    total += damage;
    lines.push("Tower (" + t.x + "," + t.y + "): range " + range + " → " + damage + " dmg");
  }

  lines.push("");
  lines.push("Total: " + total + " damage/tick");

  if (total > 0) {
    var ticksToKill = Math.ceil(600 / total);
    lines.push("600 HP creep dies in: " + ticksToKill + " ticks");
  }

  return lines.join("\n");
}

/**
 * Get fresh intel snapshot for a room.
 * Usage: military.intel("E44N39")
 */
export function intel(roomName: string): string {
  var data = buildIntelFromGame(roomName);

  if (!data) {
    return "No intel for " + roomName + ". Need vision or Memory.intel entry.";
  }

  var lines: string[] = [];
  lines.push("=== Intel: " + roomName + " ===");
  lines.push("Owner: " + data.owner);
  lines.push("Controller: (" + data.controllerPos.x + "," + data.controllerPos.y + ")");
  lines.push("RCL: " + data.controllerRCL);
  lines.push("Timer: " + data.controllerTimer);
  lines.push("Safe modes: " + (data.safeModeCharges || "unknown"));
  lines.push("");
  lines.push("Towers (" + data.towers.length + "):");
  for (var i = 0; i < data.towers.length; i++) {
    var t = data.towers[i];
    lines.push("  (" + t.x + "," + t.y + ") energy: " + t.energy);
  }

  return lines.join("\n");
}
