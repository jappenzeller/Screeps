/**
 * TerminalManager - moves surplus energy between colonies.
 *
 * The colony's three rooms are not equally able to feed themselves. E43N39 has remotes
 * and banks tens of thousands of energy; E46N37 is boxed in on all three exits by a
 * larger neighbour and can never hold more than its own two sources produce. Terminals
 * are the only way surplus reaches the rooms that cannot generate it.
 *
 * Design notes, all of them things this codebase has already paid to learn:
 *
 *   - Surplus and deficit come from EconomyTracker, the single owner of "can this room
 *     afford it". BUILD_PLANNER_IMPLEMENTATION.md specifies absolute thresholds (deficit
 *     below 50K, surplus above 200K) which suit a mature empire and would never once fire
 *     here - the richest room has peaked at 46K. A threshold that is never met is a
 *     feature that does not exist.
 *
 *   - The recipient is SCORED, not picked by the first matching branch. Two rooms at zero
 *     storage differ in how badly they need the energy and in what it costs to get there,
 *     and a branch chain would silently always pick the same one.
 *
 *   - Every gate here has a release. The reserve, the cooldown and the minimum send are
 *     all conditions that clear on their own.
 */

import { Chooser, proximityFactor } from "../core/Decision";
import { getColonyEconomy } from "../core/EconomyTracker";
import * as Liveness from "../core/Liveness";
import { logger } from "../utils/Logger";

/**
 * Energy a terminal keeps on hand so it can act the moment a recipient appears.
 *
 * Not a hoard: it is roughly two useful sends. Below this the room fills the terminal
 * instead of sending from it.
 */
export const TERMINAL_RESERVE = 5000;

/**
 * Energy above which the terminal stops being filled. Terminal space is finite and
 * shared with minerals later; parking the whole bank here helps nobody.
 */
export const TERMINAL_MAX = 25000;

/**
 * Storage a sender must hold before it gives anything away.
 *
 * Deliberately modest and expressed against this colony's real scale. The sender also has
 * to be solvent, which is the check that actually protects it - a room can hold a large
 * bank while bleeding, and giving energy away then would be wrong.
 */
export const SENDER_MIN_STORAGE = 20000;

/** A recipient is in deficit below this. Above it, it can wait for its own income. */
export const RECIPIENT_MAX_STORAGE = 10000;

/** Never send less than this - the per-transfer overhead makes dribbles wasteful. */
export const MIN_SEND = 2000;

/** Largest single transfer, so one send cannot empty the sender's terminal. */
export const MAX_SEND = 10000;

/** Terminals have a 10-tick cooldown; running more often is wasted CPU. */
const RUN_INTERVAL = 10;

export interface TransferPlan {
  from: string;
  to: string;
  amount: number;
  /** Energy the send itself consumes, on top of `amount`. */
  cost: number;
  reason: string;
}

/**
 * Energy a send costs on top of the amount delivered.
 *
 * Exported so the planner and the tests agree on the arithmetic rather than each carrying
 * their own copy of the formula.
 */
export function sendCost(amount: number, from: string, to: string): number {
  const distance = Game.map.getRoomLinearDistance(from, to, true);
  return Math.ceil(amount * (1 - Math.exp(-distance / 30)));
}

/**
 * How much a room can give away without hurting itself.
 *
 * Solvency first: a room running at a deficit has no surplus no matter what its storage
 * says, because that storage is what is keeping it alive.
 */
export function surplusOf(room: Room): number {
  if (!room.terminal || !room.storage) return 0;

  const economy = getColonyEconomy(room);
  if (economy.netFlow < 0) return 0;

  const stored = room.storage.store[RESOURCE_ENERGY];
  if (stored < SENDER_MIN_STORAGE) return 0;

  return stored - SENDER_MIN_STORAGE;
}

/**
 * How badly a room needs energy delivered, 0 when it does not.
 *
 * Scaled rather than boolean so the chooser can rank two needy rooms against each other.
 */
export function needOf(room: Room): number {
  if (!room.terminal) return 0;

  // Count what is already sitting in the terminal as delivered. Without this a recipient
  // keeps asking while holding a full terminal - E46N37 accumulated 30,000 across three
  // sends and still reported a need of 2.15, because need was measured from storage and
  // extensions alone and the delivered energy was invisible to it.
  const inTerminal = room.terminal.store[RESOURCE_ENERGY];
  const stored = (room.storage ? room.storage.store[RESOURCE_ENERGY] : 0) + inTerminal;
  if (stored >= RECIPIENT_MAX_STORAGE) return 0;

  // An empty spawn network is the urgent case - it is what stops a room replacing its
  // creeps - so weigh that more heavily than an empty bank.
  const cap = room.energyCapacityAvailable;
  const fillGap = cap > 0 ? 1 - room.energyAvailable / cap : 0;
  const bankGap = 1 - stored / RECIPIENT_MAX_STORAGE;

  return 1 + fillGap * 3 + bankGap;
}

/**
 * Choose the best transfer available across the empire this tick, or null.
 *
 * Pure apart from reading room state, so the tests can drive it with mock rooms.
 */
