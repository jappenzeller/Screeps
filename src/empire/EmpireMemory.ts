/**
 * EmpireMemory - Type definitions and initialization
 * Per empire-architecture.md Memory Schema
 */

import { ExpansionConfig } from "./EmpireConfig";

// Expansion state machine states
export type ExpansionStateType =
  | "IDLE"
  | "EVALUATING"
  | "QUEUED"
  | "CLAIMING"
  | "BOOTSTRAPPING"
  | "INTEGRATING"
  | "COMPLETE"
  | "BLOCKED"
  | "FAILED"
  | "ABANDONED";

// Empire state machine states
export type EmpireStateType = "SURVIVAL" | "STABILIZING" | "DEVELOPING" | "EXPANDING" | "DOMINANT";

export interface EmpireExpansionState {
  roomName: string;
  parentRoom: string;
  state: ExpansionStateType;
  startedAt: number;
  stateChangedAt: number;
  attempts: number;
  claimer: string | null;
  bootstrapCreeps: string[];
  spawnSiteId: string | null;
  spawnSitePos: { x: number; y: number } | null;
  blockers: string[];
  lastFailure: string | null;
}

export interface EmpireExpansionHistory {
  completedAt: number;
  success: boolean;
  reason?: string;
  duration: number;
}

// Extend global Memory interface
declare global {
  interface Memory {
    empire?: {
      state: EmpireStateType;
      stateChangedAt: number;
      config?: Partial<ExpansionConfig>;
      priorities: {
        expansion: number;
        military: number;
        economy: number;
        tech: number;
      };
      expansion?: {
        active: Record<string, EmpireExpansionState>;
        queue: Array<{ target: string; parent: string }>;
        history: Record<string, EmpireExpansionHistory>;
      };
      // Crisis targets: parentRoom -> targetRoom (for bootstrap worker emergency dispatch)
      crisisTargets?: Record<string, string>;
    };
    // NOTE: empireExpansion, expansion, and bootstrap are DEPRECATED
    // They may exist temporarily during migration but will be cleaned up
  }
}

/**
 * Initialize empire memory structures
 */
export function initializeEmpireMemory(): void {
  if (!Memory.empire) {
    Memory.empire = {
      state: "DEVELOPING",
      stateChangedAt: Game.time,
      priorities: {
        expansion: 50,
        military: 30,
        economy: 70,
        tech: 20,
      },
      expansion: {
        active: {},
        queue: [],
        history: {},
      },
    };
    console.log("[Empire] Initialized empire memory");
  }

  // Ensure expansion sub-object exists
  if (!Memory.empire.expansion) {
    Memory.empire.expansion = {
      active: {},
      queue: [],
      history: {},
    };
  }

  // === ONE-TIME MIGRATION ===
  // Migrate Memory.empireExpansion → Memory.empire.expansion
  var oldExpansion = (Memory as any).empireExpansion;
  if (oldExpansion) {
    var exp = Memory.empire.expansion;

    // Merge active expansions
    if (oldExpansion.active) {
      for (var room in oldExpansion.active) {
        if (!exp.active[room]) {
          exp.active[room] = oldExpansion.active[room];
          console.log("[Empire] Migrated active expansion: " + room);
        }
      }
    }

    // Merge queue (avoid duplicates)
    if (oldExpansion.queue) {
      for (var i = 0; i < oldExpansion.queue.length; i++) {
        var entry = oldExpansion.queue[i];
        var alreadyQueued = exp.queue.some(function(q: any) { return q.target === entry.target; });
        if (!alreadyQueued) {
          exp.queue.push(entry);
        }
      }
    }

    // Merge history
    if (oldExpansion.history) {
      for (var histRoom in oldExpansion.history) {
        if (!exp.history[histRoom]) {
          exp.history[histRoom] = oldExpansion.history[histRoom];
        }
      }
    }

    delete (Memory as any).empireExpansion;
    console.log("[Empire] Migrated Memory.empireExpansion -> Memory.empire.expansion");
  }

  // Clean up old expansion systems
  if ((Memory as any).expansion) {
    console.log("[Empire] Deleted legacy Memory.expansion");
    delete (Memory as any).expansion;
  }
  if ((Memory as any).bootstrap) {
    console.log("[Empire] Deleted legacy Memory.bootstrap");
    delete (Memory as any).bootstrap;
  }
}
