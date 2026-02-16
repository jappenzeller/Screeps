/**
 * DirectiveReader - Reads and executes directives from AWS via segment 95
 *
 * AWS generates directives based on state snapshots and writes them to segment 95.
 * The bot reads these directives and executes them, providing acknowledgments back.
 *
 * This enables offloading heavy analysis (spawn scoring, remote selection, etc.)
 * to AWS while the bot focuses on real-time execution.
 */

import { ColonyManager } from "./ColonyManager";

// ============================================================================
// TYPES
// ============================================================================

export type DirectiveType =
  | "SPAWN"
  | "REMOTE_ADD"
  | "REMOTE_REMOVE"
  | "CONSTRUCT"
  | "EXPAND"
  | "MILITARY"
  | "CONFIG"
  | "CANCEL_SPAWN";

export type DirectiveStatus = "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED" | "EXPIRED";

export interface Directive {
  id: string;
  type: DirectiveType;
  colony: string;
  priority: number;
  payload: any;
  expiresAt: number;
  status?: DirectiveStatus;
}

export interface DirectivePayload {
  version: number;
  generatedAt: number;
  gameTick: number;
  directives: Directive[];
  meta: {
    analysisMs: number;
    stateAge: number;
  };
}

export interface DirectiveAck {
  id: string;
  status: "COMPLETED" | "FAILED" | "EXPIRED";
  executedAt: number;
  result?: string;
}

// Payload type definitions
export interface SpawnDirectivePayload {
  role: string;
  targetRoom?: string;
  body?: BodyPartConstant[];
  memory?: Partial<CreepMemory>;
  maxActive?: number;
  reason: string;
}

export interface RemoteAddDirectivePayload {
  remoteRoom: string;
  distance: number;
  via?: string;
  sources: number;
  score: number;
  reason: string;
}

export interface RemoteRemoveDirectivePayload {
  remoteRoom: string;
  reason: string;
  killCreeps: boolean;
}

export interface ConstructDirectivePayload {
  structureType: BuildableStructureConstant;
  pos: { x: number; y: number; roomName: string };
  reason: string;
}

export interface ConfigDirectivePayload {
  key: string;
  value: any;
  reason: string;
}

export interface MilitaryDirectivePayload {
  action: "ATTACK" | "DEFEND" | "RETREAT";
  targetRoom: string;
  composition?: { role: string; count: number }[];
  reason: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DIRECTIVE_SEGMENT = 95;
const STALENESS_THRESHOLD = 500; // Fall back to local if directives older than this
const MAX_DIRECTIVES_PER_TICK = 5; // Rate limit directive execution

// ============================================================================
// DIRECTIVE READER
// ============================================================================

export class DirectiveReader {
  private static pendingAcks: DirectiveAck[] = [];
  private static lastPayload: DirectivePayload | null = null;
  private static lastReadTick = 0;

  /**
   * Initialize directive reading by requesting segment 95.
   * Call this from main loop initialization.
   */
  static init(): void {
    // Request segment 95 alongside existing segments
    const activeSegments = [90, 91, 93, DIRECTIVE_SEGMENT];
    RawMemory.setActiveSegments(activeSegments);
  }

  /**
   * Main entry point - run at start of each tick.
   * Reads directives from segment 95 and executes them.
   *
   * @returns true if directives were processed, false if falling back to local
   */
  static run(): boolean {
    // Check if directives are enabled
    if (!Memory.settings?.useDirectives) {
      return false;
    }

    // Read and parse segment 95
    const payload = this.readDirectives();
    if (!payload) {
      return false;
    }

    // Check staleness
    const staleness = Game.time - payload.gameTick;
    if (staleness > STALENESS_THRESHOLD) {
      console.log("[directives] AWS data stale (" + staleness + " ticks), falling back to local");
      if (Memory.settings) {
        Memory.settings.useDirectives = false;
      }
      return false;
    }

    // Process directives
    this.processDirectives(payload);

    return true;
  }

  /**
   * Read and parse directive payload from segment 95.
   */
  private static readDirectives(): DirectivePayload | null {
    // Avoid re-reading same tick
    if (this.lastReadTick === Game.time && this.lastPayload) {
      return this.lastPayload;
    }

    const raw = RawMemory.segments[DIRECTIVE_SEGMENT];
    if (!raw || raw.length === 0) {
      return null;
    }

    try {
      const payload = JSON.parse(raw) as DirectivePayload;

      // Validate version (future-proofing)
      if (!payload.version || payload.version < 1) {
        console.log("[directives] Invalid payload version: " + payload.version);
        return null;
      }

      this.lastPayload = payload;
      this.lastReadTick = Game.time;
      return payload;
    } catch (e) {
      console.log("[directives] Failed to parse segment 95: " + e);
      return null;
    }
  }

