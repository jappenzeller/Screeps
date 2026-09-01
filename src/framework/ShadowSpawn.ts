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

import type { FrameworkAction, ScoredOption } from "./types";

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
  /**
   * Latest top scores per room, as "ROLE:score". A shadow evaluator proposing the same
   * role in every room regardless of state is not agreeing with reality - it is failing
   * to discriminate - and only the runner-up scores show which it is.
   */
  scores: Record<string, string[]>;
  since: number;
}

const MAX_RECENT = 15;

/** Proposals go stale fast; a proposal older than this is not evidence about this spawn. */
const PROPOSAL_MAX_AGE = 3;

function store(): ShadowSpawnRecord {
  const mem = Memory as unknown as { _fxShadow?: Partial<ShadowSpawnRecord> };

  // Backfill fields added after a record was first written. Without this, extending the
  // diagnostic silently records nothing on any live colony that already has one, and the
  // empty field reads as "the evaluator produced no scores" rather than "new field".
  const existing = mem._fxShadow;
  if (existing) {
    if (!existing.scores) existing.scores = {};
    if (!existing.want) existing.want = {};
    if (!existing.proposals) existing.proposals = {};
    if (!existing.recent) existing.recent = [];
    if (typeof existing.silent !== "number") existing.silent = 0;
  }

  if (!mem._fxShadow) {
    mem._fxShadow = {
      want: {},
      proposals: {},
      agree: 0,
      disagree: 0,
      silent: 0,
      recent: [],
      scores: {},
      since: Game.time,
    };
  }
  return mem._fxShadow as ShadowSpawnRecord;
}

/**
 * Record the shadow evaluator's scored options for a room, so a flat or degenerate
 * ranking is visible without needing console output (which needs a websocket).
 */
export function recordShadowScores(
  roomName: string,
  options: ScoredOption<FrameworkAction>[]
): void {
  if (options.length === 0) return;
  const s = store();
  const top: string[] = [];
  for (let i = 0; i < options.length && i < 5; i++) {
    const o = options[i];
    // Show the raw score alongside the bounded one. Compression is invisible from the
    // bounded value alone, and "both options were far above the ceiling" is a different
    // situation from "both options scored 96".
    const shown = Math.round(o.score * 10) / 10;
    const raw = o.raw === undefined ? shown : o.raw;
    top.push(o.label + ":" + shown + (raw > shown + 0.5 ? "(raw " + Math.round(raw) + ")" : ""));
  }
  s.scores[roomName] = top;
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
