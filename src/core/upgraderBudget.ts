/**
 * upgraderBudget - how many upgraders a colony wants, and how many it can pay for.
 *
 * The poverty cap here was the last spawn decision still keyed on `canAffordDiscretionary`.
 * Every other one - the builder headcount, and the body clamp on both spawn paths - was
 * moved to `hasSpendableBuffer` after the same defect was measured twice. EconomyTracker's
 * own doc comment states the rule the upgrader path did not follow: "a body or a headcount
 * is a commitment for the creep's whole 1,500-tick life, so it has to answer to stock, not
 * to a one-tick reading of flow."
 *
 * `canAffordDiscretionary` returns true on `netFlow >= 0`, and netFlow is computed from the
 * creeps currently alive - so it reads healthiest at the exact moment the room has just shed
 * the burn that was sinking it. The cap therefore released one death before it had finished
 * converging, the target reverted to its RCL value, and the room respawned what it had just
 * shed. Measured live at E46N37: 20/tick income against 18/tick of upgrading across three
 * upgraders, netFlow -3.3, stored 112, runway 33 - held there rather than converging, with
 * the cap switching itself off every time it made progress.
 *
 * Pure and dependency-free so it can be unit tested; ColonyTargets pulls in ColonyManager
 * and LinkManager, so anything left inside it cannot be. See tests/unit/upgraderBudget.test.ts.
 */

/**
 * Share of a room's harvest income that upgrading may consume when there is no storage
 * buffer. The remainder has to cover spawning, repair, and rebuilding the buffer - a room
 * that spends everything on the controller never accumulates the storage that would let
 * it spend more.
 */
export const UPGRADE_INCOME_SHARE = 0.5;

/**
 * Extra upgraders a storage-rich room may add beyond its base target, so a full store can
 * spend its way out instead of dropping energy on the ground.
 */
export const MAX_SURPLUS_UPGRADERS = 4;

export interface UpgraderBudgetInput {
  rcl: number;
  /** RCL 1-3 without storage: milestone-driven rather than RCL-driven. */
  isEarlyColony: boolean;
  /** Early colonies only: whether every extension for this RCL is built. */
  allExtensions: boolean;
  /** Energy in storage, or null when the room has none. */
  storedInStorage: number | null;
  /** CONFIG.ENERGY.STORAGE_THRESHOLDS.high - the dead-capital mark. */
  storageHigh: number;
  /** Controller close enough to downgrade that upgrading stops being discretionary. */
  downgradeRisk: boolean;
  /** Whether the room holds a real buffer. Stock, never flow - see the file comment. */
  canAfford: boolean;
  /** Measured upgrade burn per tick, from EconomyTracker. */
  upgradeBurn: number;
  /** Income per tick including remote, from EconomyTracker. */
  totalIncome: number;
  /** Upgraders currently alive in this room. */
  upgraders: number;
}

/**
 * The upgrader target for a room.
 *
 * Three rules, in order: a base target from RCL, a surplus bonus when storage is above the
 * high-water mark, and a poverty cap that sheds one upgrader per death while upgrading is a
 * meaningful share of a shortfall the room cannot cover.
 *
 * The floor is one, unlike builders. Construction has no deadline and sites simply wait; a
 * controller left unupgraded downgrades, and a room that reaches zero upgraders loses RCL.
 */
export function upgraderTargetFor(i: UpgraderBudgetInput): number {
  // Base: always at least one, because the controller is always ticking down.
  let target: number;
  if (i.isEarlyColony) {
    // Infrastructure done means the energy has somewhere better to go than the ground.
    target = i.allExtensions ? Math.min(i.rcl, 3) : 1;
  } else {
    target = i.rcl < 8 ? Math.min(i.rcl, 3) : 1;
  }

  // Surplus burn: a storage sitting above the high-water mark is dead capital, and once it
  // caps out the room starts dropping energy on the ground. The base target is capped at 3,
  // so without this a full room can never spend its way out. Upgrading is the sink that
  // always exists - convert the surplus into RCL.
  if (i.storedInStorage !== null && i.rcl < 8 && i.storedInStorage > i.storageHigh) {
    const step = i.storageHigh / 2;
    const surplus = Math.min(Math.floor((i.storedInStorage - i.storageHigh) / step), MAX_SURPLUS_UPGRADERS);
    target += surplus;
  }

  // Poverty scales the target DOWN, the mirror of the surplus rule above. The target used to
  // scale up with wealth and never down with need: at RCL 7 it was an unconditional 3
  // regardless of whether the room had anything to feed them. E46N37 and E47N41 both ran
  // three upgraders on zero storage with their extensions two-thirds empty, burning the
  // energy that should have been refilling the spawn - and, in a cramped base, those parked
  // upgraders were the creeps physically boxing the haulers in.
  //
  // A controller actually near downgrade outranks the economy: that is the one case where
  // upgrading is not discretionary.
  if (i.downgradeRisk || target <= 1 || i.canAfford) return target;

  // Insolvent, but upgrading is not the reason - cutting upgraders would not fix it.
  if (i.upgradeBurn <= i.totalIncome * UPGRADE_INCOME_SHARE) return target;

  // Shed one per death: converges downward instead of lurching, and reverses on its own
  // when income recovers.
  //
  // No `upgraders > 1` guard here, deliberately. An earlier version had one and it made the
  // cap oscillate rather than converge: E46N37 shed to a single upgrader, the guard then
  // switched the cap off, the target reverted to 3, and it immediately spawned a 54-WORK
  // replacement into a room earning 20/tick. The arithmetic already holds the floor at one -
  // min(target, upgraders - 1) is 0 when a lone upgrader remains, and max(1, ...) lifts it
  // back - so the count needs no separate guard.
  return Math.max(1, Math.min(target, i.upgraders - 1));
}
