// Extend Screeps memory types
// The @types/screeps package provides empty interfaces for us to extend

// Creep state machine states
type CreepState = "IDLE" | "COLLECTING" | "DELIVERING" | "BUILDING" | "UPGRADING" | "HARVESTING" | "TRAVELING";

// Container plan interface
interface ContainerPlan {
  sources: { [sourceId: string]: { x: number; y: number } };
  controller?: { x: number; y: number };
  placed: boolean;
}

// Extend CreepMemory from @types/screeps
interface CreepMemory {
  role: string;
  room: string;
  sourceId?: Id<Source>;
  targetRoom?: string;

  // Task system
  taskId?: string;
  state?: CreepState;
  emergency?: boolean;

  // Legacy support
  working?: boolean;
}

// Extend RoomMemory from @types/screeps
interface RoomMemory {
  sources?: Id<Source>[];
  hostiles?: number;
  lastScan?: number;
  containerPlan?: ContainerPlan;

  // Assignment tracking
  assignments?: {
    harvesters: Record<string, string>; // sourceId -> creepName
    haulers: Record<string, string[]>; // containerId -> creepNames
  };

  // Scout intel
  controller?: {
    owner?: string;
    level?: number;
    reservation?: {
      username: string;
      ticksToEnd: number;
    };
  };
  hasKeepers?: boolean;
  hasInvaderCore?: boolean;
}

// Global console declaration for Screeps
declare const console: {
  log(...args: unknown[]): void;
};
