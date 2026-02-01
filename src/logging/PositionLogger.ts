/**
 * Position Logger - Records creep positions for external heatmap rendering
 * Data is stored in Memory.positionLog and flushed to segment 92
 * Enable via: Memory.settings = { logPositions: true }
 */

interface PositionEntry {
  t: number; // tick
  c: string; // creep name (last 6 chars)
  x: number;
  y: number;
  r: string; // role (3 chars)
}

interface PositionLog {
  room: string;
  startTick: number;
  entries: PositionEntry[];
}

declare global {
  interface Memory {
    positionLog?: PositionLog;
  }

  interface SettingsFlags {
    logPositions?: boolean;
  }
}

export class PositionLogger {
  private static SEGMENT_ID = 92;
  private static MAX_ENTRIES = 1500; // ~75KB safe margin under 100KB limit

  public static run(roomName: string): void {
    if (!Memory.settings?.logPositions) return;

    const room = Game.rooms[roomName];
    if (!room) return;

    // Initialize buffer
    if (!Memory.positionLog) {
      Memory.positionLog = {
        room: roomName,
        startTick: Game.time,
        entries: [],
      };
    }

    // Record positions
    const creeps = room.find(FIND_MY_CREEPS);
    for (const creep of creeps) {
      Memory.positionLog.entries.push({
        t: Game.time,
        c: creep.name.slice(-6), // Last 6 chars
        x: creep.pos.x,
        y: creep.pos.y,
        r: creep.memory.role?.slice(0, 3) || "???", // HAR, HAU, UPG, etc.
      });
    }

    // Flush to segment when buffer full
    if (Memory.positionLog.entries.length >= this.MAX_ENTRIES) {
      this.flush();
    }
  }

  public static flush(): void {
    if (!Memory.positionLog?.entries.length) return;

    RawMemory.segments[this.SEGMENT_ID] = JSON.stringify(Memory.positionLog);
    console.log(
      `[PositionLogger] Flushed ${Memory.positionLog.entries.length} entries to segment ${this.SEGMENT_ID}`
    );

    // Reset buffer, keep recording
    Memory.positionLog = {
      room: Memory.positionLog.room,
      startTick: Game.time,
      entries: [],
    };
  }

  public static getStats(): { entries: number; ticks: number; size: string } {
    const log = Memory.positionLog;
    if (!log) return { entries: 0, ticks: 0, size: "0 KB" };

    const entries = log.entries.length;
    const ticks = entries > 0 ? Game.time - log.startTick : 0;
    const size = (JSON.stringify(log).length / 1024).toFixed(1) + " KB";

    return { entries, ticks, size };
  }
}
