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
 *   - Every gate here has a release. The receive holdoff, the cooldown and the minimum send are
 *     all conditions that clear on their own.
 */

import { Chooser, proximityFactor } from "../core/Decision";
import { getColonyEconomy } from "../core/EconomyTracker";
import * as Liveness from "../core/Liveness";
import { logger } from "../utils/Logger";

/**
 * Ticks after receiving a transfer during which a room cannot send one.
 *
 * Surplus counts terminal energy, so a recipient that has just been sent 30,000 would
 * otherwise read as rich and pass it straight on - a cascade that pays the send overhead
 * at every hop and lands nowhere useful. Long enough to spend a delivery, which takes a
 * few hundred ticks; it clears on its own.
 */
export const RECEIVE_HOLDOFF = 3000;

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
 * Solvency first: a room running at a deficit has no surplus no matter what its bank
 * says, because that bank is what is keeping it alive.
 *
 * The bank is storage PLUS terminal. Counting storage alone would make a sender's role
 * depend on where its haulers had put the energy: filling the terminal would drain
 * storage below the floor, demote the room to a non-sender, drain the terminal back into
 * storage, and promote it again - the same energy shuttled back and forth by the very
 * decision meant to stop that. needOf() already counts terminal energy for the same
 * reason.
 */
export function surplusOf(room: Room): number {
  if (!room.terminal || !room.storage) return 0;
  if (receivedRecently(room.name)) return 0;

  const economy = getColonyEconomy(room);
  if (economy.netFlow < 0) return 0;

  const bank = room.storage.store[RESOURCE_ENERGY] + room.terminal.store[RESOURCE_ENERGY];
  if (bank < SENDER_MIN_STORAGE) return 0;

  return bank - SENDER_MIN_STORAGE;
}

/** True when this room was sent energy within RECEIVE_HOLDOFF ticks. */
function receivedRecently(roomName: string): boolean {
  for (const record of history()) {
    if (record.to === roomName && Game.time - record.tick < RECEIVE_HOLDOFF) return true;
  }
  return false;
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
      // terminal is meant to be drained and refilled; terminalFlow() governs filling.
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

export type TerminalFlow = "fill" | "drain" | "hold";

/**
 * Which way energy should move through this room's terminal - the ONE answer that both
 * the hauler's collection and its delivery scoring read.
 *
 * There used to be two answers, terminalWantsEnergy() for delivery and terminalHasSpare()
 * for collection, and they drifted into overlap. A recipient wanted energy below 5,000 and
 * had spare above 0; a sender wanted it below 25,000 and had spare above 5,000. Inside
 * either band the same hauler filled and drained the same structure, and E46N37's two
 * haulers were caught hovering at its terminal carrying nothing, flagged FLAP. Returning
 * a single value makes that overlap unrepresentable.
 *
 *   - A sender stocks a sendable pile up to TERMINAL_MAX, only while storage itself still
 *     holds the working floor, and sheds only what is over the cap.
 *   - Anything else spends what it was sent: drain to empty, never stock.
 */
export function terminalFlow(room: Room): TerminalFlow {
  const terminal = room.terminal;
  if (!terminal) return "hold";
  const held = terminal.store[RESOURCE_ENERGY];

  if (surplusOf(room) > 0) {
    if (held > TERMINAL_MAX) return "drain";
    const stored = room.storage ? room.storage.store[RESOURCE_ENERGY] : 0;
    // Pull more in only while storage still holds the floor. Past that, storage is the
    // room's working capital - upgraders and builders draw from it, not from the
    // terminal - so the pile stops growing rather than starving them.
    if (held < TERMINAL_MAX && stored >= SENDER_MIN_STORAGE) return "fill";
    return "hold";
  }

  return held > 0 ? "drain" : "hold";
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
  if (!plan) {
    // No room holds surplus above SENDER_MIN_STORAGE, or no room needs it. This is the
    // steady state most of the time and it is correct - but with no idle() call here the
    // registry counted all 1,087 runs as work never done and reported ALWAYS_NOOP against
    // a system behaving exactly as designed. Live right now: every bank sits below the
    // 20,000 sender floor, so there is genuinely nothing to send.
    Liveness.idle("TerminalManager");
    return;
  }

  const sender = Game.rooms[plan.from];
  if (!sender || !sender.terminal) {
    // Deliberately NOT idle: planTransfer named a sender with no terminal, which is an
    // internal inconsistency rather than an absence of work, and should surface as one.
    return;
  }

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

