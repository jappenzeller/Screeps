import { ColonyManager } from "../core/ColonyManager";
import { moveToRoom, smartMoveTo } from "../utils/movement";
import { DecisionLogger } from "../logging/DecisionLogger";
import { Chooser, proximityFactor, urgencyFactor } from "../core/Decision";

// Extend CreepMemory for renewal wait tracking
declare global {
  interface CreepMemory {
    _renewWaitStart?: number;
  }
}

// ============================================
// Filler Detection Cache
// ============================================

/**
 * Check if room has an active FILLER creep (cached per tick for CPU efficiency).
 * When a filler exists, haulers skip spawn/extension filling and go to storage.
 */
function roomHasFiller(room: Room): boolean {
  var cached = (room as any)._fillerCheck;
  if (cached && cached.tick === Game.time) return cached.result;

  var result = room.find(FIND_MY_CREEPS, {
    filter: function(c) {
      return c.memory.role === "FILLER" && (!c.ticksToLive || c.ticksToLive > 50);
    }
  }).length > 0;

  (room as any)._fillerCheck = { tick: Game.time, result: result };
  return result;
}

/**
 * Hauler: Picks up energy from containers/ground and delivers to structures.
 *
 * Container Coordination:
 * - Each hauler has a primary container assignment to prevent oscillation
 * - Haulers wait at their container if a miner is present (energy coming)
 * - Container switching has a cooldown to prevent rapid oscillation
 *
 * Renewal Strategy:
 * - Large haulers (500+ energy cost) are renewed when near spawn with low TTL
 * - TTL threshold scales with body size (larger = renew earlier)
 * - Small haulers (<500 cost) just die and respawn - cheaper than renewal overhead
 * - Renewal only triggers if already within 3 tiles of spawn (don't pull across map)
 */

/**
 * A hauler carrying at least this fraction of its capacity has a worthwhile load and
 * should deliver rather than wait on a drained container for the remainder.
 */
const PARTIAL_LOAD_FRACTION = 0.5;

/** Below this a tower cannot meaningfully defend - it outranks every other sink. */
const TOWER_CRITICAL = 300;

/** Below this a tower is under-provisioned but not an emergency. */
const TOWER_READY = 500;

/**
 * Range at which the proximity factor halves. Large enough that need dominates distance
 * across a room, small enough to break ties toward the nearer of two equal targets.
 */
const DISTANCE_HALF_LIFE = 25;

/**
 * Ticks a delivery lease is held before it is released and the target re-scored.
 *
 * The lease exists to stop scoring from oscillating, but an unbounded lease is the
 * "commitment without expiry" fault in its own right - the same shape as _safeWaypoint,
 * which pursued an unreachable room forever because it was only ever cleared on arrival.
 * Observed here: a hauler leased to a tower 32 path-steps away kept walking to it while
 * nearer sinks went unserved. Long enough to complete a cross-room delivery, short enough
 * that a bad or stale choice cannot become permanent.
 */
const DELIVER_LEASE_TICKS = 50;

/**
 * Spawn+extension fill below this fraction of capacity means the filler is not coping,
 * whatever its intentions, and haulers resume filling at full priority.
 */
const FILLER_BEHIND_FRACTION = 0.5;

/**
 * Base weight for spawn/extension delivery while a filler IS coping. Low enough that
 * haulers prefer other work, never zero - a zero base cannot be recovered from by any
 * amount of urgency.
 */
const FILLER_PRESENT_BASE = 12;

/**
 * Select the best container to collect from based on energy, distance, and competition.
 * Called when transitioning to COLLECTING state.
 */
