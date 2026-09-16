/**
 * haulerDelivery - where a hauler should put energy down.
 *
 * Shared by Hauler and RemoteHauler. It was private to Hauler, and RemoteHauler kept its
 * own ordered chain whose first branch returned storage whenever storage had any free
 * capacity at all. Storage is 1,000,000 capacity and almost never full, so in every room
 * that owns one the three branches below it - controller container, spawn/extensions, any
 * container - were unreachable code. A remote hauler would cross two rooms and pour its
 * load into storage past an empty spawn.
 *
 * That is design rule 2: an early branch that can always match starves everything below
 * it. Scoring has no "below". Storage carries the lowest base of any sink precisely so the
 * buffer of last resort behaves like one, which also makes RemoteHauler's separate
 * emergency case unnecessary - spawn and extensions outrank storage by weight now, not by
 * position in a list.
 *
 * Kept free of the haulers' movement and renewal imports so the decision can be unit
 * tested with mock rooms - see tests/unit/haulerDelivery.test.ts.
 */

import { Chooser, proximityFactor, urgencyFactor } from "../core/Decision";
import { terminalFlow } from "../structures/TerminalManager";

/** Below this a tower cannot meaningfully defend - it outranks every other sink. */
export const TOWER_CRITICAL = 300;

/** Below this a tower is under-provisioned but not an emergency. */
export const TOWER_READY = 500;

/**
 * Spawn+extension fill below this fraction of capacity means the filler is not coping,
 * whatever its intentions, and haulers resume filling at full priority.
 */
export const FILLER_BEHIND_FRACTION = 0.5;

/**
 * Base weight for spawn/extension delivery while a filler IS coping. Low enough that
 * haulers prefer other work, never zero - a zero base cannot be recovered from by any
 * amount of urgency.
 */
export const FILLER_PRESENT_BASE = 12;

/**
 * Check if room has an active FILLER creep (cached per tick for CPU efficiency).
 * When a filler exists and is keeping up, haulers deprioritise spawn/extension filling.
 */
export function roomHasFiller(room: Room): boolean {
  const cached = (room as unknown as { _fillerCheck?: { tick: number; result: boolean } })
    ._fillerCheck;
  if (cached && cached.tick === Game.time) return cached.result;

  const result =
    room.find(FIND_MY_CREEPS, {
      filter: function (c) {
        return c.memory.role === "FILLER" && (!c.ticksToLive || c.ticksToLive > 50);
      },
    }).length > 0;

  (room as unknown as { _fillerCheck?: { tick: number; result: boolean } })._fillerCheck = {
    tick: Game.time,
    result: result,
  };
  return result;
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
 *
 * Scores the room the creep is standing in. Both callers deliver at home: RemoteHauler
 * returns early and walks home before this runs.
 */
export function scoreDeliveryTargets(
  creep: Creep
): { target: AnyStoreStructure; score: number } | null {
  const room = creep.room;
  const hasFiller = roomHasFiller(room);

  // Whether a filler EXISTS is not the question - whether it is keeping up is. Deferring
  // to a filler that has fallen behind is how E43N39 ended up with 586,590 energy in
  // storage, 19 of 30 extensions empty, 11 energy in the spawn, three haulers carrying
  // energy they refused to deliver, and no ability to spawn anything at all.
  const roomCap = room.energyCapacityAvailable;
  const fillRatio = roomCap > 0 ? room.energyAvailable / roomCap : 1;
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
        // A terminal that cannot send is a structure the colony paid 100,000 energy for
        // and never uses. Filling it outranks topping up an already-deep storage, but
        // stays below the spawn network and the controller container - the room's own
        // creeps come first, and TerminalManager only gives away real surplus anyway.
        // Same owner as collection. A draining terminal is not offered at all (base 0) -
        // at base 5 a terminal one tile away could still out-score a distant storage on
        // proximity, and the hauler would put back what collection just took out.
        {
          const flow = terminalFlow(room);
          base = flow === "fill" ? 45 : flow === "hold" ? 5 : 0;
        }
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
