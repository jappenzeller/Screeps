/**
 * Shadow comparison for the spawn domain.
 *
 * The framework's SpawnEvaluator is scored every tick against live state but never
 * executes. This module records what it WOULD have spawned and, at the moment
 * utilitySpawning actually spawns something, records whether the two agreed.
 *
 * Why measure instead of reason: the framework's spawn arm read correctly and failed
 * 191 times out of 191 in production. Agreement on live data is the only evidence that
 * justifies handing it the room.
 *
 * Read with fxShadow() in the console.
 */

import type { FrameworkAction } from "./types";

export interface ShadowSpawnRecord {
  /** What the shadow evaluator proposed most recently, per room. */
  want: Record<string, { role: string; tick: number }>;
  /** How often each role was proposed, per room. */
  proposals: Record<string, Record<string, number>>;
  /** Agreement tallies at ticks where a real spawn happened. */
  agree: number;
  disagree: number;
  /** Real spawns that the shadow had no proposal for at all. */
  silent: number;
  /** Most recent disagreements, newest last. */
  recent: string[];
  since: number;
}

const MAX_RECENT = 15;

/** Proposals go stale fast; a proposal older than this is not evidence about this spawn. */
const PROPOSAL_MAX_AGE = 3;

function store(): ShadowSpawnRecord {
  const mem = Memory as unknown as { _fxShadow?: ShadowSpawnRecord };
  if (!mem._fxShadow) {
    mem._fxShadow = {
      want: {},
      proposals: {},
      agree: 0,
      disagree: 0,
      silent: 0,
      recent: [],
      since: Game.time,
    };
  }
  return mem._fxShadow;
}

/** Record this tick's shadow proposals for a room. */
export function recordShadowProposals(roomName: string, actions: FrameworkAction[]): void {
  let role: string | null = null;
  for (const a of actions) {
    if (a.type === "spawn") {
      role = a.role;
      break;
    }
  }
  if (!role) return;

  const s = store();
  s.want[roomName] = { role, tick: Game.time };
  const byRoom = s.proposals[roomName] || (s.proposals[roomName] = {});
  byRoom[role] = (byRoom[role] || 0) + 1;
}

/**
 * Called when utilitySpawning actually spawns. Compares against the shadow proposal.
 */
export function recordActualSpawn(roomName: string, role: string): void {
  const s = store();
  const want = s.want[roomName];

  if (!want || Game.time - want.tick > PROPOSAL_MAX_AGE) {
    // The shadow wanted nothing while the incumbent spawned. That is a disagreement of a
    // different kind - it is how a framework in charge would have let a role lapse - so
    // it is counted, not ignored.
    s.silent++;
    push(s, `T${Game.time} ${roomName} shadow=none actual=${role}`);
    return;
  }

  if (want.role === role) {
    s.agree++;
    return;
  }

  s.disagree++;
  push(s, `T${Game.time} ${roomName} shadow=${want.role} actual=${role}`);
}

function push(s: ShadowSpawnRecord, line: string): void {
  s.recent.push(line);
  while (s.recent.length > MAX_RECENT) s.recent.shift();
}

/** Reset the comparison window. */
export function resetShadow(): void {
  const mem = Memory as unknown as { _fxShadow?: ShadowSpawnRecord };
  delete mem._fxShadow;
}

export function getShadow(): ShadowSpawnRecord {
  return store();
}