function selectContainer(creep: Creep): StructureContainer | null {
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.pos.findInRange(FIND_SOURCES, 1).length > 0,
  }) as StructureContainer[];

  if (containers.length === 0) return null;

  // Score each container
  const scored = containers.map((container) => {
    const energy = container.store[RESOURCE_ENERGY];
    const distance = creep.pos.getRangeTo(container);

    // Count other haulers targeting this container
    const competitors = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === "HAULER" &&
        c.name !== creep.name &&
        c.memory.state === "COLLECTING" &&
        c.memory.targetContainer === container.id
    ).length;

    // Higher energy = better, more competitors = worse, closer = better
    const score = energy / (competitors + 1) / (distance + 1);

    return { container, score, energy, distance, competitors };
  });

  // Pick highest score
  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0]?.container || null;

  // Log the container selection decision
  if (selected) {
    const top = scored[0];
    DecisionLogger.logCreepDecision(
      creep.room.name,
      creep.name,
      "HAULER",
      "TARGET_SELECT",
      creep.memory.state || null,
      "COLLECTING",
      selected.id,
      "container",
      `Selected container with score ${Math.round(top.score)}, ${top.energy} energy`,
      {
        selectedScore: Math.round(top.score),
        selectedEnergy: top.energy,
        selectedDistance: top.distance,
        competitors: top.competitors,
        alternativeCount: scored.length - 1,
      }
    );
  }

  return selected;
}

/**
 * Check if this hauler should attempt renewal.
 * Returns: 'critical' (must seek spawn now), 'opportunistic' (renew if near), or false
 *
 * Queue prevention:
 * - Don't renew if other creeps already waiting at spawn
 * - Don't renew if room energy is too low
 * - Opportunistic only triggers when ALREADY adjacent (don't travel for it)
 */
function shouldRenew(creep: Creep): "critical" | "opportunistic" | false {
  // Only renew large creeps - small ones are cheap to replace
  const bodyCost = creep.body.reduce((sum, part) => sum + BODYPART_COST[part.type], 0);
  if (bodyCost < 500) return false;

  const ttl = creep.ticksToLive || 1500;
  const spawnTime = creep.body.length;
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return false;

  // Check if room has enough energy to renew (need at least 50 for one tick)
  if (spawn.room.energyAvailable < 50) return false;

  // And never renew while the room is starved - that energy belongs in the extensions
  // so the room can spawn its way back out. Same rule the filler and RenewalManager use.
  if (spawn.room.energyAvailable < spawn.room.energyCapacityAvailable * 0.5) return false;

  // Check for queue at spawn - don't join if 2+ creeps already waiting
  const creepsAtSpawn = spawn.pos.findInRange(FIND_MY_CREEPS, 1).filter(
    (c) => c.name !== creep.name
  ).length;
  if (creepsAtSpawn >= 2) return false;

  // Critical: TTL is low enough that we MUST seek spawn now or die
  // Give ourselves spawn time + travel buffer (50 ticks ~= 25 tiles on roads)
  const criticalThreshold = spawnTime + 50;
  if (ttl <= criticalThreshold) {
    // Even in critical mode, don't bother if spawn is too far and we'll die anyway
    const distToSpawn = creep.pos.getRangeTo(spawn);
    if (distToSpawn > ttl) return false; // Can't make it

    // Log critical renewal decision
    DecisionLogger.logCreepDecision(
      creep.room.name,
      creep.name,
      "HAULER",
      "RENEWAL",
      creep.memory.state || null,
      "RENEWING",
      spawn.id,
      "spawn",
      `Critical renewal: TTL ${ttl} <= threshold ${criticalThreshold}`,
      { ttl, threshold: criticalThreshold, distToSpawn, bodyCost }
    );
    return "critical";
  }

  // Opportunistic: renew if we're already adjacent to spawn (don't travel for it)
  // Use higher threshold so haulers start renewing earlier
  var opportunisticThreshold = Math.max(500, spawnTime * 8);

  // If already renewing (mid-session), keep going until we hit the target TTL
  // This prevents the "renew 1 tick, leave, come back" cycle
  var renewTarget = Math.min(1400, opportunisticThreshold + 200);
  if (creep.memory.renewing && ttl < renewTarget) {
    if (creep.pos.isNearTo(spawn) && !spawn.spawning) {
      return "opportunistic";
    }
    // If we drifted away from spawn mid-renewal, clear the flag
    if (!creep.pos.isNearTo(spawn)) {
      delete creep.memory.renewing;
      creep.memory._renewTicks = 0;
    }
  }

  if (ttl <= opportunisticThreshold) {
    if (creep.pos.isNearTo(spawn) && !spawn.spawning) {
      return "opportunistic";
    }
  }

  return false;
}

