import { logger } from "../utils/Logger";
import { CONFIG, Role } from "../config";
import { Colony, ColonyState } from "./Colony";
import { ROLE_BODIES } from "../creeps/roles";
import { StrategicCoordinator, CapacityTransition } from "./StrategicCoordinator";

interface SpawnRequest {
  role: Role;
  priority: number;
  body: BodyPartConstant[];
  memory: CreepMemory;
}

export class Spawner {
  constructor(private colony: Colony) {}

  run(state: ColonyState): void {
    const spawn = state.structures.spawns[0];
    if (!spawn) return;

    // Show spawning visual if currently spawning
    if (spawn.spawning) {
      const spawningCreep = Game.creeps[spawn.spawning.name];
      spawn.room.visual.text(
        `🛠️ ${spawningCreep?.memory.role || "?"}`,
        spawn.pos.x,
        spawn.pos.y - 1,
        { font: 0.5, opacity: 0.8 }
      );
      return; // Can't spawn while already spawning
    }

    // Try to renew dying creeps first (when spawn not busy)
    if (this.tryRenewCreeps(spawn, state)) {
      return; // Renewing a creep
    }

    // Build spawn queue
    const queue = this.buildSpawnQueue(state);
    if (queue.length === 0) return;

    // Sort by priority
    queue.sort((a, b) => a.priority - b.priority);

    // Try to spawn highest priority
    for (const request of queue) {
      const result = this.trySpawn(spawn, request);
      if (result === OK) {
        logger.info("Spawner", `Spawning ${request.role}`);
        break;
      } else if (result === ERR_NOT_ENOUGH_ENERGY) {
        // Wait for more energy
        break;
      }
      // Otherwise try next in queue
    }
  }

  private buildSpawnQueue(state: ColonyState): SpawnRequest[] {
    const queue: SpawnRequest[] = [];
    const energyCapacity = state.energy.capacity;

    // Get capacity transition state for spawn timing optimization
    const strategicState = StrategicCoordinator.getState(this.colony.roomName);
    const transition = strategicState?.capacityTransition;

    // Core economy roles - always check
    const coreRoles: Role[] = ["HARVESTER", "HAULER", "UPGRADER", "BUILDER"];
    for (const role of coreRoles) {
      if (this.colony.needsCreep(role)) {
        // Check if we should delay spawning this role
        if (this.shouldDelaySpawn(role, transition, state)) {
          continue; // Skip this role - wait for bigger body
        }

        const body = this.getBody(role, energyCapacity);
        if (body.length > 0) {
          queue.push({
            role,
            priority: CONFIG.SPAWN_PRIORITY[role],
            body,
            memory: this.getMemory(role, state),
          });
        }
      }
    }

    // Defender - spawn when hostiles detected
    if (state.threat.hostiles.length > 0) {
      const defenderCount = this.colony.getCreepCount("DEFENDER");
      const maxDefenders = CONFIG.MAX_CREEPS.DEFENDER || 3;
      if (defenderCount < Math.min(state.threat.hostiles.length, maxDefenders)) {
        const body = this.getBody("DEFENDER", energyCapacity);
        if (body.length > 0) {
          queue.push({
            role: "DEFENDER",
            priority: 0, // Highest priority when hostiles present
            body,
            memory: this.getMemory("DEFENDER", state),
          });
        }
      }
    }

    // Scout - spawn 1 for exploration at RCL 3+
    const room = Game.rooms[this.colony.roomName];
    if (room && room.controller && room.controller.level >= 3) {
      const scoutCount = this.colony.getCreepCount("SCOUT");
      const minScouts = CONFIG.MIN_CREEPS.SCOUT || 0;
      if (scoutCount < minScouts) {
        const body = this.getBody("SCOUT", energyCapacity);
        if (body.length > 0) {
          queue.push({
            role: "SCOUT",
            priority: CONFIG.SPAWN_PRIORITY.SCOUT,
            body,
            memory: this.getMemory("SCOUT", state),
          });
        }
      }
    }

    // Remote Miner - spawn when we have good economy and scouted rooms
    if (room && room.controller && room.controller.level >= 4 && energyCapacity >= 550) {
      const remoteRooms = this.getRemoteMiningTargets();
      if (remoteRooms.length > 0) {
        const remoteMinerCount = this.colony.getCreepCount("REMOTE_MINER");
        const maxRemoteMiners = Math.min(remoteRooms.length * 2, CONFIG.MAX_CREEPS.REMOTE_MINER || 4);
        if (remoteMinerCount < maxRemoteMiners) {
          const body = this.getBody("REMOTE_MINER", energyCapacity);
          if (body.length > 0) {
            const targetRoom = remoteRooms[remoteMinerCount % remoteRooms.length];
            queue.push({
              role: "REMOTE_MINER",
              priority: CONFIG.SPAWN_PRIORITY.REMOTE_MINER,
              body,
              memory: { ...this.getMemory("REMOTE_MINER", state), targetRoom },
            });
          }
        }
      }
    }

    return queue;
  }

