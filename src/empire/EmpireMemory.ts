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
    };
    empireExpansion?: {
      active: Record<string, EmpireExpansionState>;
      queue: Array<{ target: string; parent: string }>;
      history: Record<string, EmpireExpansionHistory>;
    };
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
    };
    console.log("[Empire] Initialized empire memory");
  }

  if (!Memory.empireExpansion) {
    Memory.empireExpansion = {
      active: {},
      queue: [],
      history: {},
    };
    console.log("[Empire] Initialized expansion memory");
  }
}
