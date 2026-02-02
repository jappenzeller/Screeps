/**
 * Utility-Based Spawning System
 *
 * Uses dynamic utility scoring instead of static priorities.
 * Each role's spawn utility is a continuous function of colony state.
 * The spawner always picks the highest utility role.
 *
 * Key insight: When energy income approaches zero, economy role utility
 * approaches infinity - no threshold needed for "emergency mode".
 */

import { getSpawnCandidate } from "./utilitySpawning";

/**
 * Main spawning function - uses utility-based decision making
 */
export function spawnCreeps(room: Room): void {
  const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
  if (!spawn) return;

  // Get best spawn candidate based on utility scoring
  const candidate = getSpawnCandidate(room);
  if (!candidate) return;

  const name = `${candidate.role}_${Game.time}`;
  const memory: CreepMemory = {
    role: candidate.role,
    room: room.name,
    ...candidate.memory,
  } as CreepMemory;

  const result = spawn.spawnCreep(candidate.body, name, { memory });
  if (result === OK) {
    const targetInfo = candidate.memory.targetRoom ? ` -> ${candidate.memory.targetRoom}` : "";
    console.log(
      `[${room.name}] Spawning ${candidate.role}${targetInfo} (utility: ${candidate.utility.toFixed(1)})`
    );
  } else if (result !== ERR_NOT_ENOUGH_ENERGY) {
    console.log(`[${room.name}] Spawn failed: ${result} for ${candidate.role} (cost: ${candidate.cost})`);
  }
}
