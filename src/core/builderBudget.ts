/**
 * builderBudget - how many builders a colony can actually pay for.
 *
 * The mature-colony branch computed `maxBuildersByEconomy = Math.min(rcl, 4)`. The name
 * claims a measurement; the value is a proxy. RCL is not income, and at RCL 7 that is four
 * builders whether the room earns 20 energy per tick or 200. The early-colony branch
 * directly above it did do income arithmetic - only the mature path, the one running in
 * every developed room, ignored it.
 *
 * Measured live, all three colonies were CRITICAL simultaneously with an identical shape:
 * 20/tick of income against 36/tick of upgrading and 40/tick of building. Runways were 70,
 * 11 and 4 ticks. Upgraders already answered to canAffordDiscretionary and were converging
 * down to one; builders answered to nothing, so they were the larger half of a burn no room
 * could pay.
 *
 * Keyed on MEASURED burn, not on a per-builder estimate, because build burn scales with
 * body size - EconomyTracker charges `workParts * 5 * 0.5` per builder, so one 16-WORK
 * builder burns 40/tick by itself and counting heads would have missed it entirely.
 *
 * Pure and dependency-free so it can be unit tested; ColonyTargets pulls in ColonyManager
 * and LinkManager, so anything left inside it cannot be. See
 * tests/unit/builderBudget.test.ts.
 */

/**
 * Share of income a room may spend on construction while it is otherwise insolvent. The
 * remainder has to cover spawning, upgrading and rebuilding the buffer - a room that spends
 * everything on sites never accumulates the storage that would let it build freely.
 */
export const BUILD_INCOME_SHARE = 0.3;

export interface BuilderBudgetInput {
  rcl: number;
  /** Construction sites in the room. */
  totalSites: number;
  /** Income per tick including remote, from EconomyTracker. */
  totalIncome: number;
  /** Measured build burn per tick, from EconomyTracker. */
  buildBurn: number;
  /** Builders currently alive in this room. */
  builders: number;
  /** Whether the room can afford discretionary work at all. */
  canAfford: boolean;
}

/**
 * The builder target for a developed room.
 *
 * A solvent room builds to its site count as before. An insolvent one whose construction
 * burn exceeds its share of income sheds one builder per death: converging rather than
 * lurching, and reversing on its own once income recovers - the same mechanism the upgrader
 * cap uses, for the same reason.
 *
 * Unlike upgraders, the floor is zero. An upgrader floor of one exists to keep the
 * controller off downgrade; construction has no such deadline, and sites simply wait.
 */
export function builderTargetFor(i: BuilderBudgetInput): number {
  if (i.totalSites <= 0) return 0;

  const byStructure = Math.min(Math.ceil(i.totalSites / 10), Math.min(i.rcl, 4));

  // Solvent: a buffer or positive flow means the room can spend on sites.
  if (i.canAfford) return byStructure;

  // Insolvent, but construction is not the reason - cutting builders would not fix it.
  if (i.buildBurn <= i.totalIncome * BUILD_INCOME_SHARE) return byStructure;

  return Math.max(0, Math.min(byStructure, i.builders - 1));
}
