/**
 * EnergyUtils: Weighted energy source selection to prevent creep congestion.
 *
 * Problem: Multiple creeps independently calculate "closest energy source" → all pick same target → traffic jam.
 * Solution: Score each source considering distance AND congestion, then pick the best.
 */

export interface EnergySource {
  type: "container" | "storage" | "dropped" | "tombstone" | "ruin";
  target: StructureContainer | StructureStorage | Resource | Tombstone | Ruin;
  energy: number;
  pos: RoomPosition;
}

interface ScoredSource extends EnergySource {
  score: number; // Lower = better
}

/**
 * Get current energy target if still valid, otherwise find a new one.
 * This prevents oscillation where creeps keep swapping targets each tick.
 */
export function getOrFindEnergySource(creep: Creep, minEnergy: number = 50): EnergySource | null {
  // Check if creep already has a valid target - stick with it to prevent oscillation
  if (creep.memory.energyTarget) {
    const existing = Game.getObjectById(creep.memory.energyTarget);
    if (existing) {
      // Check if target still has enough energy
      let energy = 0;
      let type: EnergySource["type"] | null = null;

      if (existing instanceof Resource) {
        energy = existing.amount;
        type = "dropped";
      } else if ("store" in existing) {
        energy = (existing as { store: Store<ResourceConstant, false> }).store.energy || 0;
        if ((existing as Structure).structureType === STRUCTURE_CONTAINER) {
          type = "container";
        } else if ((existing as Structure).structureType === STRUCTURE_STORAGE) {
          type = "storage";
        } else if (existing instanceof Tombstone) {
          type = "tombstone";
        } else if (existing instanceof Ruin) {
          type = "ruin";
        }
      }

      // Target still valid - keep using it
      if (type && energy >= minEnergy) {
        return {
          type,
          target: existing as EnergySource["target"],
          energy,
          pos: existing.pos,
        };
      }
    }

    // Target invalid - clear it
    delete creep.memory.energyTarget;
  }

  // No valid existing target - find a new one
  return findBestEnergySource(creep, minEnergy);
}

/**
 * Find best energy source considering distance and congestion.
 * Uses weighted scoring to distribute creeps across available sources.
 * NOTE: Prefer using getOrFindEnergySource() to prevent oscillation.
 */
export function findBestEnergySource(creep: Creep, minEnergy: number = 50): EnergySource | null {
  const room = creep.room;
  const sources: EnergySource[] = [];

  // Containers
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store.energy >= minEnergy,
  }) as StructureContainer[];

  for (const c of containers) {
    sources.push({
      type: "container",
      target: c,
      energy: c.store.energy,
      pos: c.pos,
    });
  }

  // Storage (if exists and has energy)
  if (room.storage && room.storage.store.energy >= minEnergy) {
    sources.push({
      type: "storage",
      target: room.storage,
      energy: room.storage.store.energy,
      pos: room.storage.pos,
    });
  }

  // Dropped resources
  const dropped = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= minEnergy,
  });

  for (const d of dropped) {
    sources.push({
      type: "dropped",
      target: d,
      energy: d.amount,
      pos: d.pos,
    });
  }

  // Tombstones
  const tombstones = room.find(FIND_TOMBSTONES, {
    filter: (t) => t.store.energy >= minEnergy,
  });

  for (const t of tombstones) {
    sources.push({
      type: "tombstone",
      target: t,
      energy: t.store.energy,
      pos: t.pos,
    });
  }

  // Ruins
  const ruins = room.find(FIND_RUINS, {
    filter: (r) => r.store.energy >= minEnergy,
  });

  for (const r of ruins) {
    sources.push({
      type: "ruin",
      target: r,
      energy: r.store.energy,
      pos: r.pos,
    });
  }

  if (sources.length === 0) return null;

  // Score each source
  const scored: ScoredSource[] = sources.map((source) => ({
    ...source,
    score: calculateSourceScore(creep, source),
  }));

  // Sort by score (lower = better)
  scored.sort((a, b) => a.score - b.score);

  return scored[0];
}

/**
 * Calculate a weighted score for an energy source.
 * Lower score = better choice.
 */
function calculateSourceScore(creep: Creep, source: EnergySource): number {
  let score = 0;

  // Base: path distance (approximated by range for speed)
  const distance = creep.pos.getRangeTo(source.pos);
  score += distance;

  // Penalty: creeps already at this location
  const creepsAtTarget = source.pos.findInRange(FIND_MY_CREEPS, 1).length;
  score += creepsAtTarget * 15; // Heavy penalty for congestion

  // Penalty: creeps already targeting this (via memory)
  const creepsTargeting = countCreepsTargeting(source.target.id, creep.name);
  score += creepsTargeting * 10;

  // Bonus: more energy (prefer fuller sources)
  // Small bonus so distance still dominates
  score -= Math.min(source.energy / 100, 5);

  // Penalty: tile is blocked (creep standing on it)
  const blocked = source.pos.findInRange(FIND_MY_CREEPS, 0).length > 0;
  if (blocked) {
    score += 50; // Heavy penalty, but not infinite (they might move)
  }

  return score;
}

/**
 * Count creeps targeting a specific resource.
 */
function countCreepsTargeting(targetId: Id<_HasId>, excludeCreep: string): number {
  let count = 0;
  for (const name in Game.creeps) {
    if (name === excludeCreep) continue;
    const creep = Game.creeps[name];
    if (creep.memory.energyTarget === targetId) {
      count++;
    }
  }
  return count;
}

/**
 * Withdraw or pickup energy from a source.
 * Returns true if action taken (even if moving).
 */
export function acquireEnergy(creep: Creep, source: EnergySource): boolean {
  // Store target in memory for coordination
  creep.memory.energyTarget = source.target.id as Id<
    StructureContainer | StructureStorage | Resource | Tombstone | Ruin
  >;

  if (source.type === "dropped") {
    const result = creep.pickup(source.target as Resource);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(source.pos, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
    }
    return true;
  }

  // All others use withdraw
  const result = creep.withdraw(
    source.target as StructureContainer | StructureStorage | Tombstone | Ruin,
    RESOURCE_ENERGY
  );
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(source.pos, { visualizePathStyle: { stroke: "#ffaa00" }, reusePath: 5 });
  }

  return true;
}

/**
 * Clear energy target when done (e.g., when switching to working state).
 */
export function clearEnergyTarget(creep: Creep): void {
  delete creep.memory.energyTarget;
}