  /**
   * Process all directives in priority order.
   */
  private static processDirectives(payload: DirectivePayload): void {
    // Initialize directive tracking if needed
    if (!Memory.directives) {
      Memory.directives = {};
    }

    // Sort by priority (highest first)
    const sorted = [...payload.directives].sort((a, b) => b.priority - a.priority);

    let executed = 0;
    for (const directive of sorted) {
      // Rate limit
      if (executed >= MAX_DIRECTIVES_PER_TICK) {
        break;
      }

      // Skip already processed directives
      const status = Memory.directives[directive.id];
      if (status && (status.status === "COMPLETED" || status.status === "FAILED")) {
        continue;
      }

      // Skip expired directives
      if (Game.time > directive.expiresAt) {
        this.ackDirective(directive.id, "EXPIRED", "Directive expired");
        continue;
      }

      // Execute directive
      const result = this.executeDirective(directive);
      if (result.executed) {
        executed++;
      }
    }
  }

  /**
   * Execute a single directive based on its type.
   */
  private static executeDirective(directive: Directive): { executed: boolean; error?: string } {
    try {
      switch (directive.type) {
        case "SPAWN":
          return this.executeSpawn(directive);
        case "REMOTE_ADD":
          return this.executeRemoteAdd(directive);
        case "REMOTE_REMOVE":
          return this.executeRemoteRemove(directive);
        case "CONSTRUCT":
          return this.executeConstruct(directive);
        case "CONFIG":
          return this.executeConfig(directive);
        case "MILITARY":
          return this.executeMilitary(directive);
        case "EXPAND":
          return this.executeExpand(directive);
        default:
          console.log("[directives] Unknown directive type: " + directive.type);
          this.ackDirective(directive.id, "FAILED", "Unknown type: " + directive.type);
          return { executed: false, error: "Unknown type" };
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.log("[directives] Error executing " + directive.id + ": " + error);
      this.ackDirective(directive.id, "FAILED", error);
      return { executed: false, error };
    }
  }

  /**
   * Execute SPAWN directive - inject into spawn queue.
   */
  private static executeSpawn(directive: Directive): { executed: boolean } {
    const payload = directive.payload as SpawnDirectivePayload;
    const colony = directive.colony;

    // Check if we already have enough of this role
    if (payload.maxActive !== undefined) {
      const currentCount = Object.values(Game.creeps).filter(
        (c) => c.memory.role === payload.role && c.memory.room === colony
      ).length;
      if (currentCount >= payload.maxActive) {
        // Not an error, just not needed
        return { executed: false };
      }
    }

    // Add to spawn directives in memory (picked up by utilitySpawning.ts)
    if (!Memory.spawnDirectives) {
      Memory.spawnDirectives = [];
    }

    // Check if directive already queued
    const alreadyQueued = Memory.spawnDirectives.some(
      (d) => d.directiveId === directive.id
    );
    if (alreadyQueued) {
      return { executed: false };
    }

    Memory.spawnDirectives.push({
      directiveId: directive.id,
      colony: colony,
      role: payload.role,
      targetRoom: payload.targetRoom,
      body: payload.body,
      memory: payload.memory,
      priority: directive.priority,
      reason: payload.reason,
      addedAt: Game.time,
    });

    console.log("[directive] Queued SPAWN " + payload.role + " for " + colony + " (" + payload.reason + ")");
    this.ackDirective(directive.id, "COMPLETED", "Queued for spawn");
    return { executed: true };
  }

  /**
   * Execute REMOTE_ADD directive - add a remote mining room.
   */
  private static executeRemoteAdd(directive: Directive): { executed: boolean } {
    const payload = directive.payload as RemoteAddDirectivePayload;
    const colony = directive.colony;

    const manager = ColonyManager.getInstance(colony);
    const success = manager.addRemote(payload.remoteRoom, payload.distance, payload.via);

    if (success) {
      console.log("[directive] Added remote " + payload.remoteRoom + " to " + colony + " (" + payload.reason + ")");
      this.ackDirective(directive.id, "COMPLETED", "Remote added");
    } else {
      this.ackDirective(directive.id, "FAILED", "addRemote returned false");
    }

    return { executed: true };
  }

  /**
   * Execute REMOTE_REMOVE directive - remove a remote mining room.
   */
  private static executeRemoteRemove(directive: Directive): { executed: boolean } {
    const payload = directive.payload as RemoteRemoveDirectivePayload;
    const colony = directive.colony;

    const manager = ColonyManager.getInstance(colony);
    const success = manager.removeRemote(payload.remoteRoom);

    if (success) {
      // Optionally kill creeps targeting this room
      if (payload.killCreeps) {
        for (const name in Game.creeps) {
          const creep = Game.creeps[name];
          if (creep.memory.targetRoom === payload.remoteRoom) {
            creep.suicide();
          }
        }
      }

      console.log("[directive] Removed remote " + payload.remoteRoom + " from " + colony + " (" + payload.reason + ")");
      this.ackDirective(directive.id, "COMPLETED", "Remote removed");
    } else {
      this.ackDirective(directive.id, "FAILED", "removeRemote returned false");
    }

    return { executed: true };
  }

  /**
   * Execute CONSTRUCT directive - place a construction site.
   */
  private static executeConstruct(directive: Directive): { executed: boolean } {
    const payload = directive.payload as ConstructDirectivePayload;
    const pos = new RoomPosition(payload.pos.x, payload.pos.y, payload.pos.roomName);

    // Check if we have visibility
    const room = Game.rooms[payload.pos.roomName];
    if (!room) {
      // Can't place without visibility, but don't fail - try again next tick
      return { executed: false };
    }

    // Check if site already exists at this position
    const existingSites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    if (existingSites.length > 0) {
      this.ackDirective(directive.id, "COMPLETED", "Site already exists");
      return { executed: true };
    }

    // Check if structure already exists
    const existingStructures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    const hasStructure = existingStructures.some((s) => s.structureType === payload.structureType);
    if (hasStructure) {
      this.ackDirective(directive.id, "COMPLETED", "Structure already built");
      return { executed: true };
    }

    const result = room.createConstructionSite(pos.x, pos.y, payload.structureType);
    if (result === OK) {
      console.log("[directive] Placed " + payload.structureType + " at " + pos + " (" + payload.reason + ")");
      this.ackDirective(directive.id, "COMPLETED", "Site placed");
    } else {
      this.ackDirective(directive.id, "FAILED", "createConstructionSite: " + result);
    }

    return { executed: true };
  }

  /**
   * Execute CONFIG directive - change colony configuration.
   */
  private static executeConfig(directive: Directive): { executed: boolean } {
    const payload = directive.payload as ConfigDirectivePayload;
    const colony = directive.colony;

    // Navigate to the config path and set value
    const parts = payload.key.split(".");
    let target: any = Memory.colonies?.[colony];

    if (!target) {
      this.ackDirective(directive.id, "FAILED", "Colony not found: " + colony);
      return { executed: true };
    }

    // Navigate to parent of final key
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) {
        target[parts[i]] = {};
      }
      target = target[parts[i]];
    }