  private getRemoteMiningTargets(): string[] {
    const targets: string[] = [];
    const roomName = this.colony.roomName;
    const exits = Game.map.describeExits(roomName);
    const MAX_REMOTE_DISTANCE = 1; // Only adjacent rooms for now

    if (!exits || !Memory.rooms) return targets;

    for (const dir in exits) {
      const adjacentRoom = exits[dir as ExitKey];
      if (!adjacentRoom) continue;

      // Explicit distance check
      const distance = Game.map.getRoomLinearDistance(roomName, adjacentRoom);
      if (distance > MAX_REMOTE_DISTANCE) continue;

      const intel = Memory.rooms[adjacentRoom];
      if (!intel) continue;

      // Good remote mining target: has sources, no owner, no keepers, scouted recently
      const hasOwner = intel.controller && intel.controller.owner;
      const isReserved = intel.controller && intel.controller.reservation;
      const isSafe = !intel.hasKeepers && !intel.hasInvaderCore && (intel.hostiles || 0) === 0;
      const hasSources = intel.sources && intel.sources.length > 0;
      const recentScan = intel.lastScan && Game.time - intel.lastScan < 2000;

      if (!hasOwner && !isReserved && isSafe && hasSources && recentScan) {
        targets.push(adjacentRoom);
      }
    }

    return targets;
  }

  private getBody(role: Role, energyCapacity: number): BodyPartConstant[] {
    const bodyConfig = ROLE_BODIES[role];
    if (!bodyConfig) {
      logger.warn("Spawner", `No body config for role: ${role}`);
      return [];
    }

    // Start with base body
    let body = [...bodyConfig.base];
    let cost = this.calculateBodyCost(body);

    // Scale up if we have more energy
    if (bodyConfig.scale && energyCapacity > cost) {
      const maxIterations = 10; // Safety limit
      let iterations = 0;

      while (iterations < maxIterations) {
        const scaledBody = [...body, ...bodyConfig.scale];
        const scaledCost = this.calculateBodyCost(scaledBody);

        if (scaledCost > energyCapacity || scaledBody.length > 50) break;

        body = scaledBody;
        cost = scaledCost;
        iterations++;
      }
    }

    return body;
  }

  private calculateBodyCost(body: BodyPartConstant[]): number {
    return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  }

  private getMemory(role: Role, state: ColonyState): CreepMemory {
    const memory: CreepMemory = {
      role,
      room: this.colony.roomName,
    };

    // Assign source for harvesters
    if (role === "HARVESTER") {
      const source = this.getLeastAssignedSource(state);
      if (source) {
        memory.sourceId = source.id;
      }
    }

    return memory;
  }

  private getLeastAssignedSource(state: ColonyState): Source | null {
    const sourceCounts: Map<Id<Source>, number> = new Map();

    // Count current assignments
    for (const source of state.sources) {
      sourceCounts.set(source.id, 0);
    }

    for (const creep of state.creeps.all) {
      if (creep.memory.role === "HARVESTER" && creep.memory.sourceId) {
        const count = sourceCounts.get(creep.memory.sourceId) ?? 0;
        sourceCounts.set(creep.memory.sourceId, count + 1);
      }
    }

    // Find least assigned
    let minSource: Source | null = null;
    let minCount = Infinity;

    for (const source of state.sources) {
      const count = sourceCounts.get(source.id) ?? 0;
      if (count < minCount) {
        minCount = count;
        minSource = source;
      }
    }

    return minSource;
  }

  private trySpawn(spawn: StructureSpawn, request: SpawnRequest): ScreepsReturnCode {
    const name = `${request.role}_${Game.time}`;
    return spawn.spawnCreep(request.body, name, { memory: request.memory });
  }