/**
 * Attempt to renew the creep at the nearest spawn.
 * @param mode 'critical' means move toward spawn, 'opportunistic' means only if already adjacent
 * Returns true if renewal is in progress (skip normal duties).
 *
 * Anti-queue features:
 * - Gives up if waiting too long (10 ticks) with no energy
 * - Gives up if 2+ other creeps already at spawn
 * - Opportunistic mode doesn't move toward spawn
 */
function tryRenew(creep: Creep, mode: "critical" | "opportunistic"): boolean {
  const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  if (!spawn) return false;

  // Check for queue - give up if too many creeps waiting
  const creepsAtSpawn = spawn.pos.findInRange(FIND_MY_CREEPS, 1).filter(
    (c) => c.name !== creep.name
  ).length;
  if (creepsAtSpawn >= 2) {
    delete creep.memory.renewing;
    delete creep.memory._renewWaitStart;
    creep.say("QUEUE");
    return false; // Give up, too crowded
  }

  // Set renewing flag so spawning system doesn't spawn a replacement
  creep.memory.renewing = true;

  // In critical mode, move toward spawn but give up if waiting too long with no energy
  if (mode === "critical") {
    if (creep.pos.isNearTo(spawn)) {
      // Check if we've been waiting too long with no energy
      if (spawn.room.energyAvailable < 50) {
        if (!creep.memory._renewWaitStart) {
          creep.memory._renewWaitStart = Game.time;
        }
        const waitTime = Game.time - (creep.memory._renewWaitStart as number);
        if (waitTime > 10) {
          // Give up - no energy for 10 ticks, go back to work
          delete creep.memory.renewing;
          delete creep.memory._renewWaitStart;
          creep.say("NO NRG");
          return false;
        }
        creep.say(`WAIT${10 - waitTime}`);
        return true;
      }

      // Reset wait timer if we have energy
      delete creep.memory._renewWaitStart;

      if (!spawn.spawning) {
        const result = spawn.renewCreep(creep);
        if (result === OK) {
          if (!creep.memory._renewTicks) creep.memory._renewTicks = 0;
          creep.memory._renewTicks++;
          creep.memory._lastRenewTick = Game.time;
          creep.say("RENEW!");

          // Check if fully renewed (TTL > 1400), clear flag
          if ((creep.ticksToLive || 0) > 1400) {
            delete creep.memory.renewing;
          }
          return true;
        }
      } else {
        // Spawn is busy - wait but track time
        if (!creep.memory._renewWaitStart) {
          creep.memory._renewWaitStart = Game.time;
        }
        const waitTime = Game.time - (creep.memory._renewWaitStart as number);
        if (waitTime > 20) {
          // Spawn busy for 20 ticks, give up
          delete creep.memory.renewing;
          delete creep.memory._renewWaitStart;
          creep.say("GIVEUP");
          return false;
        }
        creep.say(`WAIT${waitTime}`);
        return true;
      }
    } else {
      smartMoveTo(creep, spawn, { reusePath: 3 });
      creep.say(`TTL${creep.ticksToLive}`);
      return true;
    }
    return true;
  }

  // Opportunistic mode - ONLY if already adjacent (no movement)
  if (spawn.spawning || spawn.room.energyAvailable < 50) {
    delete creep.memory.renewing;
    delete creep.memory._renewWaitStart;
    creep.memory._renewTicks = 0;
    return false;
  }

  if (creep.pos.isNearTo(spawn)) {
    const result = spawn.renewCreep(creep);
    if (result === OK) {
      if (!creep.memory._renewTicks) creep.memory._renewTicks = 0;
      creep.memory._renewTicks++;
      creep.memory._lastRenewTick = Game.time;

      // Cap opportunistic renewal to prevent blocking spawn too long
      if (creep.memory._renewTicks >= 20) {
        delete creep.memory.renewing;
        delete creep.memory._renewWaitStart;
        creep.memory._renewTicks = 0;
        creep.say("RNW DONE");
        return false; // Release spawn
      }

      creep.say("RNW " + (creep.ticksToLive || 0));

      // Check if fully renewed (TTL > 1400), clear flag
      if ((creep.ticksToLive || 0) > 1400) {
        delete creep.memory.renewing;
        delete creep.memory._renewWaitStart;
        creep.memory._renewTicks = 0;
      }
      return true;
    }
  }

  // Not adjacent or renewal failed - give up (opportunistic doesn't move)
  delete creep.memory.renewing;
  delete creep.memory._renewWaitStart;
  creep.memory._renewTicks = 0;
  return false;
}

