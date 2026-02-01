/**
 * CommandExecutor - Processes commands from memory segment 91 and writes results back.
 * Enables bidirectional command execution via the AWS API.
 */

const COMMAND_SEGMENT = 91;

interface CommandRequest {
  status: "pending" | "complete";
  requestId: string;
  command: string;
  sentAt?: number;
  result?: unknown;
  error?: string | null;
  executedAt?: number;
  timestamp?: number;
}

export class CommandExecutor {
  /**
   * Initialize active segments - call once per tick before accessing segments
   */
  public static init(): void {
    // Ensure segments are active: 90 (AWS export), 91 (commands), 92 (position log)
    RawMemory.setActiveSegments([90, 91, 92]);
  }

  /**
   * Process any pending command in segment 91
   */
  public static run(): void {
    const raw = RawMemory.segments[COMMAND_SEGMENT];
    if (!raw) return;

    try {
      const data = JSON.parse(raw) as CommandRequest;

      // Only process pending commands
      if (data.status !== "pending") return;

      const command = data.command;
      const requestId = data.requestId;

      let result: unknown;
      let error: string | null = null;

      try {
        // Execute the command
        // eslint-disable-next-line no-eval
        result = eval(command);

        // Handle non-serializable results
        result = this.serializeResult(result);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      // Write result back to segment
      const response: CommandRequest = {
        status: "complete",
        requestId: requestId,
        command: command,
        result: result,
        error: error,
        executedAt: Game.time,
        timestamp: Date.now(),
      };

      RawMemory.segments[COMMAND_SEGMENT] = JSON.stringify(response);

      // Log for audit trail
      console.log(`[CommandExecutor] Executed: ${command.substring(0, 50)}${command.length > 50 ? "..." : ""}`);
      if (error) {
        console.log(`[CommandExecutor] Error: ${error}`);
      }
    } catch (e) {
      // Invalid JSON or parse error - log but don't crash
      console.log(`[CommandExecutor] Parse error: ${e}`);
    }
  }

  /**
   * Convert potentially non-serializable values to serializable format
   */
  private static serializeResult(result: unknown): unknown {
    if (result === undefined) return "undefined";
    if (result === null) return null;
    if (typeof result === "function") return "[Function]";

    // Handle RoomPosition
    if (result instanceof RoomPosition) {
      return { x: result.x, y: result.y, roomName: result.roomName, _type: "RoomPosition" };
    }

    // Handle game objects with id
    if (typeof result === "object" && result !== null && "id" in result) {
      const obj = result as { id: string; pos?: RoomPosition; structureType?: string; name?: string };
      return {
        id: obj.id,
        pos: obj.pos ? { x: obj.pos.x, y: obj.pos.y, roomName: obj.pos.roomName } : undefined,
        type: obj.structureType || obj.name || obj.constructor?.name,
        _type: "GameObject",
      };
    }

    // Handle arrays
    if (Array.isArray(result)) {
      return result.map((item) => this.serializeResult(item));
    }

    // Handle plain objects
    if (typeof result === "object" && result !== null) {
      const serialized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result)) {
        try {
          serialized[key] = this.serializeResult(value);
        } catch {
          serialized[key] = "[Unserializable]";
        }
      }
      return serialized;
    }

    return result;
  }
}
