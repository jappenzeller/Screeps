/**
 * workerEnergy - where a worker creep picks energy up.
 *
 * Builder, RemoteBuilder and RoadBuilder each carried a hand-written copy of the same
 * chain, and two of the three opened with "storage, if it holds more than 1,000". Storage
 * in a developed room nearly always does, so the container and dropped-energy branches
 * below it were unreachable in practice - dropped energy decayed on the ground while a
 * worker walked across the room to storage. Design rule 2.
 *
 * RemoteBuilder kept a *fourth* copy: `hasCollectableEnergy()` mirrored its own
 * `collectEnergy()` branch for branch, with a comment warning that if the two ever
 * diverged the creep would "either strand or thrash". One owner removes the possibility,
 * because the release check now asks the same function that does the collecting.
 *
 * The 1,000-energy floor on storage is deliberately gone. A hard floor means "no source at
 * all" the moment storage dips below it, which is the shape that left E46N37's haulers
 * parked while extensions sat empty. Under scoring a nearly-empty storage simply loses on
 * supply instead of vanishing from the option set.
 *
 * Deliberately free of movement imports so the decision can be unit tested with mock
 * rooms - see tests/unit/workerEnergy.test.ts. Callers perform the move themselves, which
 * they need to anyway: each role uses its own path styling and reuse.
 */

import { Chooser, proximityFactor, supplyFactor } from "../core/Decision";

export type WorkerEnergyAction = "withdraw" | "pickup" | "harvest";

export interface WorkerEnergyChoice {
  target: RoomObject;
  kind: WorkerEnergyAction;
  score: number;
}

/**
 * Standing weights. Relative order is what matters: supply and distance scale each one, so
 * a nearly-empty source of a high base still loses to a full source of a lower one.
 */
export const WORKER_ENERGY_BASE = {
  /** The bulk supply, and the only one that does not run out mid-job. */
  STORAGE: 80,
  /** Decays every tick it sits, so taking it is strictly better than ignoring it. */
  DROPPED: 75,
  /** Expires outright, and faster than dropped energy for a large creep's remains. */
  TOMBSTONE: 78,
  /** The ordinary intermediate store. */
  CONTAINER: 70,
  /** Decays, but slowly - worth collecting, not worth crossing a room for. */
  RUIN: 72,
  /**
   * Direct harvest, low but never absent. A worker that can always fall back to a
   * regenerating source can never be stranded, which is why Builder was exempt from the
   * exact-maximum deadlock that hit Hauler and RemoteBuilder.
   */
  HARVEST: 25,
} as const;

/** Smallest dropped pile worth a detour. Was 30 in RoadBuilder and 50 in the others. */
export const MIN_PICKUP = 50;

/** Container floor. Was 200 in RemoteBuilder, 100 in RoadBuilder, 50 in Builder. */
export const MIN_CONTAINER = 50;

export interface WorkerEnergyOptions {
  /**
   * Whether direct harvesting is allowed. A builder at home may mine; a remote builder
   * should head home rather than start mining in someone else's room.
   */
  allowHarvest?: boolean;
  /**
   * Room to draw from. Defaults to the room the creep is standing in. RemoteBuilder passes
   * its home room to ask "would there be anything to collect if I went back", in which
   * case distances are meaningless and only the presence of a choice is used.
   */
  room?: Room;
}

/** The best place for this worker to take energy from right now, or null. */
export function scoreWorkerEnergy(
  creep: Creep,
  opts: WorkerEnergyOptions = {}
): WorkerEnergyChoice | null {
  const room = opts.room || creep.room;
  const need = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 1;
  const chooser = new Chooser<{ target: RoomObject; kind: WorkerEnergyAction }>();

  const consider = (
    target: RoomObject,
    kind: WorkerEnergyAction,
    base: number,
    available: number
  ): void => {
    if (available <= 0) return;
    chooser.consider(
      { target, kind },
      kind,
      base,
      supplyFactor(available, need),
      proximityFactor(creep.pos.getRangeTo(target))
    );
  };

  const storage = room.storage;
  if (storage) {
    consider(storage, "withdraw", WORKER_ENERGY_BASE.STORAGE, storage.store[RESOURCE_ENERGY]);
  }

  const containers = room.find(FIND_STRUCTURES, {
    filter: (s: AnyStructure) =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as StructureContainer).store[RESOURCE_ENERGY] > MIN_CONTAINER,
  }) as StructureContainer[];
  for (const c of containers) {
    consider(c, "withdraw", WORKER_ENERGY_BASE.CONTAINER, c.store[RESOURCE_ENERGY]);
  }

  const dropped = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r: Resource) => r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_PICKUP,
  });
  for (const d of dropped) {
    consider(d, "pickup", WORKER_ENERGY_BASE.DROPPED, d.amount);
  }

  // Tombstones and ruins were Pioneer's alone, as tiers 2 and 3 of its own chain. Folding
  // them in here is what let that chain be replaced without losing anything, and it gives
  // the three builder roles a recovery path they never had - a dead hauler's full load used
  // to decay untouched unless a pioneer happened to be in the room.
  const tombstones = room.find(FIND_TOMBSTONES, {
    filter: (t: Tombstone) => t.store[RESOURCE_ENERGY] >= MIN_PICKUP,
  });
  for (const t of tombstones) {
    consider(t, "withdraw", WORKER_ENERGY_BASE.TOMBSTONE, t.store[RESOURCE_ENERGY]);
  }

  const ruins = room.find(FIND_RUINS, {
    filter: (r: Ruin) => r.store[RESOURCE_ENERGY] >= MIN_PICKUP,
  });
  for (const ruin of ruins) {
    consider(ruin, "withdraw", WORKER_ENERGY_BASE.RUIN, ruin.store[RESOURCE_ENERGY]);
  }

  // Only harvest in the room the creep is actually in - a source it can see in another
  // room is not something it can mine from here.
  if (opts.allowHarvest && room.name === creep.room.name) {
    const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (source) consider(source, "harvest", WORKER_ENERGY_BASE.HARVEST, source.energy);
  }

  const winner = chooser.best();
  if (!winner) return null;
  return { target: winner.target.target, kind: winner.target.kind, score: winner.score };
}

/**
 * Perform the chosen action. Returns the raw result so the caller can move on
 * ERR_NOT_IN_RANGE with its own path styling.
 */
export function applyWorkerEnergy(creep: Creep, choice: WorkerEnergyChoice): ScreepsReturnCode {
  if (choice.kind === "withdraw") {
    return creep.withdraw(choice.target as AnyStoreStructure, RESOURCE_ENERGY);
  }
  if (choice.kind === "pickup") {
    return creep.pickup(choice.target as Resource);
  }
  return creep.harvest(choice.target as Source);
}