function moveOffRoad(creep: Creep): void {
  const onRoad = creep.pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === STRUCTURE_ROAD);
  if (!onRoad) return;

  const terrain = creep.room.getTerrain();

  // Search in expanding radius for non-road tile
  for (let radius = 1; radius <= 5; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = creep.pos.x + dx;
        const y = creep.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const hasRoad = creep.room
          .lookForAt(LOOK_STRUCTURES, x, y)
          .some((s) => s.structureType === STRUCTURE_ROAD);
        const hasCreep = creep.room.lookForAt(LOOK_CREEPS, x, y).length > 0;
        if (!hasRoad && !hasCreep) {
          smartMoveTo(creep, new RoomPosition(x, y, creep.room.name), {
            visualizePathStyle: { stroke: "#888888" },
            reusePath: 3,
          });
          return;
        }
      }
    }
  }
}


/**
 * Collect from target container (selected at state transition)
 * Returns true if handled, false if should fallback
 */
function collectFromContainers(creep: Creep): boolean {
  const targetId = creep.memory.targetContainer as Id<StructureContainer> | undefined;
  if (!targetId) return false;

  const container = Game.getObjectById(targetId);
  if (!container) {
    delete creep.memory.targetContainer;
    return false;
  }

  const hasEnergy = container.store[RESOURCE_ENERGY] > 0;
  const isNearby = creep.pos.isNearTo(container);

  // Check for nearby miner (energy coming soon)
  const minerNearby = container.pos.findInRange(FIND_MY_CREEPS, 1, {
    filter: (c) => c.memory.role === "HARVESTER",
  }).length > 0;

  // If at container with miner but no energy, wait
  if (isNearby && minerNearby && !hasEnergy) {
    creep.say("WAIT");
    return true;
  }

  // If has energy, collect
  if (hasEnergy) {
    if (isNearby) {
      creep.withdraw(container, RESOURCE_ENERGY);
    } else {
      smartMoveTo(creep, container, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return true;
  }

  // No energy but miner present - go there and wait
  if (minerNearby) {
    if (!isNearby) {
      smartMoveTo(creep, container, {
        visualizePathStyle: { stroke: "#ffff00" },
        reusePath: 5,
      });
    }
    return true;
  }

  // No energy and no miner - clear target and fallback
  delete creep.memory.targetContainer;
  return false;
}

export function runHauler(creep: Creep): void {
  // Priority 0: If not in home room, go back!
  // findClosestByPath can return objects in adjacent rooms, causing haulers to wander
  if (creep.room.name !== creep.memory.room) {
    moveToRoom(creep, creep.memory.room, "#ff0000");
    creep.say("HOME!");
    return;
  }

  // Priority 1: Renew if needed
  // Large haulers (46 parts, 2300 energy, 46 tick spawn) are expensive to replace
  const renewMode = shouldRenew(creep);
  if (renewMode) {
    if (tryRenew(creep, renewMode)) {
      return; // Skip normal duties this tick
    }
  } else {
    // Clear renewing flag if we're not renewing anymore
    if (creep.memory.renewing) {
      delete creep.memory.renewing;
    }
  }

  const manager = ColonyManager.getInstance(creep.memory.room);

  // Task tracking
  if (creep.memory.taskId) {
    const tasks = manager.getTasks();
    const myTask = tasks.find((t) => t.id === creep.memory.taskId);
    if (!myTask || myTask.assignedCreep !== creep.name) {
      delete creep.memory.taskId;
    }
  }

  // Request task based on current state
  if (!creep.memory.taskId) {
    const task = manager.getAvailableTask(creep);
    if (task) {
      // Accept SUPPLY_SPAWN, SUPPLY_TOWER, or HAUL tasks
      if (["SUPPLY_SPAWN", "SUPPLY_TOWER", "HAUL"].includes(task.type)) {
        manager.assignTask(task.id, creep.name);
      }
    }
  }

  // Initialize state if needed
  if (!creep.memory.state) {
    creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? "DELIVERING" : "COLLECTING";
    // Select container if starting in COLLECTING
    if (creep.memory.state === "COLLECTING") {
      const target = selectContainer(creep);
      creep.memory.targetContainer = target?.id || null;
    }
  }

  // State transitions
  if (creep.memory.state === "DELIVERING" && creep.store[RESOURCE_ENERGY] === 0) {
    // Task complete when we finish delivering
    if (creep.memory.taskId) {
      manager.completeTask(creep.memory.taskId);
    }
    creep.memory.state = "COLLECTING";
    // Select best container for this collection trip
    const target = selectContainer(creep);
    creep.memory.targetContainer = target?.id || null;
    delete creep.memory.deliverTarget; // stale once we are collecting again
    delete creep.memory._deliverLeaseAt;
    creep.say("GET");
  }

  if (creep.memory.state === "COLLECTING" && creep.store.getFreeCapacity() === 0) {
    creep.memory.state = "DELIVERING";
    delete creep.memory.targetContainer;
    creep.say("DLV");
  }

  // Don't wait for a full load that is not coming. A hauler parked on a drained
  // container holding most of a load delivers nothing, blocks its own next trip, and
  // only escapes when the room happens to drop below the emergency threshold below.
  // Observed live: 970/1200 on an empty container for 84+ ticks while the room sat at
  // 76% - comfortably above the emergency trigger, so nothing ever released it.
  if (
    creep.memory.state === "COLLECTING" &&
    creep.store[RESOURCE_ENERGY] >= creep.store.getCapacity() * PARTIAL_LOAD_FRACTION
  ) {
    const src = creep.memory.targetContainer
      ? Game.getObjectById(creep.memory.targetContainer)
      : null;

    if (!src || src.store[RESOURCE_ENERGY] === 0) {
      creep.memory.state = "DELIVERING";
      delete creep.memory.targetContainer;
      creep.say("DLV");
    }
  }

  // Also switch to deliver earlier if spawn critically needs energy
  if (creep.memory.state === "COLLECTING" && creep.store[RESOURCE_ENERGY] >= 50) {
    const spawnCritical = creep.room.energyAvailable < creep.room.energyCapacityAvailable * 0.3;
    if (spawnCritical) {
      creep.memory.state = "DELIVERING";
      delete creep.memory.targetContainer;
      creep.say("URG");
    }
  }

  // Execute current state
  if (creep.memory.state === "DELIVERING") {
    deliver(creep);
  } else {
    collect(creep);
  }
}

function collect(creep: Creep): void {
  // === Tier 0: Already adjacent to assigned container — just withdraw ===
  // Don't reconsider targets, don't search for drops, just take the energy.
  if (creep.memory.targetContainer) {
    const target = Game.getObjectById(creep.memory.targetContainer as Id<StructureContainer>);
    if (target && creep.pos.isNearTo(target) && target.store[RESOURCE_ENERGY] > 0) {
      creep.withdraw(target, RESOURCE_ENERGY);
      return;
    }
  }

  // === Tier 1: Nearby dropped energy (range ≤ 3) — opportunistic grab ===
  // Only pick up drops we're practically on top of. Prevents decay waste
  // without causing cross-room chasing.
  const nearbyDrop = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 3, {
    filter: (r: Resource) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  })[0];

  if (nearbyDrop) {
    if (creep.pickup(nearbyDrop) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, nearbyDrop, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 3 });
    }
    return;
  }

  // === Tier 2: Tombstones (temporary, high value) ===
  const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
    filter: (t: Tombstone) => t.store[RESOURCE_ENERGY] >= 50,
  });

  if (tombstone) {
    if (creep.withdraw(tombstone, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, tombstone, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // === Tier 3: Smart container collection with affinity ===
  if (collectFromContainers(creep)) {
    return;
  }

  // === Tier 4: Room-wide drops — fallback for pre-container rooms ===
  // Only search room-wide when no container target exists.
  if (!creep.memory.targetContainer) {
    const farDrop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: (r: Resource) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
    });

    if (farDrop) {
      if (creep.pickup(farDrop) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, farDrop, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
      }
      return;
    }
  }

  // === Tier 5: Storage (if has excess) ===
  const storage = creep.room.storage;
  if (storage && storage.store[RESOURCE_ENERGY] > 10000) {
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      smartMoveTo(creep, storage, { visualizePathStyle: { stroke: "#ffff00" }, reusePath: 5 });
    }
    return;
  }

  // Nothing to collect - wait near target container or source
  const targetContainer = creep.memory.targetContainer
    ? Game.getObjectById(creep.memory.targetContainer as Id<StructureContainer>)
    : null;

  if (targetContainer) {
    if (!creep.pos.isNearTo(targetContainer)) {
      smartMoveTo(creep, targetContainer, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
    }
    return;
  }

  const source = creep.pos.findClosestByPath(FIND_SOURCES);
  if (source && creep.pos.getRangeTo(source) > 3) {
    smartMoveTo(creep, source, { visualizePathStyle: { stroke: "#888888" }, reusePath: 10 });
  }
}