export function planTransfer(rooms: Room[]): TransferPlan | null {
  const senders: Array<{ room: Room; surplus: number }> = [];
  const recipients: Array<{ room: Room; need: number }> = [];

  for (const room of rooms) {
    if (!room.controller || !room.controller.my || !room.terminal) continue;

    const surplus = surplusOf(room);
    if (surplus > 0 && room.terminal.store[RESOURCE_ENERGY] >= MIN_SEND) {
      senders.push({ room, surplus });
    }

    const need = needOf(room);
    if (need > 0) recipients.push({ room, need });
  }

  if (senders.length === 0 || recipients.length === 0) return null;

  const chooser = new Chooser<TransferPlan>();

  for (const sender of senders) {
    if (sender.room.terminal!.cooldown > 0) continue;

    for (const recipient of recipients) {
      if (recipient.room.name === sender.room.name) continue;

      // Send what the recipient can use, bounded by what the terminal actually holds and
      // by the sender's surplus - never by the sender's whole bank.
      //
      // No separate reservation subtracted here. An earlier version did `held - MIN_SEND`
      // and then also required `amount >= MIN_SEND`, so the terminal silently needed
      // twice MIN_SEND before it could send at all - a stricter gate than either constant
      // describes, which is how thresholds in this codebase have gone wrong before. The
      // terminal is meant to be drained and refilled; TERMINAL_RESERVE governs filling.
      const available = sender.room.terminal!.store[RESOURCE_ENERGY];
      const amount = Math.min(MAX_SEND, available, sender.surplus);
      if (amount < MIN_SEND) continue;

      const cost = sendCost(amount, sender.room.name, recipient.room.name);

      chooser.consider(
        {
          from: sender.room.name,
          to: recipient.room.name,
          amount,
          cost,
          reason: `need ${recipient.need.toFixed(2)}, surplus ${sender.surplus}`,
        },
        `${sender.room.name}->${recipient.room.name}`,
        100,
        recipient.need,
        // Nearer costs less to reach, but need dominates - a desperate far room still
        // beats a mildly short near one.
        proximityFactor(Game.map.getRoomLinearDistance(sender.room.name, recipient.room.name, true) * 8)
      );
    }
  }

  const winner = chooser.best();
  return winner ? winner.target : null;
}

/**
 * True when this room's haulers should be topping up the terminal rather than storage.
 *
 * Read by the hauler's delivery scoring, so filling is a preference expressed in the same
 * currency as every other delivery rather than a separate task type that could starve.
 */
export function terminalWantsEnergy(room: Room): boolean {
  if (!room.terminal) return false;
  const held = room.terminal.store[RESOURCE_ENERGY];
  if (held >= TERMINAL_MAX) return false;

  // Only worth filling if this room could plausibly be a sender - otherwise the energy is
  // better left in storage where the room's own creeps can reach it.
  return held < TERMINAL_RESERVE || surplusOf(room) > 0;
}

/** Run terminal operations. Call once per tick from the main loop. */
export function run(): void {
  if (Game.time % RUN_INTERVAL !== 0) return;
  Liveness.ran("TerminalManager");

  const rooms: Room[] = [];
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    if (room.controller && room.controller.my) rooms.push(room);
  }

  const plan = planTransfer(rooms);
  if (!plan) return;

  const sender = Game.rooms[plan.from];
  if (!sender || !sender.terminal) return;

  const result = sender.terminal.send(RESOURCE_ENERGY, plan.amount, plan.to, plan.reason);
  if (result === OK) {
    Liveness.acted("TerminalManager");
    recordTransfer(plan);
    logger.info(
      "Terminal",
      `Sent ${plan.amount} from ${plan.from} to ${plan.to} (cost ${plan.cost}) - ${plan.reason}`
    );
  } else {
    logger.warn("Terminal", `send ${plan.from}->${plan.to} failed: ${result}`);
  }
}

export interface TransferRecord {
  tick: number;
  from: string;
  to: string;
  amount: number;
  cost: number;
}

/** How many recent transfers to keep. Enough to see a pattern, small enough for Memory. */
const MAX_HISTORY = 10;

/**
 * Keep a short history so the transfer loop can be seen working - or seen not working.
 *
 * Every silent system in this codebase cost real time to find. A feature that moves energy
 * between rooms and leaves no trace would be the next one.
 */
function recordTransfer(plan: TransferPlan): void {
  const mem = Memory as unknown as { _terminal?: TransferRecord[] };
  if (!mem._terminal) mem._terminal = [];

  mem._terminal.push({
    tick: Game.time,
    from: plan.from,
    to: plan.to,
    amount: plan.amount,
    cost: plan.cost,
  });

  while (mem._terminal.length > MAX_HISTORY) mem._terminal.shift();
}

/** Recent transfers, newest last. */
export function history(): TransferRecord[] {
  const mem = Memory as unknown as { _terminal?: TransferRecord[] };
  return mem._terminal || [];
}

/**
 * True when this room's haulers should be draining the terminal into the room.
 *
 * The other half of a transfer, and the half that makes it worth anything. Energy that
 * lands in a recipient's terminal and stays there has been moved from one place the room
 * cannot spend it to another: E46N37 took three deliveries, reached 30,000, and still had
 * empty extensions.
 *
 * A room only holds back what it needs to send with, and a room with no surplus needs
 * nothing - so a pure recipient drains its terminal to empty.
 */
export function terminalHasSpare(room: Room): boolean {
  if (!room.terminal) return false;
  const held = room.terminal.store[RESOURCE_ENERGY];
  if (held === 0) return false;

  // A sender keeps its reserve; a recipient keeps nothing.
  const keep = surplusOf(room) > 0 ? TERMINAL_RESERVE : 0;
  return held > keep;
}
