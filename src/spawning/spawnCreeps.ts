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
import { StatsCollector } from "../utils/StatsCollector";
import { recordActualSpawn } from "../framework/ShadowSpawn";
import * as DuoManager from "../combat/DuoManager";
import * as MilitaryManager from "../military/MilitaryManager";
import * as WaveCoordinator from "../military/WaveCoordinator";

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

  // Track refusals for energy. This was swallowed silently, which is why a room could sit
  // in a spawn deadlock indefinitely with nothing in any log: E47N41 held one 200-energy
  // harvester at RCL 7 while both spawns idled and its sources sat full. The count feeds
  // resolveSpawnEnergyBudget, so the body shrinks to what the room can actually afford.
  if (result === ERR_NOT_ENOUGH_ENERGY) {
    room.memory._spawnStall = (room.memory._spawnStall || 0) + 1;
  } else if (room.memory._spawnStall) {
    delete room.memory._spawnStall;
  }

  if (result === OK) {
    // Compare the incumbent's choice with the framework SpawnEvaluator's shadow proposal.
    recordActualSpawn(room.name, candidate.role);

    const targetInfo = candidate.memory.targetRoom ? ` -> ${candidate.memory.targetRoom}` : "";
    console.log(
      `[${room.name}] Spawning ${candidate.role}${targetInfo} (utility: ${candidate.utility.toFixed(1)})`
    );

    // Spawn cost is the one energy sink the room event log does not report.
    let spawnCost = 0;
    for (let bi = 0; bi < candidate.body.length; bi++) {
      spawnCost += BODYPART_COST[candidate.body[bi]];
    }
    StatsCollector.recordSpawn(spawnCost);

    // Handle duo assignment for combat roles
    if (candidate.role === "RANGED_ATTACKER" || candidate.role === "COMBAT_HEALER") {
      var duoId = (candidate.memory as any).duoId;
      if (duoId) {
        var roleType: "attacker" | "healer" = candidate.role === "RANGED_ATTACKER" ? "attacker" : "healer";
        DuoManager.assignCreepToDuo(duoId, name, roleType);
      }
    }

    // Track military spawns with energy cost
    if (candidate.role === "CONTROLLER_ATTACKER") {
      var campaignId = (candidate.memory as any).campaignId;
      if (campaignId) {
        // Calculate body cost
        var bodyCost = 0;
        for (var pi = 0; pi < candidate.body.length; pi++) {
          bodyCost += BODYPART_COST[candidate.body[pi]];
        }
        MilitaryManager.reportSpawned(campaignId, bodyCost);

        // Register with wave if part of a wave attack
        var waveId = (candidate.memory as any).waveId;
        if (waveId) {
          WaveCoordinator.addMember(waveId, name);
        }
      }
    }
  } else if (result !== ERR_NOT_ENOUGH_ENERGY) {
    console.log(`[${room.name}] Spawn failed: ${result} for ${candidate.role} (cost: ${candidate.cost})`);
  }
}