/** Deliver to a chosen target and remember it, so the choice survives to the next tick. */
function deliverTo(creep: Creep, target: AnyStoreStructure, stroke: string): void {
  creep.memory.deliverTarget = target.id;
  creep.memory._deliverLeaseAt = Game.time;
  if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    smartMoveTo(creep, target, { visualizePathStyle: { stroke: stroke }, reusePath: 5 });
  }
}

/**
 * Score every delivery target and take the best.
 *
 * This replaces a chain of early returns. The chain had a structural fault that no
 * ordering fixed: any branch able to match indefinitely starved everything below it.
 * Storage almost always has free capacity, so a controller container placed after it was
 * unreachable; a tower parked at 490 under a "below 500" test captured every delivery
 * forever. Reordering only moved which branch did the starving.
 *
 * Scoring cannot starve an option, because there is no "later" - every candidate is
 * weighed on the same scale each time. Ordering that genuinely matters is expressed as
 * weight, which is also more honest than encoding it in control flow.
 *
 * Score = base(role) x urgency(how empty) x proximity. Base weights preserve the intent
 * of the old priorities; urgency lets a full structure yield to an empty one; proximity
 * breaks ties toward less walking without ever dominating need.
 */
function scoreDeliveryTargets(creep: Creep): { target: AnyStoreStructure; score: number } | null {
  const room = creep.room;
  const hasFiller = roomHasFiller(room);

  // Whether a filler EXISTS is not the question - whether it is keeping up is. Deferring
  // to a filler that has fallen behind is how E43N39 ended up with 586,590 energy in
  // storage, 19 of 30 extensions empty, 11 energy in the spawn, three haulers carrying
  // energy they refused to deliver, and no ability to spawn anything at all.
  const cap = room.energyCapacityAvailable;
  const fillRatio = cap > 0 ? room.energyAvailable / cap : 1;
  const fillerKeepingUp = hasFiller && fillRatio >= FILLER_BEHIND_FRACTION;
  const sources = room.find(FIND_SOURCES);
  const controller = room.controller;

  const chooser = new Chooser<AnyStoreStructure>();

  const candidates = room.find(FIND_MY_STRUCTURES, {
    filter: (s) => {
      const store = (s as AnyStoreStructure).store;
      return !!store && store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    },
  }) as AnyStoreStructure[];

  // Containers are not MY_STRUCTURES - add the controller container explicitly. Source
  // containers are excluded: collect() draws from those, so delivering into one lets a
  // hauler withdraw and immediately deposit into the same structure.
  if (controller) {
    const ctrlContainers = controller.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
        !sources.some((src) => src.pos.getRangeTo(s) <= 2),
    }) as StructureContainer[];
    for (const c of ctrlContainers) candidates.push(c);
  }

  for (const s of candidates) {
    const store = s.store;
    const free = store.getFreeCapacity(RESOURCE_ENERGY);
    const cap = store.getCapacity(RESOURCE_ENERGY) || 1;
    let base = 0;

    switch (s.structureType) {
      case STRUCTURE_TOWER: {
        const e = (s as StructureTower).store[RESOURCE_ENERGY];
        // A tower that cannot defend outranks everything; a topped-up one is filler work.
        base = e < TOWER_CRITICAL ? 1000 : e < TOWER_READY ? 60 : 20;
        break;
      }
      case STRUCTURE_SPAWN:
      case STRUCTURE_EXTENSION:
        // A filler owns this loop while it is coping, so haulers deprioritise it rather
        // than competing. Never zero: a zero base annihilates the score outright, which
        // turned "the filler is preferred" into "the filler is the only one allowed",
        // with no way back when it fell behind. Prefer, then fall through.
        base = fillerKeepingUp ? FILLER_PRESENT_BASE : 90;
        break;
      case STRUCTURE_CONTAINER:
        base = 55; // controller container - the only sink that produces RCL
        break;
      case STRUCTURE_STORAGE:
        base = 10; // the buffer of last resort, never zero so it is never unreachable
        break;
      case STRUCTURE_TERMINAL:
        base = 5;
        break;
      default:
        // Links belong to LINK_FILLER. Expressed by not offering the option rather than
        // by a zero score: Chooser treats a non-positive base as "not a candidate", so
        // exclusion stays a statement about the option set instead of an arithmetic
        // annihilation that other factors can never recover from.
        base = 0;
    }

    chooser.consider(
      s,
      s.structureType,
      base,
      urgencyFactor(free, cap),
      proximityFactor(creep.pos.getRangeTo(s))
    );
  }

  const winner = chooser.best();
  if (!winner) return null;
  return { target: winner.target, score: winner.score };
}