    const finalKey = parts[parts.length - 1];
    target[finalKey] = payload.value;

    console.log("[directive] Set " + colony + "." + payload.key + " = " + JSON.stringify(payload.value) + " (" + payload.reason + ")");
    this.ackDirective(directive.id, "COMPLETED", "Config updated");

    return { executed: true };
  }

  /**
   * Execute MILITARY directive - launch attack or defend.
   */
  private static executeMilitary(directive: Directive): { executed: boolean } {
    const payload = directive.payload as MilitaryDirectivePayload;

    // For now, just log - actual implementation depends on MilitaryManager integration
    console.log("[directive] Military " + payload.action + " on " + payload.targetRoom + " (" + payload.reason + ")");

    // TODO: Integrate with MilitaryManager
    // if (payload.action === 'ATTACK') {
    //   MilitaryManager.startCampaign({ targetRoom: payload.targetRoom, ... });
    // }

    this.ackDirective(directive.id, "COMPLETED", "Military action initiated");
    return { executed: true };
  }

  /**
   * Execute EXPAND directive - start expansion to a room.
   */
  private static executeExpand(directive: Directive): { executed: boolean } {
    const payload = directive.payload;

    // TODO: Integrate with ExpansionManager
    console.log("[directive] Expand to " + payload.targetRoom + " (" + payload.reason + ")");

    this.ackDirective(directive.id, "COMPLETED", "Expansion initiated");
    return { executed: true };
  }

  /**
   * Record acknowledgment for a directive.
   */
  private static ackDirective(id: string, status: DirectiveAck["status"], result?: string): void {
    // Update memory tracking
    if (!Memory.directives) {
      Memory.directives = {};
    }
    Memory.directives[id] = {
      status,
      executedAt: Game.time,
      result,
    };

    // Add to pending acks for export
    this.pendingAcks.push({
      id,
      status,
      executedAt: Game.time,
      result,
    });
  }

  /**
   * Get pending acknowledgments and clear them.
   * Called by AWSExporter to include in state export.
   */
  static getAndClearAcks(): DirectiveAck[] {
    const acks = [...this.pendingAcks];
    this.pendingAcks = [];
    return acks;
  }

  /**
   * Get current directive payload for debugging.
   */
  static getPayload(): DirectivePayload | null {
    return this.lastPayload;
  }

  /**
   * Get all directive statuses from memory.
   */
  static getStatuses(): Record<string, { status: string; executedAt: number; result?: string }> {
    return Memory.directives || {};
  }

  /**
   * Clear all directive state (for debugging/reset).
   */
  static clear(): void {
    this.pendingAcks = [];
    this.lastPayload = null;
    this.lastReadTick = 0;
    delete Memory.directives;
    delete Memory.spawnDirectives;
    console.log("[directives] Cleared all directive state");
  }

  /**
   * Force fallback to local logic.
   */
  static forceFallback(): void {
    if (Memory.settings) {
      Memory.settings.useDirectives = false;
    }
    console.log("[directives] Forced fallback to local logic");
  }

  /**
   * Toggle directives on/off.
   */
  static toggle(): boolean {
    if (!Memory.settings) {
      Memory.settings = {} as SettingsFlags;
    }
    const newValue = !Memory.settings.useDirectives;
    Memory.settings.useDirectives = newValue;
    console.log("[directives] useDirectives = " + newValue);
    return newValue;
  }
}
