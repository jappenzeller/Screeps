/**
 * Invariants - assertions checked at the moment a decision is committed.
 *
 * The registry already answers two questions. Liveness: did this system run, and did
 * running accomplish anything. AnomalyDetector: is a creep frozen. Neither catches a system
 * that runs, acts, reports success, and is *wrong about the quantity* - which is what every
 * expensive defect found on 2026-09-16 turned out to be:
 *
 *   - range standing in for reachability (a builder pathing to a site it could not reach)
 *   - RCL standing in for income (`maxBuildersByEconomy = Math.min(rcl, 4)`)
 *   - capacity standing in for income (a 36-WORK upgrader in a room earning 20/tick)
 *   - seconds standing in for milliseconds (891 advisor rows judged expired)
 *   - instantaneous flow standing in for a buffer (the clamp releasing as it succeeded)
 *
 * In all five the code ran, acted, and nothing was stalled. Liveness reported healthy
 * throughout, correctly.
 *
 * So the check has to sit at the **commit point**, while the inputs that justified the
 * decision are still in hand. A periodic sweep sees the consequence - netFlow -56, three
 * banks drained - hours or weeks later. This sees the cause at the instant it is created.
 *
 * Findings ride the existing segment-90 export to the advisor rather than becoming a fifth
 * surface. Four already existed and the actual cost this session was that nobody read them.
 */

import { BURN_PER_WORK } from "../spawning/bodyBuilder";

export type InvariantType = "UNSUSTAINABLE_SPAWN";

export interface InvariantFinding {
  type: InvariantType;
  room: string;
  /** What was committed, and the arithmetic that makes it unsustainable. */
  detail: string;
  tick: number;
}

/** Cap on stored findings - this rides to AWS, so it stays small. */
const MAX_FINDINGS = 12;

/** Findings older than this are dropped; a condition that still holds is re-committed. */
const MAX_AGE = 3000;

/**
 * Share of income a single new creep's ongoing burn may claim before the spawn is called
 * unsustainable.
 *
 * Deliberately looser than the body clamp's 0.35. This is a *report*, not a gate - the
 * clamp already prevents the ordinary case, so anything reaching here has bypassed it
 * (a rescue path, or a regression). Reporting at the same threshold the clamp enforces
 * would fire on every borderline body and teach the reader to ignore it.
 */
export const SPAWN_BURN_SHARE = 0.5;

/**
 * Stored energy above which a large body is a legitimate use of the buffer rather than a
 * defect. Same principle as the clamp: a buffer exists to be spent.
 */
export const SPAWN_BUFFER = 10000;

/**
 * Whether this spawn commits the room to more ongoing burn than it can carry, and why.
 *
 * Pure, and takes `workParts` rather than a body so it can be tested without game globals.
 * Returns null when the commitment is fine - the caller records only a non-null reason.
 */
export function unsustainableSpawn(i: {
  role: string;
  workParts: number;
  incomePerTick: number;
  storedEnergy: number;
}): string | null {
  const burnPerWork = BURN_PER_WORK[i.role];

  // Not a discretionary role. A harvester's WORK parts earn and a hauler's CARRY moves
  // energy; sizing those to the energy on hand is correct, and flagging them would be the
  // cry-wolf failure that makes a registry worthless.
  if (!burnPerWork) return null;

  if (i.storedEnergy > SPAWN_BUFFER) return null;

  const burn = i.workParts * burnPerWork;
  const allowed = i.incomePerTick * SPAWN_BURN_SHARE;
  if (burn <= allowed) return null;

  return (
    `${i.role} spawned with ${i.workParts} WORK burns ${burn}/tick against ` +
    `${i.incomePerTick}/tick income (buffer ${i.storedEnergy})`
  );
}

interface InvariantMemory {
  _invariants?: InvariantFinding[];
}

/** Record a finding, replacing any earlier one of the same type for the same room. */
export function record(finding: InvariantFinding): void {
  const mem = Memory as unknown as InvariantMemory;
  const list = mem._invariants || (mem._invariants = []);

  const existing = list.findIndex((f) => f.type === finding.type && f.room === finding.room);
  if (existing >= 0) list[existing] = finding;
  else list.push(finding);

  list.sort((a, b) => b.tick - a.tick);
  if (list.length > MAX_FINDINGS) list.length = MAX_FINDINGS;

  console.log(`[invariant] ${finding.type} ${finding.room}: ${finding.detail}`);
}

/** Current findings, newest first. */
export function get(): InvariantFinding[] {
  return (Memory as unknown as InvariantMemory)._invariants || [];
}

/** Findings for one room, for the per-colony export. */
export function forRoom(roomName: string): InvariantFinding[] {
  return get().filter((f) => f.room === roomName);
}

/**
 * Drop findings that have aged out.
 *
 * A finding is a claim about a decision that was made, so unlike an anomaly there is no
 * live condition to re-check - it either happened or it did not. Age is the only sensible
 * expiry, and a cause that persists gets re-committed and re-recorded.
 */
export function prune(): void {
  const mem = Memory as unknown as InvariantMemory;
  if (!mem._invariants) return;

  mem._invariants = mem._invariants.filter((f) => Game.time - f.tick <= MAX_AGE);
  if (mem._invariants.length === 0) delete mem._invariants;
}