function deliver(creep: Creep): void {
  // Hold the chosen target until delivered to or invalidated.
  //
  // Scoring alone oscillates: two options scoring near-identically flip rank tick to tick
  // and the creep walks between them. Observed live before this lease existed - a hauler
  // alternated between a controller container and a low tower on opposite sides of the
  // room, crossing three tiles for 100+ ticks holding a full load. Scoring prevents
  // deadlock; the lease prevents the oscillation scoring introduces. Both are required.
  if (creep.memory.deliverTarget) {
    const leaseAge = Game.time - (creep.memory._deliverLeaseAt || 0);
    const cached = Game.getObjectById(creep.memory.deliverTarget);

    if (
      leaseAge < DELIVER_LEASE_TICKS &&
      cached &&
      cached.store &&
      cached.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    ) {
      if (creep.transfer(cached, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        smartMoveTo(creep, cached, { visualizePathStyle: { stroke: "#ffffff" }, reusePath: 5 });
      }
      return;
    }

    delete creep.memory.deliverTarget;
    delete creep.memory._deliverLeaseAt;
  }

  const best = scoreDeliveryTargets(creep);
  if (best) {
    deliverTo(creep, best.target, "#ffffff");
    return;
  }

  // Genuinely nothing accepts energy - wait near spawn but off road.
  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  if (spawn && creep.pos.getRangeTo(spawn) > 3) {
    smartMoveTo(creep, spawn, { visualizePathStyle: { stroke: "#888888" } });
  } else {
    moveOffRoad(creep);
  }
}
