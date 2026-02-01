/**
 * EventBus - Simple pub/sub for empire-wide events
 * Per empire-architecture.md: "Modules communicate via events, not direct calls"
 */

export type EmpireEventType =
  | "HOSTILE_DETECTED"
  | "HOSTILE_CLEARED"
  | "ROOM_CLAIMED"
  | "ROOM_LOST"
  | "SPAWN_BUILT"
  | "RCL_UP"
  | "ENERGY_CRITICAL"
  | "ENERGY_STABLE"
  | "EXPANSION_COMPLETE"
  | "EXPANSION_FAILED"
  | "CREEP_SPAWNED"
  | "CREEP_DIED";

export interface EmpireEvent {
  type: EmpireEventType;
  roomName?: string;
  data?: Record<string, unknown>;
  tick: number;
}

type EventHandler = (event: EmpireEvent) => void;

class EventBusImpl {
  private handlers: Map<EmpireEventType, Set<EventHandler>> = new Map();
  private eventQueue: EmpireEvent[] = [];

  /**
   * Subscribe to an event type
   */
  on(type: EmpireEventType, handler: EventHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  /**
   * Unsubscribe from an event type
   */
  off(type: EmpireEventType, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Emit an event (queued for processing)
   */
  emit(type: EmpireEventType, roomName?: string, data?: Record<string, unknown>): void {
    const event: EmpireEvent = {
      type,
      roomName,
      data,
      tick: Game.time,
    };
    this.eventQueue.push(event);
    console.log(`[EventBus] Queued: ${type}${roomName ? ` (${roomName})` : ""}`);
  }

  /**
   * Process all queued events - call once per tick
   */
  processEvents(): void {
    const events = this.eventQueue.splice(0);
    for (const event of events) {
      const handlers = this.handlers.get(event.type);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (err) {
            console.log(`[EventBus] Handler error for ${event.type}: ${err}`);
          }
        }
      }
    }
  }

  /**
   * Clear all handlers (for testing/reset)
   */
  clear(): void {
    this.handlers.clear();
    this.eventQueue = [];
  }
}

// Singleton instance
export const eventBus = new EventBusImpl();
