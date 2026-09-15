/**
 * haulerCollection - where a hauler should pick energy up from.
 *
 * Collection used to be a seven-tier priority chain in Hauler.collect(). In a single
 * feature, two of its tiers turned out to be branches that could always match, and each
 * silently starved the tier below it:
 *
 *   - collectFromContainers() returned true whenever the hauler had a target container
 *     with a miner beside it - almost always - so the terminal drain placed after it
 *     never ran once.
 *   - Moved above that, the drain still sat below the adjacent-container shortcut, which
 *     fires for any hauler parked beside a source container refilling at 10/tick.
 *
 * E46N37 held exactly 30,000 delivered energy through both fixes while its extensions ran
 * down. Delivery was converted to scoring earlier and has not produced a defect of this
 * shape since; collection produced two in one feature. A scored decision has no tier
 * below that can be starved, which is the point of the conversion.
 *
 * Kept free of Hauler.ts's other imports so the decision can be unit tested with mock
 * rooms - see tests/unit/haulerCollection.test.ts.
 */

import { Chooser, proximityFactor, supplyFactor } from "../core/Decision";
import { terminalFlow } from "../structures/TerminalManager";

export type CollectTarget = AnyStoreStructure | Resource | Tombstone;
export type CollectKind = "withdraw" | "pickup";

/**
 * Standing weights. Relative order is what matters, not absolute value: supply and
 * distance scale each one, so a nearly-empty source of a high base still loses to a full
 * source of a lower one.
 */
export const COLLECT_BASE = {
  /** Expires outright - take it or lose it. */
  TOMBSTONE: 75,
  /**
   * Delivered from another colony and unspendable until moved. Larger and already mined,
   * so it beats a source container refilling at 10/tick.
   */
  TERMINAL_DRAIN: 70,
  /** Decays every tick it sits. */
  DROPPED: 65,
  /** The ordinary job. */
  SOURCE_CONTAINER: 60,
  /** Last resort - storage is where hauled energy goes, not where it comes from. */
  STORAGE: 20,
} as const;

/** Storage is only a pickup point above this; below it, it is the room's working capital. */
export const STORAGE_COLLECT_MIN = 10000;

/** Smallest drop or tombstone worth a trip. */
export const MIN_PICKUP = 50;

/**
 * Continuity bonus for the container runHauler() assigned. Keeps the partial-load release
 * there meaningful and stops haulers re-shuffling between two near-equal containers.
 */
export const ASSIGNED_AFFINITY = 1.25;

/** Energy a target currently offers. */
export function energyIn(target: CollectTarget): number {
  const asResource = target as Resource;
  if (asResource.resourceType !== undefined && asResource.amount !== undefined) {
    return asResource.resourceType === RESOURCE_ENERGY ? asResource.amount : 0;
  }
  const store = (target as AnyStoreStructure | Tombstone).store;
  return store ? store[RESOURCE_ENERGY] || 0 : 0;
}

/** Dropped resources are picked up; everything else is withdrawn from. */
export function kindOf(target: CollectTarget): CollectKind {
  return (target as Resource).amount !== undefined ? "pickup" : "withdraw";
}

/**
 * Whether a leased target is still worth continuing toward.
 *
 * A terminal is only collectable while its flow is "drain", and the lease has to re-check
 * that rather than just the energy. A room crossing from recipient to sender flips its
 * terminal to "fill" mid-trip, and a hauler still holding the old lease would withdraw
 * from the structure the delivery scoring is now filling - the FLAP loop this module
 * exists to end.
 */
export function stillCollectable(room: Room, target: CollectTarget): boolean {
  if (energyIn(target) <= 0) return false;
  if ((target as Structure).structureType === STRUCTURE_TERMINAL) {
    return terminalFlow(room) === "drain";
  }
  return true;
}

/**
 * The best place for this hauler to collect from right now, or null when nothing in the
 * room holds energy worth taking.
 */
export function scoreCollectionSources(
  creep: Creep
): { target: CollectTarget; kind: CollectKind } | null {
  const room = creep.room;
  const need = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 1;
  const chooser = new Chooser<{ target: CollectTarget; kind: CollectKind }>();

  const offer = (target: CollectTarget, base: number, ...extra: number[]): void => {
    const available = energyIn(target);
    if (available <= 0) return;
    const kind = kindOf(target);
    chooser.consider(
      { target, kind },
      kind,
      base,
      supplyFactor(available, need),
      proximityFactor(creep.pos.getRangeTo(target)),
      ...extra
    );
  };

  // Terminal: only while draining. Delivery offers it only while filling, and both read
  // terminalFlow(), so the two can never work the same terminal in opposite directions.
  const terminal = room.terminal;
  if (terminal && terminalFlow(room) === "drain") {
    offer(terminal, COLLECT_BASE.TERMINAL_DRAIN);
  }

  // Source containers, discounted by how many other haulers are already collecting from
  // each - the spreading selectContainer() did, kept so haulers do not all queue at one.
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s: AnyStructure) =>
      s.structureType === STRUCTURE_CONTAINER && s.pos.findInRange(FIND_SOURCES, 1).length > 0,
  }) as StructureContainer[];

  if (containers.length > 0) {
    const claimed: Record<string, number> = {};
    for (const name in Game.creeps) {
      const other = Game.creeps[name];
      if (other.name === creep.name) continue;
      if (other.memory.role !== "HAULER" || other.memory.state !== "COLLECTING") continue;
      const key = (other.memory._collectTarget || other.memory.targetContainer) as
        | string
        | undefined;
      if (key) claimed[key] = (claimed[key] || 0) + 1;
    }

    for (const container of containers) {
      const competitors = claimed[container.id] || 0;
      const affinity = container.id === creep.memory.targetContainer ? ASSIGNED_AFFINITY : 1;
      offer(container, COLLECT_BASE.SOURCE_CONTAINER, 1 / (competitors + 1), affinity);
    }
  }

  const drops = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r: Resource) => r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_PICKUP,
  });
  for (const drop of drops) offer(drop, COLLECT_BASE.DROPPED);

  const tombstones = room.find(FIND_TOMBSTONES, {
    filter: (t: Tombstone) => t.store[RESOURCE_ENERGY] >= MIN_PICKUP,
  });
  for (const tomb of tombstones) offer(tomb, COLLECT_BASE.TOMBSTONE);

  // Storage only while the spawn network is short. Offered unconditionally, a hauler with
  // full extensions would withdraw from storage and deliver straight back into it, because
  // storage is always a valid delivery target.
  const storage = room.storage;
  if (
    storage &&
    storage.store[RESOURCE_ENERGY] > STORAGE_COLLECT_MIN &&
    room.energyAvailable < room.energyCapacityAvailable
  ) {
    offer(storage, COLLECT_BASE.STORAGE);
  }

  const winner = chooser.best();
  return winner ? winner.target : null;
}