  /**
   * Try to renew creeps that are low on TTL and near the spawn
   * Returns true if actively renewing a creep
   */
  private tryRenewCreeps(spawn: StructureSpawn, state: ColonyState): boolean {
    // Only renew if we have good energy reserves
    if (state.energy.available < state.energy.capacity * 0.5) {
      return false;
    }

    // Get capacity transition state
    const strategicState = StrategicCoordinator.getState(spawn.room.name);
    const transition = strategicState?.capacityTransition;

    // Find creeps near spawn with low TTL
    const dyingCreeps = state.creeps.all
      .filter((c: Creep) => {
        const ttl = c.ticksToLive;
        if (!ttl || ttl > 300) return false; // Only renew if TTL < 300
        if (c.pos.getRangeTo(spawn) > 1) return false; // Must be adjacent to spawn

        // Check if renewal should be suppressed for this creep
        if (transition && this.shouldSuppressRenewal(c, transition, state)) {
          return false;
        }

        return true;
      })
      .sort((a: Creep, b: Creep) => {
        // Prioritize creeps with more body parts (more expensive)
        return b.body.length - a.body.length;
      });

    if (dyingCreeps.length === 0) return false;

    const creepToRenew = dyingCreeps[0];
    const result = spawn.renewCreep(creepToRenew);

    if (result === OK) {
      spawn.room.visual.text(
        `♻️ ${creepToRenew.memory.role}`,
        spawn.pos.x,
        spawn.pos.y - 1,
        { font: 0.5, opacity: 0.8 }
      );
      return true;
    }

    return false;
  }

  /**
   * Determine if renewal should be suppressed for a creep during capacity transition
   * Returns true if the creep should NOT be renewed (let it die for bigger replacement)
   */
  private shouldSuppressRenewal(creep: Creep, transition: CapacityTransition, state: ColonyState): boolean {
    // Calculate creep's energy cost
    const creepCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
    const currentCapacity = state.energy.capacity;

    // ALWAYS suppress renewal for severely undersized creeps (< 50% of current capacity)
    // This ensures we replace tiny early-game harvesters with proper ones
    if (creepCost < currentCapacity * 0.5) {
      logger.debug(
        "Spawner",
        `Suppressing renewal for undersized ${creep.name} (${creepCost} cost < ${(currentCapacity * 0.5).toFixed(0)} threshold)`
      );
      return true;
    }

    // Don't suppress if not in transition or suppression not recommended
    if (!transition.inTransition || !transition.shouldSuppressRenewal) {
      return false;
    }

    // For critical roles at minimum count, only suppress if very undersized (already handled above)
    const criticalRoles = ["HARVESTER", "HAULER"];
    if (criticalRoles.includes(creep.memory.role)) {
      const roleCount = state.creeps.all.filter(c => c.memory.role === creep.memory.role).length;
      const minCount = (CONFIG.MIN_CREEPS as Record<string, number>)[creep.memory.role] || 1;
      if (roleCount <= minCount) {
        return false; // Don't suppress - we need this creep (and it's not undersized)
      }
    }

    // If creep cost is less than 70% of future capacity, suppress renewal
    const valueThreshold = transition.futureCapacity * 0.7;
    if (creepCost < valueThreshold) {
      logger.debug(
        "Spawner",
        `Suppressing renewal for ${creep.name} (${creepCost} cost < ${valueThreshold.toFixed(0)} threshold)`
      );
      return true;
    }

    return false;
  }

  /**
   * Check if spawning should be delayed for non-critical roles during capacity transition
   */
  private shouldDelaySpawn(role: Role, transition: CapacityTransition | undefined, state: ColonyState): boolean {
    if (!transition || !transition.inTransition || !transition.shouldDelaySpawning) {
      return false;
    }

    // Never delay critical roles (economy must keep running)
    const criticalRoles: Role[] = ["HARVESTER", "HAULER", "UPGRADER"];
    if (criticalRoles.includes(role)) {
      return false;
    }

    // Check if we're below minimum for this role
    const currentCount = state.creeps.all.filter(c => c.memory.role === role).length;
    const minCount = (CONFIG.MIN_CREEPS as Record<string, number>)[role] || 1;
    if (currentCount < minCount) {
      return false; // Must spawn to meet minimum
    }

    // Delay spawning - bigger body coming soon
    logger.debug(
      "Spawner",
      `Delaying ${role} spawn: extensions done in ~${transition.estimatedTicksToCompletion} ticks`
    );
    return true;
  }
}
